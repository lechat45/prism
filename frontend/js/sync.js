// Synchronisation des cartes avec « Mon Hub » (mode serveur, compte connecté).
//
// Le canvas local (IndexedDB) reste la source immédiate ; le serveur en reçoit une copie :
// disposition (et présence sur le canvas), état du widget, couleur, titre, miniature et données
// du fichier joint. Une carte créée hors compte est importée à la demande (refactorisation).
// Ailleurs, « Mon Hub » et la restauration du canvas partent de cette copie.

import { account, api } from "./account.js";

const DELAY_MS = 1200;
const timers = new Map(); // id carte -> minuteur de PATCH
const pending = new Map(); // id carte -> champs à envoyer

/** Carte liée à un widget du compte connecté. */
export function isLinked(card) {
  if (!account.enabled || !account.user || !card.serverId) return false;
  return (card.serverOwner ?? account.user.id) === account.user.id;
}

const widgetUrl = (card, suffix = "") => `/api/widgets/${encodeURIComponent(card.serverId)}${suffix}`;

function state(card) {
  return {
    layout: { x: Math.round(card.x), y: Math.round(card.y), w: Math.round(card.w), h: Math.round(card.h), z: Math.max(0, card.z || 1) },
    accent: card.accent || null,
    title: String(card.title || "").slice(0, 120),
  };
}

/** Mémorise l'état tel que le serveur le connaît (après création, import ou restauration). */
export function markSynced(card) {
  const now = state(card);
  card.synced = { layout: JSON.stringify(now.layout), accent: now.accent, title: now.title, storage: card.storage };
}

/** Envoie (regroupés, différés) les champs changés depuis le dernier envoi. */
export function queueSync(card) {
  if (!isLinked(card)) return;
  const sent = card.synced || (card.synced = {});
  const now = state(card);
  const patch = pending.get(card.id) || {};
  const layout = JSON.stringify(now.layout);
  if (sent.layout !== layout) { patch.layout = now.layout; sent.layout = layout; }
  if (sent.accent !== now.accent) {
    if (now.accent) { patch.accent = now.accent; delete patch.clear_accent; } else { patch.clear_accent = true; delete patch.accent; }
    sent.accent = now.accent;
  }
  if (sent.title !== now.title && now.title) { patch.title = now.title; sent.title = now.title; }
  if (sent.storage !== card.storage) { patch.storage = card.storage || {}; sent.storage = card.storage; } // objet remplacé à chaque écriture
  if (!Object.keys(patch).length) return;
  pending.set(card.id, patch);
  clearTimeout(timers.get(card.id));
  timers.set(card.id, setTimeout(() => flush(card), DELAY_MS));
}

async function flush(card) {
  timers.delete(card.id);
  const patch = pending.get(card.id);
  pending.delete(card.id);
  if (!patch || !isLinked(card)) return;
  try {
    await api(widgetUrl(card), { method: "PATCH", body: patch });
  } catch (err) {
    if (err.code === "widget_not_found") return unlink(card); // supprimé depuis un autre appareil
    card.synced = null; // renvoi complet au prochain changement
    console.warn("Prism : synchronisation de la carte différée", err);
  }
}

/** Carte fermée : elle quitte le canvas mais reste dans le Hub. */
export async function removeFromCanvas(card) {
  clearTimeout(timers.get(card.id));
  timers.delete(card.id);
  pending.delete(card.id);
  card.synced = null; // « Rétablir » renverra la disposition
  if (!isLinked(card)) return;
  try {
    await api(widgetUrl(card), { method: "PATCH", body: { clear_layout: true } });
  } catch (err) {
    if (err.code !== "widget_not_found") console.warn("Prism : retrait du canvas non synchronisé", err);
  }
}

export function unlink(card) {
  card.serverId = null;
  card.serverOwner = null;
  card.synced = null;
  card.fileSynced = false;
}

/** Données du fichier joint → serveur, une fois (le Blob part tel quel). */
export async function uploadFile(card) {
  if (!isLinked(card) || !card.file?.blob || card.fileSynced) return;
  try {
    await api(widgetUrl(card, "/file"), { method: "PUT", body: card.file.blob });
    card.fileSynced = true;
  } catch (err) {
    if (err.code === "file_too_large") card.fileSynced = "too_large"; // gardé sur cet appareil seulement
    console.warn("Prism : données du fichier non téléversées", err);
  }
}

export async function pushThumbnail(card, data) {
  if (!isLinked(card)) return false;
  try {
    await api(widgetUrl(card), { method: "PATCH", body: { thumbnail: data } });
    return true;
  } catch (err) {
    console.warn("Prism : miniature non envoyée", err);
    return false;
  }
}

/** Carte locale sans widget serveur → ajoutée au Hub (gratuit), puis ses données de fichier. */
export async function importCard(card) {
  const now = state(card);
  const file = card.file ? { name: card.file.name, kind: card.file.kind, summary: card.file.summary || "" } : null;
  const detail = await api("/api/widgets", {
    method: "POST",
    body: {
      html: card.html, prompt: card.prompt || "", title: now.title, mode: String(card.mode || "import").slice(0, 20),
      model: String(card.model || "").slice(0, 100), accent: now.accent, layout: now.layout, storage: card.storage || {}, file,
    },
  });
  card.serverId = detail.id;
  card.serverOwner = account.user.id;
  card.serverVersions = detail.versions;
  card.thumbStale = true;
  markSynced(card);
  await uploadFile(card);
  return detail;
}

/** Widget du Hub → { detail, blob } (données du fichier gardées brutes, en Blob). */
export async function fetchWidget(id) {
  const detail = await api(`/api/widgets/${encodeURIComponent(id)}`);
  let blob = null;
  if (detail.has_file_data) {
    try {
      blob = await api(`/api/widgets/${encodeURIComponent(id)}/file`, { as: "blob" });
    } catch (err) {
      console.warn("Prism : données du fichier indisponibles", err);
    }
  }
  return { detail, blob };
}

export const listWidgets = ({ offset = 0, limit = 60, onCanvas = null } = {}) =>
  api(`/api/widgets?limit=${limit}&offset=${offset}${onCanvas === null ? "" : `&on_canvas=${onCanvas}`}`);

export const deleteWidget = (id) => api(`/api/widgets/${encodeURIComponent(id)}`, { method: "DELETE" });
