// Rejoue frontend/tests/fixtures.json avec l'implémentation navigateur (engine/*.js).
// Exécuté seul, imprime les résultats en JSON : backend/tests/test_parity.py les
// compare à ceux de l'implémentation Python (parité exacte des deux moteurs).
"use strict";

const fs = require("fs");
const path = require("path");
const S = require("../engine/sanitize.js");
const L = require("../engine/local.js");
const E = require("../engine/engram/engram.js");

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

const libs = JSON.parse(read("engine/libs.json"));
const templates = {
  user: read("engine/user-template.txt").trim(),
  file: read("engine/file-template.txt").trim(),
  refactor: read("engine/refactor-template.txt").trim(),
  canvas: read("engine/canvas-template.txt").trim(),
  dna: read("engine/dna-template.txt").trim(),
};
const demo = JSON.parse(read("engine/engram/demo-marie-curie.json"));
const engramTemplate = read("engine/engram/user-template.txt");
const chatTemplate = read("engine/engram/chat-template.txt");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Démo de l'Engramme modifiée par les opérations du cas (même algorithme que test_parity.py).
function patched(c) {
  if ("raw" in c) return clone(c.raw);
  const data = clone(demo);
  for (const [op, path, value] of c.patch) {
    let parent = data;
    for (const key of path.slice(0, -1)) parent = parent[key];
    const last = path[path.length - 1];
    if (op === "set") parent[last] = clone(value);
    else if (op === "append") parent[last].push(clone(value));
    else parent.splice(last, 1);
  }
  return data;
}

function outcome(fn) {
  try {
    return { ok: fn() };
  } catch (err) {
    if (err.name === "EngramRefused" || err.name === "EngramError") return { error: err.name };
    throw err;
  }
}

async function runFixtures() {
  const engine = L.createLocalEngine({ baseUrl: "engine/", fetch: fileFetch });
  const manifest = JSON.parse(read("engine/mocks/manifest.json"));
  const mockHtml = async (c) => (await engine.mock(c.prompt, c.file_kind)).html;
  return {
    clean: fixtures.clean.map((c) => S.cleanLlmOutput(c.raw)),
    markup: fixtures.markup.map((c) => S.hasMarkup(c.text)),
    validate: fixtures.validate.map((c) => S.validateDocument(c.doc, L.allowedUrls(libs))),
    js_syntax: fixtures.js_syntax.map((c) => S.jsSyntaxErrors(c.doc).length),
    libraries: fixtures.libraries.map((c) => S.normalizeLibraries(c.doc, libs)),
    routing: fixtures.routing.map((c) => L.route(c.prompt, manifest, c.file_kind)),
    series: fixtures.series.map((c) => L.extractSeries(c.prompt, manifest)),
    renders: await Promise.all(fixtures.render.map(mockHtml)),
    mock_renders: await Promise.all(fixtures.routing.map(mockHtml)),
    messages: fixtures.messages.map((c) => L.buildUserMessage(c.prompt, c.file || null, c.base_html || null, templates, c.canvas || null, c.dna || null)),
    engram: fixtures.engram.map((c) => outcome(() => E.normalize(patched(c)))),
    engram_parse: fixtures.engram_parse.map((t) => outcome(() => E.parse(t))),
    engram_messages: fixtures.engram_messages.map((c) => E.buildUserMessage(engramTemplate, c.person, c.language)),
    engram_chat: fixtures.engram_chat.map((c) => {
      const source = c.engram === "demo" ? clone(demo) : c.engram;
      return {
        message: E.buildChatMessage(chatTemplate, source, c.history, c.message, "fr"),
        demo: E.demoChat(source, c.message),
        normalized: outcome(() => E.normalizeChat(c.raw, source)),
      };
    }),
  };
}

module.exports = { runFixtures, fixtures, fileFetch, libs };

if (require.main === module) {
  runFixtures().then((results) => process.stdout.write(JSON.stringify(results)));
}
