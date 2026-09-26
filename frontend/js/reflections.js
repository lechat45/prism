// Reflets des bords et visibilité des cartes.
//  - Un IntersectionObserver (racine : l'espace de travail, marge 300 px) sait quelles cartes sont à
//    l'écran : seules celles-ci suivent le pointeur, et une carte hors champ n'est démarrée (iframe
//    chargée) qu'à son approche (onEnter).
//  - Reflets : le bord d'une carte capte la lumière du côté du pointeur (CSS --mx, --my, --glow).
//    Positions calculées depuis les coordonnées du monde et la vue : aucune lecture de mise en page,
//    au plus une mise à jour par image.

const REACH = 280; // px d'écran : au-delà, le bord ne s'éclaire plus

/** Éclat (0..1) et point lumineux (coordonnées de la carte) pour un pointeur en (sx, sy). */
export function glowAt(card, view, sx, sy) {
  const z = view.z;
  const left = view.x + card.x * z;
  const top = view.y + card.y * z;
  const right = left + card.w * z;
  const bottom = top + card.h * z;
  const dx = Math.max(left - sx, 0, sx - right);
  const dy = Math.max(top - sy, 0, sy - bottom);
  const glow = Math.max(0, 1 - Math.hypot(dx, dy) / REACH);
  return { glow: Math.round(glow * 100) / 100, mx: (sx - left) / z, my: (sy - top) / z };
}

export class Reflections {
  /** view() → { x, y, z } ; card(id) → carte ; onEnter(card) : une carte arrive près de l'écran. */
  constructor({ workspace, view, card, onEnter = () => {} }) {
    Object.assign(this, { view, card, onEnter });
    this.visible = new Set(); // id des cartes à l'écran (marge comprise)
    this.known = new Set(); // id des cartes dont l'IntersectionObserver a déjà rendu un premier verdict
    this.elements = new Map(); // id -> élément
    this.pointer = null;
    this.frame = 0;
    this.io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => this.onIntersect(entries), { root: workspace, rootMargin: "300px" })
      : null;
    addEventListener("pointermove", (e) => this.move(e.clientX, e.clientY), { passive: true });
    document.documentElement.addEventListener("pointerleave", () => this.move(null));
    addEventListener("blur", () => this.move(null));
  }

  observe(card, el) {
    this.elements.set(card.id, el);
    if (this.io) this.io.observe(el);
    else { this.visible.add(card.id); this.known.add(card.id); }
  }

  unobserve(id) {
    const el = this.elements.get(id);
    if (el && this.io) this.io.unobserve(el);
    this.elements.delete(id);
    this.visible.delete(id);
    this.known.delete(id);
  }

  /** undefined tant que l'observateur n'a rien dit de cette carte. */
  isVisible(id) {
    return this.known.has(id) ? this.visible.has(id) : undefined;
  }

  onIntersect(entries) {
    for (const entry of entries) {
      const id = entry.target.dataset.id;
      if (!id) continue;
      this.known.add(id);
      if (entry.isIntersecting) {
        this.visible.add(id);
        const card = this.card(id);
        if (card) this.onEnter(card);
      } else {
        this.visible.delete(id);
        this.paint(id, 0); // hors champ : plus de reflet
      }
    }
    this.schedule();
  }

  /** Pointeur en coordonnées d'écran (null : il a quitté la fenêtre). */
  move(sx, sy) {
    this.pointer = sx === null ? null : { x: sx, y: sy };
    this.schedule();
  }

  /** Pointeur au-dessus d'une iframe (relayé par son prélude) : coordonnées de l'iframe → écran. */
  moveInFrame(frame, x, y) {
    if (!frame || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const r = frame.getBoundingClientRect();
    const scale = frame.offsetWidth ? r.width / frame.offsetWidth : 1;
    this.move(r.left + x * scale, r.top + y * scale);
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  update() {
    const view = this.view();
    for (const id of this.visible) {
      const card = this.card(id);
      if (!card) continue;
      if (!this.pointer) {
        this.paint(id, 0);
        continue;
      }
      const { glow, mx, my } = glowAt(card, view, this.pointer.x, this.pointer.y);
      this.paint(id, glow, mx, my);
    }
  }

  paint(id, glow, mx, my) {
    const el = this.elements.get(id);
    if (!el) return;
    if (glow === 0 && el.dataset.glow === "0") return; // déjà éteint : aucune écriture de style
    // Pointeur sur la carte (éclat maximal) : on n'y repeint rien tant qu'il y reste. On évite ainsi de
    // repeindre sous l'iframe pendant qu'on s'en sert (clics rapides vers une iframe isolée).
    if (glow === 1 && el.dataset.glow === "1") return;
    el.dataset.glow = String(glow);
    el.style.setProperty("--glow", String(glow));
    if (glow > 0) {
      el.style.setProperty("--mx", `${Math.round(mx)}px`);
      el.style.setProperty("--my", `${Math.round(my)}px`);
    }
  }
}
