// Bus d'évènements entre widgets (page) : chaque widget publie avec prism.emit(sujet, données) et
// s'abonne avec prism.on(sujet, fn) — cf. le prélude de sandbox.js. La page relaie aux seuls abonnés,
// jamais à l'émetteur, après validation : sujet bien formé, données JSON ≤ 64 Ko, débit plafonné.
// Elle garde la dernière valeur de chaque sujet (remise à tout nouvel abonné) et sait qui parle à qui
// (liaisons dessinées sur le canvas, contexte envoyé au modèle).

export const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/; // même règle que TOPIC_RE (backend/app.py)
export const MAX_EVENT_BYTES = 64 * 1024;
const RATE = { capacity: 40, perSecond: 20 }; // seau de jetons par carte : rafales tolérées, boucles coupées
const MAX_TOPICS = 20;

export const isTopic = (topic) => typeof topic === "string" && TOPIC_RE.test(topic);

/** Sujets écrits dans le code d'un widget : prism.emit("x", …) / prism.on("y", …). */
export function scanTopics(html) {
  const emits = new Set();
  const listens = new Set();
  const re = /\bprism\s*\.\s*(emit|on)\s*\(\s*(["'`])([^"'`\\]{1,64})\2/g;
  for (const m of String(html || "").matchAll(re)) {
    const topic = m[3];
    if (m[1] === "emit" && isTopic(topic)) emits.add(topic);
    if (m[1] === "on" && (isTopic(topic) || topic === "*")) listens.add(topic);
  }
  return { emits: [...emits].slice(0, MAX_TOPICS), listens: [...listens].slice(0, MAX_TOPICS) };
}

/** Aperçu court d'une donnée (contexte du modèle, inspecteur). */
export function preview(data, max = 160) {
  let text;
  try { text = JSON.stringify(data); } catch { text = String(data); }
  if (text === undefined) text = "null";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class Bus {
  /**
   * cards()        : cartes du canvas (itérable) ;
   * post(card, m)  : envoie un message à l'iframe d'une carte ;
   * onFlow(from, to, topic) : un évènement vient d'être livré (animation de la liaison) ;
   * onTopics(card) : les sujets connus d'une carte ont changé ;
   * onFlood(card)  : une carte dépasse le débit autorisé (prévenir une fois).
   */
  constructor({ cards, post, onFlow = () => {}, onTopics = () => {}, onFlood = () => {} }) {
    Object.assign(this, { cards, post, onFlow, onTopics, onFlood });
    this.retained = new Map(); // sujet -> { data, fromId, fromTitle, at }
    this.subs = new Map(); // id carte -> Set(sujets) abonnés dans le document actuel
    this.buckets = new Map(); // id carte -> { tokens, at }
  }

  /** Sujets connus d'une carte : déclarés dans son code + observés à l'exécution. */
  static topicsOf(card) {
    if (!card.topics) card.topics = { emits: [], listens: [] };
    return card.topics;
  }

  /** Nouveau code (génération, refactorisation, annulation) : sujets relus dans le document. */
  learn(card) {
    const scanned = scanTopics(card.html);
    const before = JSON.stringify(card.topics || null);
    card.topics = scanned;
    if (JSON.stringify(card.topics) !== before) this.onTopics(card);
  }

  /** Nouveau document dans l'iframe : ses abonnements repartent de zéro. */
  reset(card) {
    this.subs.delete(card.id);
  }

  forget(card) {
    this.subs.delete(card.id);
    this.buckets.delete(card.id);
  }

  note(card, kind, topic) {
    const topics = Bus.topicsOf(card);
    if (topics[kind].includes(topic) || topics[kind].length >= MAX_TOPICS) return;
    topics[kind] = [...topics[kind], topic];
    this.onTopics(card);
  }

  allow(card) {
    const now = performance.now();
    const b = this.buckets.get(card.id) || { tokens: RATE.capacity, at: now, warned: false };
    b.tokens = Math.min(RATE.capacity, b.tokens + ((now - b.at) / 1000) * RATE.perSecond);
    b.at = now;
    this.buckets.set(card.id, b);
    if (b.tokens < 1) {
      if (!b.warned) this.onFlood(card);
      b.warned = true;
      return false;
    }
    b.tokens -= 1;
    return true;
  }

  /** Message « emit » d'un widget (données non fiables). Renvoie le nombre de livraisons. */
  emit(card, topic, data) {
    if (!isTopic(topic) || card.busMuted) return 0;
    let size;
    try { size = JSON.stringify(data ?? null).length; } catch { return 0; }
    if (size > MAX_EVENT_BYTES || !this.allow(card)) return 0;
    this.note(card, "emits", topic);
    const from = { title: String(card.title || "").slice(0, 80) };
    this.retained.set(topic, { data, fromId: card.id, fromTitle: from.title, at: Date.now() });
    card.busStats = card.busStats || {};
    card.busStats[topic] = { count: (card.busStats[topic]?.count || 0) + 1, last: preview(data) };
    let delivered = 0;
    for (const other of this.cards()) {
      if (other.id === card.id || other.busMuted) continue;
      const subs = this.subs.get(other.id);
      if (!subs || !(subs.has(topic) || subs.has("*"))) continue;
      this.post(other, { prism: "event", topic, data, from });
      this.onFlow(card, other, topic);
      delivered += 1;
    }
    return delivered;
  }

  /** Message « subscribe » d'un widget : abonnement, puis dernière valeur connue si demandée. */
  subscribe(card, topic, replay = true) {
    if (!(isTopic(topic) || topic === "*")) return;
    let subs = this.subs.get(card.id);
    if (!subs) this.subs.set(card.id, (subs = new Set()));
    if (subs.size >= MAX_TOPICS && !subs.has(topic)) return;
    subs.add(topic);
    this.note(card, "listens", topic);
    if (!replay || card.busMuted) return;
    for (const [t, last] of this.retained) {
      if ((topic === "*" || t === topic) && last.fromId !== card.id) {
        this.post(card, { prism: "event", topic: t, data: last.data, from: { title: last.fromTitle }, replay: true });
      }
    }
  }

  /** Une carte quitte le canvas : ses valeurs retenues aussi. */
  drop(card) {
    this.forget(card);
    for (const [topic, last] of this.retained) if (last.fromId === card.id) this.retained.delete(topic);
  }

  /** Liaisons émetteur → auditeur (sujets communs), pour le dessin du canvas. */
  links() {
    const list = [...this.cards()];
    const out = [];
    for (const a of list) {
      const emits = Bus.topicsOf(a).emits;
      if (!emits.length) continue;
      for (const b of list) {
        if (a === b) continue;
        const listens = Bus.topicsOf(b).listens;
        const topics = listens.includes("*") ? emits : emits.filter((t) => listens.includes(t));
        if (topics.length) out.push({ from: a, to: b, topics, muted: Boolean(a.busMuted || b.busMuted) });
      }
    }
    return out;
  }

  /** Contexte envoyé au modèle : les autres widgets, leurs sujets et une donnée d'exemple. */
  context(exclude = null) {
    const out = [];
    for (const card of this.cards()) {
      if (card === exclude || !card.html) continue;
      const { emits, listens } = Bus.topicsOf(card);
      if (!emits.length && !listens.length) continue;
      const samples = {};
      for (const t of emits) {
        const last = this.retained.get(t);
        if (last && last.fromId === card.id) samples[t] = preview(last.data, 160);
      }
      out.push({ title: String(card.title || "Widget").slice(0, 120), emits, listens, samples });
      if (out.length >= 20) break;
    }
    return out;
  }
}
