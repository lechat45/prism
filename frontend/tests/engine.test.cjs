// Tests du moteur navigateur (GitHub Pages).  Lancement : node --test frontend/tests/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../engine/local.js");
const { runFixtures, fixtures, fileFetch, libs } = require("./run_fixtures.cjs");

const GOOD =
  '<!DOCTYPE html>\n<html><head><style>b{}</style></head><body><button id="b">0</button>' +
  '<script>let n = 0; document.getElementById("b").onclick = () => { n++; };</script></body></html>';
const PRIMARY = "gemini-3.8-flash";
const SECONDARY = "gemini-3.6-flash";

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
    assert.equal(got.split(libs.tailwind.url).length - 1, c.tailwind || 0, `${c.name} (Tailwind)`);
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
// Appels Gemini depuis le navigateur (faux serveur)
// --------------------------------------------------------------------------
function gemini(text, finish = "STOP", thought = null) {
  const parts = (thought ? [{ text: thought, thought: true }] : []).concat([{ text }]);
  const body = JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: finish }] });
  return { ok: true, status: 200, text: async () => body };
}
const httpError = (status, text = `erreur ${status}`) => ({ ok: false, status, text: async () => text });
const INVALID_KEY = httpError(400, JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }));

function fakeGemini(responses) {
  const calls = [];
  const fetchImpl = (url, init) => {
    if (!init) return fileFetch(url); // fichiers du moteur (prompt, gemini.json…)
    const model = decodeURIComponent(url.split("/models/")[1].split(":")[0]);
    calls.push({ url, model, body: JSON.parse(init.body), headers: init.headers });
    const answer = responses[model];
    // Tableau : une réponse par appel (la dernière se répète) ; sinon, la même réponse à chaque appel.
    return Promise.resolve((Array.isArray(answer) ? (answer.length > 1 ? answer.shift() : answer[0]) : answer) || httpError(404, "modèle inconnu"));
  };
  return { engine: L.createLocalEngine({ baseUrl: "engine/", fetch: fetchImpl, retryDelayMs: 0 }), calls };
}

test("sans clé : mode démo depuis les gabarits partagés", async () => {
  const { engine, calls } = fakeGemini({});
  const r = await engine.generate(fixtures.routing[0].prompt);
  assert.equal(r.mode, "mock");
  assert.equal(r.model, "mock:counter");
  assert.ok(r.html.startsWith("<!DOCTYPE html>"));
  assert.equal(calls.length, 0);
});

test("format d'appel Gemini, réflexion écartée, Markdown nettoyé, design system Tailwind", async () => {
  const withCdn = GOOD.replace("<head>", '<head><script src="https://cdn.tailwindcss.com"></script>');
  const fence = "```";
  const { engine, calls } = fakeGemini({ [PRIMARY]: gemini(`Voici :\n${fence}html\n${withCdn}\n${fence}`, "STOP", "je réfléchis") });
  const r = await engine.generate("un compteur", { key: "cle-de-test" });
  assert.deepEqual([r.mode, r.model], ["gemini", PRIMARY]);
  const { url, body, headers } = calls[0];
  assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${PRIMARY}:generateContent`);
  assert.equal(headers["x-goog-api-key"], "cle-de-test");
  assert.ok(!url.includes("cle-de-test"), "la clé ne passe jamais dans l'URL");
  const system = body.systemInstruction.parts[0].text;
  assert.match(system, /^You are Prism/);
  assert.match(system, /Tu es un designer Apple\/Vercel/);
  assert.ok(system.includes(libs.tailwind.url) && !system.includes("{{"));
  assert.ok(body.contents[0].parts[0].text.includes("<<<\nun compteur\n>>>"));
  assert.ok(!r.html.includes("je réfléchis"));
  assert.ok(!r.html.includes("cdn.tailwindcss.com"));
  assert.equal(r.html.split(libs.tailwind.url).length - 1, 1);
  assert.ok(r.html.includes(`integrity="${libs.tailwind.integrity}"`));
});

test("quota, modèle retiré, troncature, blocage, prose ou JS invalide : modèle suivant", async () => {
  const failures = {
    "quota 429": httpError(429),
    "modèle retiré 404": httpError(404),
    "réponse tronquée": gemini(GOOD.slice(0, 90), "MAX_TOKENS"),
    "sécurité": gemini("", "SAFETY"),
    "demande bloquée": { ok: true, status: 200, text: async () => JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }) },
    "prose seule": gemini("Désolé, je ne peux pas."),
    "JS invalide": gemini(GOOD.replace("let n = 0;", "let n = ;")),
  };
  for (const [label, failure] of Object.entries(failures)) {
    const { engine, calls } = fakeGemini({ [PRIMARY]: failure, [SECONDARY]: gemini(GOOD) });
    const r = await engine.generate("x", { key: "k" });
    assert.equal(r.model, SECONDARY, label);
    assert.deepEqual(calls.map((c) => c.model), [PRIMARY, SECONDARY], label);
  }
});

test("clé refusée (400 API_KEY_INVALID) : arrêt immédiat, sans essayer d'autre modèle", async () => {
  const { engine, calls } = fakeGemini({ [PRIMARY]: INVALID_KEY, [SECONDARY]: gemini(GOOD) });
  await assert.rejects(engine.generate("x", { key: "k" }), /Clé Gemini refusée/);
  assert.equal(calls.length, 1);
});

test("surcharge passagère (503) : une nouvelle tentative sur le même modèle", async () => {
  const { engine, calls } = fakeGemini({ [PRIMARY]: [httpError(503), gemini(GOOD)] });
  const r = await engine.generate("x", { key: "k" });
  assert.equal(r.model, PRIMARY);
  assert.deepEqual(calls.map((c) => c.model), [PRIMARY, PRIMARY]);
});

test("plusieurs clés : quota ou clé refusée → clé suivante, même modèle ; tourniquet entre les appels", async () => {
  const { engine, calls } = fakeGemini({ [PRIMARY]: [httpError(429), INVALID_KEY, gemini(GOOD)] });
  const r = await engine.generate("x", { key: "cle-a, cle-b ,cle-c" });
  assert.equal(r.model, PRIMARY);
  assert.deepEqual(calls.map((c) => c.headers["x-goog-api-key"]).sort(), ["cle-a", "cle-b", "cle-c"]);

  const turns = fakeGemini({ [PRIMARY]: gemini(GOOD) });
  for (let i = 0; i < 3; i++) await turns.engine.generate("x", { key: "cle-a,cle-b,cle-c" });
  assert.deepEqual(turns.calls.map((c) => c.headers["x-goog-api-key"]).sort(), ["cle-a", "cle-b", "cle-c"], "quota réparti");
});

test("plusieurs clés : toutes au quota → modèle suivant ; toutes refusées → arrêt", async () => {
  const quota = fakeGemini({ [PRIMARY]: httpError(429), [SECONDARY]: gemini(GOOD) });
  assert.equal((await quota.engine.generate("x", { key: "a,b" })).model, SECONDARY);
  assert.deepEqual(quota.calls.map((c) => c.model), [PRIMARY, PRIMARY, SECONDARY]);

  const refused = fakeGemini({ [PRIMARY]: INVALID_KEY, [SECONDARY]: gemini(GOOD) });
  await assert.rejects(refused.engine.generate("x", { key: "cle-a,cle-b" }), (err) => /Clé Gemini refusée/.test(err.message) && !err.message.includes("cle-a"));
  assert.equal(refused.calls.length, 2);
});

test("tous les modèles en échec : message détaillé", async () => {
  const { engine } = fakeGemini({ [PRIMARY]: httpError(500), [SECONDARY]: gemini("Non.") });
  await assert.rejects(engine.generate("x", { key: "k" }), /Tous les modèles ont échoué.*HTTP 500.*aucune balise HTML/);
});

test("fichier joint : résumé envoyé au modèle, gabarit CSV en démo", async () => {
  const file = { name: "ventes.csv", kind: "csv", summary: "Colonnes : mois (text), total (number)" };
  const { engine, calls } = fakeGemini({ [PRIMARY]: gemini(GOOD) });
  await engine.generate("un graphique", { key: "k", file });
  assert.match(calls[0].body.contents[0].parts[0].text, /ATTACHED FILE[\s\S]*kind: csv[\s\S]*Colonnes : mois/);
  assert.ok(calls[0].body.systemInstruction.parts[0].text.includes(libs.chartjs.url));

  const demo = await fakeGemini({}).engine.generate("un graphique", { file });
  assert.equal(demo.model, "mock:csv-chart");
  assert.ok(demo.html.includes(`integrity="${libs.chartjs.integrity}"`));
});

test("refactorisation : code actuel et consigne envoyés, Chart.js ré-épinglé", async () => {
  const withOldChart = GOOD.replace("<head>", '<head><script src="https://cdn.jsdelivr.net/npm/chart.js@3"></script>')
    .replace("let n = 0;", "let n = 0; new Chart(document.body, {});");
  const { engine, calls } = fakeGemini({ [PRIMARY]: gemini(withOldChart) });
  const r = await engine.generate("ajoute un graphique", { key: "k", baseHtml: GOOD });
  const message = calls[0].body.contents[0].parts[0].text;
  assert.ok(message.includes("current source of an existing widget"));
  assert.ok(message.includes(GOOD));
  assert.ok(!r.html.includes("chart.js@3"));
  assert.equal(r.html.split(libs.chartjs.url).length - 1, 1);
});

test("refactorisation en mode démo : erreur explicite, aucun appel", async () => {
  const { engine, calls } = fakeGemini({});
  await assert.rejects(engine.generate("change la couleur", { baseHtml: GOOD }), (err) => err.code === "needs_key");
  assert.equal(calls.length, 0);
});

test("chaîne de modèles personnalisée", async () => {
  const { engine, calls } = fakeGemini({ "mon-modele": gemini(GOOD) });
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
