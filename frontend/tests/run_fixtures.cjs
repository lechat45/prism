// Rejoue frontend/tests/fixtures.json avec l'implémentation navigateur (engine/*.js).
// Exécuté seul, imprime les résultats en JSON : backend/tests/test_parity.py les
// compare à ceux de l'implémentation Python (parité exacte des deux moteurs).
"use strict";

const fs = require("fs");
const path = require("path");
const S = require("../engine/sanitize.js");
const L = require("../engine/local.js");

const FRONTEND = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8");
const fixtures = JSON.parse(read("tests/fixtures.json"));

/** fetch() minimal servant les fichiers de frontend/, comme le ferait GitHub Pages. */
function fileFetch(url) {
  const file = path.join(FRONTEND, url);
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404, text: async () => "", json: async () => null });
  const body = fs.readFileSync(file, "utf8");
  return Promise.resolve({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
}

async function runFixtures() {
  const engine = L.createLocalEngine({ baseUrl: "engine/", fetch: fileFetch });
  const manifest = JSON.parse(read("engine/mocks/manifest.json"));
  const mockHtml = async (prompt) => (await engine.mock(prompt)).html;
  return {
    clean: fixtures.clean.map((c) => S.cleanLlmOutput(c.raw)),
    markup: fixtures.markup.map((c) => S.hasMarkup(c.text)),
    validate: fixtures.validate.map((c) => S.validateDocument(c.doc)),
    js_syntax: fixtures.js_syntax.map((c) => S.jsSyntaxErrors(c.doc).length),
    routing: fixtures.routing.map((c) => L.route(c.prompt, manifest)),
    series: fixtures.series.map((c) => L.extractSeries(c.prompt, manifest)),
    renders: await Promise.all(fixtures.render.map((c) => mockHtml(c.prompt))),
    mock_renders: await Promise.all(fixtures.routing.map((c) => mockHtml(c.prompt))),
  };
}

module.exports = { runFixtures, fixtures, fileFetch };

if (require.main === module) {
  runFixtures().then((results) => process.stdout.write(JSON.stringify(results)));
}
