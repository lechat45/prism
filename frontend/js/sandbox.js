// Isolation et outillage des widgets.
//
// Chaque widget tourne dans <iframe sandbox="allow-scripts"> SANS allow-same-origin :
// origine opaque, aucun accès à la page, à la clé Gemini ni au stockage de Prism.
// Tout ce dont il a besoin est injecté dans son document :
//   - une CSP : aucune requête réseau, sauf les bibliothèques épinglées (SRI) ;
//   - window.PRISM_FILE : les données complètes du fichier joint ;
//   - un prélude qui (1) remonte les erreurs JS, (2) fournit un localStorage PERSISTANT :
//     instantané initial injecté ici, chaque écriture renvoyée à la page par postMessage
//     et sauvegardée avec la carte ; (3) applique la couleur d'accent à chaud.
//
// Fichier joint : ses données (JSON, jusqu'à ~7 Mo) sont un Blob produit par le Web Worker.
// Les inscrire dans srcdoc coûterait ~200 ms de fil principal par montage ; on charge donc
// d'abord un mini-document (bootSrcdoc) qui reçoit le Blob par postMessage (simple poignée),
// le lit et le parse DANS le processus du widget, définit PRISM_FILE, puis écrit le document.

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
const scriptSafe = (json) => json.replace(/</g, "\\u003c").split(LINE_SEP).join("\\u2028").split(PARA_SEP).join("\\u2029");
const safeJson = (value) => scriptSafe(JSON.stringify(value));

function injectInHead(html, snippet) {
  const head = /<head(\s[^>]*)?>/i;
  if (head.test(html)) return html.replace(head, (m) => m + snippet);
  const root = /<html(\s[^>]*)?>/i;
  if (root.test(html)) return html.replace(root, (m) => `${m}<head>${snippet}</head>`);
  return `<!DOCTYPE html><html><head>${snippet}</head><body>${html}</body></html>`;
}

const accentStyle = (accent) =>
  accent && ACCENT_RE.test(accent) ? `<style id="prism-accent">:root{--accent:${accent} !important}</style>` : "";

const dataScript = (json) => `<script>window.PRISM_FILE=${scriptSafe(json)};<\/script>`;
// Données en objets (cartes v2 non migrées, tests) : inscrites directement dans le document.
const inlineFile = (file) => (file && file.data !== undefined && !file.blob ? dataScript(JSON.stringify(file.data)) : "");

/** Vrai si le widget reçoit ses données par le chargeur (Blob) plutôt que dans srcdoc. */
export const needsBoot = (card) => Boolean(card.file && card.file.blob);

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

  // Bus d'évènements entre widgets : la page relaie (et filtre) vers les widgets abonnés.
  //   prism.emit(sujet, données)  ·  prism.on(sujet | "*", fn(données, { topic, from, replay })) → désabonnement
  var handlers = {};
  var bus = {
    emit: function (topic, data) {
      var json;
      try { json = JSON.stringify(data === undefined ? null : data); } catch (e) { json = undefined; }
      if (json === undefined) throw new TypeError("prism.emit : données non sérialisables en JSON");
      send("emit", { topic: String(topic), data: JSON.parse(json) });
    },
    on: function (topic, fn, options) {
      topic = String(topic);
      if (typeof fn !== "function") throw new TypeError("prism.on : fonction attendue");
      (handlers[topic] = handlers[topic] || []).push(fn);
      send("subscribe", { topic: topic, replay: !(options && options.replay === false) });
      return function () { bus.off(topic, fn); };
    },
    off: function (topic, fn) {
      var list = handlers[String(topic)] || [];
      var i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }
  };
  try { Object.defineProperty(window, "prism", { value: Object.freeze(bus) }); } catch (e) {}
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || e.data.prism !== "event") return;
    var d = e.data;
    var meta = { topic: d.topic, from: d.from || null, replay: Boolean(d.replay) };
    (handlers[d.topic] || []).concat(d.topic !== "*" ? handlers["*"] || [] : []).forEach(function (fn) {
      try { fn(d.data, meta); } catch (err) { setTimeout(function () { throw err; }); }
    });
  });

  // Miniature pour « Mon Hub », fabriquée ICI (la page ne peut pas lire le widget) : le document est
  // cloné (graphiques <canvas> figés en images, saisies en cours reportées), rendu dans une image SVG
  // (foreignObject, sans aucun réseau), réduit sur un <canvas> puis renvoyé en data:image/webp.
  function snapshot(width) {
    var fail = function (err) { send("thumbnail", { error: String((err && err.message) || err || "rendu impossible") }); };
    try {
      var root = document.documentElement;
      var w = Math.max(1, root.clientWidth);
      var h = Math.max(1, Math.min(root.clientHeight, Math.round(w * 1.25)));
      var clone = root.cloneNode(true);
      var drop = clone.querySelectorAll("script, meta, noscript");
      for (var i = 0; i < drop.length; i++) drop[i].parentNode.removeChild(drop[i]);
      var live = document.querySelectorAll("canvas");
      var copies = clone.querySelectorAll("canvas");
      for (i = 0; i < copies.length && i < live.length; i++) {
        var img = document.createElement("img");
        try { img.src = live[i].toDataURL(); } catch (e) { /* toile illisible : laissée vide */ }
        img.className = live[i].className;
        img.setAttribute("style", (live[i].getAttribute("style") || "") + ";width:" + live[i].clientWidth + "px;height:" + live[i].clientHeight + "px");
        copies[i].parentNode.replaceChild(img, copies[i]);
      }
      var fields = document.querySelectorAll("input, textarea, select");
      var fieldCopies = clone.querySelectorAll("input, textarea, select");
      for (i = 0; i < fields.length && i < fieldCopies.length; i++) {
        var f = fields[i], c = fieldCopies[i];
        if (f.type === "checkbox" || f.type === "radio") {
          if (f.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked");
        } else if (f.tagName === "TEXTAREA") c.textContent = f.value;
        else if (f.tagName === "SELECT") { for (var o = 0; o < f.options.length; o++) if (f.options[o].selected) c.options[o].setAttribute("selected", ""); }
        else if (f.type !== "file" && f.type !== "password") c.setAttribute("value", f.value);
      }
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject x="0" y="0" width="100%" height="100%">' +
        new XMLSerializer().serializeToString(clone) + "</foreignObject></svg>";
      var image = new Image();
      image.onload = function () {
        try {
          var scale = Math.min(1, width / w);
          var out = document.createElement("canvas");
          out.width = Math.round(w * scale);
          out.height = Math.round(h * scale);
          var ctx = out.getContext("2d");
          var bg = getComputedStyle(document.body).backgroundColor;
          ctx.fillStyle = !bg || /rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? "#0b0d12" : bg;
          ctx.fillRect(0, 0, out.width, out.height);
          ctx.scale(scale, scale);
          ctx.drawImage(image, 0, 0);
          var data = out.toDataURL("image/webp", 0.75);
          if (data.indexOf("data:image/webp") !== 0) data = out.toDataURL("image/jpeg", 0.8);
          send("thumbnail", { data: data });
        } catch (err) { fail(err); }
      };
      image.onerror = function () { fail("rendu impossible"); };
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    } catch (err) { fail(err); }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.prism === "snapshot") return snapshot(Math.max(80, Math.min(640, Number(e.data.width) || 360)));
    if (e.data.prism !== "accent") return;
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
  // « Prêt » seulement une fois le widget stylé : la page garde le squelette jusque-là (pas de
  // flash sans style). Tailwind compile ses classes après coup, en asynchrone : on attend sa feuille.
  function whenStyled(done) {
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      if (observer) observer.disconnect();
      requestAnimationFrame(function () { requestAnimationFrame(done); });
    };
    var styled = function () {
      var sheets = document.getElementsByTagName("style");
      for (var i = 0; i < sheets.length; i++) if (sheets[i].textContent.indexOf("tailwindcss") !== -1) return true;
      return false;
    };
    var observer = null;
    if (!document.querySelector('script[src*="tailwindcss"]') || styled()) return finish();
    observer = new MutationObserver(function () { if (styled()) finish(); });
    observer.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(finish, 1500);
  }
  window.addEventListener("load", function () {
    whenStyled(function () { send("ready", { title: document.title }); });
  });
  // Ctrl/Cmd + K, même le focus dans un widget : barre de commande de Prism (Spotlight).
  window.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      send("spotlight");
    }
  }, true);
  // Zoom fractal : double-clic sur une partie du widget → la page propose d'en faire un widget à part
  // entière. Le composant visé (le plus petit bloc qui fait sens) est décrit ici : balise, intitulé,
  // texte visible et extrait de code (sans scripts ni styles).
  function fractalTarget(el) {
    var screen = Math.max(1, window.innerWidth * window.innerHeight);
    var best = null;
    for (var node = el; node && node.nodeType === 1 && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      var r = node.getBoundingClientRect();
      var area = r.width * r.height;
      if (area > screen * 0.8) break;
      best = node;
      if (area >= 2500 && /^(section|article|aside|figure|form|table|ul|ol|nav|header|footer|canvas|svg|details|fieldset)$/i.test(node.tagName)) break;
      if (area >= 12000 && node.children.length >= 2) break;
    }
    return best;
  }
  document.addEventListener("dblclick", function (e) {
    if (document.documentElement.hasAttribute("data-prism-nofractal")) return;
    var t = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    if (!t || t.closest("input, textarea, select, option, [contenteditable], [data-prism-nofractal]")) return;
    var el = fractalTarget(t);
    if (!el) return;
    var copy = el.cloneNode(true);
    var drop = copy.querySelectorAll("script, style");
    for (var i = 0; i < drop.length; i++) drop[i].parentNode.removeChild(drop[i]);
    var heading = el.querySelector("h1, h2, h3, h4, legend, caption, figcaption, th, strong");
    var label = el.getAttribute("aria-label") || (heading && heading.textContent) || el.textContent || el.tagName;
    send("fractal", {
      x: e.clientX, y: e.clientY, tag: el.tagName.toLowerCase(),
      label: String(label).replace(/\s+/g, " ").trim().slice(0, 80),
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600),
      html: String(copy.outerHTML || "").slice(0, 3000)
    });
  }, true);
  // Position du pointeur au-dessus du widget (reflets des bords de sa carte), ~30 fois/s au plus,
  // jamais bouton enfoncé : pendant un clic ou un glisser, la page ne repeint rien sous l'iframe.
  var lastPointer = 0;
  window.addEventListener("pointermove", function (e) {
    var now = Date.now();
    if (e.buttons || now - lastPointer < 33) return;
    lastPointer = now;
    send("pointer", { x: e.clientX, y: e.clientY });
  }, { passive: true, capture: true });
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

const cspMeta = (libs) => `<meta http-equiv="Content-Security-Policy" content="${csp(libs)}">`;

/** Document complet à charger dans l'iframe sandbox d'une carte (sans les données d'un Blob). */
export function buildSrcdoc(card, libs) {
  return injectInHead(
    card.html,
    [
      cspMeta(libs),
      // Barres de défilement masquées (le contenu reste défilable) : rendu épuré des cartes.
      // [hidden] forcé : un « .panneau{display:flex} » du widget annulerait sinon l'attribut hidden
      // (erreur fréquente, y compris dans le code généré).
      "<style id=\"prism-host\">*{scrollbar-width:none}*::-webkit-scrollbar{display:none}[hidden]{display:none!important}</style>",
      accentStyle(card.accent),
      inlineFile(card.file),
      `<script>${prelude(card.storage || {})}<\/script>`,
    ].join(""),
  );
}

// Chargeur : demande { html, file } au parent, parse les données ICI (processus du widget),
// puis remplace son propre document par celui du widget. Même CSP que le widget.
const BOOT = `(function () {
  "use strict";
  var booted = false;
  window.addEventListener("message", function (e) {
    if (booted || e.source !== parent || !e.data || e.data.prism !== "boot") return;
    booted = true;
    var d = e.data;
    Promise.resolve(d.file ? d.file.text() : null)
      .then(function (text) { if (text !== null) window.PRISM_FILE = JSON.parse(text); })
      .catch(function (err) {
        parent.postMessage({ prism: "error", message: "Données du fichier illisibles : " + String((err && err.message) || err), line: 0 }, "*");
      })
      .then(function () { document.open(); document.write(d.html); document.close(); });
  });
  parent.postMessage({ prism: "boot" }, "*");
})();`;

/** Mini-document initial des widgets à fichier joint (cf. en-tête). */
export function bootSrcdoc(libs) {
  return `<!DOCTYPE html><html><head>${cspMeta(libs)}<script>${BOOT}<\/script></head><body></body></html>`;
}

// Hors de Prism, le bus n'existe pas : version inerte, pour que le widget exporté fonctionne seul.
const BUS_SHIM = "<script>window.prism=window.prism||{emit:function(){},on:function(){return function(){};},off:function(){}};<\/script>";

/** Fichier .html autonome : données et accent inclus ; ouvert hors sandbox, il utilise le vrai localStorage. */
export async function exportHtml(card) {
  const note = `<!-- Exporté depuis Prism · ${new Date().toISOString().slice(0, 10)} -->`;
  const file = card.file && card.file.blob ? dataScript(await card.file.blob.text()) : inlineFile(card.file);
  return injectInHead(card.html, note + accentStyle(card.accent) + file + BUS_SHIM);
}

const THUMBNAIL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_THUMBNAIL = 300_000;

/** Miniature envoyée par un widget (données non fiables) : image matricielle en base64 uniquement. */
export const acceptThumbnail = (data) => typeof data === "string" && data.length <= MAX_THUMBNAIL && THUMBNAIL_RE.test(data);

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
