/* Prism — moteur navigateur.
 *
 * Utilisé quand aucun backend ne répond (GitHub Pages, fichier ouvert seul) :
 *  - sans clé : mode démo, à partir des gabarits partagés frontend/engine/mocks/ ;
 *  - avec une clé Gemini fournie par l'utilisateur : appel direct à l'API Gemini
 *    (CORS autorisé par Google), même prompt système et même validation que le backend.
 * La clé n'est jamais envoyée ailleurs qu'à l'URL définie dans engine/gemini.json.
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

  /** Même construction que build_user_message() côté Python. */
  function buildUserMessage(prompt, file, baseHtml, t) {
    const fileBlock = file ? replaceAll(replaceAll(t.file, "{{kind}}", file.kind), "{{summary}}", file.summary) + "\n" : "";
    const template = baseHtml ? t.refactor : t.user;
    // {{html}} en dernier : le code existant ne doit pas être réinterprété comme gabarit.
    const message = replaceAll(replaceAll(template, "{{file}}", fileBlock), "{{prompt}}", prompt);
    return replaceAll(message, "{{html}}", baseHtml || "");
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

    async function callGemini(model, userMessage, key, ctx, signal) {
      const { cfg, system, libs } = ctx;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.max_output_tokens },
      };
      const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : null;
      const combined = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout || undefined;

      let res;
      try {
        // Clé dans un en-tête (autorisé par la CORS de Google), jamais dans l'URL.
        res = await fetchImpl(replaceAll(cfg.url, "{model}", encodeURIComponent(model)), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (err.name === "AbortError" && signal && signal.aborted) throw err;
        if (err.name === "TimeoutError") throw new Error(`${model}: délai dépassé (${TIMEOUT_MS / 1000}s)`);
        throw new Error(`${model}: erreur réseau`);
      }

      const text = await res.text().catch(() => "");
      if (res.status === 400 && text.includes("API_KEY_INVALID")) {
        throw fatal("Clé Gemini refusée (API_KEY_INVALID). Vérifiez-la dans les réglages du moteur.");
      }
      if (res.status === 401 || res.status === 403) throw fatal(`Accès Gemini refusé (HTTP ${res.status}).`);
      if (res.status === 402) throw fatal("Crédits Gemini épuisés (HTTP 402).");
      if (!res.ok) throw new Error(`${model}: HTTP ${res.status} — ${text.replace(/\s+/g, " ").slice(0, 200)}`);

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
      const raw = ((candidate.content && candidate.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");

      const cleaned = S.cleanLlmOutput(raw);
      if (!S.hasMarkup(cleaned)) throw new Error(`${model}: aucune balise HTML dans la réponse`);
      const html = S.normalizeLibraries(S.ensureDocument(cleaned), libs);
      const issues = S.validateDocument(html, allowedUrls(libs));
      const jsErrors = S.jsSyntaxErrors(html);
      if (jsErrors.length) issues.push("js_syntax");
      if (S.isBlocking(issues)) throw new Error(`${model}: document invalide (${issues.concat(jsErrors).join(", ")})`);
      return { html, warnings: issues };
    }

    /** Même contrat que POST /api/generate : { prompt, file?: {name, kind, summary}, baseHtml? }. */
    async function generate(prompt, { key = "", models = [], signal, file = null, baseHtml = null } = {}) {
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

      const [cfg, libs, system, user, fileTpl, refactor] = await Promise.all([
        load("gemini.json", "json"),
        load("libs.json", "json"),
        load("system-prompt.txt"),
        load("user-template.txt"),
        load("file-template.txt"),
        load("refactor-template.txt"),
      ]);
      const prompt0 = replaceAll(system.trim(), "{{chartjs_url}}", libs.chartjs.url);
      const ctx = { cfg, libs, system: replaceAll(prompt0, "{{tailwind_url}}", libs.tailwind.url) };
      const templates = { user: user.trim(), file: fileTpl.trim(), refactor: refactor.trim() };
      const userMessage = buildUserMessage(prompt, file, baseHtml, templates);
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

    return { generate, mock, defaults: () => load("gemini.json", "json"), libs: () => load("libs.json", "json") };
  }

  return { createLocalEngine, extractSeries, route, escapeHtml, buildUserMessage, allowedUrls };
});
