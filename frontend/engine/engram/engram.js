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
    heart: ["trait", "emotion", "attachement"],
    engine: ["algorithme_resolution", "empreinte_syntaxique", "matrice_esthetique", "methode_travail"],
    shadow: ["paradoxe", "peur_primaire", "biais_cognitif"],
    artifact: ["succes", "echec", "tournant"],
  };
  const COUNTS = { core: [1, 1], heart: [6, 8], engine: [8, 10], shadow: [10, 15], artifact: [10, 10] };
  const MIN_NODES = 36;
  // Émotions reconnues (identifiant → nom anglais pour les prompts). L'ordre départage les égalités du climat.
  const EMOTIONS = {
    joie: "joy", emerveillement: "wonder", passion: "passion", tendresse: "tenderness",
    serenite: "serenity", fierte: "pride", melancolie: "melancholy", tristesse: "sadness",
    colere: "anger", peur: "fear", angoisse: "anxiety", solitude: "loneliness",
  };
  const EMOTION_ORDER = Object.keys(EMOTIONS);
  const CLIMATE_MAX = 4;
  const LANGUAGES = { fr: "French", en: "English" };
  const BASES = ["documente", "declare", "interpretation"];
  const KINDS = ["forge", "nourrit", "contredit"];
  const DATE_RE = /^-?\d{1,4}(-\d{2}(-\d{2})?)?$/;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const LIMITS = { title: 60, content: 700, directive: 400, evidence: 300, impact: 400, summary: 400, domain: 120, temperament: 300 };
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

  const round2 = (number) => Math.floor(number * 100 + 0.5) / 100;

  function intensity(value) {
    if (typeof value === "string" ? !value.trim() : typeof value !== "number") return 0.5;
    const number = Number(value);
    if (!Number.isFinite(number)) return 0.5;
    return round2(Math.min(1, Math.max(0, number)));
  }

  /** Climat émotionnel (même règle que _climate() en Python) : 1 à 4 émotions, poids normalisés ; absent :
   *  déduit des charges émotionnelles des nœuds, pondérées par leur intensité. */
  function climate(raw, nodes) {
    let entries = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const emotion = item.emotion;
      if (typeof emotion !== "string" || !has(EMOTIONS, emotion) || seen.has(emotion)) continue;
      const weight = intensity(item.weight);
      if (weight > 0) {
        seen.add(emotion);
        entries.push([emotion, weight]);
      }
    }
    if (!entries.length) {
      const totals = new Map();
      for (const node of nodes) if (node.emotion) totals.set(node.emotion, (totals.get(node.emotion) || 0) + node.intensity);
      entries = [...totals].filter(([, w]) => w > 0);
    }
    entries.sort((a, b) => b[1] - a[1] || EMOTION_ORDER.indexOf(a[0]) - EMOTION_ORDER.indexOf(b[0]));
    entries = entries.slice(0, CLIMATE_MAX);
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    return total > 0 ? entries.map(([emotion, w]) => ({ emotion, weight: round2(w / total) })) : [];
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
      if (typeof node.emotion === "string" && has(EMOTIONS, node.emotion)) clean.emotion = node.emotion;
      else if (node.type === "emotion") return; // une émotion sans nom reconnu n'a pas sa place
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
      temperament: text(raw.temperament, LIMITS.temperament),
      climate: climate(raw.climate, ordered),
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
    // Caractère et émotions : la génération reprend la charge du nœud et le climat de la personne.
    if (node.emotion && has(EMOTIONS, node.emotion)) dna.emotion = node.emotion;
    if (engram.temperament) dna.temperament = engram.temperament;
    const moods = (engram.climate || []).map((c) => c.emotion).filter((e) => has(EMOTIONS, e)).slice(0, CLIMATE_MAX);
    if (moods.length) dna.climate = moods;
    return dna;
  }

  // ------------------------------------------------------------------------
  // Conversation (« Discuter avec … ») : même algorithme que backend/engram.py (parité testée)
  // ------------------------------------------------------------------------
  const CHAT_NODES_MAX = 50;
  const CHAT_HISTORY_MAX = 12;
  const TRACE_MAX = 4;
  const STOPWORDS = new Set([
    "pour", "dans", "avec", "vous", "votre", "vos", "quoi", "comment", "pourquoi", "quel", "quelle", "quels", "quelles",
    "etre", "avoir", "fait", "faire", "cette", "elle", "lui", "leur", "leurs", "sont", "plus", "moins", "tout", "tous",
    "toute", "toutes", "mais", "donc", "alors", "aussi", "tres", "bien", "etait", "avez", "etes", "est-ce", "what",
    "your", "with", "have", "that", "this", "about", "would", "could", "there", "their", "from", "were",
  ]);

  function clip(value, limit) {
    const chars = Array.from(value);
    return chars.length <= limit ? value : chars.slice(0, limit - 1).join("").trimEnd() + "…";
  }

  /** Texte sur plusieurs lignes : espaces réduits, lignes vides en trop retirées, coupé à limit points de code. */
  function multiline(value, limit) {
    const lines = scalar(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((l) => l.replace(/[^\S\n]+/g, " ").trim());
    return clip(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), limit);
  }

  /** Bulles d'un Engramme (données non fiables) : champs utiles, bornés, identifiants nettoyés. */
  function chatNodes(engram) {
    const raw = engram && typeof engram === "object" && Array.isArray(engram.nodes) ? engram.nodes : [];
    const nodes = [];
    const seen = new Set();
    raw.slice(0, CHAT_NODES_MAX).forEach((node, index) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const id = slug(node.id, `n${index}`);
      if (seen.has(id)) return;
      seen.add(id);
      const keywords = Array.isArray(node.keywords) ? node.keywords : [];
      nodes.push({
        id,
        category: text(node.category, 30),
        type: text(node.type, 30),
        title: text(node.title, LIMITS.title),
        content: text(node.content, LIMITS.content),
        evidence: text(node.evidence, LIMITS.evidence),
        basis: BASES.includes(node.basis) ? node.basis : "interpretation",
        emotion: typeof node.emotion === "string" && has(EMOTIONS, node.emotion) ? node.emotion : "",
        date: text(node.date, 20),
        impact: text(node.impact, LIMITS.impact),
        keywords: keywords.filter((k) => typeof k === "string" && k.trim()).map((k) => text(k, 40)).slice(0, 8),
      });
    });
    return nodes;
  }

  /** Toutes les données écrites de l'Engramme, en texte compact pour le modèle. */
  function chatDossier(engram) {
    const e = engram && typeof engram === "object" ? engram : {};
    const person = text(e.person, 120);
    const domain = text(e.domain, LIMITS.domain);
    const lines = [`PERSON: ${person}${domain ? ` — ${domain}` : ""}`];
    for (const [label, key] of [["SUMMARY", "summary"], ["TEMPERAMENT", "temperament"]]) {
      const value = text(e[key], LIMITS[key]);
      if (value) lines.push(`${label}: ${value}`);
    }
    const moods = [];
    for (const item of Array.isArray(e.climate) ? e.climate : []) {
      if (item && typeof item === "object" && typeof item.emotion === "string" && has(EMOTIONS, item.emotion)) {
        moods.push(`${EMOTIONS[item.emotion]} ${Math.floor(intensity(item.weight) * 100 + 0.5)}%`);
      }
    }
    if (moods.length) lines.push(`EMOTIONAL CLIMATE: ${moods.slice(0, CLIMATE_MAX).join(", ")}`);
    const nodes = chatNodes(e);
    lines.push("NODES:");
    for (const n of nodes) {
      const parts = [`[${n.id}] ${n.category}/${n.type} · ${n.title} — ${n.content}`];
      if (n.emotion) parts.push(`emotion: ${EMOTIONS[n.emotion]}`);
      if (n.date) parts.push(n.impact ? `${n.date}: ${n.impact}` : n.date);
      if (n.keywords.length) parts.push(`keywords: ${n.keywords.join(", ")}`);
      if (n.evidence) parts.push(`source (${n.basis}): ${n.evidence}`);
      lines.push(parts.join(" · "));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const links = [];
    for (const link of Array.isArray(e.links) ? e.links : []) {
      if (!link || typeof link !== "object" || Array.isArray(link)) continue;
      const a = slug(link.from, "");
      const b = slug(link.to, "");
      if (ids.has(a) && ids.has(b) && a !== b && KINDS.includes(link.kind)) links.push(`${a} ${link.kind} ${b}`);
    }
    if (links.length) lines.push(`LINKS: ${links.slice(0, 40).join("; ")}`);
    return lines.join("\n");
  }

  /** Même construction que build_chat_message() en Python (une seule passe). */
  function buildChatMessage(template, engram, history, message, language) {
    const person = text(engram && typeof engram === "object" ? engram.person : "", 120) || "?";
    const turns = [];
    for (const turn of (Array.isArray(history) ? history : []).slice(-CHAT_HISTORY_MAX)) {
      if (turn && typeof turn === "object" && (turn.role === "user" || turn.role === "persona")) {
        const said = text(turn.text, 1200);
        if (said) turns.push(`${turn.role === "user" ? "User" : person}: ${said}`);
      }
    }
    const values = {
      person, dossier: chatDossier(engram), history: turns.join("\n") || "(none)",
      message: multiline(message, 2000), language: LANGUAGES[language] || "French",
    };
    return template.trim().replace(/\{\{(person|dossier|history|message|language)\}\}/g, (_, key) => values[key]);
  }

  /** Réponse du modèle → { reply, trace } ; la trace ne cite que des bulles de cet Engramme. */
  function normalizeChat(raw, engram) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw EngramError("réponse qui n'est pas un objet JSON");
    const reply = multiline(raw.reply, 1500);
    if (!reply) throw EngramError("réponse vide");
    const ids = new Set(chatNodes(engram).map((n) => n.id));
    const trace = [];
    const seen = new Set();
    for (const step of Array.isArray(raw.trace) ? raw.trace : []) {
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      const id = slug(step.id, "");
      if (ids.has(id) && !seen.has(id)) {
        seen.add(id);
        trace.push({ id, why: text(step.why, 120) });
      }
    }
    return { reply, trace: trace.slice(0, TRACE_MAX) };
  }

  function words(value) {
    const plain = value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return (plain.match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  }

  /** Sans modèle : les bulles dont les mots rejoignent la question (sinon noyau, cœur, moteur), et une réponse honnête. */
  function demoChat(engram, message) {
    const nodes = chatNodes(engram);
    const person = text(engram && typeof engram === "object" ? engram.person : "", 120) || "cette personne";
    const question = [...new Set(words(scalar(message)))];
    const scored = [];
    nodes.forEach((n, index) => {
      const own = new Set(words(`${n.title} ${n.content}`));
      const common = question.filter((w) => own.has(w));
      if (common.length) scored.push([common.length, index, n, common[0]]);
    });
    scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const trace = scored.slice(0, 3).map(([, , n, word]) => ({ id: n.id, why: `mot commun : « ${word} »` }));
    if (!trace.length) {
      for (const [category, why] of [["core", "l'axiome au centre de tout"], ["heart", "son caractère"], ["engine", "sa manière de penser"]]) {
        const n = nodes.find((m) => m.category === category);
        if (n) trace.push({ id: n.id, why });
      }
    }
    const titles = trace.map((s) => `« ${nodes.find((n) => n.id === s.id).title} »`).join(", ");
    const reply = `(Mode démo : sans modèle de langage, ${person} ne peut pas vraiment vous répondre.) `
      + `Voici les traits de l'Engramme qui guideraient sa réponse : ${titles}. `
      + "Ajoutez une clé Gemini pour une vraie conversation.";
    return { reply, trace };
  }

  /** « Engramme : Marie Curie », « engramme de … », « engramme d'… » en tête de demande → le nom, sinon null. */
  function engramRequest(value) {
    const m = /^\s*engramm?e\s*(?:[:：]|de\s+|d['’]\s*)\s*(.{2,120}?)\s*$/i.exec(String(value || ""));
    return m ? m[1] : null;
  }

  return {
    TYPES, COUNTS, MIN_NODES, LIMITS, LANGUAGES, EMOTIONS, normalize, parse, buildUserMessage, buildViewer, readViewer, dnaOf,
    dateKey, engramRequest, chatNodes, chatDossier, buildChatMessage, normalizeChat, demoChat,
  };
});
