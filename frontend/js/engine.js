// Choix du moteur de génération et réglages.
//  - "server"  : backend Python (POST /api/generate, compte requis : account.js), même origine ;
//  - "browser" : sans backend (GitHub Pages…) — démo, ou Gemini en direct avec la clé de l'utilisateur.
//    L'appel, le nettoyage et la validation du code reçu tournent dans le Web Worker (offload.js).

import { api, API_BASE, initAccount } from "./account.js";
import { run } from "./offload.js";

// Hébergement purement statique connu : inutile de chercher un backend (évite un 404 en console).
const STATIC_HOST = /\.github\.io$/i.test(location.hostname);
const KEY_STORAGE = "prism:gemini-key";
const MODELS_STORAGE = "prism:gemini-models";
const PROVIDER_LABELS = { gemini: "Gemini", groq: "Groq" };

const local = window.PrismLocal.createLocalEngine({ baseUrl: "engine/" });
export const engine = { kind: "pending", info: null, defaults: null, libs: null };
let listeners = [];

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------
// Clé Gemini : sessionStorage par défaut, localStorage si « Mémoriser ».
// --------------------------------------------------------------------------
function storageAreas() {
  const areas = [];
  try { areas.push(window.sessionStorage); } catch { /* indisponible */ }
  try { areas.push(window.localStorage); } catch { /* indisponible */ }
  return areas;
}

export function readKey() {
  for (const area of storageAreas()) {
    try {
      const key = area.getItem(KEY_STORAGE);
      if (key) return key;
    } catch { /* indisponible */ }
  }
  return "";
}

function isKeyRemembered() {
  try { return Boolean(localStorage.getItem(KEY_STORAGE)); } catch { return false; }
}

function writeKey(key, remember) {
  for (const area of storageAreas()) {
    try { area.removeItem(KEY_STORAGE); } catch { /* indisponible */ }
  }
  if (!key) return;
  try { (remember ? localStorage : sessionStorage).setItem(KEY_STORAGE, key); } catch { /* indisponible */ }
}

function readModels() {
  try {
    return (localStorage.getItem(MODELS_STORAGE) || "").split(",").map((m) => m.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function writeModels(value) {
  const models = value.split(",").map((m) => m.trim()).filter(Boolean);
  try {
    if (models.length) localStorage.setItem(MODELS_STORAGE, models.join(","));
    else localStorage.removeItem(MODELS_STORAGE);
  } catch { /* indisponible */ }
}

// --------------------------------------------------------------------------
// Détection
// --------------------------------------------------------------------------
async function detect() {
  engine.libs = await local.libs();
  if (!STATIC_HOST) {
    try {
      const res = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
      const info = res.ok ? await res.json() : null;
      if (info && info.status === "ok") {
        engine.kind = "server";
        engine.info = info;
        initAccount(info); // session relue tout de suite ; vérification (/api/auth/me) en arrière-plan
        return;
      }
    } catch { /* pas de backend : moteur navigateur */ }
  }
  engine.kind = "browser";
  engine.defaults = await local.defaults().catch(() => null);
}

export const engineReady = detect().finally(() => render());

export function onEngineChange(fn) {
  listeners.push(fn);
}

/** Vrai quand un modèle est disponible (la refactorisation n'existe pas en démo). */
export function hasModel() {
  if (engine.kind === "server") return engine.info.mode !== "mock";
  return engine.kind === "browser" && Boolean(readKey());
}

function render() {
  const badge = $("engine");
  const text = $("engine-text");
  const shortName = (model) => model.replace(/^openai\//, "");
  if (engine.kind === "server") {
    const info = engine.info;
    const live = info.mode !== "mock";
    badge.dataset.state = live ? "live" : "mock";
    text.textContent = live ? `${PROVIDER_LABELS[info.mode] || info.mode} · ${shortName(info.models[0])}` : "Mode démo";
    badge.title = live
      ? `Serveur Prism v${info.version} · modèles : ${info.models.join(" → ")}`
      : "Serveur sans GEMINI_API_KEY : widgets de démonstration. Ajoutez la clé dans backend/.env.";
  } else {
    const models = readModels().length ? readModels() : (engine.defaults && engine.defaults.models) || [];
    const live = Boolean(readKey());
    badge.dataset.state = live ? "live" : "mock";
    text.textContent = live ? `Gemini · ${shortName(models[0] || "navigateur")}` : "Démo · ajouter une clé";
    badge.title = live
      ? `Génération depuis ce navigateur avec votre clé · modèles : ${models.join(" → ")}`
      : "Aucun serveur ici : mode démo. Cliquez pour utiliser votre clé Gemini gratuite (Google AI Studio).";
  }
  listeners.forEach((fn) => fn(engine));
}

// --------------------------------------------------------------------------
// Génération : même contrat pour les deux moteurs.
// request = { prompt, file?: {name, kind, summary}, baseHtml?, widgetId?, canvas?: [{ title, emits, listens, samples }] }
//  - serveur : la refactorisation désigne le widget enregistré (widgetId), jamais du code client ;
//    la réponse porte aussi { widget, sparks, cost }. Erreurs : ApiError (code auth_required,
//    insufficient_sparks…).
//  - navigateur : la refactorisation part de baseHtml.
// --------------------------------------------------------------------------
export async function generate(request, signal) {
  await engineReady;
  let payload;
  if (engine.kind === "server") {
    const body = { prompt: request.prompt };
    if (request.file) body.file = request.file;
    if (request.widgetId) body.widget_id = request.widgetId;
    if (request.canvas?.length) body.canvas = request.canvas;
    payload = await api("/api/generate", { method: "POST", body, signal });
  } else {
    const options = {
      key: readKey(), models: readModels(), file: request.file || null, baseHtml: request.baseHtml || null, canvas: request.canvas || null,
    };
    payload = await run("generate", { prompt: request.prompt, options }, { signal });
  }
  if (!payload || typeof payload.html !== "string" || !payload.html.trim()) throw new Error("réponse vide");
  return payload;
}

// --------------------------------------------------------------------------
// Dialogue des réglages
// --------------------------------------------------------------------------
export function openSettings() {
  const browserMode = engine.kind !== "server";
  $("settings-server").hidden = browserMode;
  $("settings-browser").hidden = !browserMode;
  $("btn-forget").hidden = !browserMode || !readKey();
  $("btn-save-settings").hidden = !browserMode;
  $("gemini-key").value = readKey();
  $("remember-key").checked = isKeyRemembered();
  $("gemini-models").value = readModels().join(", ");
  $("gemini-models").placeholder = ((engine.defaults && engine.defaults.models) || []).join(", ");
  $("settings").showModal();
  (browserMode ? $("gemini-key") : $("btn-cancel-settings")).focus();
}

export function initSettings(notify) {
  $("engine").addEventListener("click", openSettings);
  $("btn-cancel-settings").addEventListener("click", () => $("settings").close());
  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const key = $("gemini-key").value.trim();
    writeKey(key, $("remember-key").checked);
    writeModels($("gemini-models").value);
    $("settings").close();
    render();
    notify(key ? "Clé Gemini enregistrée : génération réelle activée" : "Aucune clé : mode démo");
  });
  $("btn-forget").addEventListener("click", () => {
    writeKey("", false);
    $("settings").close();
    render();
    notify("Clé oubliée : retour au mode démo");
  });
}
