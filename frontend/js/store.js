// Persistance du canvas.
//  - Cartes (code, fichier joint, données du widget, position…) : IndexedDB, quota confortable
//    (un CSV joint peut peser plusieurs Mo, bien au-delà des ~5 Mo de localStorage).
//  - Vue (pan/zoom) : localStorage, petite et synchrone.

const DB_NAME = "prism";
const DB_VERSION = 1;
const STORE = "cards";
const VIEW_KEY = "prism:view";

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("base de données bloquée par un autre onglet"));
    });
  }
  return dbPromise;
}

async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction annulée"));
  });
}

// Champs persistés d'une carte (l'état d'exécution — contrôleur, minuteurs — reste en mémoire).
const FIELDS = ["id", "title", "prompt", "html", "file", "storage", "accent", "x", "y", "w", "h", "z",
  "mode", "model", "elapsed_ms", "warnings", "history", "createdAt", "updatedAt",
  // Mode serveur (« Mon Hub ») : widget lié, son propriétaire, ses versions serveur, données du
  // fichier déjà téléversées, miniature à refaire.
  "serverId", "serverOwner", "serverVersions", "fileSynced", "thumbStale"];

export function serialize(card) {
  const out = {};
  for (const key of FIELDS) if (card[key] !== undefined) out[key] = card[key];
  return out;
}

export const cardStore = {
  all: () => run("readonly", (s) => s.getAll()),
  put: (card) => run("readwrite", (s) => s.put(serialize(card))),
  remove: (id) => run("readwrite", (s) => s.delete(id)),
};

export function loadView() {
  try {
    const view = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    if (view && [view.x, view.y, view.z].every(Number.isFinite)) return view;
  } catch { /* stockage indisponible */ }
  return null;
}

export function saveView(view) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* stockage indisponible */ }
}
