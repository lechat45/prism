// Document des cartes Engramme (engine/engram/engram.js + viewer.html).  node --test frontend/tests/engram-viewer.test.cjs
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const E = require("../engine/engram/engram.js");

const ENGINE = path.resolve(__dirname, "../engine");
const read = (rel) => fs.readFileSync(path.join(ENGINE, rel), "utf8");
const template = read("engram/viewer.html");
const physics = read("engram/physics.js");
const libs = JSON.parse(read("libs.json"));
const demo = E.normalize(JSON.parse(read("engram/demo-marie-curie.json")));
const build = (engram) => E.buildViewer(template, physics, engram, libs, "fr");

test("document complet : gabarit rempli, Tailwind épinglé (SRI), données relisibles", () => {
  const html = build(demo);
  assert.doesNotMatch(html, /\{\{(lang|title|tailwind|physics|engram)\}\}/);
  assert.match(html, /<title>Engramme · Marie Curie<\/title>/);
  assert.ok(html.includes(`src="${libs.tailwind.url}" integrity="${libs.tailwind.integrity}"`));
  assert.ok(html.includes("PrismEngramPhysics"));
  assert.deepEqual(E.readViewer(html), demo);
  assert.equal(E.readViewer("<!DOCTYPE html><html><body>widget ordinaire</body></html>"), null);
  assert.ok(html.includes("data-prism-nofractal"), "le double-clic d'un Engramme ne propose pas de zoom fractal");
});

test("données hostiles : rien ne sort du bloc JSON inerte", () => {
  const evil = JSON.parse(JSON.stringify(demo));
  evil.person = "</script><script>parent.postMessage('x','*')</script>";
  evil.nodes[1].title = "{{physics}}   <!-- </SCRIPT> {{engram}}";
  evil.nodes[2].content = "a b";
  const html = build(evil);
  assert.equal(E.readViewer(html).person, evil.person);
  assert.deepEqual(E.readViewer(html), evil);
  const data = /<script type="application\/json" id="prism-engram">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotMatch(data, /</, "aucun « < » brut dans les données");
  assert.ok(!data.includes(" ") && !data.includes(" "));
  assert.match(html, /<title>Engramme · &lt;\/script&gt;/, "titre échappé");
  assert.equal(html.split("PrismEngramPhysics = api").length, 2, "moteur inscrit une seule fois (pas de réinterprétation)");
});

test("les scripts du document sont du JavaScript valide", () => {
  const html = build(demo);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2, "moteur physique + rendu");
  for (const code of scripts) assert.doesNotThrow(() => new Function(code));
  assert.throws(() => E.buildViewer(template, "x = '</script>'", demo, libs), /<\/script/);
});

test("trait ADN d'une bulle : champs du filtre, palette et vocabulaire", () => {
  const aesthetic = demo.nodes.find((n) => n.type === "matrice_esthetique");
  const dna = E.dnaOf(demo, aesthetic.id);
  assert.deepEqual(Object.keys(dna).sort(), ["category", "content", "directive", "palette", "person", "title", "type"]);
  assert.equal(dna.person, "Marie Curie");
  assert.deepEqual(dna.palette, aesthetic.palette);
  const syntax = demo.nodes.find((n) => n.type === "empreinte_syntaxique");
  assert.deepEqual(E.dnaOf(demo, syntax.id).keywords, syntax.keywords);
  assert.equal(E.dnaOf(demo, "inconnu"), null);
  assert.equal(E.dnaOf(null, "core"), null);
});

test("demande « Engramme : nom » reconnue dans le dock, Spotlight et la voix", () => {
  const rule = E.engramRequest;
  assert.equal(rule("Engramme : Marie Curie"), "Marie Curie");
  assert.equal(rule("engramme de Léonard de Vinci"), "Léonard de Vinci");
  assert.equal(rule("Engramme d'Ada Lovelace"), "Ada Lovelace");
  assert.equal(rule("ENGRAMME: Nikola Tesla "), "Nikola Tesla");
  assert.equal(rule("Engramme :"), null);
  assert.equal(rule("un engramme de mon chat"), null, "seulement en tête de demande");
  assert.equal(rule("Crée un tableau"), null);
});
