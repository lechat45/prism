// Choix du moteur de génération et réglages.
//  - "server"  : backend Python (POST /api/generate), servi sur la même origine ;
//  - "browser" : sans backend (GitHub Pages…) — démo, ou Groq en direct avec la clé de l'utilisateur.

const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
// Hébergement purement statique connu : inutile de chercher un backend (évite un 404 en console).
const STATIC_HOST = /\.github\.io$/i.test(location.hostname);
const KEY_STORAGE = "prism:groq-key";
const MODELS_STORAGE = "prism:groq-models";

const local = window.PrismLocal.createLocalEngine({ baseUrl: "engine/" });
export const engine = { kind: "pending", info: null, defaults: null, libs: null };
let listeners = [];

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------
// Clé Groq : sessionStorage par défaut, localStorage si « Mémoriser ».
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
  if (engine.kind === "server") return engine.info.mode === "groq";
  return engine.kind === "browser" && Boolean(readKey());
}

function render() {
  const badge = $("engine");
  const text = $("engine-text");
  const shortName = (model) => model.replace(/^openai\//, "");
  if (engine.kind === "server") {
    const info = engine.info;
    const live = info.mode === "groq";
    badge.dataset.state = live ? "groq" : "mock";
    text.textContent = live ? `Groq · ${shortName(info.models[0])}` : "Mode démo";
    badge.title = live
      ? `Serveur Prism v${info.version} · modèles : ${info.models.join(" → ")}`
      : "Serveur sans GROQ_API_KEY : widgets de démonstration. Ajoutez la clé dans backend/.env.";
  } else {
    const models = readModels().length ? readModels() : (engine.defaults && engine.defaults.models) || [];
    const live = Boolean(readKey());
    badge.dataset.state = live ? "groq" : "mock";
    text.textContent = live ? `Groq · ${shortName(models[0] || "navigateur")}` : "Démo · ajouter une clé";
    badge.title = live
      ? `Génération depuis ce navigateur avec votre clé · modèles : ${models.join(" → ")}`
      : "Aucun serveur ici : mode démo. Cliquez pour utiliser votre clé Groq gratuite.";
  }
  listeners.forEach((fn) => fn(engine));
}

// --------------------------------------------------------------------------
// Génération : même contrat pour les deux moteurs.
// request = { prompt, file?: {name, kind, summary}, baseHtml? }
// --------------------------------------------------------------------------
function errorMessage(payload, status) {
  if (payload && typeof payload.detail === "string") return payload.detail;
  if (payload && Array.isArray(payload.detail)) return payload.detail.map((d) => d.msg).join(" ; ");
  return `erreur serveur (HTTP ${status})`;
}

export async function generate(request, signal) {
  await engineReady;
  let payload;
  if (engine.kind === "server") {
    const body = { prompt: request.prompt };
    if (request.file) body.file = request.file;
    if (request.baseHtml) body.base_html = request.baseHtml;
    let res;
    try {
      res = await fetch(`${API_BASE}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new Error("serveur injoignable (lancez « python backend/app.py »)");
    }
    payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(errorMessage(payload, res.status));
  } else {
    payload = await local.generate(request.prompt, {
      key: readKey(),
      models: readModels(),
      signal,
      file: request.file || null,
      baseHtml: request.baseHtml || null,
    });
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
  $("groq-key").value = readKey();
  $("remember-key").checked = isKeyRemembered();
  $("groq-models").value = readModels().join(", ");
  $("groq-models").placeholder = ((engine.defaults && engine.defaults.models) || []).join(", ");
  $("settings").showModal();
  (browserMode ? $("groq-key") : $("btn-cancel-settings")).focus();
}

export function initSettings(notify) {
  $("engine").addEventListener("click", openSettings);
  $("btn-cancel-settings").addEventListener("click", () => $("settings").close());
  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const key = $("groq-key").value.trim();
    writeKey(key, $("remember-key").checked);
    writeModels($("groq-models").value);
    $("settings").close();
    render();
    notify(key ? "Clé Groq enregistrée : génération réelle activée" : "Aucune clé : mode démo");
  });
  $("btn-forget").addEventListener("click", () => {
    writeKey("", false);
    $("settings").close();
    render();
    notify("Clé oubliée : retour au mode démo");
  });
}
