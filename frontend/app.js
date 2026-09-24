"use strict";

/* ==========================================================================
   Prism — logique du frontend (Vanilla JS, aucune dépendance)
   ========================================================================== */

// Servi par le backend : même origine. Ouvert en file:// : backend local par défaut.
const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
const MAX_CHARS = 12000;

const $ = (id) => document.getElementById(id);
const els = {
  form: $("form"),
  prompt: $("prompt"),
  charCount: $("char-count"),
  generate: $("generate"),
  generateLabel: $("generate-label"),
  engine: $("engine"),
  engineText: $("engine-text"),
  status: $("status"),
  statusText: $("status-text"),
  viewport: $("viewport"),
  empty: $("empty"),
  skeleton: $("skeleton"),
  skText: $("sk-text"),
  frame: $("frame"),
  code: $("code"),
  codeContent: $("code-content"),
  meta: $("meta"),
  btnCode: $("btn-code"),
  btnCopy: $("btn-copy"),
  btnReload: $("btn-reload"),
  btnFull: $("btn-full"),
};

const state = {
  controller: null, // AbortController de la requête en cours
  timer: null,
  result: null, // { html, mode, model, elapsed_ms, warnings }
  runtimeErrors: [],
};

const WARNING_LABELS = {
  external_resource: "ressource externe (bloquée par la CSP)",
  "sandbox_api:localStorage": "localStorage (remplacé par un stockage mémoire)",
  "sandbox_api:sessionStorage": "sessionStorage (remplacé par un stockage mémoire)",
  "sandbox_api:document.cookie": "cookies (indisponibles dans la sandbox)",
  "sandbox_api:fetch()": "appel réseau (bloqué par la CSP)",
  missing_doctype: "doctype absent",
};

/* --------------------------------------------------------------------------
   Isolation du code généré
   - iframe sandbox="allow-scripts" (sans allow-same-origin : origine opaque) ;
   - CSP injectée : aucune requête réseau possible (pas d'exfiltration) ;
   - prélude : remonte les erreurs JS au parent via postMessage et remplace
     localStorage/sessionStorage (qui lèvent une exception en sandbox).
   -------------------------------------------------------------------------- */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
].join("; ");

const PRELUDE_JS = `(function () {
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
  var memoryStorage = function () {
    var s = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; },
      setItem: function (k, v) { s[k] = String(v); },
      removeItem: function (k) { delete s[k]; },
      clear: function () { s = {}; },
      key: function (i) { return Object.keys(s)[i] || null; },
      get length() { return Object.keys(s).length; }
    };
  };
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { void window[name].length; } catch (e) {
      try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (e2) {}
    }
  });
  window.addEventListener("load", function () { send("ready"); });
})();`;

const PRELUDE = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${PRELUDE_JS}<\/script>`;

function buildSrcdoc(html) {
  const headOpen = /<head(\s[^>]*)?>/i;
  if (headOpen.test(html)) return html.replace(headOpen, (m) => m + PRELUDE);
  const htmlOpen = /<html(\s[^>]*)?>/i;
  if (htmlOpen.test(html)) return html.replace(htmlOpen, (m) => `${m}<head>${PRELUDE}</head>`);
  return `<!DOCTYPE html><html><head>${PRELUDE}</head><body>${html}</body></html>`;
}

/* --------------------------------------------------------------------------
   Indicateurs d'état
   -------------------------------------------------------------------------- */
function setStatus(kind, text) {
  els.status.dataset.state = kind;
  els.statusText.textContent = text;
  els.statusText.title = text;
}

function formatSeconds(ms) {
  return (ms / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " s";
}

function showPanel(panel) {
  els.empty.hidden = panel !== "empty";
  els.skeleton.hidden = panel !== "loading";
  els.frame.hidden = panel !== "frame";
  els.code.hidden = panel !== "code";
}

function setLoading(on) {
  els.generate.classList.toggle("is-loading", on);
  els.generateLabel.textContent = on ? "Annuler" : "Générer";
  els.generate.setAttribute("aria-label", on ? "Annuler la génération" : "Générer le composant");
  els.prompt.readOnly = on;
  clearInterval(state.timer);
  if (on) {
    const started = performance.now();
    const tick = () => {
      const ms = performance.now() - started;
      els.skText.textContent = `Prism réfracte votre demande… ${formatSeconds(ms)}`;
      setStatus("loading", `Génération en cours · ${formatSeconds(ms)}`);
    };
    tick();
    state.timer = setInterval(tick, 100);
  }
}

function setToolsEnabled(on) {
  [els.btnCode, els.btnCopy, els.btnReload, els.btnFull].forEach((b) => { b.disabled = !on; });
}

function renderMeta(result) {
  const size = new Blob([result.html]).size / 1024;
  const parts = [
    result.mode === "mock" ? `démo · ${result.model.replace("mock:", "")}` : result.model,
    formatSeconds(result.elapsed_ms),
    `${size.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} ko`,
  ];
  els.meta.replaceChildren(document.createTextNode(parts.join(" · ")));
  const notes = (result.warnings || []).filter((w) => WARNING_LABELS[w]);
  if (notes.length) {
    const span = document.createElement("span");
    span.className = "warn";
    span.textContent = " · ⚠ " + notes.map((w) => WARNING_LABELS[w]).join(", ");
    els.meta.append(span);
  }
}

/* --------------------------------------------------------------------------
   Rendu
   -------------------------------------------------------------------------- */
function mountFrame(html) {
  state.runtimeErrors = [];
  els.btnCode.setAttribute("aria-pressed", "false");
  showPanel("frame");
  els.frame.classList.remove("is-entering");
  void els.frame.offsetWidth; // relance l'animation d'apparition
  els.frame.classList.add("is-entering");
  els.frame.srcdoc = buildSrcdoc(html);
}

window.addEventListener("message", (event) => {
  // Seuls les messages de NOTRE iframe comptent (origine opaque => "null").
  if (event.source !== els.frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data.prism !== "string") return;
  if (data.prism === "error") {
    state.runtimeErrors.push(data);
    const where = data.line ? ` (ligne ${data.line})` : "";
    setStatus("warn", `Rendu avec erreur JS : ${String(data.message).slice(0, 140)}${where}`);
  }
});

/* --------------------------------------------------------------------------
   Génération
   -------------------------------------------------------------------------- */
function errorMessage(payload, status) {
  if (payload && typeof payload.detail === "string") return payload.detail;
  if (payload && Array.isArray(payload.detail)) return payload.detail.map((d) => d.msg).join(" ; ");
  return `Erreur serveur (HTTP ${status})`;
}

async function generate() {
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    els.prompt.setAttribute("aria-invalid", "true");
    setStatus("error", "Écrivez d'abord une demande.");
    els.prompt.focus();
    return;
  }
  els.prompt.removeAttribute("aria-invalid");
  saveDraft();

  const controller = new AbortController();
  state.controller = controller;
  setLoading(true);
  setToolsEnabled(false);
  els.btnCode.setAttribute("aria-pressed", "false");
  showPanel("loading");
  els.meta.textContent = "";

  let reachedServer = false;
  try {
    const res = await fetch(`${API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    reachedServer = true;
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(errorMessage(payload, res.status));
    if (!payload || typeof payload.html !== "string" || !payload.html.trim()) {
      throw new Error("Réponse vide du serveur.");
    }

    state.result = payload;
    mountFrame(payload.html);
    setToolsEnabled(true);
    renderMeta(payload);
    const label = payload.mode === "mock" ? "Composant de démo prêt" : "Composant prêt";
    setStatus("success", `${label} · ${formatSeconds(payload.elapsed_ms)}`);
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("idle", "Génération annulée");
    } else if (!reachedServer) {
      setStatus("error", "Serveur injoignable : lancez « python backend/app.py »");
    } else {
      setStatus("error", `Échec : ${err.message}`);
    }
    if (state.result) {
      showPanel("frame"); // le dernier composant valide reste affiché, avec son état
      setToolsEnabled(true);
    } else {
      showPanel("empty");
    }
  } finally {
    if (state.controller === controller) state.controller = null;
    setLoading(false);
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.controller) {
    state.controller.abort();
    return;
  }
  generate();
});

els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

els.prompt.addEventListener("input", () => {
  els.prompt.removeAttribute("aria-invalid");
  updateCounter();
});

document.querySelectorAll(".chip[data-prompt]").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (state.controller) return;
    els.prompt.value = chip.dataset.prompt;
    updateCounter();
    els.prompt.focus();
  });
});

/* --------------------------------------------------------------------------
   Barre d'outils
   -------------------------------------------------------------------------- */
els.btnCode.addEventListener("click", () => {
  if (!state.result) return;
  const showCode = els.btnCode.getAttribute("aria-pressed") !== "true";
  els.btnCode.setAttribute("aria-pressed", String(showCode));
  if (showCode) {
    els.codeContent.textContent = state.result.html;
    showPanel("code");
  } else {
    showPanel("frame");
  }
});

els.btnCopy.addEventListener("click", async () => {
  if (!state.result) return;
  try {
    await navigator.clipboard.writeText(state.result.html);
    flashButton(els.btnCopy, "Copié ✓");
  } catch {
    flashButton(els.btnCopy, "Échec");
  }
});

els.btnReload.addEventListener("click", () => {
  if (!state.result) return;
  mountFrame(state.result.html);
  setStatus("success", "Composant relancé");
});

els.btnFull.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else els.viewport.requestFullscreen?.().catch(() => setStatus("warn", "Plein écran refusé par le navigateur"));
});

function flashButton(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1400);
}

/* --------------------------------------------------------------------------
   Divers : compteur, brouillon, moteur
   -------------------------------------------------------------------------- */
function updateCounter() {
  els.charCount.textContent = `${els.prompt.value.length.toLocaleString("fr-FR")} / ${MAX_CHARS.toLocaleString("fr-FR")}`;
}

function saveDraft() {
  try { localStorage.setItem("prism:draft", els.prompt.value); } catch { /* stockage indisponible */ }
}

function restoreDraft() {
  try {
    const draft = localStorage.getItem("prism:draft");
    if (draft) els.prompt.value = draft;
  } catch { /* stockage indisponible */ }
  updateCounter();
}

async function checkEngine() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) throw new Error(String(res.status));
    const info = await res.json();
    if (info.mode === "groq") {
      els.engine.dataset.state = "groq";
      els.engineText.textContent = `Groq · ${info.models[0]}`;
      els.engine.title = `Chaîne de modèles : ${info.models.join(" → ")} · v${info.version}`;
    } else {
      els.engine.dataset.state = "mock";
      els.engineText.textContent = "Mode démo";
      els.engine.title = "GROQ_API_KEY absente : composants pré-écrits. Ajoutez la clé dans backend/.env.";
    }
  } catch {
    els.engine.dataset.state = "offline";
    els.engineText.textContent = "Serveur hors ligne";
    els.engine.title = "Lancez : python backend/app.py";
  }
}

restoreDraft();
checkEngine();
