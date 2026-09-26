// Incantation (V4) : maintenir Espace (focus hors d'un champ et hors d'un widget) et parler ; la demande
// dictée devient une carte à l'endroit du pointeur. Reconnaissance vocale du navigateur (Web Speech API).
//
// Verre organique : pendant l'écoute, le volume du micro (AudioContext + AnalyserNode) module le flou et
// la saturation des panneaux de verre (--organic, de 0 à 1). Uniquement pendant l'incantation : un
// panneau qui se repeint en continu au-dessus des widgets leur ferait perdre des clics (cf. phase 5).

const HOLD_MS = 260; // en deçà : simple appui sur Espace, ignoré
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const ERRORS = {
  "not-allowed": "Micro refusé : autorisez-le dans le navigateur pour incanter.",
  "service-not-allowed": "Reconnaissance vocale refusée par le navigateur.",
  "audio-capture": "Aucun micro détecté.",
  network: "Reconnaissance vocale indisponible (réseau).",
  "no-speech": "Aucune parole entendue.",
  "language-not-supported": "Le français n'est pas reconnu par ce navigateur.",
};

export class Incantation {
  /** onSpell(texte, { x, y } écran) ; blocked() : vrai quand une fenêtre a la main. */
  constructor({ onSpell, toast, blocked = () => false }) {
    Object.assign(this, { onSpell, toast, blocked });
    this.pointer = { x: innerWidth / 2, y: innerHeight / 2 };
    this.active = false;
    this.holdTimer = null;
    this.recognition = null;
    this.audio = null;
    this.el = document.getElementById("incantation");
    this.textEl = this.el.querySelector(".inc-text");
    this.el.querySelector(".inc-stop").addEventListener("click", () => this.stop());
    addEventListener("pointermove", (e) => this.movePointer(e.clientX, e.clientY), { passive: true });
    addEventListener("keydown", (e) => this.keydown(e), true);
    addEventListener("keyup", (e) => this.keyup(e), true);
    addEventListener("blur", () => this.cancel());
  }

  static get supported() {
    return Boolean(SR);
  }

  /** Position du pointeur (aussi relayée depuis les widgets, cf. message « pointer »). */
  movePointer(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.pointer = { x, y };
    if (this.active && this.mode === "hold") this.place();
  }

  keydown(e) {
    if (e.key === "Escape" && this.active) {
      e.preventDefault();
      e.stopPropagation();
      return this.cancel();
    }
    if (e.code !== "Space" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, button, a, [contenteditable], [role='button'], dialog")) return;
    e.preventDefault();
    if (e.repeat || this.holdTimer || this.active) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.start("hold");
    }, HOLD_MS);
  }

  keyup(e) {
    if (e.code !== "Space") return;
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
      return;
    }
    if (this.active && this.mode === "hold") {
      e.preventDefault();
      this.stop();
    }
  }

  /** mode : "hold" (tant qu'Espace est enfoncé) | "toggle" (jusqu'au silence, ou clic sur l'orbe). */
  start(mode = "toggle") {
    if (this.active || this.blocked()) return;
    if (!SR) {
      this.toast("Incantation indisponible : ce navigateur ne reconnaît pas la voix (Chrome, Edge ou Safari).", { tone: "error", timeout: 6000 });
      return;
    }
    Object.assign(this, { active: true, mode, final: "", interim: "", error: null, cancelled: false, session: (this.session || 0) + 1 });
    if (mode === "toggle") this.pointer = { x: innerWidth / 2, y: innerHeight / 2 };
    const rec = new SR();
    rec.lang = "fr-FR";
    rec.interimResults = true;
    rec.continuous = mode === "hold";
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      let final = "";
      let interim = "";
      for (const result of event.results) {
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      this.final = final;
      this.interim = interim;
      this.render();
    };
    rec.onerror = (event) => { this.error = event.error; };
    rec.onend = () => this.finish();
    this.recognition = rec;
    this.show();
    this.organic(true);
    try {
      rec.start();
    } catch (err) {
      this.error = err.message;
      this.finish();
    }
  }

  /** Fin de l'écoute : la phrase entendue part. */
  stop() {
    if (!this.active) return;
    try { this.recognition.stop(); } catch { this.finish(); }
  }

  /** Abandon (Échap, fenêtre quittée) : rien ne part. */
  cancel() {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (!this.active) return;
    this.cancelled = true;
    try { this.recognition.abort(); } catch { this.finish(); }
  }

  get text() {
    return `${this.final || ""} ${this.interim || ""}`.replace(/\s+/g, " ").trim();
  }

  finish() {
    if (!this.active) return;
    const text = this.text;
    const at = { ...this.pointer };
    this.active = false;
    this.recognition = null;
    this.organic(false);
    this.hide();
    if (this.cancelled) return;
    if (text) this.onSpell(text, at);
    else this.toast(ERRORS[this.error] || (this.error ? `Incantation interrompue (${this.error}).` : ERRORS["no-speech"]), { tone: this.error && this.error !== "no-speech" ? "error" : "info", timeout: 5000 });
  }

  // ------------------------------------------------------------ orbe d'écoute
  show() {
    this.el.hidden = false;
    this.el.dataset.mode = this.mode;
    this.render();
    this.place();
  }

  hide() {
    this.el.hidden = true;
  }

  place() {
    const { x, y } = this.pointer;
    this.el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
  }

  render() {
    const text = this.text;
    this.textEl.textContent = text || (this.mode === "hold" ? "Je vous écoute… relâchez Espace pour incanter" : "Je vous écoute…");
    this.textEl.classList.toggle("is-placeholder", !text);
  }

  // ------------------------------------------------------------ verre organique
  async organic(on) {
    const root = document.documentElement;
    if (!on) {
      document.body.classList.remove("is-incanting");
      root.style.removeProperty("--organic");
      const audio = this.audio;
      this.audio = null;
      if (audio) {
        cancelAnimationFrame(audio.raf);
        audio.stream.getTracks().forEach((t) => t.stop());
        audio.ctx.close().catch(() => {});
      }
      return;
    }
    document.body.classList.add("is-incanting");
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) return;
    const session = this.session;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      console.warn("Prism : verre organique indisponible (micro)", err); // la reconnaissance le signalera aussi
      return;
    }
    if (!this.active || session !== this.session) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const ctx = new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {}); // créé hors du geste (après l'accord du micro)
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let level = 0;
    let shown = -1;
    const audio = { ctx, stream, raf: 0 };
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const target = Math.min(1, Math.sqrt(sum / samples.length) * 7);
      level += (target - level) * (target > level ? 0.45 : 0.1); // attaque vive, relâchement doux
      if (Math.abs(level - shown) > 0.015) {
        shown = level;
        root.style.setProperty("--organic", level.toFixed(3));
      }
      audio.raf = requestAnimationFrame(tick);
    };
    this.audio = audio;
    tick();
  }
}
