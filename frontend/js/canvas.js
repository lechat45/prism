// Canvas spatial : vue infinie (pan/zoom) et cartes déplaçables, redimensionnables, fermables.
//
// Coordonnées : chaque carte a une position « monde » (x, y, w, h). Écran = monde × z + (vue.x, vue.y).
// Les iframes avalent les évènements pointeur : pendant un glisser, <body> reçoit une classe
// qui les rend transparentes aux clics (voir style.css), en plus de la capture de pointeur.

export const CARD_MIN_W = 280;
export const CARD_MIN_H = 220;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2;
const GAP = 32;
const KEY_STEP = 16;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (t) => 1 - Math.pow(1 - t, 3);

const ICONS = {
  inspect: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 10h8M4 14h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
};

export class Canvas {
  constructor({ workspace, world, onViewChange, onCardChange, onSelect, onInspect, onAction, onBackground,
    onPlace = () => {}, onAdd = () => {}, onRemove = () => {} }) {
    Object.assign(this, { workspace, world, onViewChange, onCardChange, onSelect, onInspect, onAction, onBackground, onPlace, onAdd, onRemove });
    this.view = { x: 0, y: 0, z: 1 };
    this.cards = new Map(); // id -> { card, el }
    this.selectedId = null;
    this.topZ = 1;
    this.pointers = new Map(); // pincement tactile
    this.bindWorkspace();
  }

  // ------------------------------------------------------------------ vue
  applyView() {
    const { x, y, z } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    this.workspace.style.setProperty("--grid-size", `${28 * z}px`);
    this.workspace.style.setProperty("--grid-x", `${x}px`);
    this.workspace.style.setProperty("--grid-y", `${y}px`);
    this.onViewChange(this.view);
  }

  setView(view) {
    this.view = { x: view.x, y: view.y, z: clamp(view.z, ZOOM_MIN, ZOOM_MAX) };
    this.applyView();
  }

  screenToWorld(sx, sy) {
    const r = this.workspace.getBoundingClientRect();
    return { x: (sx - r.left - this.view.x) / this.view.z, y: (sy - r.top - this.view.y) / this.view.z };
  }

  /** Zone réellement visible (sous la barre du haut, au-dessus du dock). */
  safeArea() {
    const r = this.workspace.getBoundingClientRect();
    const top = Math.max(0, (document.querySelector(".topbar")?.getBoundingClientRect().bottom || 0) - r.top) + 12;
    const dock = document.getElementById("dock")?.getBoundingClientRect();
    const bottom = dock ? Math.min(r.height, dock.top - r.top) - 12 : r.height;
    return { left: 16, top, width: r.width - 32, height: Math.max(120, bottom - top) };
  }

  zoomAt(sx, sy, z) {
    const r = this.workspace.getBoundingClientRect();
    const px = sx - r.left;
    const py = sy - r.top;
    const next = clamp(z, ZOOM_MIN, ZOOM_MAX);
    const wx = (px - this.view.x) / this.view.z;
    const wy = (py - this.view.y) / this.view.z;
    this.setView({ x: px - wx * next, y: py - wy * next, z: next });
  }

  zoomBy(factor) {
    const r = this.workspace.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, this.view.z * factor);
  }

  animateTo(target, duration = 380) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return this.setView(target);
    const from = { ...this.view };
    const start = performance.now();
    cancelAnimationFrame(this.anim);
    const step = (now) => {
      const t = ease(Math.min(1, (now - start) / duration));
      this.setView({
        x: from.x + (target.x - from.x) * t,
        y: from.y + (target.y - from.y) * t,
        z: from.z + (target.z - from.z) * t,
      });
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Cadre toutes les cartes dans la zone visible. */
  fit() {
    const cards = [...this.cards.values()].map((c) => c.card);
    const area = this.safeArea();
    if (!cards.length) return this.animateTo({ x: area.left + area.width / 2, y: area.top + area.height / 2, z: 1 });
    const minX = Math.min(...cards.map((c) => c.x));
    const minY = Math.min(...cards.map((c) => c.y));
    const maxX = Math.max(...cards.map((c) => c.x + c.w));
    const maxY = Math.max(...cards.map((c) => c.y + c.h));
    const z = clamp(Math.min(area.width / (maxX - minX + 48), area.height / (maxY - minY + 48), 1), ZOOM_MIN, 1);
    this.animateTo({
      x: area.left + area.width / 2 - ((minX + maxX) / 2) * z,
      y: area.top + area.height / 2 - ((minY + maxY) / 2) * z,
      z,
    });
  }

  /** Range les cartes en grille (ordre de création), puis cadre l'ensemble. */
  arrange() {
    const cards = [...this.cards.values()].map((c) => c.card).sort((a, b) => a.createdAt - b.createdAt);
    if (!cards.length) return;
    const cols = Math.ceil(Math.sqrt(cards.length));
    let y = 0;
    for (let i = 0; i < cards.length; i += cols) {
      const row = cards.slice(i, i + cols);
      let x = 0;
      row.forEach((card) => {
        card.x = x;
        card.y = y;
        x += card.w + GAP;
      });
      y += Math.max(...row.map((c) => c.h)) + GAP;
    }
    this.world.classList.add("is-arranging");
    cards.forEach((card) => {
      this.place(card);
      this.onCardChange(card);
    });
    setTimeout(() => this.world.classList.remove("is-arranging"), 500);
    this.fit();
  }

  // ------------------------------------------------------------------ interactions du fond
  /** Zoom à la molette (Ctrl) autour d'un point écran ; deltaY en pixels. */
  wheelZoom(sx, sy, deltaY) {
    this.zoomAt(sx, sy, this.view.z * Math.exp(-deltaY * 0.0015));
  }

  bindWorkspace() {
    const ws = this.workspace;
    // Ctrl + molette n'importe où dans Prism (barre, dock, inspecteur…) : zoom du canvas, jamais de la page.
    // Au-dessus d'un widget, c'est son prélude qui relaie l'évènement (message « zoom »).
    addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.wheelZoom(e.clientX, e.clientY, e.deltaY * (e.deltaMode === 1 ? 16 : 1));
    }, { passive: false });
    ws.addEventListener("wheel", (e) => {
      // Sans Ctrl : la molette déplace la vue, sauf au-dessus d'une carte (elle reste à la carte).
      if (e.ctrlKey || e.metaKey || e.target.closest(".card")) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      this.setView({ x: this.view.x - e.deltaX * unit, y: this.view.y - e.deltaY * unit, z: this.view.z });
    }, { passive: false });

    ws.addEventListener("pointerdown", (e) => {
      if (e.target !== ws && e.target !== this.world) return;
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      this.onBackground();
      ws.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      document.body.classList.add("is-panning");
    });
    ws.addEventListener("pointermove", (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.entries()];
        const other = a[0] === e.pointerId ? b[1] : a[1];
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 0) this.zoomAt((e.clientX + other.x) / 2, (e.clientY + other.y) / 2, this.view.z * (after / before));
      } else {
        this.setView({ x: this.view.x + e.clientX - prev.x, y: this.view.y + e.clientY - prev.y, z: this.view.z });
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const end = (e) => {
      this.pointers.delete(e.pointerId);
      if (!this.pointers.size) document.body.classList.remove("is-panning");
    };
    ws.addEventListener("pointerup", end);
    ws.addEventListener("pointercancel", end);
  }

  // ------------------------------------------------------------------ cartes
  place(card) {
    const entry = this.cards.get(card.id);
    if (!entry) return;
    const s = entry.el.style;
    s.left = `${card.x}px`;
    s.top = `${card.y}px`;
    s.width = `${card.w}px`;
    s.height = `${card.h}px`;
    s.zIndex = card.z || 1;
    this.onPlace(card); // ex. liaisons du bus d'évènements
  }

  /** from : point du monde d'où la carte émerge (zoom fractal, incantation) ; sinon entrée simple. */
  add(card, { animate = true, from = null } = {}) {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.id = card.id;
    el.innerHTML = `
      <header class="card-bar" tabindex="0" role="button" aria-describedby="card-help">
        <span class="dot" aria-hidden="true"></span>
        <span class="card-title"></span>
        <span class="card-meta"></span>
        <span class="card-actions">
          <button type="button" class="card-btn" data-action="inspect" aria-label="Inspecter la carte">${ICONS.inspect}</button>
          <button type="button" class="card-btn" data-action="close" aria-label="Fermer la carte">${ICONS.close}</button>
        </span>
      </header>
      <div class="card-body">
        <div class="card-overlay">
          <div class="holo" aria-hidden="true">
            <span class="holo-bone holo-title"></span>
            <span class="holo-bone holo-sub"></span>
            <span class="holo-tiles"><span class="holo-bone"></span><span class="holo-bone"></span><span class="holo-bone"></span></span>
            <span class="holo-bone holo-panel"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
          </div>
          <div class="card-status">
            <p class="card-overlay-text"></p>
            <p class="card-elapsed"></p>
            <button type="button" class="tool" data-action="cancel">Annuler</button>
          </div>
        </div>
        <div class="card-error" hidden>
          <p class="card-error-text"></p>
          <button type="button" class="tool" data-action="retry">Réessayer</button>
        </div>
        <pre class="card-code" hidden></pre>
      </div>
      <div class="card-resize" aria-hidden="true"></div>`;
    if (animate && from) {
      el.style.setProperty("--from-dx", `${Math.round(from.x - (card.x + card.w / 2))}px`);
      el.style.setProperty("--from-dy", `${Math.round(from.y - (card.y + card.h / 2))}px`);
      el.classList.add("is-emerging");
    } else if (animate) el.classList.add("is-entering");
    el.addEventListener("animationend", () => el.classList.remove("is-entering", "is-emerging"), { once: true });
    this.world.append(el);
    this.cards.set(card.id, { card, el });
    card.z = card.z || ++this.topZ;
    this.topZ = Math.max(this.topZ, card.z);
    this.bindCard(card, el);
    this.place(card);
    this.updateChrome(card);
    this.onAdd(card, el);
    return el;
  }

  remove(id) {
    const entry = this.cards.get(id);
    if (!entry) return;
    this.cards.delete(id);
    this.onRemove(id);
    if (this.selectedId === id) this.selectedId = null;
    entry.el.classList.add("is-leaving");
    const done = () => entry.el.remove();
    entry.el.addEventListener("animationend", done, { once: true });
    setTimeout(done, 400);
  }

  element(id) {
    return this.cards.get(id)?.el || null;
  }

  frame(id) {
    return this.element(id)?.querySelector("iframe.card-frame") || null;
  }

  /** Titre, méta et état visuel d'une carte (data-state : loading | busy | ready | warn | error). */
  updateChrome(card) {
    const el = this.element(card.id);
    if (!el) return;
    el.dataset.state = card.status;
    el.style.setProperty("--card-accent", card.accent || "#7cc4ff");
    el.querySelector(".card-title").textContent = card.title;
    el.querySelector(".card-meta").textContent = card.metaLabel || "";
    el.querySelector(".card-bar").setAttribute("aria-label", `Carte « ${card.title} »`);
    el.setAttribute("aria-label", card.title);
  }

  select(id, { focus = false } = {}) {
    if (this.selectedId && this.selectedId !== id) this.element(this.selectedId)?.classList.remove("is-selected");
    this.selectedId = id;
    const entry = this.cards.get(id);
    if (!entry) return;
    entry.el.classList.add("is-selected");
    if (entry.card.z !== this.topZ) {
      entry.card.z = ++this.topZ;
      this.place(entry.card);
      this.onCardChange(entry.card);
    }
    if (focus) entry.el.querySelector(".card-bar").focus({ preventScroll: true });
    this.onSelect(id);
  }

  deselect() {
    if (this.selectedId) this.element(this.selectedId)?.classList.remove("is-selected");
    this.selectedId = null;
  }

  bindCard(card, el) {
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === "inspect") this.onInspect(card.id);
      else this.onAction(card.id, action);
    });

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const onResize = e.target.closest(".card-resize");
      const onBar = e.target.closest(".card-bar") && !e.target.closest("button");
      this.select(card.id);
      if (!onResize && !onBar) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      document.body.classList.add("is-dragging");
      el.classList.add(onResize ? "is-resizing" : "is-moving");
      const start = { px: e.clientX, py: e.clientY, x: card.x, y: card.y, w: card.w, h: card.h };
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.px, ev.clientY - start.py) < 4) return;
        moved = true;
        const dx = (ev.clientX - start.px) / this.view.z;
        const dy = (ev.clientY - start.py) / this.view.z;
        if (onResize) {
          card.w = Math.max(CARD_MIN_W, Math.round(start.w + dx));
          card.h = Math.max(CARD_MIN_H, Math.round(start.h + dy));
        } else {
          card.x = Math.round(start.x + dx);
          card.y = Math.round(start.y + dy);
        }
        this.place(card);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        document.body.classList.remove("is-dragging");
        el.classList.remove("is-resizing", "is-moving");
        if (moved) this.onCardChange(card);
        else if (onBar) this.onInspect(card.id);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });

    el.querySelector(".card-bar").addEventListener("keydown", (e) => {
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.onInspect(card.id);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.onAction(card.id, "close");
      } else if (arrows[e.key]) {
        e.preventDefault();
        const [dx, dy] = arrows[e.key];
        if (e.shiftKey) {
          card.w = Math.max(CARD_MIN_W, card.w + dx * KEY_STEP);
          card.h = Math.max(CARD_MIN_H, card.h + dy * KEY_STEP);
        } else {
          card.x += dx * KEY_STEP;
          card.y += dy * KEY_STEP;
        }
        this.place(card);
        this.onCardChange(card);
      }
    });
  }

  /** Vrai si un rectangle w × h en (x, y) ne touche aucune carte (marge comprise). */
  isFree(x, y, w, h) {
    return [...this.cards.values()].every(({ card: o }) =>
      x + w + GAP / 2 <= o.x || o.x + o.w + GAP / 2 <= x || y + h + GAP / 2 <= o.y || o.y + o.h + GAP / 2 <= y);
  }

  /** Emplacement libre contre une carte (à droite, dessous, à gauche, dessus…), sinon près du centre. */
  spotNear(source, w, h) {
    const { x, y } = source;
    const candidates = [
      [x + source.w + GAP, y], [x, y + source.h + GAP], [x - w - GAP, y], [x, y - h - GAP],
      [x + source.w + GAP, y + source.h + GAP], [x - w - GAP, y + source.h + GAP],
      [x + source.w + GAP, y - h - GAP], [x - w - GAP, y - h - GAP],
    ];
    const spot = candidates.find(([cx, cy]) => this.isFree(cx, cy, w, h));
    return spot ? { x: Math.round(spot[0]), y: Math.round(spot[1]) } : this.findSpot(w, h);
  }

  /** Premier emplacement libre autour du centre de la zone visible. */
  findSpot(w, h) {
    const area = this.safeArea();
    const r = this.workspace.getBoundingClientRect();
    const center = this.screenToWorld(r.left + area.left + area.width / 2, r.top + area.top + area.height / 2);
    const others = [...this.cards.values()].map((c) => c.card);
    const free = (x, y) => this.isFree(x, y, w, h);
    const stepX = (w + GAP) / 2;
    const stepY = (h + GAP) / 2;
    for (let ring = 0; ring < 14; ring++) {
      const candidates = [];
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          candidates.push([center.x - w / 2 + i * stepX, center.y - h / 2 + j * stepY]);
        }
      }
      candidates.sort((a, b) => Math.hypot(a[0] + w / 2 - center.x, a[1] + h / 2 - center.y) - Math.hypot(b[0] + w / 2 - center.x, b[1] + h / 2 - center.y));
      const spot = candidates.find(([x, y]) => free(x, y));
      if (spot) return { x: Math.round(spot[0]), y: Math.round(spot[1]) };
    }
    return { x: Math.round(center.x - w / 2 + others.length * 24), y: Math.round(center.y - h / 2 + others.length * 24) };
  }

  /** Recentre la vue sur une carte si elle sort de la zone visible. */
  ensureVisible(card) {
    const area = this.safeArea();
    const { x, y, z } = this.view;
    const left = card.x * z + x;
    const top = card.y * z + y;
    const inside = left >= area.left && top >= area.top && left + card.w * z <= area.left + area.width && top + card.h * z <= area.top + area.height;
    if (inside) return;
    const zoom = clamp(Math.min(z, area.width / (card.w + 48), area.height / (card.h + 48)), ZOOM_MIN, ZOOM_MAX);
    this.animateTo({
      x: area.left + area.width / 2 - (card.x + card.w / 2) * zoom,
      y: area.top + area.height / 2 - (card.y + card.h / 2) * zoom,
      z: zoom,
    });
  }
}
