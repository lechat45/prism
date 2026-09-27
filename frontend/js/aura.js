// V5 · Aura sonore et haptique : le canvas répond par des sons discrets, synthétisés (Web Audio, aucun fichier), et de
// brèves vibrations sur mobile — un tintement quand deux idées se lient, un son grave quand une ombre fuit le pointeur,
// une montée lumineuse quand deux esprits fusionnent, un souffle quand une carte se dissout, un « clic » doux quand une
// bulle devient filtre ADN.
//
// Désactivée par défaut (Paramètres → Écosystème) ; volume bas ; chaque son est espacé (pas de rafale) ; le contexte
// audio n'est créé qu'après un geste de l'utilisateur (règle des navigateurs).

const GAP_MS = { link: 400, shadow: 1400, fusion: 2000, dissolve: 800, pin: 250 };
const HAPTIC = { link: [12], shadow: [6, 40, 6], fusion: [20, 60, 40], dissolve: [30], pin: [8] };

/** Enveloppe : attaque, puis décroissance exponentielle. */
function envelope(ctx, gain, t, attack, decay, peak) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(ctx, out, { freq, type = "sine", t, attack = 0.005, decay = 1, peak = 0.08, glide = null }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t + attack + decay);
  envelope(ctx, gain, t, attack, decay, peak);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

export const SOUNDS = {
  /** Deux idées se lient : tintement cristallin (quinte). */
  link(ctx, out, t) {
    tone(ctx, out, { freq: 880, t, decay: 1.2, peak: 0.07 });
    tone(ctx, out, { freq: 1320, t: t + 0.04, decay: 0.9, peak: 0.04 });
  },
  /** Une ombre fuit : son grave, feutré. */
  shadow(ctx, out, t) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.connect(out);
    tone(ctx, filter, { freq: 98, type: "triangle", t, attack: 0.08, decay: 0.9, peak: 0.09, glide: 82 });
    tone(ctx, filter, { freq: 147, t, attack: 0.1, decay: 0.7, peak: 0.04 });
  },
  /** Deux esprits fusionnent : montée, puis scintillement. */
  fusion(ctx, out, t) {
    tone(ctx, out, { freq: 220, type: "sawtooth", t, attack: 0.3, decay: 1.2, peak: 0.025, glide: 880 });
    [1320, 1760, 2640].forEach((f, i) => tone(ctx, out, { freq: f, t: t + 1.1 + i * 0.07, decay: 0.8, peak: 0.03 }));
  },
  /** Une carte se dissout : souffle qui s'éteint (bruit filtré). */
  dissolve(ctx, out, t) {
    const length = Math.floor(ctx.sampleRate * 0.9);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(2400, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.9);
    const gain = ctx.createGain();
    envelope(ctx, gain, t, 0.02, 0.85, 0.06);
    noise.connect(filter).connect(gain).connect(out);
    noise.start(t);
  },
  /** Une bulle devient filtre ADN : « clic » doux. */
  pin(ctx, out, t) {
    tone(ctx, out, { freq: 660, t, decay: 0.18, peak: 0.05 });
  },
};

export class Aura {
  constructor({ enabled = false, volume = 0.7 } = {}) {
    this.enabled = enabled;
    this.volume = volume;
    this.ctx = null;
    this.master = null;
    this.last = new Map();
    this.played = []; // derniers évènements joués (diagnostic et tests)
  }

  /** Crée ou réveille le contexte audio : à appeler pendant un geste de l'utilisateur. */
  unlock() {
    if (!this.enabled) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (this.enabled) this.unlock();
    else if (this.ctx) this.ctx.suspend().catch(() => {});
  }

  /** Joue un évènement (s'il n'a pas été joué trop récemment) ; vrai s'il a été joué. */
  play(kind, now = performance.now()) {
    if (!this.enabled || !SOUNDS[kind]) return false;
    if (now - (this.last.get(kind) ?? -Infinity) < (GAP_MS[kind] ?? 300)) return false;
    this.last.set(kind, now);
    this.played.push(kind);
    if (this.played.length > 20) this.played.shift();
    try { globalThis.navigator?.vibrate?.(HAPTIC[kind]); } catch { /* vibration refusée */ }
    if (this.ctx && this.ctx.state === "running") SOUNDS[kind](this.ctx, this.master, this.ctx.currentTime + 0.01);
    return true;
  }
}
