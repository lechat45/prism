// Tests du moteur navigateur (GitHub Pages).  Lancement : node --test frontend/tests/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../engine/local.js");
const { runFixtures, fixtures, fileFetch, libs } = require("./run_fixtures.cjs");

const GOOD =
  '<!DOCTYPE html>\n<html><head><style>b{}</style></head><body><button id="b">0</button>' +
  '<script>let n = 0; document.getElementById("b").onclick = () => { n++; };</script></body></html>';
const PRIMARY = "openai/gpt-oss-120b";
const SECONDARY = "llama-3.3-70b-versatile";

// --------------------------------------------------------------------------
// Cas partagés avec Python
// --------------------------------------------------------------------------
test("fixtures partagées : mêmes attentes que le backend", async () => {
  const r = await runFixtures();
  fixtures.clean.forEach((c, i) => assert.equal(r.clean[i], c.expected, c.name));
  fixtures.markup.forEach((c, i) => assert.equal(r.markup[i], c.expected, c.text));
  fixtures.validate.forEach((c, i) => {
    const blocking = r.validate[i].some((issue) => ["empty_document", "markdown_fence", "missing_closing_html", "unbalanced_<script>"].includes(issue));
    assert.equal(blocking, c.blocking, c.name);
    if (c.exact) assert.deepEqual(r.validate[i], c.exact, c.name);
    (c.includes || []).forEach((issue) => assert.ok(r.validate[i].includes(issue), `${c.name} : ${issue}`));
  });
  fixtures.js_syntax.forEach((c, i) => assert.equal(r.js_syntax[i], c.errors, c.name));
  fixtures.routing.forEach((c, i) => assert.equal(r.routing[i], c.template, c.prompt));
  fixtures.series.forEach((c, i) => {
    assert.deepEqual(r.series[i].map((s) => s.label), c.labels);
    assert.deepEqual(r.series[i].map((s) => s.value), c.values);
  });
  fixtures.libraries.forEach((c, i) => {
    const got = r.libraries[i];
    assert.equal(got.split(libs.chartjs.url).length - 1, c.pinned, c.name);
    (c.absent || []).forEach((s) => assert.ok(!got.includes(s), `${c.name} : sans ${s}`));
    (c.contains || []).forEach((s) => assert.ok(got.includes(s), `${c.name} : contient ${s}`));
  });
  fixtures.messages.forEach((c, i) => {
    (c.contains || []).forEach((s) => assert.ok(r.messages[i].includes(s), `${c.name} : contient ${s}`));
    (c.absent || []).forEach((s) => assert.ok(!r.messages[i].includes(s), `${c.name} : sans ${s}`));
  });
  fixtures.render.forEach((c, i) => {
    (c.contains || []).forEach((s) => assert.ok(r.renders[i].includes(s), `${c.name} : contient ${s}`));
    (c.absent || []).forEach((s) => assert.ok(!r.renders[i].includes(s), `${c.name} : sans ${s}`));
    if (c.script_tags) assert.equal(r.renders[i].toLowerCase().split("<script>").length - 1, c.script_tags, c.name);
  });
});

// --------------------------------------------------------------------------
// Appels Groq depuis le navigateur (faux serveur)
// --------------------------------------------------------------------------
function completion(content, finish = "stop") {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }), text: async () => "" };
}
const httpError = (status) => ({ ok: false, status, json: async () => ({}), text: async () => `erreur ${status}` });

function fakeGroq(responses) {
  const calls = [];
  const fetchImpl = (url, init) => {
    if (!init) return fileFetch(url); // fichiers du moteur (prompt, groq.json…)
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    return Promise.resolve(responses[body.model]);
  };
  return { engine: L.createLocalEngine({ baseUrl: "engine/", fetch: fetchImpl }), calls };
}

test("sans clé : mode démo depuis les gabarits partagés", async () => {
  const { engine, calls } = fakeGroq({});
  const r = await engine.generate(fixtures.routing[0].prompt);
  assert.equal(r.mode, "mock");
  assert.equal(r.model, "mock:counter");
  assert.ok(r.html.startsWith("<!DOCTYPE html>"));
  assert.equal(calls.length, 0);
});

test("réponse en Markdown nettoyée, prompt système partagé envoyé", async () => {
  const { engine, calls } = fakeGroq({ [PRIMARY]: completion(`Voici :\n\`\`\`html\n${GOOD}\n\`\`\`\nBonne utilisation !`) });
  const r = await engine.generate("un compteur", { key: "cle-de-test" });
  assert.equal(r.html, GOOD);
  assert.deepEqual([r.mode, r.model], ["groq", PRIMARY]);
  const { url, body, headers } = calls[0];
  assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(headers.Authorization, "Bearer cle-de-test");
  assert.match(body.messages[0].content, /^You are Prism/);
  assert.match(body.messages[1].content, /<<<\nun compteur\n>>>/);
  assert.equal(body.reasoning_effort, "medium");
});

test("429, troncature, prose ou JS invalide : bascule vers le modèle suivant", async () => {
  const failures = {
    "quota 429": httpError(429),
    "réponse tronquée": completion(GOOD.slice(0, 90), "length"),
    "prose seule": completion("Désolé, je ne peux pas."),
    "JS invalide": completion(GOOD.replace("let n = 0;", "let n = ;")),
  };
  for (const [label, failure] of Object.entries(failures)) {
    const { engine, calls } = fakeGroq({ [PRIMARY]: failure, [SECONDARY]: completion(GOOD) });
    const r = await engine.generate("x", { key: "k" });
    assert.equal(r.model, SECONDARY, label);
    assert.equal(calls[1].body.reasoning_effort, undefined, `${label} : paramètre réservé à gpt-oss`);
  }
});

test("clé refusée : arrêt immédiat, sans essayer d'autre modèle", async () => {
  const { engine, calls } = fakeGroq({ [PRIMARY]: httpError(401), [SECONDARY]: completion(GOOD) });
  await assert.rejects(engine.generate("x", { key: "k" }), /401/);
  assert.equal(calls.length, 1);
});

test("tous les modèles en échec : message détaillé", async () => {
  const { engine } = fakeGroq({ [PRIMARY]: httpError(500), [SECONDARY]: completion("Non.") });
  await assert.rejects(engine.generate("x", { key: "k" }), /Tous les modèles ont échoué.*HTTP 500.*aucune balise HTML/);
});

test("fichier joint : résumé envoyé au modèle, gabarit CSV en démo", async () => {
  const file = { name: "ventes.csv", kind: "csv", summary: "Colonnes : mois (text), total (number)" };
  const { engine, calls } = fakeGroq({ [PRIMARY]: completion(GOOD) });
  await engine.generate("un graphique", { key: "k", file });
  assert.match(calls[0].body.messages[1].content, /ATTACHED FILE[\s\S]*kind: csv[\s\S]*Colonnes : mois/);
  assert.match(calls[0].body.messages[0].content, new RegExp(libs.chartjs.url.replace(/[.]/g, "\\.")));

  const demo = await fakeGroq({}).engine.generate("un graphique", { file });
  assert.equal(demo.model, "mock:csv-chart");
  assert.ok(demo.html.includes(`integrity="${libs.chartjs.integrity}"`));
});

test("refactorisation : code actuel et consigne envoyés, Chart.js ré-épinglé", async () => {
  const withOldChart = GOOD.replace("<head>", '<head><script src="https://cdn.jsdelivr.net/npm/chart.js@3"></script>')
    .replace("let n = 0;", "let n = 0; new Chart(document.body, {});");
  const { engine, calls } = fakeGroq({ [PRIMARY]: completion(withOldChart) });
  const r = await engine.generate("ajoute un graphique", { key: "k", baseHtml: GOOD });
  const message = calls[0].body.messages[1].content;
  assert.ok(message.includes("current source of an existing widget"));
  assert.ok(message.includes(GOOD));
  assert.ok(!r.html.includes("chart.js@3"));
  assert.equal(r.html.split(libs.chartjs.url).length - 1, 1);
});

test("refactorisation en mode démo : erreur explicite, aucun appel", async () => {
  const { engine, calls } = fakeGroq({});
  await assert.rejects(engine.generate("change la couleur", { baseHtml: GOOD }), (err) => err.code === "needs_key");
  assert.equal(calls.length, 0);
});

test("chaîne de modèles personnalisée", async () => {
  const { engine, calls } = fakeGroq({ "mon-modele": completion(GOOD) });
  const r = await engine.generate("x", { key: "k", models: ["mon-modele"] });
  assert.equal(r.model, "mon-modele");
  assert.equal(calls.length, 1);
});

test("annulation par l'utilisateur propagée telle quelle", async () => {
  const controller = new AbortController();
  const fetchImpl = (url, init) => {
    if (!init) return fileFetch(url);
    controller.abort();
    return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  };
  const engine = L.createLocalEngine({ baseUrl: "engine/", fetch: fetchImpl });
  await assert.rejects(engine.generate("x", { key: "k", signal: controller.signal }), { name: "AbortError" });
});
