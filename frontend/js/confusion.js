// V5 · Darwinisme d'interface : repérer, au seul mouvement du pointeur au-dessus d'un widget, qu'une
// personne tourne en rond sans rien trouver à cliquer.
//
// Tout reste sur l'appareil : le prélude des widgets envoie la position du pointeur (déjà utilisée pour les
// reflets), la page en garde quelques secondes par carte et le Web Worker (tâche « confusion ») calcule un
// verdict. Aucune position n'est envoyée au serveur ; seule une suggestion (« Simplifier ? ») en découle,
// jamais une dépense sans accord (cf. le mode automatique, à activer soi-même dans les Paramètres).

export const CONFUSION = {
  WINDOW_MS: 5000, // au moins 5 s de mouvement…
  GAP_MS: 900, // …sans pause de plus de 0,9 s (au-delà, la personne lit ou réfléchit) ni clic
  MIN_SAMPLES: 20,
  MIN_TURNS: 2, // deux tours complets autour d'un même point…
  MIN_PATH: 1500, // …ou 1 500 px parcourus…
  MAX_BOX: 260, // …sans sortir d'une zone de 260 px : elle cherche quelque chose sans le trouver
  SLOW: 60, // px/s : en dessous, le pointeur hésite
};

const round = (v, digits = 0) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * samples : [{ t, x, y }] (ms croissants, px de l'iframe) ; clicks : [t] ; now : ms.
 * → { confused, reason: "circles" | "wander" | null, duration, path, box, turns, speed, hesitation }
 */
export function analyzePointer(samples, clicks = [], now = Date.now(), limits = CONFUSION) {
  const quiet = { confused: false, reason: null, duration: 0, path: 0, box: 0, turns: 0, speed: 0, hesitation: 0 };
  const lastClick = clicks.reduce((m, t) => (t <= now && t > m ? t : m), -Infinity);
  const points = (Array.isArray(samples) ? samples : [])
    .filter((p) => p && [p.t, p.x, p.y].every(Number.isFinite) && p.t > lastClick && p.t <= now);
  if (!points.length || now - points[points.length - 1].t > limits.GAP_MS) return quiet; // immobile : rien à dire
  // Série continue la plus récente (pas de trou de plus de GAP_MS).
  let start = points.length - 1;
  while (start > 0 && points[start].t - points[start - 1].t <= limits.GAP_MS) start -= 1;
  const run = points.slice(start);
  const end = run[run.length - 1].t;
  const duration = end - run[0].t;
  // Mesures sur les WINDOW_MS dernières millisecondes de la série.
  const from = run.findIndex((p) => p.t >= end - limits.WINDOW_MS);
  const win = run.slice(Math.max(0, from - 1));
  let path = 0;
  let slow = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  for (const p of win) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    cx += p.x / win.length;
    cy += p.y / win.length;
  }
  let swept = 0; // angle balayé autour du centre (tours)
  for (let i = 1; i < win.length; i += 1) {
    const [a, b] = [win[i - 1], win[i]];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const dt = Math.max(1, b.t - a.t);
    path += d;
    if ((d / dt) * 1000 < limits.SLOW) slow += dt;
    let turn = Math.atan2(b.y - cy, b.x - cx) - Math.atan2(a.y - cy, a.x - cx);
    if (turn > Math.PI) turn -= 2 * Math.PI;
    if (turn < -Math.PI) turn += 2 * Math.PI;
    swept += turn;
  }
  const span = Math.max(1, win[win.length - 1].t - win[0].t);
  const box = Math.max(maxX - minX, maxY - minY);
  const turns = Math.abs(swept) / (2 * Math.PI);
  const stats = {
    duration: Math.round(duration), path: Math.round(path), box: Math.round(box), turns: round(turns, 2),
    speed: Math.round((path / span) * 1000), hesitation: round(slow / span, 2),
  };
  const long = duration >= limits.WINDOW_MS && win.length >= limits.MIN_SAMPLES;
  const circles = long && turns >= limits.MIN_TURNS && box <= limits.MAX_BOX * 1.5;
  const wander = long && path >= limits.MIN_PATH && box <= limits.MAX_BOX;
  return { confused: circles || wander, reason: circles ? "circles" : wander ? "wander" : null, ...stats };
}

/**
 * Suivi par carte : quelques secondes de pointeur, les clics, et un verdict demandé chaque seconde à
 * analyze(samples, clicks, now) (le Worker) pour les cartes survolées. onConfused(id, verdict) au plus une
 * fois par carte et par délai de grâce.
 */
export class ConfusionWatcher {
  constructor({ analyze, onConfused, cooldownMs = 10 * 60 * 1000, keepMs = 12000, intervalMs = 1000, now = () => Date.now(),
    setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (id) => clearInterval(id) }) {
    Object.assign(this, { analyze, onConfused, cooldownMs, keepMs, intervalMs, now, setTimer, clearTimer });
    this.tracks = new Map(); // id -> { samples, clicks }
    this.cooling = new Map(); // id -> instant de la dernière alerte
    this.timer = null;
    this.busy = false;
    this.enabled = true;
  }

  track(id) {
    if (!this.tracks.has(id)) this.tracks.set(id, { samples: [], clicks: [] });
    return this.tracks.get(id);
  }

  /** at : instant du mouvement dans le widget (évite qu'une page chargée tasse les échantillons), sinon maintenant. */
  pointer(id, x, y, at = null) {
    if (!this.enabled || ![x, y].every(Number.isFinite)) return;
    const now = this.now();
    const t = Number.isFinite(at) && at <= now && now - at < 2000 ? at : now;
    const track = this.track(id);
    if (track.samples.length && t < track.samples[track.samples.length - 1].t) return; // message en retard
    track.samples.push({ t, x: Math.round(x), y: Math.round(y) });
    while (track.samples.length && t - track.samples[0].t > this.keepMs) track.samples.shift();
    if (track.samples.length > 600) track.samples.splice(0, track.samples.length - 600);
    if (!this.timer) this.timer = this.setTimer(() => this.tick(), this.intervalMs);
  }

  click(id) {
    const track = this.tracks.get(id);
    if (!track) return;
    track.clicks = [this.now()];
    track.samples = []; // un clic : la personne a trouvé quelque chose
  }

  forget(id) {
    this.tracks.delete(id);
    this.cooling.delete(id);
  }

  async tick() {
    const now = this.now();
    for (const [id, track] of this.tracks) if (!track.samples.length || now - track.samples[track.samples.length - 1].t > this.keepMs) this.tracks.delete(id);
    if (!this.tracks.size) {
      this.clearTimer(this.timer);
      this.timer = null;
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [id, track] of [...this.tracks]) {
        const last = track.samples[track.samples.length - 1];
        if (!last || now - last.t > 1000 || now - (this.cooling.get(id) ?? -Infinity) < this.cooldownMs) continue;
        const verdict = await this.analyze(track.samples, track.clicks, now);
        if (!verdict?.confused || !this.tracks.has(id)) continue;
        this.cooling.set(id, now);
        track.samples = [];
        this.onConfused(id, verdict);
      }
    } catch (err) {
      console.warn("Prism : analyse du pointeur impossible", err);
    } finally {
      this.busy = false;
    }
  }
}
