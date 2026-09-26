// Prism v2 — orchestration : dock de saisie, cycle de vie des cartes, messages des widgets, persistance.

import { account, api, canAfford, onAccountChange, setSparks, signOut } from "./account.js";
import { initAccountUi, openAuth, openPro, requireAccount } from "./account-ui.js";
import { Bus } from "./bus.js";
import { Canvas, CARD_MIN_H, CARD_MIN_W } from "./canvas.js";
import { engine, engineReady, generate, hasModel, initSettings, onEngineChange, openSettings } from "./engine.js";
import { forRequest } from "./files.js";
import { Inspector } from "./inspector.js";
import { Links } from "./links.js";
import { run } from "./offload.js";
import { initHub, openHub } from "./hub.js";
import { Reflections } from "./reflections.js";
import { Spotlight } from "./spotlight.js";
import { acceptStorage, acceptThumbnail, bootSrcdoc, buildSrcdoc, exportHtml, FRAME_SANDBOX, isAccent, needsBoot } from "./sandbox.js";
import { cardStore, loadView, saveView } from "./store.js";
import { fetchWidget, flushAll, importCard, isLinked, listWidgets, markSynced, pushThumbnail, queueSync, removeFromCanvas, unlink, uploadFile } from "./sync.js";

const $ = (id) => document.getElementById(id);
const cards = new Map(); // id -> carte (champs persistés + état d'exécution : status, controller, timer…)
const saveTimers = new Map();
const SIZES = { widget: { w: 460, h: 420 }, file: { w: 640, h: 480 } };
const DRAFT_KEY = "prism:draft";
const PLACEHOLDER = "Décrivez un widget, ou glissez un fichier CSV, JSON ou TXT…";
const REVEAL_TIMEOUT_MS = 6000; // widget muet (pas de signal « ready ») : affiché quand même
let attachment = null;
let reading = null; // nom du fichier en cours d'analyse dans le Web Worker

// ============================================================================
// Utilitaires
// ============================================================================
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

function promptTitle(prompt) {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 46)}…` : t;
}

function titleFrom(html, fallback) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  if (m) {
    // DOMParser décode les entités sans rien exécuter.
    const t = new DOMParser().parseFromString(`<!doctype html><title>${m[1]}</title>`, "text/html").title.trim();
    if (t) return t.slice(0, 80);
  }
  return fallback;
}

function slug(text) {
  const s = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 60) || "widget";
}

function metaLabel(card) {
  if (card.status === "loading") return "génération…";
  if (!card.mode) return "";
  return card.mode === "mock" ? "Démo" : String(card.model || "").replace(/^openai\//, "");
}

// ============================================================================
// Toast (avec action facultative, ex. « Annuler »)
// ============================================================================
let toastTimer = null;
function toast(message, { action = null, timeout = 3200, tone = "info" } = {}) {
  const box = $("toast");
  clearTimeout(toastTimer);
  box.replaceChildren();
  box.dataset.tone = tone;
  const text = document.createElement("span");
  text.textContent = message;
  box.append(text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      box.hidden = true;
      action.onClick();
    });
    box.append(btn);
  }
  box.hidden = false;
  toastTimer = setTimeout(() => { box.hidden = true; }, timeout);
}

let storageWarned = false;
function storageFailure(err) {
  console.warn("Prism : sauvegarde locale impossible", err);
  if (storageWarned) return;
  storageWarned = true;
  toast("Sauvegarde locale indisponible : les cartes ne survivront pas au rechargement.", { tone: "error", timeout: 7000 });
}

// ============================================================================
// Persistance (IndexedDB, écritures regroupées)
// ============================================================================
async function persist(card) {
  clearTimeout(saveTimers.get(card.id));
  saveTimers.delete(card.id);
  if (!card.html || !cards.has(card.id)) return;
  card.updatedAt = Date.now();
  queueSync(card); // copie vers « Mon Hub » (champs changés seulement, regroupés)
  try {
    await cardStore.put(card);
  } catch (err) {
    storageFailure(err);
  }
}

function scheduleSave(card, delay = 300) {
  if (!card.html) return;
  clearTimeout(saveTimers.get(card.id));
  saveTimers.set(card.id, setTimeout(() => persist(card), delay));
}

function flushSaves() {
  for (const id of [...saveTimers.keys()]) {
    const card = cards.get(id);
    if (card) persist(card);
  }
  flushAll(cards); // copies vers « Mon Hub » en attente : envoyées avant le départ de la page
}
addEventListener("pagehide", flushSaves);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSaves();
});

// ============================================================================
// Canvas et inspecteur
// ============================================================================
let viewTimer = null;
const canvas = new Canvas({
  workspace: $("workspace"),
  world: $("world"),
  onViewChange: (view) => {
    $("zoom-reset").textContent = `${Math.round(view.z * 100)} %`;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => saveView(canvas.view), 250);
  },
  onCardChange: (card) => scheduleSave(card),
  onSelect: (id) => {
    if (inspector.isOpen && inspector.card?.id !== id) inspector.open(cards.get(id), { focus: false });
  },
  onInspect: (id) => inspector.open(cards.get(id)),
  onAction: (id, action) => {
    const card = cards.get(id);
    if (!card) return;
    if (action === "close") closeCard(card);
    else if (action === "cancel") card.controller?.abort();
    else if (action === "retry") runGeneration(card);
  },
  onBackground: () => {
    canvas.deselect();
    inspector.close();
  },
  onPlace: () => redrawLinks(),
  onAdd: (card, el) => reflections.observe(card, el),
  onRemove: (id) => reflections.unobserve(id),
});

// Reflets des bords et visibilité : une carte hors champ ne démarre qu'à son approche (cf. flushMount).
const parked = new Set(); // cartes en attente d'être visibles pour charger leur iframe
const reflections = new Reflections({
  workspace: $("workspace"),
  view: () => canvas.view,
  card: (id) => cards.get(id),
  onEnter: (card) => {
    if (parked.delete(card.id)) mountWidget(card);
  },
});

// Bus d'évènements entre widgets (cf. bus.js) et ses liaisons dessinées sur le canvas.
const links = new Links($("world"));
const bus = new Bus({
  cards: () => cards.values(),
  post: (card, message) => canvas.frame(card.id)?.contentWindow?.postMessage(message, "*"),
  onFlow: (from, to) => links.pulse(from.id, to.id),
  onTopics: (card) => {
    redrawLinks();
    inspector.refresh(card);
    scheduleSave(card);
  },
  onFlood: (card) => toast(`« ${card.title} » émet trop d'évènements : les suivants sont ignorés.`, { tone: "error", timeout: 6000 }),
});
function redrawLinks() {
  links.schedule(() => bus.links());
}

const inspector = new Inspector({
  refactor: (card, instruction) => refactorCard(card, instruction),
  undo: (card) => undoRefactor(card),
  setAccent: (card, value) => setAccent(card, value),
  copy: (card) => copyCode(card),
  download: (card) => downloadHtml(card),
  toggleCode: (card) => toggleCode(card),
  reload: (card) => {
    mountWidget(card);
    toast("Widget relancé");
  },
  resetData: (card) => {
    card.storage = {};
    card.thumbStale = true;
    mountWidget(card);
    persist(card);
    toast("Données du widget effacées");
  },
  remove: (card) => closeCard(card),
  openSettings,
  hasModel,
  engineKind: () => engine.kind,
  canUndo: (card) => Boolean(card.history?.length) || (isLinked(card) && card.serverVersions > 0),
  setMuted: (card, muted) => {
    card.busMuted = muted;
    redrawLinks();
    inspector.refresh(card);
    scheduleSave(card);
    toast(muted ? `« ${card.title} » isolée du bus` : `« ${card.title} » reconnectée au bus`);
  },
});

function updateEmpty() {
  $("canvas-empty").hidden = cards.size > 0;
  document.body.classList.toggle("is-empty", cards.size === 0); // fond animé seulement à vide
  $("card-count").textContent = cards.size ? `${cards.size} widget${cards.size > 1 ? "s" : ""}` : "";
}

/** État d'une carte : loading | busy | ready | warn | error. */
function setStatus(card, status, { text = "", error = "" } = {}) {
  card.status = status;
  card.metaLabel = metaLabel(card);
  const el = canvas.element(card.id);
  if (el) {
    el.querySelector(".card-overlay-text").textContent = text;
    el.querySelector(".card-error").hidden = status !== "error";
    el.querySelector(".card-error-text").textContent = error;
  }
  canvas.updateChrome(card);
  inspector.refresh(card);
  updateEmpty();
}

function startTimer(card) {
  const el = canvas.element(card.id);
  const started = performance.now();
  const out = el?.querySelector(".card-elapsed");
  clearInterval(card.timer);
  card.timer = setInterval(() => {
    if (out) out.textContent = `${((performance.now() - started) / 1000).toFixed(1).replace(".", ",")} s`;
  }, 100);
}

function stopTimer(card) {
  clearInterval(card.timer);
  card.timer = null;
}

// ----------------------------------------------------------------------------
// Montage des widgets : le squelette holographique reste affiché jusqu'au signal « ready » du
// widget (chargé ET stylé, cf. sandbox.js), puis fondu enchaîné. Les documents sont injectés en
// début d'image (requestAnimationFrame), une carte par image : restaurer un canvas chargé ne
// provoque pas de rafale de travail qui figerait l'interface.
// ----------------------------------------------------------------------------
const mountQueue = new Map(); // id -> carte, dans l'ordre d'arrivée
let mountScheduled = false;

function mountWidget(card) {
  const el = canvas.element(card.id);
  if (!el || !card.html) return;
  card.runtimeError = null;
  card.showCode = false;
  el.querySelector(".card-code").hidden = true;
  el.querySelector(".card-body").dataset.frame = "pending";
  if (card.status === "warn") setStatus(card, "ready");
  mountQueue.delete(card.id);
  mountQueue.set(card.id, card);
  if (!mountScheduled) {
    mountScheduled = true;
    requestAnimationFrame(flushMount);
  }
}

function flushMount() {
  mountScheduled = false;
  for (const card of mountQueue.values()) {
    mountQueue.delete(card.id);
    // Jamais démarrée et hors champ (ou pas encore vue par l'IntersectionObserver) : en attente.
    if (!card.mounted && reflections.isVisible(card.id) !== true) {
      parked.add(card.id);
      continue;
    }
    injectFrame(card);
    break;
  }
  if (mountQueue.size) {
    mountScheduled = true;
    requestAnimationFrame(flushMount);
  }
}

function injectFrame(card) {
  const el = canvas.element(card.id);
  if (!el || !cards.has(card.id)) return;
  let frame = el.querySelector("iframe.card-frame");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "card-frame";
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.setAttribute("referrerpolicy", "no-referrer");
    el.querySelector(".card-body").prepend(frame);
  }
  frame.title = `Widget : ${card.title}`;
  card.mounted = true;
  bus.reset(card); // le nouveau document se réabonnera
  if (needsBoot(card)) {
    // Fichier joint : chargeur minuscule, le document et le Blob partent sur sa demande (« boot »).
    card.boot = { html: buildSrcdoc(card, engine.libs), file: card.file.blob };
    frame.srcdoc = bootSrcdoc(engine.libs);
  } else {
    card.boot = null;
    frame.srcdoc = buildSrcdoc(card, engine.libs);
  }
  clearTimeout(card.revealTimer);
  card.revealTimer = setTimeout(() => revealFrame(card), REVEAL_TIMEOUT_MS);
}

function revealFrame(card) {
  clearTimeout(card.revealTimer);
  card.revealTimer = null;
  const body = canvas.element(card.id)?.querySelector(".card-body");
  if (body) body.dataset.frame = "live";
  if (card.thumbStale !== false) scheduleThumbnail(card, 1500); // laisser finir les animations d'entrée
}

function unmount(card) {
  card.boot = null;
  mountQueue.delete(card.id);
  parked.delete(card.id);
  clearTimeout(card.revealTimer);
  card.revealTimer = null;
  clearTimeout(card.thumbTimer);
}

// ----------------------------------------------------------------------------
// Miniatures « Mon Hub » : fabriquées par le widget lui-même (cf. sandbox.js), puis envoyées.
// ----------------------------------------------------------------------------
function scheduleThumbnail(card, delay) {
  if (!isLinked(card)) return;
  clearTimeout(card.thumbTimer);
  card.thumbTimer = setTimeout(() => {
    const body = canvas.element(card.id)?.querySelector(".card-body");
    if (!cards.has(card.id) || body?.dataset.frame !== "live" || card.showCode) return;
    canvas.frame(card.id)?.contentWindow?.postMessage({ prism: "snapshot", width: 360 }, "*");
  }, delay);
}

async function receiveThumbnail(card, data) {
  if (!acceptThumbnail(data)) return;
  if (await pushThumbnail(card, data)) {
    card.thumbStale = false;
    scheduleSave(card);
  }
}

function markChanged(card, thumbDelay = null) {
  card.thumbStale = true;
  if (thumbDelay !== null) scheduleThumbnail(card, thumbDelay);
}

// ============================================================================
// Génération, refactorisation, fermeture
// ============================================================================
function applyPayload(card, payload) {
  card.html = payload.html;
  card.mode = payload.mode;
  card.model = payload.model;
  card.elapsed_ms = payload.elapsed_ms;
  card.warnings = payload.warnings || [];
  card.title = titleFrom(payload.html, card.title);
  card.thumbStale = true;
  bus.learn(card);
  // Mode serveur : widget enregistré dans « Mon Hub » (sa refactorisation le désignera) et nouveau solde.
  if (payload.widget?.id) {
    card.serverId = payload.widget.id;
    card.serverOwner = account.user?.id ?? null;
    card.serverVersions = payload.widget.versions;
  }
  if (Number.isFinite(payload.sparks)) setSparks(payload.sparks);
}

/** Refus du serveur qui appellent une fenêtre plutôt qu'un message d'erreur. */
function handleAccountError(err, retry) {
  if (err.code === "insufficient_sparks") {
    if (Number.isFinite(err.detail?.sparks)) setSparks(err.detail.sparks);
    openPro(err.detail);
    return true;
  }
  if (err.code === "auth_required") {
    openAuth({ mode: "login", reason: `${err.message} Votre demande repartira ensuite.`, then: retry });
    return true;
  }
  return false;
}

/** Remet une demande refusée dans le dock, pour la relancer telle quelle. */
function restorePrompt(card) {
  if (!promptEl.value.trim()) {
    promptEl.value = card.prompt;
    saveDraft();
  }
  if (card.file && !attachment && !reading) setAttachment(card.file);
  updateComposer();
}

async function runGeneration(card) {
  const controller = new AbortController();
  card.controller = controller;
  setStatus(card, "loading", { text: card.file ? `Prism analyse ${card.file.name}…` : "Prism réfracte votre demande…" });
  startTimer(card);
  try {
    const payload = await generate({ prompt: card.prompt, file: forRequest(card.file), canvas: bus.context(card) }, controller.signal);
    if (!cards.has(card.id)) return;
    applyPayload(card, payload);
    setStatus(card, "ready");
    mountWidget(card);
    persist(card);
    uploadFile(card).then(() => scheduleSave(card)); // données du fichier → Hub (réouverture ailleurs)
  } catch (err) {
    if (!cards.has(card.id)) return;
    if (err.name === "AbortError") {
      discard(card);
      toast("Génération annulée");
    } else if (err.code === "insufficient_sparks" || err.code === "auth_required") {
      discard(card); // rien n'a été généré : la demande retourne dans le dock
      restorePrompt(card);
      handleAccountError(err, () => submitPrompt());
    } else {
      setStatus(card, "error", { error: `Échec : ${err.message}` });
    }
  } finally {
    stopTimer(card);
    card.controller = null;
  }
}

async function refactorCard(card, instruction) {
  if (card.status === "busy" || card.status === "loading") return;
  if (engine.kind === "server") {
    if (!requireAccount(() => refactorCard(card, instruction), "Connectez-vous pour refactoriser vos widgets.")) return;
    if (!canAfford("refactor")) return openPro({ sparks: account.user.sparks, required: account.pricing.refactor });
    if (!isLinked(card)) {
      // Carte créée hors compte (moteur navigateur, avant connexion) : ajoutée d'abord à « Mon Hub ».
      try {
        await importCard(card);
        persist(card);
        toast("Carte ajoutée à Mon Hub");
      } catch (err) {
        toast(`Ajout à Mon Hub impossible : ${err.message}`, { tone: "error", timeout: 7000 });
        return;
      }
    }
  }
  const controller = new AbortController();
  card.controller = controller;
  setStatus(card, "busy", { text: "Refactorisation en cours…" });
  startTimer(card);
  try {
    const payload = await generate(
      { prompt: instruction, file: forRequest(card.file), baseHtml: card.html, widgetId: card.serverId, canvas: bus.context(card) },
      controller.signal,
    );
    if (!cards.has(card.id)) return;
    card.history = [card.html, ...(card.history || [])].slice(0, 5);
    applyPayload(card, payload);
    setStatus(card, "ready");
    mountWidget(card);
    persist(card);
    if (inspector.card?.id === card.id) $("refactor-input").value = "";
    toast("Carte refactorisée", { action: { label: "Annuler", onClick: () => undoRefactor(card) }, timeout: 6000 });
  } catch (err) {
    if (!cards.has(card.id)) return;
    setStatus(card, "ready");
    if (err.name === "AbortError" || handleAccountError(err, () => refactorCard(card, instruction))) return;
    toast(`Refactorisation impossible : ${err.message}`, { tone: "error", timeout: 7000 });
  } finally {
    stopTimer(card);
    card.controller = null;
  }
}

async function undoRefactor(card) {
  if (!cards.has(card.id)) return;
  let [previous, ...rest] = card.history || [];
  if (isLinked(card) && (card.serverVersions > 0 || previous === undefined)) {
    // Le serveur garde ses versions (y compris celles d'un autre appareil) : la prochaine
    // refactorisation doit partir de la version restaurée.
    try {
      const detail = await api(`/api/widgets/${encodeURIComponent(card.serverId)}/undo`, { method: "POST" });
      previous = detail.html;
      card.serverVersions = detail.versions;
    } catch (err) {
      if (err.code !== "no_history" || previous === undefined) {
        toast(`Annulation impossible : ${err.message}`, { tone: "error", timeout: 6000 });
        return;
      }
    }
    if (!cards.has(card.id)) return;
  }
  if (previous === undefined) return;
  card.html = previous;
  card.history = rest;
  card.title = titleFrom(previous, card.title);
  bus.learn(card);
  markChanged(card);
  setStatus(card, "ready");
  mountWidget(card);
  persist(card);
  toast("Version précédente restaurée");
}

/** Retire une carte sans possibilité de retour (génération annulée ou échouée). */
function discard(card) {
  unmount(card);
  bus.drop(card);
  cards.delete(card.id);
  canvas.remove(card.id);
  redrawLinks();
  if (inspector.card?.id === card.id) inspector.close();
  updateEmpty();
}

function closeCard(card) {
  card.controller?.abort();
  const hadWidget = Boolean(card.html);
  discard(card);
  clearTimeout(saveTimers.get(card.id));
  saveTimers.delete(card.id);
  if (!hadWidget) return;
  cardStore.remove(card.id).catch(storageFailure);
  removeFromCanvas(card); // le widget reste dans « Mon Hub »
  toast(`« ${card.title} » fermée`, {
    action: { label: "Rétablir", onClick: () => restoreCard(card) },
    timeout: 6000,
  });
}

function restoreCard(card) {
  cards.set(card.id, card);
  canvas.add(card);
  setStatus(card, "ready");
  mountWidget(card);
  persist(card);
  canvas.select(card.id);
}

function setAccent(card, value) {
  if (!isAccent(value)) return;
  card.accent = value;
  canvas.updateChrome(card);
  canvas.frame(card.id)?.contentWindow?.postMessage({ prism: "accent", value }, "*");
  inspector.refresh(card);
  scheduleSave(card);
  markChanged(card, 1500);
}

function toggleCode(card) {
  const el = canvas.element(card.id);
  if (!el) return;
  card.showCode = !card.showCode;
  const pre = el.querySelector(".card-code");
  if (card.showCode) pre.textContent = card.html;
  pre.hidden = !card.showCode;
  inspector.refresh(card);
}

async function copyCode(card) {
  const pending = exportHtml(card); // lecture du Blob du fichier joint : asynchrone
  let html;
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      // Promesse confiée au presse-papiers : la copie reste rattachée au clic (exigence de Safari).
      const blob = pending.then((text) => new Blob([text], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    } else {
      await navigator.clipboard.writeText(await pending);
    }
    html = await pending;
  } catch {
    html = await pending;
    const area = document.createElement("textarea");
    area.value = html;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) return toast("Copie refusée par le navigateur", { tone: "error" });
  }
  toast(`Code complet copié (${(html.length / 1024).toFixed(1).replace(".", ",")} Ko)`);
}

async function downloadHtml(card) {
  const blob = new Blob([await exportHtml(card)], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(card.title)}.html`;
  document.body.append(a);
  a.click();
  a.remove();
  // Révocation tardive : sur une machine chargée, un téléchargement peut démarrer lentement.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`Téléchargement : ${a.download}`);
}

// ============================================================================
// Messages des widgets (données non fiables : validées ici)
// ============================================================================
function cardFromSource(source) {
  for (const card of cards.values()) {
    if (canvas.frame(card.id)?.contentWindow === source) return card;
  }
  return null;
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data.prism !== "string") return;
  const card = cardFromSource(event.source);
  if (!card) return;
  if (data.prism === "boot") {
    // Une seule livraison par montage.
    const payload = card.boot;
    card.boot = null;
    if (payload) canvas.frame(card.id)?.contentWindow?.postMessage({ prism: "boot", ...payload }, "*");
  } else if (data.prism === "storage") {
    const clean = acceptStorage(data.data);
    if (!clean) return toast(`« ${card.title} » : données refusées (plus de 1 Mo ou format invalide)`, { tone: "error" });
    card.storage = clean;
    scheduleSave(card);
    inspector.refresh(card);
    markChanged(card, 8000); // miniature rafraîchie une fois l'utilisateur au calme
  } else if (data.prism === "emit") {
    bus.emit(card, data.topic, data.data);
    if (inspector.card?.id === card.id) inspector.refresh(card); // compteur et dernière valeur
  } else if (data.prism === "subscribe") {
    bus.subscribe(card, data.topic, data.replay !== false);
  } else if (data.prism === "pointer") {
    reflections.moveInFrame(canvas.frame(card.id), Number(data.x), Number(data.y));
  } else if (data.prism === "spotlight") {
    toggleSpotlight();
  } else if (data.prism === "thumbnail") {
    if (data.data) receiveThumbnail(card, data.data);
    else console.warn(`Prism : miniature de « ${card.title} » impossible`, data.error);
  } else if (data.prism === "focus") {
    canvas.select(card.id);
  } else if (data.prism === "zoom") {
    // Ctrl + molette au-dessus d'un widget : coordonnées de l'iframe → écran.
    const frame = canvas.frame(card.id);
    const [x, y, dy] = [data.x, data.y, data.deltaY].map(Number);
    if (!frame || ![x, y, dy].every(Number.isFinite)) return;
    const r = frame.getBoundingClientRect();
    const scale = frame.offsetWidth ? r.width / frame.offsetWidth : 1;
    canvas.wheelZoom(r.left + x * scale, r.top + y * scale, Math.max(-500, Math.min(500, dy)));
  } else if (data.prism === "ready") {
    revealFrame(card);
    const runtimeTitle = typeof data.title === "string" ? data.title.trim().slice(0, 80) : "";
    if (runtimeTitle && runtimeTitle !== card.title) {
      card.title = runtimeTitle;
      canvas.updateChrome(card);
      inspector.refresh(card);
      scheduleSave(card);
    }
  } else if (data.prism === "error") {
    const first = !card.runtimeError;
    card.runtimeError = `${String(data.message).slice(0, 160)}${data.line ? ` (ligne ${data.line})` : ""}`;
    if (card.status === "ready") setStatus(card, "warn");
    canvas.element(card.id)?.querySelector(".card-meta")?.setAttribute("title", `Erreur JS : ${card.runtimeError}`);
    if (first) toast(`Erreur JS dans « ${card.title} » : ${card.runtimeError}`, { tone: "error", timeout: 6000 });
  }
});

// ============================================================================
// Dock : saisie, exemples, fichier joint (sélecteur, glisser-déposer, collage)
// ============================================================================
const promptEl = $("prompt");

function autosize() {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 168)}px`;
}

function updateComposer() {
  $("examples").hidden = Boolean(promptEl.value.trim() || attachment);
  autosize();
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, promptEl.value); } catch { /* stockage indisponible */ }
}

function setAttachment(att) {
  attachment = att;
  const box = $("attachment");
  box.hidden = !att && !reading;
  $("dock").classList.toggle("has-file", Boolean(att || reading));
  if (reading && !att) {
    box.dataset.state = "reading";
    delete box.dataset.kind;
    $("file-name").textContent = reading;
    $("file-meta").textContent = "Analyse en cours…";
  } else {
    delete box.dataset.state;
  }
  if (att) {
    box.dataset.kind = att.kind;
    $("file-name").textContent = att.name;
    $("file-meta").textContent = att.meta;
  }
  promptEl.placeholder = att ? "Que voulez-vous faire de ce fichier ? (facultatif)" : PLACEHOLDER;
  updateComposer();
}

/** Analyse dans le Web Worker : l'interface reste fluide, même pour 5 Mo de CSV. */
let readToken = 0; // un nouveau dépôt (ou « retirer ») rend caduque l'analyse en cours
async function attach(job, name) {
  const token = ++readToken;
  reading = name;
  setAttachment(null);
  try {
    const att = await job;
    if (token !== readToken) return;
    reading = null;
    setAttachment(att);
    promptEl.focus();
  } catch (err) {
    if (token !== readToken) return;
    reading = null;
    setAttachment(null);
    toast(`Fichier refusé : ${err.message}`, { tone: "error", timeout: 6000 });
  }
}

function clearAttachment() {
  readToken += 1;
  reading = null;
  setAttachment(null);
}

function handleFiles(fileList) {
  const file = fileList && fileList[0];
  if (!file) return;
  if (fileList.length > 1) toast("Un fichier à la fois : seul le premier est joint.");
  attach(run("attach", { file }), file.name);
}

function newCardSize(kind) {
  const area = canvas.safeArea();
  const z = canvas.view.z;
  return {
    w: Math.round(Math.min(kind.w, Math.max(CARD_MIN_W, (area.width - 16) / z))),
    h: Math.round(Math.min(kind.h, Math.max(CARD_MIN_H, (area.height - 16) / z))),
  };
}

function submitPrompt() {
  const text = promptEl.value.trim();
  if (reading) {
    toast(`Analyse de ${reading} en cours… un instant.`);
    return;
  }
  if (!text && !attachment) {
    $("dock").classList.add("is-invalid");
    setTimeout(() => $("dock").classList.remove("is-invalid"), 600);
    toast("Décrivez un widget ou joignez un fichier.");
    promptEl.focus();
    return;
  }
  if (engine.kind === "server") {
    // Compte et solde vérifiés avant de créer la carte : la demande reste dans le dock.
    const gift = `${String(account.signupSparks).replace(".", ",")} Sparks offerts à l'inscription`;
    if (!requireAccount(() => submitPrompt(), `Créez votre compte pour générer : ${gift}. Votre demande partira ensuite.`)) return;
    if (!canAfford("generate")) return openPro({ sparks: account.user.sparks, required: account.pricing.generate });
  }
  const prompt = text || `Crée le widget le plus utile pour explorer le fichier ${attachment.name}.`;
  const { w, h } = newCardSize(attachment ? SIZES.file : SIZES.widget);
  const card = {
    id: uid(),
    title: promptTitle(text || attachment.name),
    prompt,
    html: "",
    file: attachment,
    storage: {},
    accent: null,
    ...canvas.findSpot(w, h),
    w,
    h,
    createdAt: Date.now(),
    history: [],
    status: "loading",
  };
  cards.set(card.id, card);
  canvas.add(card);
  canvas.select(card.id);
  canvas.ensureVisible(card);
  promptEl.value = "";
  saveDraft();
  clearAttachment();
  runGeneration(card);
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitPrompt();
});
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitPrompt();
  }
});
promptEl.addEventListener("input", () => {
  updateComposer();
  saveDraft();
});
promptEl.addEventListener("paste", (e) => {
  if (e.clipboardData?.files?.length) {
    e.preventDefault();
    handleFiles(e.clipboardData.files);
  }
});
$("examples").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.dataset.sample === "csv") attach(run("sample"), "ventes-2025.csv");
  else promptEl.value = chip.dataset.prompt;
  updateComposer();
  promptEl.focus();
});
$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  handleFiles(e.target.files);
  e.target.value = "";
});
$("file-remove").addEventListener("click", () => {
  clearAttachment();
  promptEl.focus();
});

// Glisser-déposer : la cible visible est le dock ; un dépôt ailleurs sur la page est aussi accepté.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add("is-dropping");
});
addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  $("dock").classList.toggle("is-drop-target", Boolean(e.target.closest?.("#dock")));
});
addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("is-dropping");
});
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("is-dropping");
  $("dock").classList.remove("is-drop-target");
  handleFiles(e.dataTransfer.files);
});

// ============================================================================
// Barre du haut et raccourcis
// ============================================================================
$("zoom-in").addEventListener("click", () => canvas.zoomBy(1.2));
$("zoom-out").addEventListener("click", () => canvas.zoomBy(1 / 1.2));
$("zoom-reset").addEventListener("click", () => canvas.zoomBy(1 / canvas.view.z));
$("zoom-fit").addEventListener("click", () => canvas.fit());
$("arrange").addEventListener("click", () => {
  if (cards.size) canvas.arrange();
  else toast("Aucun widget à ranger.");
});

addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    toggleSpotlight();
  } else if (e.key === "/" && !typing) {
    e.preventDefault();
    promptEl.focus();
  } else if (e.key === "Escape" && inspector.isOpen && !e.target.closest?.("dialog")) {
    inspector.close();
  }
});

// ============================================================================
// Spotlight (Ctrl/Cmd + K) : générer, sauter à une carte, commandes, « Mon Hub »
// ============================================================================
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
let hubCache = { at: 0, items: [], loading: false };

function focusCard(card) {
  canvas.select(card.id);
  canvas.ensureVisible(card);
  const el = canvas.element(card.id);
  if (!el) return;
  el.classList.remove("is-flash");
  void el.offsetWidth; // relance l'animation
  el.classList.add("is-flash");
}

function hubResults() {
  if (engine.kind !== "server" || !account.user) return [];
  if (Date.now() - hubCache.at > 60000 && !hubCache.loading) {
    hubCache.loading = true;
    listWidgets({ limit: 100 })
      .then((page) => {
        hubCache = { at: Date.now(), items: page.items, loading: false };
        spotlight.refresh();
      })
      .catch(() => { hubCache.loading = false; });
  }
  return hubCache.items.filter((w) => !localCardFor(w.id)).map((w) => ({
    group: "Mon Hub", icon: "▦", label: w.title, keywords: [w.prompt, w.file_name || ""], hint: "Ouvrir",
    run: () => openWidget(w.id),
  }));
}

function spotlightItems(query) {
  const text = query.trim();
  const short = (t) => (t.length > 70 ? `${t.slice(0, 69)}…` : t);
  const items = [];
  const selected = canvas.selectedId ? cards.get(canvas.selectedId) : null;
  if (text) {
    items.push({
      kind: "generate", group: "Générer", icon: "✦", label: `Générer « ${short(text)} »`, hint: "Entrée", always: true, base: 50,
      run: () => {
        promptEl.value = text;
        saveDraft();
        updateComposer();
        submitPrompt();
      },
    });
    if (selected?.html && hasModel()) {
      items.push({
        kind: "generate", group: "Générer", icon: "✎", label: `Refactoriser « ${selected.title} » : ${short(text)}`, always: true, base: 45,
        run: () => refactorCard(selected, text),
      });
    }
  }
  for (const card of cards.values()) {
    items.push({
      group: "Cartes du canvas", icon: "◧", label: card.title, keywords: [card.prompt, ...(card.topics?.emits || [])],
      hint: "Afficher", base: 2, run: () => focusCard(card),
    });
  }
  const command = (label, icon, run, keywords = [], hint = "") => items.push({ group: "Commandes", icon, label, run, keywords, hint, base: 3 });
  command("Tout voir", "⤢", () => canvas.fit(), ["cadrer", "fit", "zoom", "vue"]);
  if (cards.size) command("Ranger les cartes", "▤", () => canvas.arrange(), ["grille", "organiser", "aligner"]);
  command("Zoom 100 %", "⊙", () => canvas.zoomBy(1 / canvas.view.z), ["taille réelle", "reset"]);
  command("Nouveau widget", "＋", () => promptEl.focus(), ["écrire", "créer", "demande", "dock"], "/");
  command("Joindre un fichier CSV, JSON ou TXT", "📎", () => $("file-input").click(), ["importer", "fichier", "données", "upload"]);
  command("Essayer avec l'exemple CSV", "📈", () => {
    attach(run("sample"), "ventes-2025.csv");
    promptEl.focus();
  }, ["démo", "ventes"]);
  if (selected) {
    command(`Inspecter « ${selected.title} »`, "☰", () => inspector.open(selected), ["réglages", "carte", "accent"]);
    command(`Exporter « ${selected.title} » en .html`, "⭳", () => downloadHtml(selected), ["télécharger", "export"]);
    command(`${selected.busMuted ? "Reconnecter" : "Isoler"} « ${selected.title} » ${selected.busMuted ? "au" : "du"} bus`, "⇄",
      () => inspector.actions.setMuted(selected, !selected.busMuted), ["évènements", "bus"]);
    command(`Fermer « ${selected.title} »`, "✕", () => closeCard(selected), ["supprimer", "retirer"]);
  }
  if (engine.kind === "server" && account.user) {
    command("Mon Hub", "▦", () => openHub(), ["bibliothèque", "historique", "widgets"]);
    command("Prism Pro", "✦", () => openPro(), ["sparks", "abonnement", "crédits"]);
    command("Se déconnecter", "⎋", () => {
      signOut();
      toast("Déconnecté");
    }, ["compte", "logout"]);
  } else if (engine.kind === "server") {
    command("Se connecter", "⎆", () => openAuth({ mode: "login" }), ["compte", "login", "inscription"]);
  }
  command("Moteur de génération", "⚙", () => openSettings(), ["réglages", "clé", "gemini", "modèle"]);
  if (!text) {
    document.querySelectorAll("#examples .chip[data-prompt]").forEach((chip) => {
      items.push({ group: "Suggestions", icon: "✧", label: chip.dataset.prompt, base: 1, run: () => spotlight.open(chip.dataset.prompt) });
    });
  }
  items.push(...hubResults());
  return items;
}

const spotlight = new Spotlight({
  provide: spotlightItems,
  onError: (err) => toast(`Action impossible : ${err.message}`, { tone: "error", timeout: 6000 }),
});

function toggleSpotlight() {
  // Une autre fenêtre (réglages, compte, Hub…) a la main : on ne l'empile pas.
  if (!spotlight.isOpen && document.querySelector("dialog[open]:not(#spotlight)")) return;
  spotlight.toggle();
}

$("btn-spotlight").addEventListener("click", () => spotlight.open());
if (IS_MAC) {
  $("spot-kbd").textContent = "⌘ K";
  document.querySelectorAll(".kbd-mod").forEach((k) => { k.textContent = "⌘"; });
}

// ============================================================================
// « Mon Hub » : réouverture, suppression, restauration du canvas depuis le serveur
// ============================================================================
const localCardFor = (serverId) => [...cards.values()].find((c) => c.serverId === serverId && isLinked(c)) || null;

/** Widget du serveur → carte. place : "saved" (sa position enregistrée) ou "view" (place libre à l'écran). */
function cardFromServer({ detail, blob }, place) {
  const layout = place === "saved" ? detail.layout : null;
  const size = detail.layout ? { w: detail.layout.w, h: detail.layout.h } : newCardSize(detail.file ? SIZES.file : SIZES.widget);
  const card = {
    id: uid(),
    title: detail.title,
    prompt: detail.prompt,
    html: detail.html,
    file: detail.file ? { ...detail.file, meta: `${detail.file.kind.toUpperCase()} · ${detail.file.name}`, blob: blob || undefined } : null,
    storage: detail.storage || {},
    accent: detail.accent,
    ...(layout ? { x: layout.x, y: layout.y, z: layout.z } : canvas.findSpot(size.w, size.h)),
    ...size,
    mode: detail.mode,
    model: detail.model,
    createdAt: Date.parse(detail.created_at) || Date.now(),
    history: [],
    status: "ready",
    serverId: detail.id,
    serverOwner: account.user.id,
    serverVersions: detail.versions,
    fileSynced: Boolean(blob),
    thumbStale: !detail.thumbnail,
  };
  bus.learn(card);
  markSynced(card);
  if (!layout) card.synced.layout = null; // nouvelle position : à envoyer
  cards.set(card.id, card);
  canvas.add(card, { animate: !layout });
  setStatus(card, "ready");
  mountWidget(card);
  persist(card);
  if (detail.file && !blob) {
    toast(`« ${card.title} » : données du fichier absentes (jamais téléversées depuis l'appareil d'origine).`, { tone: "error", timeout: 7000 });
  }
  return card;
}

async function openWidget(serverId) {
  const card = localCardFor(serverId) || cardFromServer(await fetchWidget(serverId), "view");
  canvas.select(card.id);
  canvas.ensureVisible(card);
}

function onWidgetDeleted(serverId) {
  const card = localCardFor(serverId);
  if (!card) return toast("Widget supprimé de Mon Hub");
  unlink(card); // plus rien à synchroniser
  card.controller?.abort();
  discard(card);
  cardStore.remove(card.id).catch(storageFailure);
  toast(`« ${card.title} » supprimé de Mon Hub et du canvas`);
}

/** Connexion (ou démarrage) : les cartes posées sur le canvas depuis un autre appareil arrivent ici. */
let syncing = null;
let started = false; // canvas local restauré (cf. start)
function syncCanvasFromServer() {
  if (engine.kind !== "server" || !account.user || syncing) return syncing;
  syncing = (async () => {
    try {
      const page = await listWidgets({ onCanvas: true, limit: 200 });
      const missing = page.items.filter((item) => !localCardFor(item.id));
      let restored = 0;
      for (const item of missing) {
        try {
          cardFromServer(await fetchWidget(item.id), "saved");
          restored += 1;
        } catch (err) {
          console.warn("Prism : widget non restauré", item.id, err);
        }
      }
      if (restored) {
        toast(`${restored} widget${restored > 1 ? "s" : ""} de Mon Hub ${restored > 1 ? "restaurés" : "restauré"} sur le canvas`);
        if (restored === cards.size) canvas.fit(); // appareil neuf : on cadre les cartes arrivées
      }
    } catch (err) {
      if (err.status !== 401) console.warn("Prism : canvas non synchronisé avec Mon Hub", err);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// ============================================================================
// Démarrage : restauration du canvas
// ============================================================================
async function start() {
  initSettings((message) => toast(message));
  initAccountUi({ toast: (message) => toast(message) });
  initHub({ openWidget, isOnCanvas: (serverId) => Boolean(localCardFor(serverId)), onDeleted: onWidgetDeleted, toast });
  onAccountChange((state, change) => {
    if (change.signedIn) syncCanvasFromServer();
  });
  onEngineChange(() => {
    inspector.refresh(inspector.card);
    // API distante réveillée après le démarrage : le canvas rejoint « Mon Hub » (jamais avant la
    // restauration locale, sinon des cartes seraient ajoutées en double).
    if (started && engine.kind === "server") syncCanvasFromServer();
  });
  try {
    promptEl.value = localStorage.getItem(DRAFT_KEY) || "";
  } catch { /* stockage indisponible */ }
  updateComposer();

  await engineReady;
  const area = canvas.safeArea();
  canvas.setView(loadView() || { x: area.left + area.width / 2, y: area.top + area.height / 2, z: 1 });

  let saved = [];
  try {
    saved = await cardStore.all();
  } catch (err) {
    storageFailure(err);
  }
  saved.sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((record) => {
    const card = { ...record, storage: record.storage || {}, history: record.history || [], status: "ready" };
    if (card.file && card.file.data !== undefined && !card.file.blob) {
      // Carte v2 : données en objets → Blob JSON (une fois pour toutes).
      const { data, ...rest } = card.file;
      card.file = { ...rest, blob: new Blob([JSON.stringify(data)], { type: "application/json" }) };
      persist(card);
    }
    if (!card.topics) bus.learn(card); // cartes d'avant le bus : sujets relus dans le code
    cards.set(card.id, card);
    canvas.add(card, { animate: false });
    setStatus(card, "ready");
    mountWidget(card);
  });
  updateEmpty();
  redrawLinks();
  document.body.classList.add("is-ready");
  started = true;
  syncCanvasFromServer();
}

start();
