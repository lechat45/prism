// Tests de l'isolation des widgets (js/sandbox.js).  Lancement : node --test "frontend/tests/*.test.*"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptStorage, buildSrcdoc, exportHtml, FRAME_SANDBOX, isAccent } from "../js/sandbox.js";

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

test("CSP en tête : aucun réseau sauf Chart.js épinglé", () => {
  const doc = buildSrcdoc({ html: DOC, storage: {} }, libs);
  const head = injected(doc);
  assert.ok(head.startsWith('<meta http-equiv="Content-Security-Policy"'), "la CSP doit précéder tout script");
  assert.match(head, /default-src 'none'/);
  assert.match(head, new RegExp(`script-src 'unsafe-inline' ${libs.chartjs.url.replace(/[.]/g, "\\.")}`));
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

test("export autonome : données et accent inclus, ni CSP ni prélude", () => {
  const html = exportHtml({ html: DOC, accent: "#3ddc84", file: { data: { name: "d.json", kind: "json", data: [1] } } });
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes('window.PRISM_FILE={"name":"d.json","kind":"json","data":[1]}'));
  assert.ok(html.includes("--accent:#3ddc84"));
  assert.ok(!html.includes("Content-Security-Policy"));
  assert.ok(!html.includes("parent.postMessage"));
});

test("documents sans <head> ou sans <html>", () => {
  assert.match(buildSrcdoc({ html: "<html><body>x</body></html>" }, libs), /^<html><head><meta http-equiv/);
  assert.match(buildSrcdoc({ html: "<p>fragment</p>" }, libs), /^<!DOCTYPE html><html><head><meta/);
});

test("stockage envoyé par un widget : validé et plafonné", () => {
  assert.deepEqual(acceptStorage({ state: "{}" }), { state: "{}" });
  assert.equal(acceptStorage({ n: 1 }), null);
  assert.equal(acceptStorage(["a"]), null);
  assert.equal(acceptStorage("x"), null);
  assert.equal(acceptStorage({ big: "x".repeat(1_000_001) }), null);
});
