// Isolation et outillage des widgets.
//
// Chaque widget tourne dans <iframe sandbox="allow-scripts"> SANS allow-same-origin :
// origine opaque, aucun accès à la page, à la clé Groq ni au stockage de Prism.
// Tout ce dont il a besoin est injecté dans son document :
//   - une CSP : aucune requête réseau, sauf le fichier Chart.js épinglé (SRI) ;
//   - window.PRISM_FILE : les données complètes du fichier joint ;
//   - un prélude qui (1) remonte les erreurs JS, (2) fournit un localStorage PERSISTANT :
//     instantané initial injecté ici, chaque écriture renvoyée à la page par postMessage
//     et sauvegardée avec la carte ; (3) applique la couleur d'accent à chaud.

export const FRAME_SANDBOX = "allow-scripts";
const ACCENT_RE = /^#[0-9a-f]{6}$/i;
const MAX_STORAGE_CHARS = 1_000_000;

export const ACCENTS = [
  { value: null, label: "Couleur d'origine" },
  { value: "#7cc4ff", label: "Bleu glacier" },
  { value: "#a66bff", label: "Violet" },
  { value: "#ff5e8a", label: "Rose" },
  { value: "#ff9f1c", label: "Orange" },
  { value: "#3ddc84", label: "Vert" },
  { value: "#ffe14d", label: "Jaune" },
];

export const isAccent = (value) => value === null || (typeof value === "string" && ACCENT_RE.test(value));

// JSON sûr dans un <script> : ni fermeture de balise ni séparateurs de ligne Unicode (U+2028/U+2029).
// Construits par code : écrits tels quels dans une regex, ce sont des fins de ligne qui la cassent.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
const safeJson = (value) =>
  JSON.stringify(value).replace(/</g, "\\u003c").split(LINE_SEP).join("\\u2028").split(PARA_SEP).join("\\u2029");

function injectInHead(html, snippet) {
  const head = /<head(\s[^>]*)?>/i;
  if (head.test(html)) return html.replace(head, (m) => m + snippet);
  const root = /<html(\s[^>]*)?>/i;
  if (root.test(html)) return html.replace(root, (m) => `${m}<head>${snippet}</head>`);
  return `<!DOCTYPE html><html><head>${snippet}</head><body>${html}</body></html>`;
}

const accentStyle = (accent) =>
  accent && ACCENT_RE.test(accent) ? `<style id="prism-accent">:root{--accent:${accent} !important}</style>` : "";

const fileScript = (file) => (file && file.data ? `<script>window.PRISM_FILE=${safeJson(file.data)};<\/script>` : "");

function prelude(snapshot) {
  return `(function () {
  "use strict";
  var send = function (type, data) {
    try { parent.postMessage(Object.assign({ prism: type }, data || {}), "*"); } catch (e) {}
  };
  window.addEventListener("error", function (e) {
    send("error", { message: String(e.message || "Erreur inconnue"), line: e.lineno || 0 });
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    send("error", { message: "Promesse rejetée : " + String((r && r.message) || r), line: 0 });
  });

  function makeStorage(data, persistent) {
    var pending = false;
    var changed = function () {
      if (!persistent || pending) return;
      pending = true;
      Promise.resolve().then(function () { pending = false; send("storage", { data: data }); });
    };
    var api = {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); changed(); },
      removeItem: function (k) { delete data[String(k)]; changed(); },
      clear: function () { Object.keys(data).forEach(function (k) { delete data[k]; }); changed(); },
      key: function (i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      get length() { return Object.keys(data).length; }
    };
    return new Proxy(api, {
      get: function (t, k) {
        if (k in t) return t[k];
        if (typeof k !== "string") return undefined;
        var v = t.getItem(k);
        return v === null ? undefined : v;
      },
      set: function (t, k, v) { if (k in t) return false; t.setItem(k, v); return true; },
      deleteProperty: function (t, k) { t.removeItem(k); return true; },
      has: function (t, k) { return k in t || Object.prototype.hasOwnProperty.call(data, k); }
    });
  }
  var local = makeStorage(${safeJson(snapshot)}, true);
  var session = makeStorage({}, false);
  [["localStorage", local], ["sessionStorage", session]].forEach(function (pair) {
    try { Object.defineProperty(window, pair[0], { value: pair[1], configurable: true }); } catch (e) {}
  });

  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || e.data.prism !== "accent") return;
    var root = document.documentElement;
    var forced = document.getElementById("prism-accent");
    if (forced) forced.remove();
    if (e.data.value) root.style.setProperty("--accent", e.data.value, "important");
    else root.style.removeProperty("--accent");
    window.dispatchEvent(new Event("prism:accent"));
  });
  // Sélection de la carte en fin de geste : remonter la carte (z-index) pendant un clic en cours
  // faisait parfois perdre le relâchement du clic suivant.
  document.addEventListener("pointerup", function () { send("focus"); }, true);
  // Ctrl + molette (et pincement du pavé tactile) : zoom du canvas, jamais de la page entière.
  window.addEventListener("wheel", function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    send("zoom", { deltaY: e.deltaY * (e.deltaMode === 1 ? 16 : 1), x: e.clientX, y: e.clientY });
  }, { passive: false });
  window.addEventListener("load", function () { send("ready", { title: document.title }); });
})();`;
}

function csp(libs) {
  const scripts = Object.keys(libs).filter((k) => !k.startsWith("_")).map((k) => libs[k].url);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${scripts.join(" ")}`.trim(),
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Document complet à charger dans l'iframe sandbox d'une carte. */
export function buildSrcdoc(card, libs) {
  return injectInHead(
    card.html,
    [
      `<meta http-equiv="Content-Security-Policy" content="${csp(libs)}">`,
      // Barres de défilement masquées (le contenu reste défilable) : rendu épuré des cartes.
      // [hidden] forcé : un « .panneau{display:flex} » du widget annulerait sinon l'attribut hidden
      // (erreur fréquente, y compris dans le code généré).
      "<style id=\"prism-host\">*{scrollbar-width:none}*::-webkit-scrollbar{display:none}[hidden]{display:none!important}</style>",
      accentStyle(card.accent),
      fileScript(card.file),
      `<script>${prelude(card.storage || {})}<\/script>`,
    ].join(""),
  );
}

/** Fichier .html autonome : données et accent inclus ; ouvert hors sandbox, il utilise le vrai localStorage. */
export function exportHtml(card) {
  const note = `<!-- Exporté depuis Prism · ${new Date().toISOString().slice(0, 10)} -->`;
  return injectInHead(card.html, note + accentStyle(card.accent) + fileScript(card.file));
}

/** Valide un instantané de stockage envoyé par un widget (données non fiables). */
export function acceptStorage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const clean = {};
  let size = 0;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "string") return null;
    size += k.length + v.length;
    if (size > MAX_STORAGE_CHARS) return null;
    clean[k] = v;
  }
  return clean;
}
