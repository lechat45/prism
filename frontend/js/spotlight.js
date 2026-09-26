// Spotlight (Ctrl/Cmd + K) : une invite flottante pour tout faire au clavier — générer un widget,
// sauter à une carte, lancer une commande, rouvrir un widget de « Mon Hub ».
// Le contenu vient d'un fournisseur (main.js) ; ce module classe, affiche et exécute.

const $ = (id) => document.getElementById(id);
const MAX_RESULTS = 12;

/** Minuscules sans accents : « Écran » et « ecran » se valent. */
export const fold = (text) => String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

/** Pertinence d'un libellé (et de ses mots-clés) pour une requête : 0 = sans rapport. */
export function score(query, item) {
  const q = fold(query).trim();
  if (!q) return item.base ?? 1;
  let best = 0;
  for (const text of [item.label, ...(item.keywords || [])]) {
    const t = fold(text);
    if (!t) continue;
    if (t === q) best = Math.max(best, 120);
    else if (t.startsWith(q)) best = Math.max(best, 100);
    else if (t.split(/[\s·:«»"'().,/-]+/).some((w) => w.startsWith(q))) best = Math.max(best, 70);
    else if (q.split(/\s+/).every((w) => t.includes(w))) best = Math.max(best, 40);
    else {
      let i = 0; // sous-séquence : « tv » → « tout voir »
      for (const ch of t) if (ch === q[i]) i += 1;
      if (i === q.length && q.length >= 2) best = Math.max(best, 15);
    }
  }
  return best;
}

/** Éléments pertinents, les meilleurs d'abord (à score égal : ordre du fournisseur). */
export function rank(query, items) {
  return items
    .map((item, index) => ({ item, index, s: item.always ? item.base ?? 50 : score(query, item) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map((r) => r.item);
}

export class Spotlight {
  /** provide(query) → [{ id, label, group, icon, hint?, keywords?, always?, base?, run() }] */
  constructor({ provide, onError = () => {} }) {
    this.provide = provide;
    this.onError = onError;
    this.results = [];
    this.active = 0;
    this.dialog = $("spotlight");
    this.input = $("spotlight-input");
    this.list = $("spotlight-list");
    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.list.addEventListener("click", (e) => {
      const option = e.target.closest("[role=option]");
      if (option) this.run(Number(option.dataset.index));
    });
    this.list.addEventListener("pointermove", (e) => {
      const option = e.target.closest("[role=option]");
      if (option && Number(option.dataset.index) !== this.active) this.select(Number(option.dataset.index));
    });
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.close(); // clic sur le fond
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  open(text = "") {
    if (!this.isOpen) this.dialog.showModal();
    this.input.value = text;
    this.input.focus();
    this.input.select();
    this.refresh();
  }

  close() {
    if (this.isOpen) this.dialog.close();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Recalcule les résultats (aussi appelé quand une source asynchrone, ex. le Hub, arrive). */
  refresh() {
    if (!this.isOpen) return;
    const query = this.input.value;
    this.results = rank(query, this.provide(query));
    this.active = 0;
    this.render();
  }

  render() {
    let group = null;
    const nodes = [];
    this.results.forEach((item, index) => {
      if (item.group !== group) {
        group = item.group;
        const head = document.createElement("li");
        head.className = "spot-group";
        head.setAttribute("role", "presentation");
        head.textContent = group;
        nodes.push(head);
      }
      const li = document.createElement("li");
      li.id = `spot-${index}`;
      li.className = "spot-item";
      li.setAttribute("role", "option");
      li.dataset.index = String(index);
      li.dataset.kind = item.kind || "";
      const icon = document.createElement("span");
      icon.className = "spot-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = item.icon || "›";
      const label = document.createElement("span");
      label.className = "spot-label";
      label.textContent = item.label;
      li.append(icon, label);
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "spot-hint";
        hint.textContent = item.hint;
        li.append(hint);
      }
      nodes.push(li);
    });
    this.list.replaceChildren(...nodes);
    $("spotlight-empty").hidden = this.results.length > 0;
    this.select(0);
  }

  select(index) {
    if (!this.results.length) {
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    this.active = (index + this.results.length) % this.results.length;
    this.list.querySelectorAll("[role=option]").forEach((el) => {
      const on = Number(el.dataset.index) === this.active;
      el.setAttribute("aria-selected", String(on));
      if (on) el.scrollIntoView({ block: "nearest" });
    });
    this.input.setAttribute("aria-activedescendant", `spot-${this.active}`);
  }

  onKey(e) {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      this.select(this.active + 1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      this.select(this.active - 1);
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      this.run(this.active);
    }
  }

  async run(index) {
    const item = this.results[index];
    if (!item) return;
    this.close();
    try {
      await item.run();
    } catch (err) {
      this.onError(err);
    }
  }
}
