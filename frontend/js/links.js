// Liaisons du bus d'évènements sur le canvas : une courbe par couple émetteur → auditeur, sous les
// cartes, en coordonnées du monde (elles suivent pan et zoom sans aucun calcul). Chaque évènement
// livré fait courir une lueur le long de la courbe. Redessin regroupé par image (requestAnimationFrame).

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Courbe de Bézier d'un bord de la carte a vers le bord en vis-à-vis de la carte b. */
export function curve(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  let s, e, c1, c2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1;
    s = { x: dir > 0 ? a.x + a.w : a.x, y: ac.y };
    e = { x: dir > 0 ? b.x : b.x + b.w, y: bc.y };
    const k = Math.max(48, Math.abs(e.x - s.x) / 2) * dir;
    c1 = { x: s.x + k, y: s.y };
    c2 = { x: e.x - k, y: e.y };
  } else {
    const dir = dy >= 0 ? 1 : -1;
    s = { x: ac.x, y: dir > 0 ? a.y + a.h : a.y };
    e = { x: bc.x, y: dir > 0 ? b.y : b.y + b.h };
    const k = Math.max(48, Math.abs(e.y - s.y) / 2) * dir;
    c1 = { x: s.x, y: s.y + k };
    c2 = { x: e.x, y: e.y - k };
  }
  const r = (n) => Math.round(n * 10) / 10;
  return `M${r(s.x)},${r(s.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(e.x)},${r(e.y)}`;
}

export class Links {
  constructor(world) {
    this.svg = el("svg", { class: "links", "aria-hidden": "true" });
    const marker = el("marker", { id: "link-arrow", viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    marker.append(el("path", { d: "M0,0 L10,5 L0,10 z", class: "link-arrow" }));
    const defs = el("defs");
    defs.append(marker);
    this.svg.append(defs);
    world.prepend(this.svg);
    this.entries = new Map(); // "idA>idB" -> { g, line, glow, title }
    this.frame = 0;
  }

  /** Redessin au prochain rafraîchissement ; source() rend la liste des liaisons. */
  schedule(source) {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw(source());
    });
  }

  draw(links) {
    const seen = new Set();
    for (const link of links) {
      const key = `${link.from.id}>${link.to.id}`;
      seen.add(key);
      let entry = this.entries.get(key);
      if (!entry) {
        const g = el("g", { class: "link" });
        const title = el("title");
        const line = el("path", { class: "link-line", "marker-end": "url(#link-arrow)" });
        const glow = el("path", { class: "link-glow", pathLength: "100" });
        g.append(title, line, glow);
        this.svg.append(g);
        entry = { g, line, glow, title };
        this.entries.set(key, entry);
      }
      const d = curve(link.from, link.to);
      if (entry.d !== d) {
        entry.line.setAttribute("d", d);
        entry.glow.setAttribute("d", d);
        entry.d = d;
      }
      entry.g.classList.toggle("is-muted", link.muted);
      entry.title.textContent = `${link.from.title} → ${link.to.title} : ${link.topics.join(", ")}`;
    }
    for (const [key, entry] of this.entries) {
      if (!seen.has(key)) {
        entry.g.remove();
        this.entries.delete(key);
      }
    }
    this.svg.dataset.count = String(this.entries.size);
  }

  /** Un évènement vient de passer de from à to : la lueur parcourt la liaison. */
  pulse(fromId, toId) {
    const entry = this.entries.get(`${fromId}>${toId}`);
    if (!entry) return;
    const now = performance.now();
    if (now - (entry.pulsedAt || 0) < 150) return; // rafales : une lueur suffit
    entry.pulsedAt = now;
    entry.glow.classList.remove("is-pulsing");
    void entry.glow.getBBox(); // relance l'animation CSS
    entry.glow.classList.add("is-pulsing");
    entry.g.dataset.pulses = String(Number(entry.g.dataset.pulses || 0) + 1);
  }
}
