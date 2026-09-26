// « Mon Hub » : bibliothèque des widgets du compte (mode serveur). Miniatures, recherche,
// réouverture sur le canvas (sur cet appareil ou un autre), suppression définitive.

import { account, onAccountChange } from "./account.js";
import { deleteWidget, listWidgets } from "./sync.js";

const $ = (id) => document.getElementById(id);
const PAGE = 60;
const dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const rtf = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });

let hooks = null; // { openWidget(id), isOnCanvas(id), onDeleted(id), toast }
let items = [];
let total = 0;
let loading = false;

function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.round((t - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  if (Math.abs(minutes) < 60 * 24) return rtf.format(Math.round(minutes / 60), "hour");
  if (Math.abs(minutes) < 60 * 24 * 7) return rtf.format(Math.round(minutes / 1440), "day");
  return dateFmt.format(t);
}

function matches(item, query) {
  if (!query) return true;
  const haystack = `${item.title} ${item.prompt} ${item.file_name || ""}`.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

function thumb(item) {
  if (item.thumbnail) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = item.thumbnail; // data:image/… validée par le serveur
    return img;
  }
  const ph = document.createElement("span");
  ph.className = "hub-placeholder";
  if (item.accent) ph.style.setProperty("--accent", item.accent);
  ph.textContent = (item.title.trim()[0] || "✦").toUpperCase();
  return ph;
}

function renderItem(item) {
  const el = document.createElement("article");
  el.className = "hub-item";
  el.dataset.id = item.id;
  const onCanvas = hooks.isOnCanvas(item.id);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "hub-thumb";
  open.dataset.action = "open";
  open.setAttribute("aria-label", `${onCanvas ? "Afficher" : "Ouvrir"} « ${item.title} »`);
  open.append(thumb(item));
  if (onCanvas) {
    const badge = document.createElement("span");
    badge.className = "hub-badge";
    badge.textContent = "Sur le canvas";
    open.append(badge);
  }

  const info = document.createElement("div");
  info.className = "hub-info";
  const title = document.createElement("h3");
  title.className = "hub-title";
  title.textContent = item.title || "Sans titre";
  title.title = item.prompt;
  const meta = document.createElement("p");
  meta.className = "hub-meta";
  meta.textContent = [
    when(item.updated_at),
    item.mode === "mock" ? "Démo" : item.mode === "import" ? "Importé" : item.model,
    item.file_name ? `📎 ${item.file_name}` : "",
    item.versions ? `${item.versions} version${item.versions > 1 ? "s" : ""} antérieure${item.versions > 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(" · ");
  info.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "hub-actions";
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "tool";
  openBtn.dataset.action = "open";
  openBtn.textContent = onCanvas ? "Afficher" : "Ouvrir";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "tool danger";
  del.dataset.action = "delete";
  del.textContent = "Supprimer";
  actions.append(openBtn, del);

  el.append(open, info, actions);
  return el;
}

function render() {
  const query = $("hub-search").value.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const shown = items.filter((item) => matches(item, query));
  $("hub-grid").replaceChildren(...shown.map(renderItem));
  $("hub-count").textContent = total ? `${total} widget${total > 1 ? "s" : ""}${query ? ` · ${shown.length} affiché${shown.length > 1 ? "s" : ""}` : ""}` : "";
  $("hub-empty").hidden = loading || shown.length > 0;
  $("hub-empty").textContent = items.length
    ? "Aucun widget ne correspond à cette recherche."
    : "Vos widgets apparaîtront ici dès leur génération : rouvrez-les sur n'importe quel appareil.";
  $("hub-more").hidden = items.length >= total;
  $("hub").dataset.state = loading ? "loading" : "ready";
}

async function load({ more = false } = {}) {
  if (loading) return;
  loading = true;
  if (!more) { items = []; total = 0; }
  render();
  try {
    const page = await listWidgets({ offset: more ? items.length : 0, limit: PAGE });
    items = more ? items.concat(page.items) : page.items;
    total = page.total;
  } catch (err) {
    hooks.toast(`Mon Hub indisponible : ${err.message}`, { tone: "error", timeout: 6000 });
  } finally {
    loading = false;
    render();
  }
}

export function openHub() {
  if (!account.user) return;
  $("hub-search").value = "";
  if (!$("hub").open) $("hub").showModal();
  $("hub-search").focus();
  load();
}

async function onGridClick(e) {
  const button = e.target.closest("button[data-action]");
  const itemEl = e.target.closest(".hub-item");
  if (!button || !itemEl) return;
  const id = itemEl.dataset.id;
  if (button.dataset.action === "open") {
    itemEl.classList.add("is-busy");
    try {
      await hooks.openWidget(id);
      $("hub").close();
    } catch (err) {
      hooks.toast(`Ouverture impossible : ${err.message}`, { tone: "error", timeout: 6000 });
    } finally {
      itemEl.classList.remove("is-busy");
    }
    return;
  }
  // Suppression définitive : second clic de confirmation dans les 4 secondes.
  if (!button.classList.contains("is-armed")) {
    button.classList.add("is-armed");
    button.textContent = "Confirmer ?";
    setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove("is-armed");
      button.textContent = "Supprimer";
    }, 4000);
    return;
  }
  button.disabled = true;
  try {
    await deleteWidget(id);
    items = items.filter((item) => item.id !== id);
    total = Math.max(0, total - 1);
    render();
    hooks.onDeleted(id);
  } catch (err) {
    button.disabled = false;
    hooks.toast(`Suppression impossible : ${err.message}`, { tone: "error", timeout: 6000 });
  }
}

export function initHub(options) {
  hooks = options;
  $("btn-hub").addEventListener("click", openHub);
  $("hub-close").addEventListener("click", () => $("hub").close());
  $("hub-more").addEventListener("click", () => load({ more: true }));
  $("hub-search").addEventListener("input", render);
  $("hub-grid").addEventListener("click", onGridClick);
  onAccountChange((state) => {
    $("btn-hub").hidden = !(state.enabled && state.user);
    if (!state.user && $("hub").open) $("hub").close();
  });
}
