// Compte Prism (mode serveur) : session, appels authentifiés, solde de Sparks.
//
// Jeton Bearer (pas de cookie : l'API peut être servie ailleurs que le site), gardé en
// sessionStorage, ou en localStorage si « Rester connecté ». Les widgets n'y ont jamais accès
// (sandbox sans allow-same-origin). Sur GitHub Pages (moteur navigateur), pas de compte.

// API distante (déploiement) : seulement sur GitHub Pages, jamais en local.
export const STATIC_HOST = /\.github\.io$/i.test(location.hostname);
const configuredApi = (document.querySelector('meta[name="prism-api"]')?.content || "").trim().replace(/\/+$/, "");
// HTTPS obligatoire (la page l'est), sauf API sur la machine elle-même (développement, tests).
const acceptableApi = /^https:\/\/[^/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configuredApi);
export const REMOTE_API = STATIC_HOST && acceptableApi ? configuredApi : "";
export const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:8000" : REMOTE_API;
const SESSION_KEY = "prism:session";

/** État observable : enabled (serveur à comptes), user ({ id, email, sparks, plan } | null). */
export const account = { enabled: false, user: null, token: "", pricing: { generate: 1, refactor: 0.5 }, signupSparks: 50 };
const listeners = [];

export function onAccountChange(fn) {
  listeners.push(fn);
}

function emit(change = {}) {
  listeners.forEach((fn) => fn(account, change));
}

// --------------------------------------------------------------------------
// Session persistée
// --------------------------------------------------------------------------
/** [mémorisée ?, stockage] : sessionStorage (oubliée à la fermeture), puis localStorage. */
function stores() {
  const out = [];
  try { out.push([false, sessionStorage]); } catch { /* indisponible */ }
  try { out.push([true, localStorage]); } catch { /* indisponible */ }
  return out;
}

function readSession() {
  for (const [remember, area] of stores()) {
    try {
      const saved = JSON.parse(area.getItem(SESSION_KEY) || "null");
      if (saved && typeof saved.token === "string" && saved.token) return { ...saved, remember };
    } catch { /* entrée corrompue : ignorée */ }
  }
  return null;
}

function writeSession(remember) {
  for (const [, area] of stores()) {
    try { area.removeItem(SESSION_KEY); } catch { /* indisponible */ }
  }
  if (!account.token) return;
  try {
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify({ token: account.token, user: account.user }));
  } catch { /* stockage indisponible : session limitée à cette page */ }
}

let remembered = true;

// --------------------------------------------------------------------------
// Appels à l'API
// --------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(status, detail) {
    super(messageOf(detail, status));
    this.name = "ApiError";
    this.status = status;
    this.code = (detail && typeof detail === "object" && !Array.isArray(detail) && detail.code) || (status === 401 ? "auth_required" : "");
    this.detail = detail;
  }
}

const FIELD_NAMES = { email: "E-mail", password: "Mot de passe", prompt: "Demande" };

/** detail FastAPI : chaîne, { code, message } ou liste d'erreurs de validation. */
function messageOf(detail, status) {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail.message === "string") return detail.message;
  if (Array.isArray(detail)) {
    return detail.map((d) => {
      const field = FIELD_NAMES[(d.loc || []).at(-1)] || "";
      if (d.type === "string_too_short" && field === "Mot de passe") return "Mot de passe : 8 caractères minimum.";
      const msg = String(d.msg || "").replace(/^Value error, /, "");
      return field ? `${field} : ${msg}` : msg;
    }).join(" ; ");
  }
  return `erreur serveur (HTTP ${status})`;
}

/** body : objet (envoyé en JSON) ou Blob déjà en JSON (envoyé tel quel, sans copie ni analyse).
 *  as: "json" (défaut) ou "blob" (réponse gardée brute : données d'un fichier joint).
 *  keepalive : la requête survit au départ de la page (corps < 64 Ko, limite des navigateurs). */
export async function api(path, { method = "GET", body, signal, as = "json", keepalive = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (account.token) headers.Authorization = `Bearer ${account.token}`;
  const payloadOut = body === undefined || body instanceof Blob ? body : JSON.stringify(body);
  const survive = keepalive && (payloadOut === undefined || (typeof payloadOut === "string" && payloadOut.length < 60_000));
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: payloadOut, signal, keepalive: survive });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, { code: "network", message: "serveur injoignable (lancez « python backend/app.py »)" });
  }
  if (res.ok && as === "blob") return res.blob();
  const payload = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, payload && payload.detail);
    if (res.status === 401 && account.token) forget(); // jeton expiré ou révoqué
    throw err;
  }
  return payload;
}

// --------------------------------------------------------------------------
// Cycle de vie
// --------------------------------------------------------------------------
function adopt(session, remember) {
  account.token = session.token;
  account.user = session.user;
  remembered = remember;
  writeSession(remember);
  emit({ signedIn: true });
}

function forget() {
  account.token = "";
  account.user = null;
  writeSession(false);
  emit({ signedOut: true });
}

/** Appelé une fois le serveur détecté (GET /api/health) : active les comptes et valide la session. */
export async function initAccount(info) {
  account.enabled = Boolean(info && info.auth);
  if (!account.enabled) return emit();
  if (info.pricing) account.pricing = info.pricing;
  if (Number.isFinite(info.signup_sparks)) account.signupSparks = info.signup_sparks;
  const saved = readSession();
  if (saved) {
    account.token = saved.token;
    account.user = saved.user || null;
    remembered = saved.remember;
  }
  emit();
  if (!account.token) return;
  try {
    account.user = await api("/api/auth/me");
    writeSession(remembered);
    emit();
  } catch (err) {
    // 401 : déjà oubliée par api(). Serveur injoignable : on garde la session pour plus tard.
    if (err.status !== 401) console.warn("Prism : session non vérifiée", err);
  }
}

export async function signIn(mode, email, password, remember) {
  const session = await api(`/api/auth/${mode === "register" ? "register" : "login"}`, { method: "POST", body: { email, password } });
  adopt(session, remember);
  return session.user;
}

export function signOut() {
  forget();
}

/** Nouveau solde (réponse de génération, refus 403…). */
export function setSparks(sparks) {
  if (!account.user || !Number.isFinite(sparks)) return;
  const delta = sparks - account.user.sparks;
  account.user = { ...account.user, sparks };
  writeSession(remembered);
  emit({ delta });
}

export const needsSignIn = () => account.enabled && !account.user;
export const canAfford = (action) => !account.enabled || !account.user || account.user.sparks >= (account.pricing[action] ?? 0);
