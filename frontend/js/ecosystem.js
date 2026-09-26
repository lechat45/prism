// V5 · réglages de l'« Écosystème vivant », propres à cet appareil (localStorage) :
//  - watch    : repérer la confusion du pointeur et proposer une simplification (oui par défaut ; rien n'est dépensé) ;
//  - auto     : simplifier sans demander — à activer soi-même, au plus AUTO_PER_DAY fois par 24 h, annulable ;
//  - sediment : contexte fantôme des zones où des cartes ont été dissoutes (oui par défaut, visible dans l'inspecteur).

export const AUTO_PER_DAY = 3;
const DAY = 24 * 60 * 60 * 1000;
const KEYS = { watch: "prism:confusion", auto: "prism:auto-mutation", log: "prism:auto-mutation-log", sediment: "prism:sediment" };

function read(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
}

const recent = (now) => (Array.isArray(read(KEYS.log, [])) ? read(KEYS.log, []) : []).filter((t) => Number.isFinite(t) && now - t < DAY);

export const eco = {
  get watch() { return read(KEYS.watch, true) !== false; },
  set watch(on) { write(KEYS.watch, Boolean(on)); },
  /** Mode automatique : consentement explicite (case cochée dans les Paramètres), daté. */
  get auto() { return read(KEYS.auto, null)?.on === true; },
  set auto(on) { write(KEYS.auto, on ? { on: true, since: new Date().toISOString() } : { on: false }); },
  get sediment() { return read(KEYS.sediment, true) !== false; },
  set sediment(on) { write(KEYS.sediment, Boolean(on)); },
  autoToday: (now = Date.now()) => recent(now).length,
  canAuto: (now = Date.now()) => eco.watch && eco.auto && recent(now).length < AUTO_PER_DAY,
  recordAuto: (now = Date.now()) => write(KEYS.log, [...recent(now), now]),
};
