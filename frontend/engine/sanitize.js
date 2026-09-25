/* Prism — nettoyage et validation de la sortie LLM, côté navigateur.
 *
 * Portage fidèle de backend/sanitize.py, pour le moteur navigateur (GitHub Pages).
 * La parité est vérifiée par frontend/tests/fixtures.json, rejoué par les tests
 * Python (backend/tests/test_parity.py) et Node (frontend/tests/engine.test.cjs).
 * Script classique (pas de module ES) : fonctionne aussi hors serveur.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrismSanitize = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FENCE_RE = /```[\w+-]*[ \t]*\n?([\s\S]*?)```/g;
  const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
  const DOC_START_RE = /<!doctype\s+html|<html[\s>]/i;
  const TAG_START_RE = /<[a-zA-Z!]/;
  const EXTERNAL_RE = /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i;
  // localStorage n'y figure plus : la sandbox fournit un stockage persistant par widget.
  const SANDBOX_APIS = {
    sessionStorage: /\bsessionStorage\b/,
    "document.cookie": /\bdocument\.cookie\b/,
    "fetch()": /\bfetch\s*\(/,
  };
  const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  const JS_TYPES = new Set(["text/javascript", "application/javascript"]);
  const BLOCKING_ISSUES = new Set([
    "empty_document",
    "markdown_fence",
    "missing_closing_html",
    "unbalanced_<script>",
    "js_syntax",
  ]);

  function lastMatchEnd(text, re) {
    let end = -1;
    for (const m of text.matchAll(re)) end = m.index + m[0].length;
    return end;
  }

  /** Extrait le document HTML brut d'une réponse de modèle. */
  function cleanLlmOutput(raw) {
    let text = String(raw || "").replace(/^\uFEFF+/, "").trim();
    text = text.replace(THINK_RE, "").trim();

    const fences = [...text.matchAll(FENCE_RE)].map((m) => m[1]);
    if (fences.length) {
      // Plusieurs blocs possibles : on garde le plus gros qui contient du HTML.
      const rank = (block) => (block.includes("<") ? 1e9 : 0) + block.length;
      text = fences.reduce((best, block) => (rank(block) > rank(best) ? block : best)).trim();
    } else {
      // Bloc non refermé (réponse tronquée) ou fence orpheline.
      text = text.replace(/^```[\w+-]*[ \t]*\n?/, "").replace(/\n?```\s*$/, "").trim();
    }

    let start = text.search(DOC_START_RE);
    if (start === -1) start = text.search(TAG_START_RE);
    if (start > 0) text = text.slice(start);

    const htmlEnd = lastMatchEnd(text, /<\/html>/gi);
    if (htmlEnd !== -1) {
      text = text.slice(0, htmlEnd);
    } else {
      const lastTag = text.lastIndexOf(">");
      if (lastTag !== -1) text = text.slice(0, lastTag + 1);
    }
    return text.trim();
  }

  /** Faux pour une réponse en prose pure (refus, explication…) : rien à rendre. */
  function hasMarkup(text) {
    return TAG_START_RE.test(text);
  }

  /** Enveloppe un fragment dans un document HTML5 complet si nécessaire. */
  function ensureDocument(html, lang = "fr") {
    if (!/<html[\s>]/i.test(html)) {
      return (
        "<!DOCTYPE html>\n" +
        `<html lang="${lang}">\n<head>\n<meta charset="utf-8">\n` +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        "<title>Prism</title>\n</head>\n<body>\n" +
        `${html}\n</body>\n</html>`
      );
    }
    if (!/^\s*<!doctype\s+html/i.test(html)) html = "<!DOCTYPE html>\n" + html.replace(/^\s+/, "");
    return html;
  }

  const EMPTY_SCRIPT_RE = /<script\b([^>]*)>\s*<\/script\s*>/gi;
  const SRC_ATTR_RE = /\bsrc\s*=\s*(["']?)([^"'\s>]+)\1/i;

  function insertInHead(html, tag) {
    const head = /<head(?:\s[^>]*)?>/i.exec(html);
    if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
    const root = /<html(?:\s[^>]*)?>/i.exec(html);
    if (root) {
      const at = root.index + root[0].length;
      return html.slice(0, at) + "<head>" + tag + "</head>" + html.slice(at);
    }
    return tag + html;
  }

  /** Remplace toute balise d'une bibliothèque autorisée par sa version épinglée avec SRI (règles : libs.json). Idempotent. */
  function normalizeLibraries(html, libs) {
    for (const name of Object.keys(libs)) {
      if (name.startsWith("_")) continue;
      const lib = libs[name];
      const srcRe = new RegExp(lib.match, "i");
      let found = false;
      html = html.replace(EMPTY_SCRIPT_RE, (whole, attrs) => {
        const src = SRC_ATTR_RE.exec(attrs);
        if (src && srcRe.test(src[2])) {
          found = true;
          return "";
        }
        return whole;
      });
      const used = (html.match(new RegExp(lib.uses, "g")) || []).length >= lib.min_uses;
      if ((found && lib.keep_if_tag) || used) {
        html = insertInHead(html, `<script src="${lib.url}" integrity="${lib.integrity}" crossorigin="anonymous"></script>`);
      }
    }
    return html;
  }

  /** Compte ouvertures/fermetures d'un élément à contenu brut (script, style), comme HTMLParser. */
  function rawTextBalance(html, tag) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    const close = new RegExp(`</${tag}\\s*>`, "gi");
    let opened = 0;
    let closed = 0;
    let pos = 0;
    for (;;) {
      open.lastIndex = pos;
      const o = open.exec(html);
      if (!o) break;
      opened += 1;
      close.lastIndex = o.index + o[0].length;
      const c = close.exec(html);
      if (!c) break;
      closed += 1;
      pos = c.index + c[0].length;
    }
    return opened === closed;
  }

  function stripRawText(html) {
    return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  }

  function tagBalance(markup, tag) {
    const opened = (markup.match(new RegExp(`<${tag}(?=[\\s/>])`, "gi")) || []).length;
    const closed = (markup.match(new RegExp(`</${tag}\\s*>`, "gi")) || []).length;
    return opened === closed;
  }

  /** Liste des problèmes détectés (vide = document propre). allowedUrls : bibliothèques épinglées. */
  function validateDocument(html, allowedUrls = []) {
    const issues = [];
    if (!String(html).trim()) return ["empty_document"];
    if (html.includes("```")) issues.push("markdown_fence");
    if (!/^\s*<!doctype\s+html/i.test(html)) issues.push("missing_doctype");
    if (!/<\/html>/i.test(html)) issues.push("missing_closing_html");

    const markup = stripRawText(html);
    for (const tag of ["html", "head", "body"]) {
      if (!tagBalance(markup, tag)) issues.push(`unbalanced_<${tag}>`);
    }
    for (const tag of ["script", "style"]) {
      if (!rawTextBalance(html, tag)) issues.push(`unbalanced_<${tag}>`);
    }

    const checked = allowedUrls.reduce((text, url) => text.split(url).join(""), html);
    if (EXTERNAL_RE.test(checked)) issues.push("external_resource");
    for (const [name, pattern] of Object.entries(SANDBOX_APIS)) {
      if (pattern.test(html)) issues.push(`sandbox_api:${name}`);
    }
    return issues;
  }

  /** Contenu des <script> inline exécutables (ignore src=, JSON, templates…). */
  function inlineScripts(html) {
    const sources = [];
    for (const [, attrs, body] of html.matchAll(SCRIPT_RE)) {
      if (/\bsrc\s*=/i.test(attrs)) continue;
      const declared = /\btype\s*=\s*["']?([\w/+.-]+)/i.exec(attrs);
      if (declared && !JS_TYPES.has(declared[1].toLowerCase())) continue;
      if (body.trim()) sources.push(body);
    }
    return sources;
  }

  /** Erreurs de syntaxe : new Function() analyse le code sans jamais l'exécuter. */
  function jsSyntaxErrors(html) {
    const errors = [];
    inlineScripts(html).forEach((source, i) => {
      try {
        // eslint-disable-next-line no-new-func
        new Function(source);
      } catch (err) {
        if (err instanceof SyntaxError) errors.push(`script #${i + 1}: ${err.message}`);
      }
    });
    return errors;
  }

  function isBlocking(issues) {
    return issues.some((issue) => BLOCKING_ISSUES.has(issue));
  }

  return {
    cleanLlmOutput,
    hasMarkup,
    ensureDocument,
    normalizeLibraries,
    validateDocument,
    inlineScripts,
    jsSyntaxErrors,
    isBlocking,
    BLOCKING_ISSUES,
  };
});
