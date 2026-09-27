// V5 · Mode spatial : le Liquid Glass sort de l'écran plat.
//  - Aperçu spatial (tout navigateur) : les cartes se disposent en arc, inclinées vers vous selon leur place à l'écran,
//    avec une profondeur ; le canvas reste utilisable (pan, zoom, cartes).
//  - Réalité mixte (WebXR « immersive-ar » avec superposition DOM, ex. Chrome sur Android) : la session projette
//    l'interface Prism par-dessus la vue de la caméra ; une couche WebGL transparente sert de support à la session.
//    Disponible seulement si l'appareil le permet (vérifié avant d'afficher le bouton).

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Inclinaison et profondeur d'une carte selon la position horizontale de son centre (−1 à gauche, 1 à droite). */
export function arcOf(offset) {
  const u = clamp(offset, -1, 1);
  return { tilt: -u * 22, depth: -Math.abs(u) * 140, lift: Math.abs(u) * 10 };
}

export class Spatial {
  constructor({ workspace, cards, onChange = () => {} }) {
    Object.assign(this, { workspace, cards, onChange });
    this.on = false;
    this.session = null;
    this.xr = null; // null : inconnu ; true/false après vérification
  }

  /** L'appareil sait-il faire de la réalité mixte avec superposition DOM ? (réponse attendue 1,5 s au plus : sans
   *  environnement de réalité virtuelle, certains navigateurs ne répondent jamais.) */
  async detect() {
    if (this.xr !== null) return this.xr;
    const xr = globalThis.navigator?.xr;
    if (!xr?.isSessionSupported) return (this.xr = false);
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 1500));
    try {
      this.xr = Boolean(await Promise.race([xr.isSessionSupported("immersive-ar"), timeout]));
    } catch {
      this.xr = false;
    }
    return this.xr;
  }

  toggle(force = !this.on) {
    this.on = Boolean(force);
    document.body.classList.toggle("is-spatial", this.on);
    if (this.on) this.layout();
    else for (const el of this.workspace.querySelectorAll(".card")) el.style.removeProperty("--arc");
    this.onChange(this.on);
    return this.on;
  }

  /** Recalcule l'arc (à chaque changement de vue ou de carte, en mode spatial). */
  layout() {
    if (!this.on) return;
    const r = this.workspace.getBoundingClientRect();
    const half = r.width / 2 || 1;
    for (const el of this.workspace.querySelectorAll(".card")) {
      const b = el.getBoundingClientRect();
      const { tilt, depth, lift } = arcOf((b.left + b.width / 2 - (r.left + half)) / half);
      el.style.setProperty("--arc", `translateZ(${depth.toFixed(1)}px) translateY(${(-lift).toFixed(1)}px) rotateY(${tilt.toFixed(2)}deg)`);
    }
  }

  /** Réalité mixte : session WebXR immersive-ar, interface Prism en superposition DOM. */
  async enterXR() {
    const xr = globalThis.navigator?.xr;
    if (!xr || !(await this.detect())) throw new Error("La réalité mixte n'est pas disponible sur cet appareil.");
    const session = await xr.requestSession("immersive-ar", { optionalFeatures: ["dom-overlay", "local"], domOverlay: { root: document.body } });
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", { xrCompatible: true, alpha: true });
    await gl.makeXRCompatible?.();
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    const space = await session.requestReferenceSpace("local").catch(() => session.requestReferenceSpace("viewer"));
    const frame = (_t, xrFrame) => {
      xrFrame.getViewerPose(space); // pose suivie (la superposition DOM suit la tête)
      const layer = session.renderState.baseLayer;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0, 0, 0, 0); // transparent : la pièce, puis le verre de Prism par-dessus
      gl.clear(gl.COLOR_BUFFER_BIT);
      session.requestAnimationFrame(frame);
    };
    session.requestAnimationFrame(frame);
    this.session = session;
    document.body.classList.add("is-xr");
    session.addEventListener("end", () => {
      this.session = null;
      document.body.classList.remove("is-xr");
      this.onChange(this.on);
    });
    this.onChange(this.on);
    return session;
  }

  async exitXR() {
    await this.session?.end();
  }
}
