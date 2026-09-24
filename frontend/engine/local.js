/* Prism — moteur navigateur.
 *
 * Utilisé quand aucun backend ne répond (GitHub Pages, fichier ouvert seul) :
 *  - sans clé : mode démo, à partir des gabarits partagés frontend/engine/mocks/ ;
 *  - avec une clé Groq fournie par l'utilisateur : appel direct à api.groq.com
 *    (CORS autorisé par Groq), même prompt système et même validation que le backend.
 * La clé n'est jamais envoyée ailleurs qu'à l'URL définie dans engine/groq.json.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./sanitize.js"));
  else root.PrismLocal = factory(root.PrismSanitize);
})(typeof self !== "undefined" ? self : this, function (S) {
  "use strict";

  const TIMEOUT_MS = 90000;
  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  // JSON sûr dans un <script> : aucun « < » ne peut fermer la balise.
  const jsValue = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
  const normalize = (text) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const replaceAll = (text, token, value) => text.split(token).join(value);
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

  function route(prompt, spec) {
    const text = normalize(prompt);
    for (const r of spec.routes) {
      if (r.keywords.some((k) => text.includes(k))) return r.template;
    }
    return extractSeries(prompt, spec).length >= spec.series_min ? "dashboard" : spec.fallback;
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

    async function mock(prompt) {
      const spec = await load("mocks/manifest.json", "json");
      const name = route(prompt, spec);
      const marks = spec.placeholders;
      let html = (await load(`mocks/${name}.html`)).replace(/\n+$/, "");
      if (name === "dashboard") {
        const series = extractSeries(prompt, spec);
        const ownData = series.length >= spec.series_min;
        html = replaceAll(html, marks.data, jsValue(ownData ? series : spec.sample_series));
        html = replaceAll(html, marks.source, escapeHtml(spec.sources[ownData ? "user" : "sample"]));
      }
      return { html: replaceAll(html, marks.prompt, escapeHtml(prompt)), template: name };
    }

    function fatal(message) {
      const err = new Error(message);
      err.fatal = true;
      return err;
    }

    async function callGroq(model, prompt, key, ctx, signal) {
      const { cfg, system, userTemplate } = ctx;
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: replaceAll(userTemplate, "{{prompt}}", prompt) },
        ],
        temperature: cfg.temperature,
        max_completion_tokens: cfg.max_completion_tokens,
      };
      if (model.startsWith(cfg.reasoning_models_prefix)) body.reasoning_effort = cfg.reasoning_effort;

      const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : null;
      const combined = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout || undefined;

      let res;
      try {
        res = await fetchImpl(cfg.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (err.name === "AbortError" && signal && signal.aborted) throw err;
        if (err.name === "TimeoutError") throw new Error(`${model}: délai dépassé (${TIMEOUT_MS / 1000}s)`);
        throw new Error(`${model}: erreur réseau`);
      }

      if (res.status === 401) throw fatal("Clé Groq refusée (401). Vérifiez-la dans les réglages du moteur.");
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
        throw new Error(`${model}: HTTP ${res.status} — ${detail}`);
      }

      let choice;
      try {
        choice = (await res.json()).choices[0];
      } catch {
        throw new Error(`${model}: réponse Groq illisible`);
      }
      if (choice.finish_reason === "length") {
        throw new Error(`${model}: réponse tronquée (max_completion_tokens=${cfg.max_completion_tokens})`);
      }

      const cleaned = S.cleanLlmOutput((choice.message && choice.message.content) || "");
      if (!S.hasMarkup(cleaned)) throw new Error(`${model}: aucune balise HTML dans la réponse`);
      const html = S.ensureDocument(cleaned);
      const issues = S.validateDocument(html);
      const jsErrors = S.jsSyntaxErrors(html);
      if (jsErrors.length) issues.push("js_syntax");
      if (S.isBlocking(issues)) throw new Error(`${model}: document invalide (${issues.concat(jsErrors).join(", ")})`);
      return { html, warnings: issues };
    }

    /** Même contrat de réponse que POST /api/generate. */
    async function generate(prompt, { key = "", models = [], signal } = {}) {
      const started = now();
      const elapsed = () => Math.round(now() - started);

      if (!key) {
        const { html, template } = await mock(prompt);
        return { html, mode: "mock", model: `mock:${template}`, elapsed_ms: elapsed(), warnings: S.validateDocument(html) };
      }

      const [cfg, system, userTemplate] = await Promise.all([
        load("groq.json", "json"),
        load("system-prompt.txt"),
        load("user-template.txt"),
      ]);
      const ctx = { cfg, system: system.trim(), userTemplate: userTemplate.trim() };
      const errors = [];
      for (const model of models.length ? models : cfg.models) {
        try {
          const { html, warnings } = await callGroq(model, prompt, key, ctx, signal);
          return { html, mode: "groq", model, elapsed_ms: elapsed(), warnings };
        } catch (err) {
          if (err.fatal || (err.name === "AbortError" && signal && signal.aborted)) throw err;
          errors.push(err.message);
        }
      }
      throw new Error(`Tous les modèles ont échoué : ${errors.join(" | ")}`);
    }

    return { generate, mock, defaults: () => load("groq.json", "json") };
  }

  return { createLocalEngine, extractSeries, route, escapeHtml };
});
