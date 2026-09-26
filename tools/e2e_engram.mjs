// Test E2E de la V4 (Engramme cognitif) : Chrome headless piloté par le protocole DevTools (CDP).
//
// Scénario : « Engramme : Marie Curie » dans le dock → carte Engramme (30 bulles, rendu Canvas) ; survol
// réel d'une bulle (arrêt, fiche Liquid Glass) ; clic → filtre ADN dans le dock → génération filtrée ;
// fichier CSV déposé sur une bulle (« Injection d'ADN ») → widget généré à côté ; double-clic dans un
// widget → zoom fractal ; incantation (Espace maintenu, micro factice de Chrome, reconnaissance vocale
// simulée) → carte sous le pointeur et verre organique ; refactorisation refusée ; rechargement.
//
// Usage : node tools/e2e_engram.mjs [--base URL] [--screenshot capture.png]
//   Serveur (tools/e2e_server.py --demo) ou site statique (moteur navigateur, démo) : détecté.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };
const BASE = opt("base") || "http://127.0.0.1:8004";
const SHOT = opt("screenshot");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = [
  process.env.PRISM_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));

// Reconnaissance vocale simulée (le vrai service de Chrome exige le réseau de Google) : une phrase
// intermédiaire au démarrage, la phrase finale à l'arrêt. Le micro, lui, est le périphérique factice
// de Chrome (--use-fake-device-for-media-stream) : l'AudioContext mesure un vrai signal.
const FAKE_SPEECH = `(() => {
  class FakeRecognition {
    start() {
      this.phrase = window.__fakeSpeech || "Crée une horloge analogique";
      this.timer = setTimeout(() => this.emit(false), 200);
    }
    emit(final) {
      const result = Object.assign([{ transcript: this.phrase, confidence: 0.9 }], { isFinal: final });
      this.onresult && this.onresult({ results: [result], resultIndex: 0 });
    }
    stop() { clearTimeout(this.timer); setTimeout(() => { this.emit(true); this.onend && this.onend(); }, 60); }
    abort() { clearTimeout(this.timer); setTimeout(() => this.onend && this.onend(), 10); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
})();`;

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
  }
  async open() {
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const waiter = msg.id && this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
      } else if (msg.method) this.listeners.forEach((fn) => fn(msg));
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const results = [];
const check = (label, ok, detail = "") => results.push({ label, ok: Boolean(ok), detail });

async function main() {
  if (!BROWSER) throw new Error("Aucun Chrome/Edge trouvé : définissez PRISM_BROWSER.");
  const work = mkdtempSync(join(tmpdir(), "prism-e2e-engram-"));
  const csvPath = join(work, "mesures.csv");
  writeFileSync(csvPath, "echantillon;activite\nA;12\nB;30\nC;7\n");
  const browser = spawn(BROWSER, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const pageErrors = [];
  const consoleLines = []; // avertissements de la page (diagnostic)
  const requests = []; // corps des POST /api/generate et /api/engram (mode serveur)

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buffer = "";
      browser.stderr.on("data", (chunk) => {
        buffer += chunk;
        const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      setTimeout(() => reject(new Error("le navigateur n'a pas ouvert DevTools")), 60000);
    });
    const cdp = new CDP(wsUrl);
    await cdp.open();
    // Micro accordé d'office (sinon la demande peut rester en attente sous CDP) : périphérique factice de Chrome.
    await cdp.send("Browser.grantPermissions", { origin: new URL(BASE).origin, permissions: ["audioCapture"] });
    const { targetInfos } = await cdp.send("Target.getTargets");
    const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
    const frames = new Map(); // session de l'iframe -> session parente
    cdp.listeners.push((msg) => {
      if (msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "iframe") frames.set(msg.params.sessionId, msg.sessionId);
      if (msg.method === "Target.detachedFromTarget") frames.delete(msg.params.sessionId);
      if (msg.sessionId === S && msg.method === "Runtime.consoleAPICalled" && /warn|error/.test(msg.params.type)) {
        consoleLines.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
      }
      if (msg.sessionId === S && msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        pageErrors.push(`${d.exception?.description || d.text} @${d.url || ""}:${d.lineNumber}`);
      }
      if (msg.sessionId === S && msg.method === "Network.requestWillBeSent" && /\/api\/(generate|engram)$/.test(msg.params.request.url)) {
        try { requests.push({ url: msg.params.request.url, body: JSON.parse(msg.params.request.postData || "{}") }); } catch { /* corps non JSON */ }
      }
    });
    await cdp.send("Runtime.enable", {}, S);
    await cdp.send("Network.enable", {}, S);
    await cdp.send("Page.enable", {}, S);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_SPEECH }, S);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, S);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);

    const evaluate = async (expression, session = S) => {
      const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      return res.result.value;
    };
    const waitFor = async (fn, label, timeout = 20000) => {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < timeout) {
        try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
        await sleep(150);
      }
      throw new Error(`délai dépassé : ${label}${last ? ` (${last.message})` : ""}`);
    };
    const findFrame = (predicate, label, exclude = new Set()) => waitFor(async () => {
      for (const [session, parent] of frames) {
        if (parent !== S || exclude.has(session)) continue;
        try { if (await evaluate(`document.readyState === "complete" && (${predicate})`, session)) return session; } catch { /* en chargement */ }
      }
      return null;
    }, label);
    const mouse = (type, x, y, extra = {}) =>
      cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1, ...extra }, S);
    const click = async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
    const doubleClick = async (x, y) => {
      await mouse("mouseMoved", x, y);
      for (const count of [1, 2]) {
        await mouse("mousePressed", x, y, { clickCount: count });
        await mouse("mouseReleased", x, y, { clickCount: count });
      }
    };
    const box = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    const stableBox = (selector) => waitFor(async () => {
      const a = await box(selector);
      await sleep(120);
      const b = await box(selector);
      return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && a.w > 0 ? b : null;
    }, `position stable de ${selector}`);
    const clickSel = async (selector) => { const b = await stableBox(selector); await click(b.cx, b.cy); };
    const key = (type, k) => cdp.send("Input.dispatchKeyEvent", { type, ...k }, S);
    const ENTER = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    const SPACE = { key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
    const submit = async (text) => {
      await clickSel("#prompt");
      await evaluate(`document.getElementById("prompt").value = ""`);
      await cdp.send("Input.insertText", { text }, S);
      await key("keyDown", { ...ENTER, text: "\r" });
      await key("keyUp", ENTER);
    };
    const cards = () => evaluate(`[...document.querySelectorAll(".card")].map((c) => ({ id: c.dataset.id, state: c.dataset.state,
      title: c.querySelector(".card-title").textContent, left: parseFloat(c.style.left), top: parseFloat(c.style.top),
      w: parseFloat(c.style.width), h: parseFloat(c.style.height) }))`);
    const cardCount = async () => (await cards()).length;
    const allReady = () => evaluate(`[...document.querySelectorAll(".card")].every((c) => c.dataset.state === "ready" || c.dataset.state === "warn")
      && [...document.querySelectorAll(".card-body")].every((b) => b.dataset.frame === "live")`);
    /** Point d'une iframe (coordonnées CSS du widget) → point de la page. */
    const toPage = (cardId, x, y) => evaluate(`(() => {
      const f = document.querySelector('.card[data-id="${cardId}"] iframe.card-frame');
      const r = f.getBoundingClientRect(); const s = r.width / f.offsetWidth;
      return { x: r.left + ${x} * s, y: r.top + ${y} * s };
    })()`);
    const worldOf = () => evaluate(`(() => {
      const m = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/.exec(document.getElementById("world").style.transform);
      const r = document.getElementById("workspace").getBoundingClientRect();
      return { x: +m[1], y: +m[2], z: +m[3], left: r.left, top: r.top };
    })()`);

    // ------------------------------------------------------------------ 1. Chargement (+ compte en mode serveur)
    await cdp.send("Page.navigate", { url: BASE }, S);
    const loaded = () => waitFor(() => evaluate(`document.body.classList.contains("is-ready") && document.getElementById("engine").dataset.state !== "pending"`), "chargement", 90000)
      .catch(async (err) => {
        const state = await evaluate(`JSON.stringify({ url: location.href, body: document.body && document.body.className, engine: document.getElementById("engine") && document.getElementById("engine").dataset.state })`).catch((e) => e.message);
        throw new Error(`${err.message} — ${state} — erreurs : ${pageErrors.join(" | ")} — console : ${consoleLines.join(" | ")}`);
      });
    await loaded();
    const serverMode = await evaluate(`!document.getElementById("account").hidden`);
    if (serverMode) {
      // Compte jetable (base temporaire de tools/e2e_server.py), session posée comme après une connexion.
      const status = await evaluate(`(async () => {
        const res = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "e2e-engram-" + Date.now() + "@prism.test", password: crypto.randomUUID() }) });
        const s = await res.json();
        localStorage.setItem("prism:session", JSON.stringify({ token: s.token, user: s.user }));
        return res.status;
      })()`);
      check("compte de test créé", status === 201, `HTTP ${status}`);
      await cdp.send("Page.reload", {}, S);
      await loaded();
    }
    check("Prism chargé", true, serverMode ? "mode serveur" : "moteur navigateur");

    // ------------------------------------------------------------------ 2. Engramme depuis le dock
    await submit("Engramme : Marie Curie");
    await waitFor(async () => (await cardCount()) === 1 && allReady(), "carte Engramme prête", 30000);
    const [engramCard] = await cards();
    const EF = await findFrame(`Boolean(window.__engram)`, "document de l'Engramme");
    const shape = await evaluate(`(() => { const e = window.__engram; const c = {}; e.sim.nodes.forEach((n) => { c[n.category] = (c[n.category] || 0) + 1; });
      return { counts: c, person: e.data.person, title: document.title, links: e.sim.links.length }; })()`, EF);
    check("Engramme : 30 bulles en 4 catégories (1 / 9 / 10 / 10)", JSON.stringify(shape.counts) === JSON.stringify({ core: 1, engine: 9, shadow: 10, artifact: 10 }), JSON.stringify(shape));
    check("titre de la carte", engramCard.title === "Engramme · Marie Curie", engramCard.title);
    if (serverMode) {
      const req = requests.find((r) => r.url.endsWith("/api/engram"));
      check("POST /api/engram (personne, langue)", req && req.body.person === "Marie Curie" && req.body.language === "fr", JSON.stringify(req?.body));
      const sparks = await evaluate(`document.getElementById("sparks-count").textContent`);
      check("2 Sparks débités (50 → 48)", /^48/.test(sparks), sparks);
    }
    // Rendu réel : des pixels lumineux au centre (noyau), le fond ailleurs.
    const pixels = await evaluate(`(() => { const c = document.getElementById("stage"); const g = c.getContext("2d");
      const px = (x, y) => Array.from(g.getImageData(Math.round(x * c.width / innerWidth), Math.round(y * c.height / innerHeight), 1, 1).data);
      const core = window.__engram.sim.nodes[0]; return { core: px(core.x, core.y), corner: px(3, innerHeight - 3) }; })()`, EF);
    check("rendu Canvas : noyau blanc lumineux, fond sombre", pixels.core[0] > 200 && pixels.core[2] > 200 && pixels.corner[0] < 40, JSON.stringify(pixels));
    await sleep(1500);
    const motion = await evaluate(`(async () => { const n = window.__engram.sim.nodes; const a = n.map((m) => [m.x, m.y]);
      await new Promise((r) => setTimeout(r, 500));
      const moved = (cat) => n.filter((m) => m.category === cat).map((m) => Math.hypot(m.x - a[m.index][0], m.y - a[m.index][1]));
      const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
      return { core: avg(moved("core")), engine: avg(moved("engine")), shadow: avg(moved("shadow")), artifact: avg(moved("artifact")) }; })()`, EF);
    check("physique vivante : noyau fixe, moteurs lents, artefacts rapides", motion.core < 1 && motion.engine < motion.artifact && motion.artifact > 20, JSON.stringify(motion));

    // ------------------------------------------------------------------ 3. Survol réel : arrêt, fiche Liquid Glass
    const engine1 = await evaluate(`(() => { const n = window.__engram.sim.nodes.find((m) => m.category === "engine"); return { id: n.id, x: n.x, y: n.y, title: n.data.title }; })()`, EF);
    // La bulle bouge : on la suit jusqu'à ce que le pointeur la tienne (elle s'arrête alors).
    const hovered = await waitFor(async () => {
      const p = await evaluate(`(() => { const n = window.__engram.sim.nodes.find((m) => m.id === ${JSON.stringify(engine1.id)}); return { x: n.x, y: n.y }; })()`, EF);
      const at = await toPage(engramCard.id, p.x, p.y);
      await mouse("mouseMoved", at.x, at.y);
      await sleep(80);
      const st = await evaluate(`window.__engram.state()`, EF);
      return st.hover === engine1.id ? st : null;
    }, "survol d'un moteur", 8000);
    await sleep(400);
    const glass = await evaluate(`(() => { const g = document.getElementById("glass"); const n = window.__engram.sim.nodes.find((m) => m.id === ${JSON.stringify(engine1.id)});
      const x0 = n.x; const y0 = n.y; return new Promise((r) => setTimeout(() => r({ opacity: getComputedStyle(g).opacity, text: g.textContent,
      still: Math.hypot(n.x - x0, n.y - y0), grown: n.r / n.baseR, blur: getComputedStyle(g).backdropFilter }), 300)); })()`, EF);
    check("survol : la bulle s'arrête et grossit", hovered && glass.still < 0.5 && glass.grown > 1.5, `déplacement ${glass.still.toFixed(2)} px, ×${glass.grown.toFixed(2)}`);
    const glassText = glass.text.replace(/\s+/g, " ").trim();
    check("fiche Liquid Glass (verre flouté, textes du nœud)", glass.opacity === "1" && glassText.includes(engine1.title) && /blur/.test(glass.blur) && glassText.includes("Directive ADN"),
      `opacité ${glass.opacity} · ${glass.blur} · ${glassText.slice(0, 90)}…`);

    // ------------------------------------------------------------------ 4. Clic → filtre ADN → génération filtrée
    const here = await evaluate(`(() => { const n = window.__engram.sim.nodes.find((m) => m.id === ${JSON.stringify(engine1.id)}); return { x: n.x, y: n.y }; })()`, EF);
    const at = await toPage(engramCard.id, here.x, here.y);
    await click(at.x, at.y);
    await waitFor(() => evaluate(`!document.getElementById("dna").hidden`), "filtre ADN dans le dock", 5000);
    const chip = await evaluate(`({ title: document.getElementById("dna-title").textContent, meta: document.getElementById("dna-meta").textContent,
      focus: document.activeElement.id, placeholder: document.getElementById("prompt").placeholder })`);
    check("clic sur une bulle : filtre ADN dans le dock, saisie prête", chip.title === engine1.title && chip.focus === "prompt" && chip.placeholder.includes(engine1.title), JSON.stringify(chip));
    check("bulle épinglée dans l'Engramme", (await evaluate(`window.__engram.state().pinned`, EF)) === engine1.id);
    await submit("Un minuteur de concentration");
    await waitFor(async () => (await cardCount()) === 2 && allReady(), "widget filtré prêt", 30000);
    check("après envoi : filtre retiré, bulle libérée",
      (await evaluate(`document.getElementById("dna").hidden`)) && (await evaluate(`window.__engram.state().pinned`, EF)) === null);
    if (serverMode) {
      const req = requests.filter((r) => r.url.endsWith("/api/generate")).at(-1);
      check("POST /api/generate avec le trait (dna)", req?.body.dna?.title === engine1.title && req.body.dna.person === "Marie Curie" && req.body.prompt === "Un minuteur de concentration",
        JSON.stringify(req?.body.dna || null).slice(0, 120));
    }

    // ------------------------------------------------------------------ 5. Injection d'ADN : fichier déposé sur une bulle
    const shadow = await evaluate(`(() => { const n = window.__engram.sim.nodes.find((m) => m.category === "shadow"); return { id: n.id, title: n.data.title }; })()`, EF);
    const csv = await evaluate(`"echantillon;activite\\nA;12\\nB;30\\nC;7\\n"`);
    await evaluate(`(() => {
      const n = window.__engram.sim.nodes.find((m) => m.id === ${JSON.stringify(shadow.id)});
      window.__engram.sim.setHover(n.id); // immobile le temps du geste
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(csv)}], "mesures.csv", { type: "text/csv" }));
      const at = { clientX: n.x, clientY: n.y, bubbles: true, cancelable: true, dataTransfer: dt };
      const stage = document.getElementById("stage");
      stage.dispatchEvent(new DragEvent("dragover", at));
      stage.dispatchEvent(new DragEvent("drop", at));
    })()`, EF);
    const loadingText = await waitFor(() => evaluate(`document.querySelectorAll(".card").length === 3 && document.querySelector(".card:last-of-type .card-overlay-text").textContent`), "carte de l'injection d'ADN", 30000);
    await waitFor(async () => (await cardCount()) === 3 && allReady(), "widget de l'injection d'ADN prêt", 45000).catch(async (err) => {
      const state = await evaluate(`JSON.stringify({ toast: document.getElementById("toast").textContent, cards: document.querySelectorAll(".card").length })`);
      const inFrame = await evaluate(`JSON.stringify(window.__engram.state())`, EF).catch((e) => e.message);
      throw new Error(`${err.message} — page ${state} — Engramme ${inFrame} — erreurs ${pageErrors.join(" | ")}`);
    });
    const injected = (await cards()).at(-1);
    const source = (await cards()).find((c) => c.id === engramCard.id);
    const beside = injected.left >= source.left + source.w || injected.top >= source.top + source.h || injected.left + injected.w <= source.left || injected.top + injected.h <= source.top;
    check("fichier déposé sur une ombre : widget généré à côté de l'Engramme", beside && loadingText.includes(`ADN « ${shadow.title} »`), `${loadingText} @ ${injected.left},${injected.top}`);
    if (serverMode) {
      const req = requests.filter((r) => r.url.endsWith("/api/generate")).at(-1);
      check("injection : trait de l'ombre + résumé du fichier envoyés", req?.body.dna?.category === "shadow" && req.body.file?.name === "mesures.csv", JSON.stringify({ dna: req?.body.dna?.title, file: req?.body.file?.name }));
    }

    // ------------------------------------------------------------------ 6. Zoom fractal
    const WF = await findFrame(`!window.__engram && document.body && document.body.innerText.length > 0`, "document d'un widget", new Set([EF]));
    const target = await evaluate(`(() => { const el = [...document.querySelectorAll("h1, h2, h3, p, li")].find((e) => e.getBoundingClientRect().width > 20);
      const r = el.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2, text: el.textContent.trim().slice(0, 40) }; })()`, WF);
    // Carte de ce widget : repérée par son titre (celui de son document).
    const wTitle = await evaluate(`document.title`, WF);
    const wCard = (await cards()).find((c) => c.title === wTitle && c.id !== engramCard.id);
    await clickSel("#zoom-fit"); // toutes les cartes à l'écran
    await sleep(700);
    const wAt = await toPage(wCard.id, target.x, target.y);
    const before = await cardCount();
    // Carte d'abord sélectionnée (premier plan) : un changement de plan entre les deux clics d'un double-clic
    // peut perdre le second au-dessus d'une iframe isolée (limite du navigateur, cf. phase 5).
    await click(wAt.x, wAt.y);
    await sleep(400);
    await doubleClick(wAt.x, wAt.y);
    await waitFor(() => evaluate(`!document.getElementById("fractal").hidden`), "proposition de zoom fractal", 5000)
      .catch(async (err) => { throw new Error(`${err.message} — cible ${JSON.stringify(target)} dans « ${wTitle} » (${wCard && wCard.id}) — page ${JSON.stringify(wAt)}`); });
    const offer = await evaluate(`document.getElementById("fractal-label").textContent`);
    check("double-clic dans un widget : zoom fractal proposé", offer.length > 0, offer);
    await clickSel("#fractal-go");
    await waitFor(async () => (await cardCount()) === before + 1, "carte fractale créée", 5000);
    // Origine de l'animation d'émergence (posée à la création ; la classe, elle, disparaît en fin d'animation).
    const emerging = await evaluate(`Boolean(document.querySelector(".card:last-of-type").style.getPropertyValue("--from-dx"))`);
    await waitFor(allReady, "sous-widget prêt", 30000);
    check("sous-widget : la carte émerge du point du double-clic", emerging);
    if (serverMode) {
      const req = requests.filter((r) => r.url.endsWith("/api/generate")).at(-1);
      check("POST /api/generate : consigne « Zoom fractal » avec l'extrait du composant", /^Zoom fractal sur/.test(req?.body.prompt || "") && req.body.prompt.includes("Extrait de son code"), (req?.body.prompt || "").slice(0, 90));
    }
    // Double-clic dans l'Engramme : pas de zoom fractal (données, pas une interface).
    const eMid = await toPage(engramCard.id, 40, 40);
    await doubleClick(eMid.x, eMid.y);
    await sleep(600);
    check("double-clic dans l'Engramme : aucun zoom fractal", await evaluate(`document.getElementById("fractal").hidden`));

    // ------------------------------------------------------------------ 7. Incantation + verre organique
    await evaluate(`document.activeElement && document.activeElement.blur()`);
    const pointer = { x: 260, y: 300 };
    await mouse("mouseMoved", pointer.x, pointer.y);
    const view = await worldOf();
    const countBefore = await cardCount();
    const gumProbe = () => evaluate(`(async () => { const t = performance.now(); const r = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((k) => k.stop()); return "ok"; }, (e) => e.name),
        new Promise((res) => setTimeout(() => res("en attente"), 15000))]); return r + " en " + Math.round(performance.now() - t) + " ms"; })()`);
    // Préchauffage : le tout premier accès au micro factice peut prendre plus de 10 s sur une machine chargée
    // (démarrage du service audio de Chrome headless) ; hors test, l'autorisation du micro le précède de toute façon.
    const warm = await gumProbe();
    await key("keyDown", { ...SPACE, text: " " });
    await waitFor(() => evaluate(`!document.getElementById("incantation").hidden && document.body.classList.contains("is-incanting")`), "orbe d'incantation", 3000);
    for (let i = 0; i < 8; i++) {
      await key("keyDown", { ...SPACE, text: " ", autoRepeat: true });
      await sleep(60);
    }
    const heard = await waitFor(() => evaluate(`(() => { const t = document.querySelector("#incantation .inc-text").textContent; return t.includes("horloge") ? t : null; })()`), "transcription affichée", 3000);
    let organic = 0;
    const t0 = Date.now();
    const seen = new Set();
    let organicAt = null;
    // Premier accès au micro : l'initialisation audio peut prendre plusieurs secondes sur une machine chargée.
    while (Date.now() - t0 < 10000 && (organic === 0 || Date.now() - t0 < 1500)) {
      const raw = await evaluate(`document.documentElement.style.getPropertyValue("--organic")`);
      seen.add(raw);
      organic = Math.max(organic, Number(raw || 0));
      if (organic && organicAt === null) organicAt = Date.now() - t0;
      await sleep(80);
    }
    if (!organic) consoleLines.push(`valeurs vues : ${JSON.stringify([...seen])}`);
    const orb = await box("#incantation .inc-orb");
    if (!organic) {
      consoleLines.push(await evaluate(`(async () => { const t = performance.now(); const r = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((k) => k.stop()); return "ok"; }, (e) => e.name),
        new Promise((res) => setTimeout(() => res("en attente"), 5000))]);
        return "getUserMedia direct : " + r + " en " + Math.round(performance.now() - t) + " ms, focus " + document.hasFocus() + ", visible " + document.visibilityState; })()`));
    }
    await key("keyUp", SPACE);
    await waitFor(async () => (await cardCount()) === countBefore + 1, "carte incantée", 5000);
    check("Espace maintenu : orbe au pointeur, transcription en direct", Math.hypot(orb.cx - pointer.x, orb.cy - pointer.y) < 30, `« ${heard} » · orbe à ${Math.round(orb.cx)},${Math.round(orb.cy)}`);
    const analysed = [...seen].some((v) => v !== "");
    check("verre organique : le micro est analysé en direct (AudioContext → --organic)", analysed,
      `niveau max ${organic}${organicAt === null ? "" : `, dès ${organicAt} ms`} (micro préchauffé : ${warm})${analysed ? "" : ` — console : ${consoleLines.join(" | ")}`}`);
    check("après l'incantation : micro rendu, verre normal", await evaluate(`!document.body.classList.contains("is-incanting") && !document.documentElement.style.getPropertyValue("--organic")`));
    const spelled = (await cards()).at(-1);
    const wx = (pointer.x - view.left - view.x) / view.z;
    const wy = (pointer.y - view.top - view.y) / view.z;
    check("carte créée sous le pointeur (centre ≈ point de l'incantation)", Math.hypot(spelled.left + spelled.w / 2 - wx, spelled.top + spelled.h / 2 - wy) < 2,
      `${spelled.title} : centre ${Math.round(spelled.left + spelled.w / 2)},${Math.round(spelled.top + spelled.h / 2)} / pointeur ${Math.round(wx)},${Math.round(wy)}`);
    await waitFor(allReady, "carte incantée prête", 30000);
    // Effet du verre organique : la voix (--organic, 0 → 1) épaissit le flou du verre (28 → 68 px).
    const glassAt = (level) => evaluate(`(() => { document.body.classList.add("is-incanting"); document.documentElement.style.setProperty("--organic", "${level}");
      const f = getComputedStyle(document.getElementById("dock")).backdropFilter; document.body.classList.remove("is-incanting");
      document.documentElement.style.removeProperty("--organic"); return f; })()`);
    const [calm, loud] = [await glassAt(0), await glassAt(1)];
    check("verre organique : la voix épaissit le flou du verre", /blur\(28px\)/.test(calm) && /blur\(68px\)/.test(loud), `${calm} → ${loud}`);
    // Appui bref sur Espace : rien.
    await key("keyDown", { ...SPACE, text: " " });
    await sleep(80);
    await key("keyUp", SPACE);
    await sleep(500);
    check("appui bref sur Espace : aucune incantation", (await evaluate(`document.getElementById("incantation").hidden`)) && (await cardCount()) === countBefore + 1);

    // ------------------------------------------------------------------ 8. Inspecteur : un Engramme ne se refactorise pas
    const bar = await toPage(engramCard.id, 0, 0);
    await click(bar.x + 60, bar.y - 14); // barre de titre de la carte → inspecteur
    await waitFor(() => evaluate(`!document.getElementById("inspector").hidden`), "inspecteur", 5000);
    const insp = await evaluate(`({ disabled: document.getElementById("refactor-input").disabled, note: document.getElementById("refactor-note").textContent,
      hidden: document.getElementById("refactor-note").hidden })`);
    check("inspecteur : refactorisation désactivée pour un Engramme", insp.disabled && !insp.hidden && insp.note.startsWith("Un Engramme"), insp.note);

    // ------------------------------------------------------------------ 9. Spotlight
    await key("keyDown", { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 });
    await key("keyUp", { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 });
    await waitFor(() => evaluate(`document.getElementById("spotlight").open`), "Spotlight", 5000);
    await cdp.send("Input.insertText", { text: "engramme de Ada Lovelace" }, S);
    const first = await waitFor(() => evaluate(`document.querySelector("#spotlight-list [role=option]")?.textContent`), "résultats Spotlight", 5000);
    check("Spotlight : « engramme de … » propose l'Engramme en premier", first.includes("Engramme cognitif de « Ada Lovelace »"), first);
    await key("keyDown", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await key("keyUp", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

    // ------------------------------------------------------------------ 10. Rechargement
    const total = await cardCount();
    await sleep(1500); // écritures IndexedDB regroupées
    await cdp.send("Page.reload", {}, S);
    await loaded();
    await waitFor(async () => (await cardCount()) === total && allReady(), "cartes restaurées", 30000);
    const EF2 = await findFrame(`Boolean(window.__engram) && window.__engram.sim.nodes.length === 30`, "Engramme restauré");
    check("rechargement : Engramme restauré et vivant", Boolean(EF2), `${total} cartes`);
    if (SHOT) {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
      writeFileSync(SHOT, Buffer.from(data, "base64"));
    }
    check("aucune erreur JavaScript dans la page", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  } finally {
    browser.kill();
    await sleep(300);
    try { rmSync(work, { recursive: true, force: true }); } catch { /* profil encore verrouillé */ }
  }
}

main()
  .catch((err) => check("scénario complet", false, err.stack || err.message))
  .finally(() => {
    for (const r of results) console.log(`${r.ok ? "OK  " : "ÉCHEC"} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
    process.exit(failed ? 1 : 0);
  });
