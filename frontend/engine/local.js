/* Prism — moteur navigateur.
 *
 * Utilisé quand aucun backend ne répond (GitHub Pages, fichier ouvert seul) :
 *  - sans clé : mode démo, à partir des gabarits partagés frontend/engine/mocks/ ;
 *  - avec une clé Gemini fournie par l'utilisateur : appel direct à l'API Gemini
 *    (CORS autorisé par Google), même prompt système et même validation que le backend.
 * La clé n'est jamais envoyée ailleurs qu'à l'URL définie dans engine/gemini.json.
 * Engramme cognitif (V4) : même schéma, même prompt et même validation que backend/engram.py.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./sanitize.js"), require("./engram/engram.js"));
  else root.PrismLocal = factory(root.PrismSanitize, root.PrismEngram);
})(typeof self !== "undefined" ? self : this, function (S, E) {
  "use strict";

  const TIMEOUT_MS = 90000;
  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  // JSON sûr dans un <script> : aucun « < » ne peut fermer la balise.
  const jsValue = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
  const normalize = (text) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const replaceAll = (text, token, value) => text.split(token).join(value);
  const allowedUrls = (libs) => Object.keys(libs).filter((k) => !k.startsWith("_")).map((k) => libs[k].url);
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  function extractSeries(prompt, spec) {
    const series = [];
    for (const m of prompt.matchAll(new RegExp(spec.series_pattern, "g"))) {
      const label = m[1].replace(/^[ '’-]+|[ '’-]+$/g, "");
      if (label && series.length < spec.series_max) {
        series.push({ label: label.slice(0, spec.label_max), value: parseFloat(m[2].replace(",", ".")) });
      }
    }
    return series;
  }

  function route(prompt, spec, fileKind) {
    if (fileKind && spec.file_routes[fileKind]) return spec.file_routes[fileKind];
    const text = normalize(prompt);
    for (const r of spec.routes) {
      if (r.keywords.some((k) => text.includes(k))) return r.template;
    }
    return extractSeries(prompt, spec).length >= spec.series_min ? "dashboard" : spec.fallback;
  }

  /** Section CANVAS (autres widgets et sujets du bus) : même texte que canvas_block() côté Python. */
  function buildCanvasBlock(canvas, template) {
    const lines = [];
    for (const w of canvas || []) {
      const emits = w.emits || [];
      const listens = w.listens || [];
      if (!emits.length && !listens.length) continue;
      const samples = w.samples || {};
      const parts = [];
      if (emits.length) parts.push("emits " + emits.map((t) => (samples[t] ? `${t} (e.g. ${samples[t]})` : t)).join(", "));
      if (listens.length) parts.push("listens to " + listens.join(", "));
      lines.push(`- ${JSON.stringify(w.title)}: ${parts.join("; ")}`);
    }
    return lines.length ? replaceAll(template, "{{widgets}}", lines.join("\n")) + "\n" : "";
  }

  /** Section FILTRE ADN (trait d'Engramme) : même texte que dna_block() côté Python. */
  function buildDnaBlock(dna, template) {
    if (!dna || !template) return "";
    let extras = "";
    if (dna.palette && dna.palette.length) extras += `Palette to use: ${dna.palette.join(", ")}.\n`;
    if (dna.keywords && dna.keywords.length) extras += `Vocabulary to weave into the texts: ${dna.keywords.join(", ")}.\n`;
    const values = {
      person: dna.person, category: dna.category, type: dna.type, title: dna.title,
      content: dna.content || "-", directive: dna.directive, extras,
    };
    return template.replace(/\{\{(person|category|type|title|content|directive|extras)\}\}/g, (_, key) => values[key]) + "\n";
  }

  /** Même construction que build_user_message() côté Python. */
  function buildUserMessage(prompt, file, baseHtml, t, canvas = null, dna = null) {
    const fileBlock = file ? replaceAll(replaceAll(t.file, "{{kind}}", file.kind), "{{summary}}", file.summary) + "\n" : "";
    const template = baseHtml ? t.refactor : t.user;
    const values = {
      file: fileBlock, canvas: buildCanvasBlock(canvas, t.canvas || ""), dna: baseHtml ? "" : buildDnaBlock(dna, t.dna || ""),
      prompt, html: baseHtml || "",
    };
    // Une seule passe : rien de ce qui est inséré (code, demande, titres…) n'est réinterprété comme gabarit.
    return template.replace(/\{\{(file|canvas|dna|prompt|html)\}\}/g, (_, key) => values[key]);
  }

  function createLocalEngine(options = {}) {
    const base = options.baseUrl || "engine/";
    const fetchImpl = options.fetch || ((...args) => fetch(...args));
    const cache = new Map();

    function load(path, kind = "text") {
      const key = `${kind}:${path}`;
      if (!cache.has(key)) {
        const pending = fetchImpl(base + path)
          .then((res) => {
            if (!res.ok) throw new Error(`${path} introuvable (HTTP ${res.status})`);
            return kind === "json" ? res.json() : res.text();
          })
          .catch((err) => {
            cache.delete(key);
            throw err;
          });
        cache.set(key, pending);
      }
      return cache.get(key);
    }

    async function mock(prompt, fileKind) {
      const [spec, libs] = await Promise.all([load("mocks/manifest.json", "json"), load("libs.json", "json")]);
      const name = route(prompt, spec, fileKind);
      const marks = spec.placeholders;
      let html = (await load(`mocks/${name}.html`)).replace(/\n+$/, "");
      if (name === "dashboard") {
        const series = extractSeries(prompt, spec);
        const ownData = series.length >= spec.series_min;
        html = replaceAll(html, marks.data, jsValue(ownData ? series : spec.sample_series));
        html = replaceAll(html, marks.source, escapeHtml(spec.sources[ownData ? "user" : "sample"]));
      }
      html = replaceAll(html, marks.prompt, escapeHtml(prompt));
      return { html: S.normalizeLibraries(html, libs), template: name };
    }

    function fatal(message) {
      const err = new Error(message);
      err.fatal = true;
      return err;
    }

    // Raisons de fin Gemini qui signifient « pas de document exploitable » (mêmes règles que providers.py).
    const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE", "OTHER"]);

    /** Message d'erreur de Google (champ error.message du JSON s'il existe), sur une ligne : même règle que _detail(). */
    function detail(text) {
      let message = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error && parsed.error.message !== undefined) message = String(parsed.error.message);
      } catch { /* texte brut */ }
      return message.replace(/\s+/g, " ").trim().slice(0, 300);
    }

    /** Attente annulable (nouvelle tentative après une surcharge). */
    function pause(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(signal.reason || new DOMException("Opération annulée", "AbortError"));
        const timer = setTimeout(resolve, ms);
        if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new DOMException("Opération annulée", "AbortError")); }, { once: true });
      });
    }

    async function post(url, model, body, key, signal) {
      const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : null;
      const combined = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout || undefined;
      try {
        // Clé dans un en-tête (autorisé par la CORS de Google), jamais dans l'URL.
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: combined,
        });
        return { res, text: await res.text().catch(() => "") };
      } catch (err) {
        if (err.name === "AbortError" && signal && signal.aborted) throw err;
        if (err.name === "TimeoutError") throw new Error(`${model}: délai dépassé (${TIMEOUT_MS / 1000}s)`);
        throw new Error(`${model}: erreur réseau`);
      }
    }

    const retryDelayMs = options.retryDelayMs == null ? 2000 : options.retryDelayMs;
    let turn = 0; // tourniquet des clés : chaque appel commence par la suivante (quota réparti)

    /** Clés à tour de rôle (mêmes règles que _gemini_post() dans providers.py) : clé refusée ou quota
     *  atteint (429) → clé suivante ; surcharge passagère (500/503) → une nouvelle tentative. */
    async function postWithKeys(url, model, body, keys, signal) {
      const list = String(keys || "").split(",").map((k) => k.trim()).filter(Boolean);
      const start = list.length ? turn++ % list.length : 0;
      const order = list.slice(start).concat(list.slice(0, start));
      const refused = [];
      const exhausted = [];
      for (let i = 0; i < order.length; i++) {
        let reply = await post(url, model, body, order[i], signal);
        if (reply.res.status === 500 || reply.res.status === 503) {
          await pause(retryDelayMs, signal);
          reply = await post(url, model, body, order[i], signal);
        }
        const { res, text } = reply;
        const index = list.indexOf(order[i]) + 1;
        if (res.status === 400 && text.includes("API_KEY_INVALID")) refused.push(`clé n°${index} refusée (API_KEY_INVALID)`);
        else if (res.status === 401 || res.status === 403) refused.push(`clé n°${index} : accès refusé (HTTP ${res.status})`);
        else if (res.status === 429) exhausted.push(`clé n°${index}`);
        else return reply;
      }
      if (exhausted.length) {
        throw new Error(`${model}: quota atteint (HTTP 429) — ${exhausted.join(", ")}${refused.length ? ` ; ${refused.join(" ; ")}` : ""}`);
      }
      throw fatal(`Clé Gemini refusée : ${refused.join(" ; ")}. Vérifiez-la dans les réglages du moteur.`);
    }

    /** Appel generateContent : texte du modèle (sans les parties « thought »), mêmes règles que providers.py.
     *  key : une clé ou plusieurs séparées par des virgules. schema : réponse JSON imposée ; un HTTP 400
     *  lève alors SchemaRejected (réessayer en JSON simple). */
    async function requestGemini(model, system, userMessage, key, cfg, signal, { json = false, schema = null } = {}) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.max_output_tokens },
      };
      if (json || schema) body.generationConfig.responseMimeType = "application/json";
      if (schema) body.generationConfig.responseSchema = schema;
      const url = replaceAll(cfg.url, "{model}", encodeURIComponent(model));
      const { res, text } = await postWithKeys(url, model, body, key, signal);
      if (res.status === 402) throw fatal("Crédits Gemini épuisés (HTTP 402).");
      if (res.status === 400 && schema) {
        const err = new Error(`${model}: schéma de réponse refusé — ${detail(text)}`);
        err.name = "SchemaRejected";
        throw err;
      }
      if (!res.ok) throw new Error(`${model}: HTTP ${res.status} — ${detail(text)}`);

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`${model}: réponse illisible`);
      }
      const blocked = data.promptFeedback && data.promptFeedback.blockReason;
      if (blocked) throw new Error(`${model}: demande bloquée (${blocked})`);
      const candidate = (data.candidates || [])[0];
      if (!candidate) throw new Error(`${model}: aucune réponse`);
      if (candidate.finishReason === "MAX_TOKENS") {
        throw new Error(`${model}: réponse tronquée (maxOutputTokens=${cfg.max_output_tokens})`);
      }
      if (BLOCKED.has(candidate.finishReason)) throw new Error(`${model}: réponse interrompue (${candidate.finishReason})`);
      // Les parties « thought » sont la réflexion du modèle, pas le document.
      return ((candidate.content && candidate.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    }

    async function callGemini(model, userMessage, key, ctx, signal) {
      const { cfg, system, libs } = ctx;
      const raw = await requestGemini(model, system, userMessage, key, cfg, signal);
      const cleaned = S.cleanLlmOutput(raw);
      if (!S.hasMarkup(cleaned)) throw new Error(`${model}: aucune balise HTML dans la réponse`);
      const html = S.normalizeLibraries(S.ensureDocument(cleaned), libs);
      const issues = S.validateDocument(html, allowedUrls(libs));
      const jsErrors = S.jsSyntaxErrors(html);
      if (jsErrors.length) issues.push("js_syntax");
      if (S.isBlocking(issues)) throw new Error(`${model}: document invalide (${issues.concat(jsErrors).join(", ")})`);
      return { html, warnings: issues };
    }

    /** Même contrat que POST /api/generate : { prompt, file?: {name, kind, summary}, baseHtml?, canvas? }. */
    async function generate(prompt, { key = "", models = [], signal, file = null, baseHtml = null, canvas = null, dna = null } = {}) {
      const started = now();
      const elapsed = () => Math.round(now() - started);

      if (!key) {
        if (baseHtml) {
          const err = new Error("La refactorisation a besoin d'un modèle : ajoutez votre clé Gemini (mode démo actif).");
          err.code = "needs_key";
          throw err;
        }
        const [{ html, template }, libs] = await Promise.all([mock(prompt, file && file.kind), load("libs.json", "json")]);
        return { html, mode: "mock", model: `mock:${template}`, elapsed_ms: elapsed(), warnings: S.validateDocument(html, allowedUrls(libs)) };
      }

      const [cfg, libs, system, user, fileTpl, refactor, canvasTpl, dnaTpl] = await Promise.all([
        load("gemini.json", "json"),
        load("libs.json", "json"),
        load("system-prompt.txt"),
        load("user-template.txt"),
        load("file-template.txt"),
        load("refactor-template.txt"),
        load("canvas-template.txt"),
        load("dna-template.txt"),
      ]);
      const prompt0 = replaceAll(system.trim(), "{{chartjs_url}}", libs.chartjs.url);
      const ctx = { cfg, libs, system: replaceAll(prompt0, "{{tailwind_url}}", libs.tailwind.url) };
      const templates = { user: user.trim(), file: fileTpl.trim(), refactor: refactor.trim(), canvas: canvasTpl.trim(), dna: dnaTpl.trim() };
      const userMessage = buildUserMessage(prompt, file, baseHtml, templates, canvas, dna);
      const errors = [];
      for (const model of models.length ? models : cfg.models) {
        try {
          const { html, warnings } = await callGemini(model, userMessage, key, ctx, signal);
          return { html, mode: "gemini", model, elapsed_ms: elapsed(), warnings };
        } catch (err) {
          if (err.fatal || (err.name === "AbortError" && signal && signal.aborted)) throw err;
          errors.push(err.message);
        }
      }
      throw new Error(`Tous les modèles ont échoué : ${errors.join(" | ")}`);
    }

    /** Même contrat que POST /api/engram : { engram, mode, model }. Sans clé : l'Engramme de démonstration. */
    async function engram(person, { key = "", models = [], language = "fr", signal } = {}) {
      if (!key) {
        return { engram: E.normalize(await load("engram/demo-marie-curie.json", "json")), mode: "mock", model: "mock:engram-marie-curie" };
      }
      const [cfg, schema, system, template] = await Promise.all([
        load("gemini.json", "json"),
        load("engram/schema.json", "json"),
        load("engram/system-prompt.txt"),
        load("engram/user-template.txt"),
      ]);
      const userMessage = E.buildUserMessage(template, person, language);
      const errors = [];
      // Schéma imposé d'abord ; si chaque modèle le refuse, JSON simple (le prompt décrit la structure).
      for (const withSchema of [true, false]) {
        let rejectedAll = true;
        for (const model of models.length ? models : cfg.models) {
          try {
            const text = await requestGemini(model, system.trim(), userMessage, key, cfg, signal, { json: true, schema: withSchema ? schema : null });
            return { engram: E.normalize(E.parse(text)), mode: "gemini", model };
          } catch (err) {
            if (err.fatal || err.name === "EngramRefused" || (err.name === "AbortError" && signal && signal.aborted)) throw err;
            errors.push(err.name === "EngramError" ? `${model}: ${err.message}` : err.message);
            if (err.name !== "SchemaRejected") rejectedAll = false;
          }
        }
        if (!rejectedAll) break;
      }
      throw new Error(`Engramme impossible : ${errors.slice(-6).join(" | ")}`);
    }

    return { generate, mock, engram, defaults: () => load("gemini.json", "json"), libs: () => load("libs.json", "json") };
  }

  return { createLocalEngine, extractSeries, route, escapeHtml, buildUserMessage, buildCanvasBlock, buildDnaBlock, allowedUrls };
});
