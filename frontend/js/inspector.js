// Volet « Inspector » : refactorisation, couleur d'accent, export et actions sur la carte sélectionnée.

import { ACCENTS, isAccent } from "./sandbox.js";

const $ = (id) => document.getElementById(id);
const dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

export class Inspector {
  /** actions : { refactor, undo, setAccent, copy, download, toggleCode, reload, resetData, remove, openSettings, hasModel, engineKind, canUndo } */
  constructor(actions) {
    this.actions = actions;
    this.card = null;
    this.panel = $("inspector");
    this.buildSwatches();
    this.bind();
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  buildSwatches() {
    const box = $("swatches");
    ACCENTS.forEach(({ value, label }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.setAttribute("role", "radio");
      b.dataset.accent = value || "";
      b.title = label;
      b.setAttribute("aria-label", label);
      if (value) b.style.setProperty("--swatch", value);
      else b.classList.add("is-default");
      box.append(b);
    });
    const custom = document.createElement("label");
    custom.className = "swatch swatch-custom";
    custom.title = "Couleur personnalisée";
    custom.innerHTML = '<input type="color" id="accent-custom" aria-label="Couleur personnalisée" value="#7cc4ff">';
    box.append(custom);
  }

  bind() {
    const a = this.actions;
    $("insp-close").addEventListener("click", () => this.close());
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    $("swatches").addEventListener("click", (e) => {
      const sw = e.target.closest("button.swatch");
      if (sw && this.card) a.setAccent(this.card, sw.dataset.accent || null);
    });
    $("accent-custom").addEventListener("input", (e) => {
      if (this.card && isAccent(e.target.value)) a.setAccent(this.card, e.target.value);
    });
    $("refactor-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const instruction = $("refactor-input").value.trim();
      if (!this.card) return;
      if (!instruction) {
        $("refactor-input").focus();
        return;
      }
      a.refactor(this.card, instruction);
    });
    $("refactor-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        $("refactor-form").requestSubmit();
      }
    });
    $("refactor-settings").addEventListener("click", () => a.openSettings());
    const simple = { "undo-btn": a.undo, "copy-code": a.copy, "download-html": a.download, "toggle-code": a.toggleCode,
      "reload-card": a.reload, "reset-data": a.resetData, "delete-card": a.remove };
    for (const [id, fn] of Object.entries(simple)) {
      $(id).addEventListener("click", () => this.card && fn(this.card));
    }
  }

  /** focus: false quand le volet suit simplement la sélection (ne pas voler le focus du widget). */
  open(card, { focus = true } = {}) {
    if (!card) return;
    const switching = this.card && this.card.id !== card.id;
    this.card = card;
    if (switching) $("refactor-input").value = "";
    this.render();
    if (this.panel.hidden) {
      this.panel.hidden = false;
      document.body.classList.add("has-inspector");
    }
    if (focus) $("insp-title").focus({ preventScroll: true });
  }

  close() {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    document.body.classList.remove("has-inspector");
    const id = this.card && this.card.id;
    this.card = null;
    if (id) document.querySelector(`.card[data-id="${id}"] .card-bar`)?.focus({ preventScroll: true });
  }

  /** Rafraîchit le volet si la carte affichée a changé. */
  refresh(card) {
    if (this.card && card && this.card.id === card.id) this.render();
  }

  render() {
    const card = this.card;
    if (!card) return;
    const a = this.actions;
    $("insp-title").textContent = card.title;
    this.panel.dataset.state = card.status;
    const size = card.html ? `${(new Blob([card.html]).size / 1024).toFixed(1).replace(".", ",")} Ko` : "";
    const bits = [
      card.mode === "mock" ? "Démo" : card.model || "",
      card.createdAt ? dateFmt.format(card.createdAt) : "",
      size,
      card.file ? `fichier : ${card.file.name}` : "",
    ].filter(Boolean);
    $("insp-meta").textContent = bits.join(" · ");
    $("insp-prompt").textContent = card.prompt;

    const ready = card.status === "ready" || card.status === "warn";
    const busy = card.status === "busy" || card.status === "loading";
    const canRefactor = a.hasModel();
    $("refactor-input").disabled = !canRefactor || busy;
    $("refactor-btn").disabled = !canRefactor || busy || !ready;
    $("refactor-btn").querySelector(".cta-label").textContent = card.status === "busy" ? "Refactorisation…" : "Appliquer";
    const note = $("refactor-note");
    note.hidden = canRefactor;
    $("refactor-settings").hidden = canRefactor || a.engineKind() === "server";
    note.textContent = a.engineKind() === "server"
      ? "La refactorisation utilise un modèle : ajoutez GEMINI_API_KEY dans backend/.env."
      : "La refactorisation utilise un modèle : ajoutez votre clé Gemini gratuite.";
    $("undo-btn").hidden = !a.canUndo(card) || busy;

    document.querySelectorAll("#swatches button.swatch").forEach((sw) => {
      sw.setAttribute("aria-checked", String((sw.dataset.accent || null) === (card.accent || null)));
    });
    if (card.accent) $("accent-custom").value = card.accent;

    for (const id of ["copy-code", "download-html", "toggle-code", "reload-card", "reset-data"]) $(id).disabled = !ready;
    $("toggle-code").setAttribute("aria-pressed", String(Boolean(card.showCode)));
    $("toggle-code").textContent = card.showCode ? "Voir le widget" : "Voir le code";
    const keys = Object.keys(card.storage || {}).length;
    $("reset-data").title = keys ? `${keys} clé(s) enregistrée(s) par le widget` : "Aucune donnée enregistrée";
  }
}
