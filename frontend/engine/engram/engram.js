/* Prism V4 — Engramme cognitif : validation et document de la carte, partagés par la page, le
 * Web Worker (moteur navigateur) et les tests Node.
 *
 * normalize() est la réplique exacte de backend/engram.py (parité vérifiée par
 * backend/tests/test_parity.py) : même tri, mêmes coupes, mêmes refus.
 * buildViewer() assemble le document autonome d'une carte Engramme : gabarit viewer.html, moteur
 * physique (physics.js) et données, inscrites en JSON inerte (<script type="application/json">).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrismEngram = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TYPES = {
    core: ["axiome"],
    engine: ["algorithme_resolution", "empreinte_syntaxique", "matrice_esthetique", "methode_travail"],
    shadow: ["paradoxe", "peur_primaire", "biais_cognitif"],
    artifact: ["succes", "echec", "tournant"],
  };
  const COUNTS = { core: [1, 1], engine: [8, 10], shadow: [10, 15], artifact: [10, 10] };
  const MIN_NODES = 30;
  const LANGUAGES = { fr: "French", en: "English" };
  const BASES = ["documente", "declare", "interpretation"];
  const KINDS = ["forge", "nourrit", "contredit"];
  const DATE_RE = /^-?\d{1,4}(-\d{2}(-\d{2})?)?$/;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const LIMITS = { title: 60, content: 700, directive: 400, evidence: 300, impact: 400, summary: 400, domain: 120 };
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function EngramError(message) {
    const err = new Error(message);
    err.name = "EngramError";
    return err;
  }

  function EngramRefused(message) {
    const err = new Error(message);
    err.name = "EngramRefused";
    err.code = "engram_refused";
    return err;
  }

  /** Chaîne, ou entier écrit en chiffres ; tout le reste compte pour vide (comme en Python). */
  const scalar = (value) => (typeof value === "string" ? value : Number.isInteger(value) ? String(value) : "");

  function text(value, limit) {
    const clean = scalar(value).replace(/\s+/g, " ").trim();
    const chars = Array.from(clean); // points de code, comme len() en Python
    return chars.length <= limit ? clean : chars.slice(0, limit - 1).join("").trimEnd() + "…";
  }

  function intensity(value) {
    if (typeof value === "string" ? !value.trim() : typeof value !== "number") return 0.5;
    const number = Number(value);
    if (!Number.isFinite(number)) return 0.5;
    return Math.floor(Math.min(1, Math.max(0, number)) * 100 + 0.5) / 100;
  }

  function dateKey(date) {
    const negative = date.startsWith("-");
    const parts = date.replace(/^-+/, "").split("-").map((p) => parseInt(p, 10)).concat([0, 0]);
    return [negative ? -parts[0] : parts[0], parts[1], parts[2]];
  }

  const compareKeys = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  function slug(value, fallback) {
    const s = scalar(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
    return s || fallback;
  }

  /** JSON du modèle → Engramme conforme ; lève EngramError (modèle suivant) ou EngramRefused. */
  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw EngramError("réponse qui n'est pas un objet JSON");
    const refusal = typeof raw.refusal === "string" ? raw.refusal.trim() : "";
    if (refusal || raw.public_figure === false) throw EngramRefused(text(refusal || "Personnalité publique non reconnue.", 300));

    const nodes = [];
    const seen = new Set();
    (Array.isArray(raw.nodes) ? raw.nodes : []).forEach((node, index) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const category = node.category;
      if (typeof category !== "string" || !has(TYPES, category) || !TYPES[category].includes(node.type)) return;
      let id = slug(node.id, `n${index}`);
      while (seen.has(id)) id = `${id.slice(0, 20)}-${index}`;
      seen.add(id);
      const clean = {
        id,
        category,
        type: node.type,
        title: text(node.title, LIMITS.title),
        content: text(node.content, LIMITS.content),
        directive: text(node.directive, LIMITS.directive),
        basis: BASES.includes(node.basis) ? node.basis : "interpretation",
        evidence: text(node.evidence, LIMITS.evidence),
        intensity: intensity(node.intensity),
      };
      if (!(clean.title && clean.content && clean.directive)) return;
      if (category === "artifact") {
        const date = scalar(node.date).trim();
        const impact = text(node.impact, LIMITS.impact);
        if (!DATE_RE.test(date) || !impact) return; // un artefact sans date vérifiable n'a pas sa place
        clean.date = date;
        clean.impact = impact;
      }
      if (node.type === "matrice_esthetique") {
        const palette = Array.isArray(node.palette) ? node.palette : [];
        clean.palette = palette.filter((c) => typeof c === "string" && HEX_RE.test(c)).map((c) => c.toLowerCase()).slice(0, 5);
      }
      if (node.type === "empreinte_syntaxique") {
        const keywords = Array.isArray(node.keywords) ? node.keywords : [];
        clean.keywords = keywords.filter((k) => typeof k === "string" && k.trim()).map((k) => text(k, 40)).slice(0, 8);
      }
      nodes.push(clean);
    });

    const byCategory = {};
    for (const category of Object.keys(TYPES)) byCategory[category] = nodes.filter((n) => n.category === category);
    for (const [category, [low, high]] of Object.entries(COUNTS)) {
      let group = byCategory[category];
      if (group.length < low) throw EngramError(`catégorie ${category} : ${group.length} nœud(s) valides, ${low} attendus au moins`);
      if (group.length > high) {
        // Surplus : on garde les plus intenses, dans l'ordre du modèle (tri stable, comme sorted()).
        const keep = new Set(group.slice().sort((a, b) => b.intensity - a.intensity).slice(0, high));
        group = byCategory[category] = group.filter((n) => keep.has(n));
      }
      const present = new Set(group.map((n) => n.type));
      const missing = TYPES[category].filter((t) => !present.has(t));
      if (missing.length) throw EngramError(`catégorie ${category} : types manquants ${missing.sort().join(", ")}`);
    }
    byCategory.artifact.sort((a, b) => compareKeys(dateKey(a.date), dateKey(b.date)));
    const ordered = Object.keys(TYPES).flatMap((c) => byCategory[c]);
    if (ordered.length < MIN_NODES) throw EngramError(`${ordered.length} nœuds, ${MIN_NODES} attendus au moins`);

    const ids = new Set(ordered.map((n) => n.id));
    const links = [];
    const pairs = new Set();
    for (const link of Array.isArray(raw.links) ? raw.links : []) {
      if (!link || typeof link !== "object" || Array.isArray(link)) continue;
      const a = slug(link.from, "");
      const b = slug(link.to, "");
      const pair = `${a}\u0000${b}`;
      if (ids.has(a) && ids.has(b) && a !== b && KINDS.includes(link.kind) && !pairs.has(pair)) {
        pairs.add(pair);
        links.push({ from: a, to: b, kind: link.kind });
      }
    }
    return {
      person: text(raw.person, 120),
      domain: text(raw.domain, LIMITS.domain),
      summary: text(raw.summary, LIMITS.summary),
      nodes: ordered,
      links: links.slice(0, 40),
    };
  }

  /** Texte du modèle → objet JSON (tolère un bloc ```json ou une phrase autour, en mode JSON simple). */
  function parse(raw) {
    let body = String(raw || "").trim();
    const fence = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(body);
    if (fence) body = fence[1];
    else if (!body.startsWith("{")) {
      const start = body.indexOf("{");
      const end = body.lastIndexOf("}");
      if (start !== -1 && end > start) body = body.slice(start, end + 1);
    }
    try {
      return JSON.parse(body);
    } catch (err) {
      throw EngramError(`JSON illisible (${err.message})`);
    }
  }

  /** Même construction que build_user_message() dans backend/engram.py (une seule passe). */
  function buildUserMessage(template, person, language) {
    const values = { person, language: LANGUAGES[language] || "French" };
    return template.trim().replace(/\{\{(person|language)\}\}/g, (_, key) => values[key]);
  }

  // ------------------------------------------------------------------------
  // Document de la carte
  // ------------------------------------------------------------------------
  const LINE_SEP = String.fromCharCode(0x2028);
  const PARA_SEP = String.fromCharCode(0x2029);
  /** JSON inscriptible dans un <script> : ni « </script », ni séparateurs de ligne Unicode. */
  const scriptJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c").split(LINE_SEP).join("\\u2028").split(PARA_SEP).join("\\u2029");
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[ch]);
  const DATA_RE = /<script type="application\/json" id="prism-engram">([\s\S]*?)<\/script>/;

  /**
   * Document autonome de la carte. template : viewer.html ; physics : source de physics.js ;
   * libs : engine/libs.json (Tailwind épinglé, avec SRI) ; lang : "fr" | "en".
   */
  function buildViewer(template, physics, engram, libs, lang = "fr") {
    if (/<\/script/i.test(physics)) throw new Error("physics.js ne peut pas contenir « </script »");
    const values = {
      lang: lang === "en" ? "en" : "fr",
      title: escapeHtml(`Engramme · ${engram.person || "?"}`),
      tailwind: `<script src="${escapeHtml(libs.tailwind.url)}" integrity="${escapeHtml(libs.tailwind.integrity)}" crossorigin="anonymous"><\/script>`,
      physics,
      engram: scriptJson(engram),
    };
    // Une seule passe : rien de ce qui est inséré (données, moteur) n'est réinterprété comme gabarit.
    return template.replace(/\{\{(lang|title|tailwind|physics|engram)\}\}/g, (_, key) => values[key]);
  }

  /** Données d'une carte Engramme, relues dans son document (null pour un widget ordinaire). */
  function readViewer(html) {
    const match = DATA_RE.exec(html || "");
    if (!match) return null;
    try {
      const data = JSON.parse(match[1]);
      return data && Array.isArray(data.nodes) ? data : null;
    } catch {
      return null;
    }
  }

  /** Trait d'un nœud prêt à filtrer une génération (« Injection d'ADN »), cf. dna-template.txt. */
  function dnaOf(engram, nodeId) {
    const node = (engram && engram.nodes || []).find((n) => n.id === nodeId);
    if (!node) return null;
    const dna = {
      person: engram.person || "?",
      category: node.category,
      type: node.type,
      title: node.title,
      content: node.content,
      directive: node.directive,
    };
    if (node.palette && node.palette.length) dna.palette = node.palette.slice(0, 5);
    if (node.keywords && node.keywords.length) dna.keywords = node.keywords.slice(0, 8);
    return dna;
  }

  /** « Engramme : Marie Curie », « engramme de … », « engramme d'… » en tête de demande → le nom, sinon null. */
  function engramRequest(value) {
    const m = /^\s*engramm?e\s*(?:[:：]|de\s+|d['’]\s*)\s*(.{2,120}?)\s*$/i.exec(String(value || ""));
    return m ? m[1] : null;
  }

  return { TYPES, COUNTS, MIN_NODES, LIMITS, LANGUAGES, normalize, parse, buildUserMessage, buildViewer, readViewer, dnaOf, dateKey, engramRequest };
});
