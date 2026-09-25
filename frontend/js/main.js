// Prism v2 — orchestration : dock de saisie, cycle de vie des cartes, messages des widgets, persistance.

import { Canvas, CARD_MIN_H, CARD_MIN_W } from "./canvas.js";
import { engine, engineReady, generate, hasModel, initSettings, onEngineChange, openSettings } from "./engine.js";
import { forRequest } from "./files.js";
import { Inspector } from "./inspector.js";
import { run } from "./offload.js";
import { acceptStorage, bootSrcdoc, buildSrcdoc, exportHtml, FRAME_SANDBOX, isAccent, needsBoot } from "./sandbox.js";
import { cardStore, loadView, saveView } from "./store.js";

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
});

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
    mountWidget(card);
    persist(card);
    toast("Données du widget effacées");
  },
  remove: (card) => closeCard(card),
  openSettings,
  hasModel,
  engineKind: () => engine.kind,
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
  const next = mountQueue.values().next();
  if (next.done) return;
  mountQueue.delete(next.value.id);
  injectFrame(next.value);
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
}

function unmount(card) {
  card.boot = null;
  mountQueue.delete(card.id);
  clearTimeout(card.revealTimer);
  card.revealTimer = null;
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
}

async function runGeneration(card) {
  const controller = new AbortController();
  card.controller = controller;
  setStatus(card, "loading", { text: card.file ? `Prism analyse ${card.file.name}…` : "Prism réfracte votre demande…" });
  startTimer(card);
  try {
    const payload = await generate({ prompt: card.prompt, file: forRequest(card.file) }, controller.signal);
    if (!cards.has(card.id)) return;
    applyPayload(card, payload);
    setStatus(card, "ready");
    mountWidget(card);
    persist(card);
  } catch (err) {
    if (!cards.has(card.id)) return;
    if (err.name === "AbortError") {
      discard(card);
      toast("Génération annulée");
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
  const controller = new AbortController();
  card.controller = controller;
  setStatus(card, "busy", { text: "Refactorisation en cours…" });
  startTimer(card);
  try {
    const payload = await generate(
      { prompt: instruction, file: forRequest(card.file), baseHtml: card.html },
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
    if (err.name !== "AbortError") toast(`Refactorisation impossible : ${err.message}`, { tone: "error", timeout: 7000 });
  } finally {
    stopTimer(card);
    card.controller = null;
  }
}

function undoRefactor(card) {
  if (!card.history?.length || !cards.has(card.id)) return;
  const [previous, ...rest] = card.history;
  card.html = previous;
  card.history = rest;
  card.title = titleFrom(previous, card.title);
  setStatus(card, "ready");
  mountWidget(card);
  persist(card);
  toast("Version précédente restaurée");
}

/** Retire une carte sans possibilité de retour (génération annulée ou échouée). */
function discard(card) {
  unmount(card);
  cards.delete(card.id);
  canvas.remove(card.id);
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
  if (e.key === "/" && !typing) {
    e.preventDefault();
    promptEl.focus();
  } else if (e.key === "Escape" && inspector.isOpen && !e.target.closest?.("dialog")) {
    inspector.close();
  }
});

// ============================================================================
// Démarrage : restauration du canvas
// ============================================================================
async function start() {
  initSettings((message) => toast(message));
  onEngineChange(() => inspector.refresh(inspector.card));
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
    cards.set(card.id, card);
    canvas.add(card, { animate: false });
    setStatus(card, "ready");
    mountWidget(card);
  });
  updateEmpty();
  document.body.classList.add("is-ready");
}

start();
