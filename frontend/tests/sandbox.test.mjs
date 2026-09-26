// Tests de l'isolation des widgets (js/sandbox.js).  Lancement : node --test "frontend/tests/*.test.*"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptStorage, acceptThumbnail, bootSrcdoc, buildSrcdoc, exportHtml, FRAME_SANDBOX, isAccent, MAX_THUMBNAIL, needsBoot } from "../js/sandbox.js";

const libs = JSON.parse(readFileSync(new URL("../engine/libs.json", import.meta.url), "utf8"));
const DOC = '<!DOCTYPE html><html lang="fr"><head><title>T</title></head><body><script>localStorage.setItem("state","1")</script></body></html>';
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function injected(html) {
  const head = html.indexOf("<head>") + "<head>".length;
  return html.slice(head, html.indexOf("<title>"));
}

test("sandbox sans allow-same-origin", () => {
  assert.equal(FRAME_SANDBOX, "allow-scripts");
});

test("CSP en tête : aucun réseau sauf les bibliothèques épinglées (Tailwind, Chart.js)", () => {
  const doc = buildSrcdoc({ html: DOC, storage: {} }, libs);
  const head = injected(doc);
  assert.ok(head.startsWith('<meta http-equiv="Content-Security-Policy"'), "la CSP doit précéder tout script");
  assert.match(head, /default-src 'none'/);
  const scriptSrc = /script-src ([^;]+);/.exec(head)[1].trim().split(/\s+/);
  assert.deepEqual(scriptSrc.sort(), ["'unsafe-inline'", libs.tailwind.url, libs.chartjs.url].sort());
  assert.doesNotMatch(head, /connect-src/);
});

test("style hôte : barres de défilement masquées et attribut hidden toujours respecté", () => {
  const head = injected(buildSrcdoc({ html: DOC }, libs));
  assert.match(head, /\*::-webkit-scrollbar\{display:none\}/);
  assert.match(head, /\[hidden\]\{display:none!important\}/);
});

test("instantané du stockage et données du fichier injectés sans casser le <script>", () => {
  const card = {
    html: DOC,
    storage: { state: `a</script><script>alert(1)</script>${LS}b${PS}` },
    file: { data: { name: "x.csv", rows: [{ v: "</script>" }] } },
  };
  const doc = buildSrcdoc(card, libs);
  const head = injected(doc);
  // Seules nos balises ouvrent/ferment des scripts : aucune donnée ne peut s'en échapper.
  assert.equal(head.split("</script>").length - 1, 2);
  assert.ok(!head.includes(LS) && !head.includes(PS), "séparateurs Unicode échappés");
  assert.ok(head.includes("window.PRISM_FILE="));
  assert.ok(head.includes("\\u003c/script>"));
});

test("le prélude est du JavaScript valide", () => {
  const doc = buildSrcdoc({ html: DOC, storage: { k: "v" }, file: { data: { a: 1 } }, accent: "#ff5e8a" }, libs);
  const scripts = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 3); // PRISM_FILE, prélude, script du widget
  scripts.forEach((src) => assert.doesNotThrow(() => new Function(src)));
});

test("couleur d'accent : seules les couleurs #rrggbb passent", () => {
  assert.ok(isAccent("#a66bff"));
  assert.ok(isAccent(null));
  for (const bad of ["red", "#fff", "#12345g", "#000000;}body{display:none", "", undefined]) assert.equal(isAccent(bad), false, String(bad));
  const doc = buildSrcdoc({ html: DOC, accent: "#000000;}*{x:y" }, libs);
  assert.ok(!doc.includes('<style id="prism-accent">'), "une valeur invalide n'est jamais injectée");
  assert.ok(buildSrcdoc({ html: DOC, accent: "#a66bff" }, libs).includes(":root{--accent:#a66bff !important}"));
});

test("export autonome : données et accent inclus, ni CSP ni prélude", async () => {
  const html = await exportHtml({ html: DOC, accent: "#3ddc84", file: { data: { name: "d.json", kind: "json", data: [1] } } });
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes('window.PRISM_FILE={"name":"d.json","kind":"json","data":[1]}'));
  assert.ok(html.includes("--accent:#3ddc84"));
  assert.ok(!html.includes("Content-Security-Policy"));
  assert.ok(!html.includes("parent.postMessage"));
});

// Fichier joint en Blob (produit par le Web Worker) : jamais dans srcdoc, livré par le chargeur.
const blobFile = (value) => ({ name: "v.csv", kind: "csv", blob: new Blob([JSON.stringify(value)], { type: "application/json" }) });

test("fichier en Blob : srcdoc sans les données, chargeur minimal sous la même CSP", () => {
  const card = { html: DOC, storage: {}, file: blobFile({ rows: [{ secret: "valeur-témoin" }] }) };
  assert.ok(needsBoot(card));
  assert.ok(!needsBoot({ html: DOC, file: { data: {} } }), "cartes v2 non migrées : données dans srcdoc");
  assert.ok(!buildSrcdoc(card, libs).includes("valeur-témoin"));
  assert.ok(!buildSrcdoc(card, libs).includes("PRISM_FILE"));

  const boot = bootSrcdoc(libs);
  assert.ok(boot.length < 2000, `chargeur de ${boot.length} caractères`);
  assert.equal(boot.indexOf('<meta http-equiv="Content-Security-Policy"'), "<!DOCTYPE html><html><head>".length, "CSP avant tout script");
  assert.equal(/script-src ([^;]+);/.exec(boot)[1], /script-src ([^;]+);/.exec(buildSrcdoc(card, libs))[1]);
  const script = /<script>([\s\S]*?)<\/script>/.exec(boot)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /e\.source !== parent/, "seul le parent peut livrer le document");
  assert.match(script, /booted/, "une seule livraison");
});

test("export d'une carte à Blob : données lues et échappées pour le <script>", async () => {
  const html = await exportHtml({ html: DOC, file: blobFile({ rows: [{ v: `</script><b>${LS}` }] }) });
  assert.ok(html.includes("window.PRISM_FILE={"));
  assert.ok(html.includes("\\u003c/script>") && !html.includes(LS));
  assert.equal(html.split("</script>").length - 1, 2); // données + script du widget
});

test("documents sans <head> ou sans <html>", () => {
  assert.match(buildSrcdoc({ html: "<html><body>x</body></html>" }, libs), /^<html><head><meta http-equiv/);
  assert.match(buildSrcdoc({ html: "<p>fragment</p>" }, libs), /^<!DOCTYPE html><html><head><meta/);
});

test("miniature envoyée par un widget : image matricielle base64 uniquement, plafonnée", () => {
  assert.ok(acceptThumbnail("data:image/webp;base64,UklGRg=="));
  assert.ok(acceptThumbnail("data:image/png;base64,iVBORw0KGgo="));
  for (const bad of ["data:image/svg+xml;base64,PHN2Zz4=", "javascript:alert(1)", "data:image/png;base64,<script>", 42, null,
    `data:image/png;base64,${"A".repeat(MAX_THUMBNAIL)}`]) {
    assert.equal(acceptThumbnail(bad), false, String(bad).slice(0, 40));
  }
});

test("le prélude sait fabriquer une miniature (demande « snapshot » du parent uniquement)", () => {
  const doc = buildSrcdoc({ html: DOC, storage: {} }, libs);
  assert.match(doc, /e\.data\.prism === "snapshot"/);
  assert.match(doc, /e\.source !== parent/);
  assert.match(doc, /foreignObject/);
});

test("stockage envoyé par un widget : validé et plafonné", () => {
  assert.deepEqual(acceptStorage({ state: "{}" }), { state: "{}" });
  assert.equal(acceptStorage({ n: 1 }), null);
  assert.equal(acceptStorage(["a"]), null);
  assert.equal(acceptStorage("x"), null);
  assert.equal(acceptStorage({ big: "x".repeat(1_000_001) }), null);
});
