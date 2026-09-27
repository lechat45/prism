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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };
const BASE = opt("base") || "http://127.0.0.1:8004";
const SHOT = opt("screenshot");
const SHOT_CHAT = opt("screenshot-chat"); // capture pendant la conversation (ronds de la logique écrits)
const SHOT_FUSION = opt("screenshot-fusion"); // V5 : captures pendant puis après la fusion (…-intro.png, …-fin.png)
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
    "--no-first-run", "--disable-gpu-shader-disk-cache", "--no-default-browser-check", "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required",
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
      if (msg.sessionId === S && msg.method === "Network.requestWillBeSent" && /\/api\/(generate|engram(\/fusion)?)$/.test(msg.params.request.url)) {
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
    check("Engramme : 37 bulles en 5 catégories (1 / 7 / 9 / 10 / 10)", JSON.stringify(shape.counts) === JSON.stringify({ core: 1, heart: 7, engine: 9, shadow: 10, artifact: 10 }), JSON.stringify(shape));
    const character = await evaluate(`({ temperament: document.getElementById("temperament").textContent,
      climate: [...document.querySelectorAll("#climate li")].map((li) => li.textContent) })`, EF);
    check("caractère et émotions : tempérament et climat émotionnel affichés", character.temperament.startsWith("Réservée") && character.climate.length === 4 && /Passion 35/.test(character.climate[0]),
      JSON.stringify(character.climate));
    check("titre de la carte", engramCard.title === "Engramme · Marie Curie", engramCard.title);
    if (serverMode) {
      const req = requests.find((r) => r.url.endsWith("/api/engram"));
      check("POST /api/engram (personne, langue)", req && req.body.person === "Marie Curie" && req.body.language === "fr", JSON.stringify(req?.body));
      const sparks = await evaluate(`document.getElementById("sparks-count").textContent`);
      check("2 Sparks débités (50 → 48)", /^48/.test(sparks), sparks);
    }
    // Rendu réel : des pixels lumineux au centre (noyau), le fond ailleurs — lus par le fil qui dessine.
    const pixels = await evaluate(`(async () => { const core = window.__engram.sim.nodes[0];
      const [c, corner] = await window.__engram.pixels([[core.x, core.y], [3, innerHeight - 3]]); return { core: c, corner }; })()`, EF);
    check("rendu Canvas : noyau blanc lumineux, fond sombre", pixels.core[0] > 200 && pixels.core[2] > 200 && pixels.corner[0] < 40, JSON.stringify(pixels));
    // Phase 1 (V5) : physique et dessin dans un Worker (OffscreenCanvas) ; le fil de la carte reste libre.
    const perf = await waitFor(() => evaluate(`window.__engram.perf()`, EF), "mesures du fil de rendu", 5000).catch(() => null);
    check("rendu dans un Worker (OffscreenCanvas), mesures publiées", (await evaluate(`window.__engram.mode`, EF)) === "worker" && perf && perf.fps > 0,
      perf ? `${perf.fps.toFixed(0)} img/s · physique ${perf.physics.toFixed(2)} ms · dessin ${perf.draw.toFixed(2)} ms` : "aucune mesure");
    await sleep(1500);
    const motion = await evaluate(`(async () => { const n = window.__engram.sim.nodes; const a = n.map((m) => [m.x, m.y]);
      await new Promise((r) => setTimeout(r, 500));
      const moved = (cat) => n.filter((m) => m.category === cat).map((m) => Math.hypot(m.x - a[m.index][0], m.y - a[m.index][1]));
      const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
      return { core: avg(moved("core")), engine: avg(moved("engine")), shadow: avg(moved("shadow")), artifact: avg(moved("artifact")) }; })()`, EF);
    check("physique vivante : noyau fixe, moteurs lents, ombres et artefacts vifs", motion.core < 1 && motion.artifact > motion.engine * 2 && motion.shadow > motion.engine * 3, JSON.stringify(motion));

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
    // Texte de chargement capté au vol : en démo, la carte est prête (texte effacé) en quelques millisecondes.
    await evaluate(`(() => {
      window.__overlayTexts = [];
      new MutationObserver(() => document.querySelectorAll(".card-overlay-text").forEach((el) => {
        if (el.textContent && !window.__overlayTexts.includes(el.textContent)) window.__overlayTexts.push(el.textContent);
      })).observe(document.getElementById("world"), { subtree: true, childList: true, characterData: true });
    })()`);
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
    const loadingText = await waitFor(() => evaluate(`document.querySelectorAll(".card").length === 3 && window.__overlayTexts.find((t) => t.startsWith("ADN «"))`), "carte de l'injection d'ADN", 30000)
      .catch(async (err) => {
        const page = await evaluate(`JSON.stringify({ toast: document.getElementById("toast").textContent, cards: document.querySelectorAll(".card").length })`);
        const inFrame = await evaluate(`JSON.stringify(window.__engram.state())`, EF).catch((e) => e.message);
        throw new Error(`${err.message} — page ${page} — Engramme ${inFrame} — erreurs ${pageErrors.join(" | ")} — console ${consoleLines.join(" | ")}`);
      });
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
    // Éléments candidats du widget (coordonnées de l'iframe).
    const candidates = await evaluate(`[...document.querySelectorAll("h1, h2, h3, p, li")].filter((e) => e.getBoundingClientRect().width > 20).slice(0, 20)
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2, text: el.textContent.trim().slice(0, 40) }; })`, WF);
    // Carte de ce widget : repérée par son titre (celui de son document).
    const wTitle = await evaluate(`document.title`, WF);
    const wCard = (await cards()).find((c) => c.title === wTitle && c.id !== engramCard.id);
    await clickSel("#zoom-fit"); // toutes les cartes à l'écran
    await sleep(700);
    // Premier élément dont le point, dans la page, tombe bien sur l'iframe du widget (ni barre du haut, ni dock).
    let target = candidates[0];
    let wAt = await toPage(wCard.id, target.x, target.y);
    for (const c of candidates) {
      const at = await toPage(wCard.id, c.x, c.y);
      const hit = await evaluate(`document.elementFromPoint(${at.x}, ${at.y}) === document.querySelector('.card[data-id="${wCard.id}"] iframe.card-frame')`);
      if (hit) { target = c; wAt = at; break; }
    }
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
    // Appui bref sur Espace : rien. Appui et relâchement dans la même tâche : sous CDP, deux évènements
    // séparés peuvent arriver à plus de 260 ms d'écart sur une machine chargée (incantation légitime).
    await evaluate(`(() => {
      const opts = { key: " ", code: "Space", bubbles: true, cancelable: true };
      document.body.dispatchEvent(new KeyboardEvent("keydown", opts));
      document.body.dispatchEvent(new KeyboardEvent("keyup", opts));
    })()`);
    await sleep(600);
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

    // ------------------------------------------------------------------ 9 bis. Discuter avec Marie Curie
    const sparksBefore = serverMode ? await evaluate(`document.getElementById("sparks-count").textContent`) : null;
    await evaluate(`document.getElementById("chat-btn").click()`, EF); // bouton « Discuter avec … » de la carte
    await waitFor(() => evaluate(`!document.getElementById("chat").hidden`), "panneau de conversation", 5000);
    const chatTitle = await evaluate(`document.getElementById("chat-title").textContent`);
    await clickSel("#chat-input");
    await cdp.send("Input.insertText", { text: "Comment avez-vous vécu la mort de Pierre ?" }, S);
    await key("keyDown", { ...ENTER, text: "\r" });
    await key("keyUp", ENTER);
    const reply = await waitFor(() => evaluate(`(() => {
      const m = [...document.querySelectorAll("#chat-log .msg-persona:not(.is-pending)")];
      return m.length ? { text: m.at(-1).querySelector(".msg-text").textContent, steps: [...m.at(-1).querySelectorAll(".msg-trace strong")].map((s) => s.textContent) } : null;
    })()`), "réponse de la conversation", 20000);
    check("« Discuter avec Marie Curie » : réponse et sa logique (ronds numérotés)", chatTitle === "Marie Curie" && reply.steps.length > 0 && reply.text.length > 20,
      `${reply.steps.join(" → ")} — ${reply.text.slice(0, 60)}…`);
    const traced = await waitFor(async () => { const t = await evaluate(`window.__engram.state().trace`, EF); return t.length ? t : null; }, "trace sur la carte", 5000);
    check("les ronds de la logique s'écrivent sur l'Engramme", traced.includes("h4"), traced.join(" → "));
    if (SHOT_CHAT) {
      await sleep(4500); // le temps que chaque rond écrive son explication
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
      writeFileSync(SHOT_CHAT, Buffer.from(data, "base64"));
    }
    if (serverMode) {
      const sparksAfter = await evaluate(`document.getElementById("sparks-count").textContent`);
      check("un quart de Spark par message", Math.abs(parseFloat(sparksBefore.replace(",", ".")) - parseFloat(sparksAfter.replace(",", ".")) - 0.25) <= 0.05 /* compteur arrondi au dixième */, `${sparksBefore} → ${sparksAfter}`);
    }
    await clickSel("#chat-close");
    // Paramètres (roue dentée) : la conversation figure dans « Mes écrits », la version dans « À propos ».
    await clickSel("#btn-prefs");
    await waitFor(() => evaluate(`document.getElementById("prefs").open`), "paramètres", 5000);
    await evaluate(`document.querySelector('#prefs [data-tab="writings"]').click()`);
    const writings = await waitFor(() => evaluate(`(() => { const t = document.getElementById("prefs-body").textContent; return t.includes("Conversations") ? t : null; })()`), "mes écrits", 5000);
    await evaluate(`document.querySelector('#prefs [data-tab="about"]').click()`);
    const about = await evaluate(`document.getElementById("prefs-body").textContent`);
    const badge = await evaluate(`document.getElementById("app-version").textContent.trim()`);
    check("Paramètres : mes écrits (conversation avec Marie Curie) et version", writings.includes("Marie Curie") && writings.includes("Reprendre") && about.includes(badge) && /^v\d+\.\d+\.\d+/.test(badge),
      `${badge} · ${writings.slice(0, 80)}…`);
    await clickSel("#prefs-close");
    check("conversation fermée : la trace quitte la carte", await waitFor(async () => (await evaluate(`window.__engram.state().trace.length`, EF)) === 0, "trace effacée", 5000).then(() => true).catch(() => false));
    if (serverMode) {
      // Mon Hub : la personne apparaît en tête, avec « Discuter ».
      await clickSel("#btn-hub");
      const people = await waitFor(() => evaluate(`(() => { const s = document.getElementById("hub-people"); return !s.hidden && s.textContent.includes("Marie Curie") ? [...s.querySelectorAll(".hub-person strong")].map((e) => e.textContent) : null; })()`), "personnes de Mon Hub", 10000);
      check("Mon Hub : les personnes (Engrammes) en tête", people.includes("Marie Curie"), people.join(", "));
      await evaluate(`document.querySelector('#hub-people-list .hub-person [data-action="chat"]').click()`);
      const reopened = await waitFor(() => evaluate(`!document.getElementById("hub").open && !document.getElementById("chat").hidden && document.querySelectorAll("#chat-log .msg").length >= 2`), "conversation rouverte depuis Mon Hub", 10000).catch(() => false);
      check("Mon Hub → « Discuter » : la conversation rouvre, historique conservé", reopened);
      await clickSel("#chat-close");
    }

    // ------------------------------------------------------------------ 10. Rechargement
    const total = await cardCount();
    await sleep(1500); // écritures IndexedDB regroupées
    await cdp.send("Page.reload", {}, S);
    await loaded();
    await waitFor(async () => (await cardCount()) === total && allReady(), "cartes restaurées", 30000);
    const EF2 = await findFrame(`Boolean(window.__engram) && window.__engram.sim.nodes.length === 37`, "Engramme restauré");
    check("rechargement : Engramme restauré et vivant", Boolean(EF2), `${total} cartes`);

    // ------------------------------------------------------------------ 11. V5 · Singularité symbiotique (fusion)
    const sparksNow = async () => parseFloat((await evaluate(`document.getElementById("sparks-count").textContent`)).replace(",", "."));
    await submit("Engramme : Ada Lovelace");
    await waitFor(async () => (await cardCount()) === total + 1 && allReady(), "Engramme d'Ada Lovelace prêt", 30000);
    await clickSel("#arrange"); // grille sans chevauchement, puis « Tout voir »
    await sleep(900);
    const ada = (await cards()).find((c) => c.title === "Engramme · Ada Lovelace");
    const curieBox = await stableBox(`.card[data-id="${engramCard.id}"]`);
    const adaBar = await stableBox(`.card[data-id="${ada.id}"] .card-title`);
    const sparksFusion = serverMode ? await sparksNow() : 0;
    await mouse("mouseMoved", adaBar.cx, adaBar.cy);
    await mouse("mousePressed", adaBar.cx, adaBar.cy);
    const [tx, ty] = [curieBox.cx, curieBox.cy];
    for (let i = 1; i <= 14; i++) {
      await mouse("mouseMoved", adaBar.cx + ((tx - adaBar.cx) * i) / 14, adaBar.cy + ((ty - adaBar.cy) * i) / 14, { buttons: 1 });
      await sleep(25);
    }
    const highlighted = await evaluate(`document.querySelector('.card[data-id="${engramCard.id}"]').classList.contains("is-fusion-target")`);
    await mouse("mouseReleased", tx, ty);
    const fusionOffer = await waitFor(() => evaluate(`(() => { const t = document.getElementById("toast"); const b = t.querySelector("button");
      return !t.hidden && b && b.textContent.startsWith("Fusionner") ? { text: t.textContent, button: b.textContent } : null; })()`), "fusion proposée", 5000);
    await sleep(600); // retour de la carte à sa place
    const adaAfter = (await cards()).find((c) => c.id === ada.id);
    check("glisser un Engramme sur un autre : cible surlignée, fusion proposée, carte revenue à sa place",
      highlighted && fusionOffer.text.includes("Ada Lovelace et Marie Curie") && adaAfter.left === ada.left && adaAfter.top === ada.top && !(await evaluate(`Boolean(document.querySelector(".is-fusion-target"))`)),
      `${fusionOffer.button} · ${ada.left},${ada.top} → ${adaAfter.left},${adaAfter.top}`);
    if (serverMode) check("fusion : prix affiché, rien débité avant l'accord", fusionOffer.button === "Fusionner (3 Sparks)" && (await sparksNow()) === sparksFusion, fusionOffer.button);
    const beforeFusion = await cardCount();
    await clickSel("#toast button");
    await waitFor(async () => (await cardCount()) === beforeFusion + 1 && allReady(), "Hyper-Engramme prêt", 30000);
    const hyperCard = (await cards()).find((c) => c.title.startsWith("Hyper-Engramme"));
    const HF = await findFrame(`Boolean(window.__engram) && Array.isArray(window.__engram.data.parents)`, "document de l'Hyper-Engramme");
    const shotFusion = async (suffix) => {
      if (!SHOT_FUSION) return;
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
      writeFileSync(SHOT_FUSION.replace(/\.png$/i, "") + `-${suffix}.png`, Buffer.from(data, "base64"));
    };
    // Le fil de rendu démarre de façon asynchrone : lire l'état une fois le premier instantané arrivé.
    await waitFor(() => evaluate(`window.__engram.state().fusion > 0`, HF), "premier instantané de l'Hyper-Engramme", 8000).catch(() => null);
    await shotFusion("intro");
    const early = await evaluate(`({ fusion: window.__engram.state().fusion, fusing: document.getElementById("stage").classList.contains("is-fusing"),
      kicker: document.querySelector('[data-t="kicker"]').textContent, parents: window.__engram.data.parents })`, HF);
    check("Hyper-Engramme : titre, parents, libellé", hyperCard?.title === "Hyper-Engramme · Ada Lovelace × Marie Curie" && early.kicker.startsWith("Hyper-Engramme")
      && early.parents.join(" + ") === "Ada Lovelace + Marie Curie", `${hyperCard?.title} · ${early.kicker}`);
    check("fusion jouée : attraction des noyaux, ombres en glitch pendant l'introduction", early.fusion !== null && (early.fusion >= 1 || early.fusing),
      `avancement ${early.fusion} · glitch ${early.fusing}`);
    const settled = await waitFor(() => evaluate(`window.__engram.state().fusion === 1 && !document.getElementById("stage").classList.contains("is-fusing")`, HF), "fin de la fusion", 8000).catch(() => false);
    if (SHOT_FUSION) {
      await sleep(2500);
      await shotFusion("fin");
    }
    const lineage = await evaluate(`(() => { const n = window.__engram.data.nodes; const only = (k) => n.filter((x) => x.sources && x.sources.length === 1 && x.sources[0] === k).length;
      return { total: n.length, a: only("a"), b: only("b"), both: n.filter((x) => x.sources && x.sources.length === 2).length,
        artifacts: n.filter((x) => x.category === "artifact").length, seen: localStorage.getItem("prism:fusion-seen") }; })()`, HF);
    check("Hyper-Engramme : bulles des deux vies (provenance), 10 évènements, intro jouée une fois", settled && lineage.total >= 36 && lineage.a > 0 && lineage.b > 0
      && lineage.artifacts === 10 && lineage.seen === "1", JSON.stringify(lineage));
    if (serverMode) {
      const req = requests.filter((r) => r.url.endsWith("/api/engram/fusion")).at(-1);
      check("POST /api/engram/fusion (JSON complet des deux Engrammes), 3 Sparks", req?.body.a?.person === "Ada Lovelace" && req.body.b?.person === "Marie Curie"
        && req.body.a.nodes.length === 37 && Math.abs(sparksFusion - (await sparksNow()) - 3) < 0.05, `${req?.body.a?.nodes?.length} + ${req?.body.b?.nodes?.length} bulles`);
    }

    // ------------------------------------------------------------------ 12. V5 · Darwinisme d'interface (confusion)
    await clickSel("#zoom-fit"); // tout à l'écran : la vue a suivi l'Hyper-Engramme
    await sleep(900);
    /** Widgets prêts (hors Engrammes) dont le centre de l'iframe est visible et libre. */
    const visibleWidgets = () => evaluate(`[...document.querySelectorAll(".card")].map((c) => {
      const title = c.querySelector(".card-title").textContent;
      const f = c.querySelector("iframe.card-frame");
      if (!f || /^(Hyper-)?Engramme/.test(title) || c.dataset.state !== "ready") return null;
      const r = f.getBoundingClientRect();
      const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
      return r.width > 150 && document.elementFromPoint(cx, cy) === f ? { id: c.dataset.id, title, cx, cy, meta: c.querySelector(".card-meta").textContent } : null;
    }).filter(Boolean)`);
    // Inspecteur fermé pendant les cercles : son verre flouté au-dessus des Engrammes animés sature le rendu
    // logiciel de Chrome headless et espacerait les évènements du pointeur.
    // Zoom (Ctrl + molette) sur le widget : les Engrammes animés sortent de l'écran, où Chrome bride leurs iframes.
    const [aimed] = await visibleWidgets();
    for (let i = 0; i < 20; i++) {
      const w = await evaluate(`document.querySelector('.card[data-id="${aimed.id}"]').getBoundingClientRect().width`);
      if (w > 860) break; // les Engrammes animés sortent de l'écran (leur fil de rendu se met en pause)
      const at = await evaluate(`(() => { const r = document.querySelector('.card[data-id="${aimed.id}"] .card-bar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -240, modifiers: 2 }, S);
      await sleep(120);
    }
    await sleep(600);
    const widget = (await visibleWidgets()).find((w) => w.id === aimed.id) || (await visibleWidgets())[0];
    const withModel = !widget.meta.includes("Démo");
    const requestsBefore = requests.length;
    // Journal des messages (toasts) de la suite du scénario.
    await evaluate(`(() => { window.__toasts = []; const t = document.getElementById("toast");
      new MutationObserver(() => { if (!t.hidden && window.__toasts.at(-1) !== t.textContent) window.__toasts.push(t.textContent); })
        .observe(t, { childList: true, subtree: true, characterData: true, attributes: true }); })()`);
    // Cercles au pointeur (sans clic) jusqu'au verdict, 14 s au plus : une machine chargée peut couper la série.
    // Sujets émis par la carte, tels qu'enregistrés (IndexedDB) : la preuve de l'émission sans ouvrir l'inspecteur.
    const confusionOf = `new Promise((resolve) => {
      const chip = document.querySelector('.card[data-id="${widget.id}"] .card-evolve');
      const out = { chip: chip ? chip.textContent : "", verdict: chip ? { ...chip.dataset } : null, bus: "" };
      const open = indexedDB.open("prism");
      open.onerror = () => resolve(out);
      open.onsuccess = () => {
        const get = open.result.transaction("cards").objectStore("cards").get("${widget.id}");
        get.onsuccess = () => { out.bus = ((get.result && get.result.topics && get.result.topics.emits) || []).join(" "); open.result.close(); resolve(out); };
        get.onerror = () => { open.result.close(); resolve(out); };
      };
    })`;
    // Diagnostic : messages « pointer » reçus du widget, rejoués ensuite dans analyzePointer.
    await evaluate(`(() => { window.__ptr = []; const f = document.querySelector('.card[data-id="${widget.id}"] iframe.card-frame');
      addEventListener("message", (e) => { if (e.source === f.contentWindow && e.data && e.data.prism === "pointer") window.__ptr.push({ t: e.data.t, x: e.data.x, y: e.data.y, at: Date.now() }); }); })()`);
    const fps = await evaluate(`new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 1000 ? requestAnimationFrame(f) : res(n); }; requestAnimationFrame(f); })`);
    const lat = [];
    const t0Circles = Date.now();
    let watch = { chip: "", bus: "" };
    let seenAfter = 0;
    const settledConfusion = (v) => (withModel ? v.chip : v.bus.includes("prism.ux.confusion"));
    for (let i = 0; Date.now() - t0Circles < 14000 && !settledConfusion(watch); i++) {
      const a = ((Date.now() - t0Circles) / 1000) * 0.7 * 2 * Math.PI;
      const tSend = Date.now();
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: widget.cx + 45 * Math.cos(a), y: widget.cy + 45 * Math.sin(a), button: "none", buttons: 0 }, S);
      lat.push(Date.now() - tSend);
      await sleep(20);
      if (i % 15 === 0 && settledConfusion((watch = await evaluate(confusionOf)))) seenAfter = Date.now() - t0Circles;
    }
    await sleep(1200); // une éventuelle pastille (avec modèle) a le temps d'apparaître
    watch = await evaluate(confusionOf);
    // Visible pour l'utilisateur : le sujet figure dans le bus de la carte (inspecteur).
    await evaluate(`document.querySelector('.card[data-id="${widget.id}"] [data-action="inspect"]').click()`);
    const busRow = await waitFor(() => evaluate(`(() => { const t = document.getElementById("bus-topics").textContent; return t.includes("prism.ux.confusion") ? t : null; })()`),
      "sujet dans l'inspecteur", 3000).catch(() => "");
    const tooSoon = seenAfter && seenAfter < 5000 ? ` (trop tôt : ${seenAfter} ms)` : "";
    check("pointeur en rond 5 s sans clic : confusion repérée, sujet prism.ux.confusion émis sur le bus", watch.bus.includes("prism.ux.confusion") && busRow.includes("prism.ux.confusion") && !tooSoon,
      `${widget.title} : après ${(seenAfter / 1000).toFixed(1)} s${tooSoon}` + (watch.bus.includes("prism.ux.confusion") ? "" : ` — diagnostic ${await evaluate(`(async () => {
        const { analyzePointer } = await import("./js/confusion.js");
        const p = window.__ptr; const card = document.querySelector('.card[data-id="${widget.id}"]');
        const gaps = p.slice(1).map((q, i) => q.t - p[i].t);
        return JSON.stringify({ fps: ${fps}, dispatch: "${lat.length} envois, moy. ${Math.round(lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length))} ms, max ${Math.max(0, ...lat)} ms", messages: p.length, state: card.dataset.state, frame: card.querySelector(".card-body").dataset.frame, maxGap: Math.max(0, ...gaps),
          verdict: p.length ? analyzePointer(p.map(({ t, x, y }) => ({ t, x, y })), [], p[p.length - 1].t) : null, bus: document.getElementById("bus-topics").textContent.slice(0, 80) });
      })()`)}`));
    if (!withModel) {
      check("mode démo : aucune simplification proposée (impossible sans modèle), rien dépensé", !watch.chip && requests.length === requestsBefore, watch.chip || "aucune pastille");
    } else {
      check("« Simplifier ? » proposé avec son prix, rien dépensé avant l'accord", watch.chip.includes("Simplifier") && requests.length === requestsBefore
        && (!serverMode || watch.chip.includes("0,5 Spark")), `${watch.chip} · ${JSON.stringify(watch.verdict)}`);
      await clickSel(`.card[data-id="${widget.id}"] .card-evolve-go`);
      const simplifyState = `(() => { const t = document.getElementById("toast"); const c = document.querySelector('.card[data-id="${widget.id}"]');
        return { toast: t.hidden ? "" : t.textContent, state: c && c.dataset.state }; })()`;
      const simplified = await waitFor(async () => { const v = await evaluate(simplifyState); return v.toast.includes("simplifiée") && /ready|warn/.test(v.state) ? v : null; },
        "widget simplifié", 30000).catch(async () => evaluate(simplifyState));
      const simplifyReq = requests.slice(requestsBefore).find((r) => r.url.endsWith("/api/generate"));
      check("« Simplifier » : refactorisation « simplifier l'UX » de la carte, annulable", simplified.toast.includes("simplifiée") && simplified.toast.includes("Annuler")
        && (!serverMode || (/^Simplifie l'expérience/.test(simplifyReq?.body.prompt || "") && Boolean(simplifyReq.body.widget_id))),
        `${simplified.toast} (${simplified.state}) · toasts ${await evaluate(`JSON.stringify(window.__toasts)`)}`);
    }
    await evaluate(`document.getElementById("insp-close").click()`);
    await clickSel("#zoom-fit");
    await sleep(900);

    // ------------------------------------------------------------------ 13. V5 · Sédimentation (dissoudre, contexte fantôme)
    const victim = (await visibleWidgets()).find((w) => w.id !== widget.id); // visible : son sédiment sera à l'écran
    await evaluate(`document.querySelector('.card[data-id="${victim.id}"] [data-action="inspect"]').click()`);
    await waitFor(() => evaluate(`!document.getElementById("inspector").hidden`), "inspecteur", 5000);
    await clickSel("#dissolve-card");
    const shattered = await waitFor(() => evaluate(`Boolean(document.querySelector("canvas.shatter"))`), "particules", 2000).catch(() => false);
    await waitFor(async () => !(await cards()).some((c) => c.id === victim.id), "carte dissoute", 6000);
    const sediment = await evaluate(`(() => { const s = JSON.parse(localStorage.getItem("prism:sediments") || "[]").find((x) => x.id === "${victim.id}");
      return { s, dot: Boolean(document.querySelector('#world .sediment[data-id="${victim.id}"]')), toast: document.getElementById("toast").textContent,
        particles: Boolean(document.querySelector("canvas.shatter")) }; })()`);
    check("« Dissoudre » : particules, sédiment incrusté dans le fond, mots-clés gardés", shattered && sediment.dot && !sediment.particles
      && sediment.s?.words.length > 0 && sediment.toast.includes("dissoute"), `${victim.title} → ${sediment.s?.words.join(", ")} (case ${sediment.s?.cell})`);
    // Une incantation au même endroit : la nouvelle carte reçoit le contexte fantôme de la zone.
    await evaluate(`document.activeElement && document.activeElement.blur(); window.__fakeSpeech = "Crée une liste de courses"`);
    const dot = await box(`#world .sediment[data-id="${victim.id}"]`); // le sédiment : au centre de la carte dissoute
    const spot = { x: dot.cx, y: dot.cy };
    await mouse("mouseMoved", spot.x, spot.y);
    const beforeGhost = await cardCount();
    const requestsGhost = requests.length;
    await key("keyDown", { ...SPACE, text: " " });
    await waitFor(() => evaluate(`!document.getElementById("incantation").hidden`), "orbe d'incantation", 3000);
    for (let i = 0; i < 6; i++) {
      await key("keyDown", { ...SPACE, text: " ", autoRepeat: true });
      await sleep(60);
    }
    await waitFor(() => evaluate(`document.querySelector("#incantation .inc-text").textContent.includes("courses")`), "transcription", 3000);
    const viewGhost = await worldOf();
    await key("keyUp", SPACE);
    await waitFor(async () => (await cardCount()) === beforeGhost + 1 && allReady(), "carte née sur le sédiment", 30000);
    const heir = (await cards()).at(-1);
    await evaluate(`document.querySelector('.card[data-id="${heir.id}"] [data-action="inspect"]').click()`);
    const ghostLine = await waitFor(() => evaluate(`(() => { const g = document.getElementById("insp-ghost"); return !g.hidden ? g.textContent : null; })()`), "contexte sédimenté dans l'inspecteur", 5000)
      .catch(async () => `(rien) — carte ${heir.title} centrée en ${Math.round(heir.left + heir.w / 2)},${Math.round(heir.top + heir.h / 2)} ; sédiment ${sediment.s.x},${sediment.s.y}`
        + ` ; point ${Math.round(spot.x)},${Math.round(spot.y)} → monde ${Math.round((spot.x - viewGhost.left - viewGhost.x) / viewGhost.z)},${Math.round((spot.y - viewGhost.top - viewGhost.y) / viewGhost.z)}`
        + ` ; cartes ${JSON.stringify((await cards()).map((c) => [c.title.slice(0, 14), Math.round(c.left + c.w / 2), Math.round(c.top + c.h / 2)]))}`);
    const ghostReq = requests.slice(requestsGhost).find((r) => r.url.endsWith("/api/generate"));
    const uses = await evaluate(`JSON.parse(localStorage.getItem("prism:sediments") || "[]").find((x) => x.id === "${victim.id}")?.uses`);
    check("génération au même endroit : contexte fantôme envoyé et visible dans l'inspecteur", sediment.s.words.every((w) => ghostLine.includes(w)) && uses === 1
      && (!serverMode || JSON.stringify(ghostReq?.body.ghost) === JSON.stringify(sediment.s.words)), ghostLine);
    await evaluate(`document.getElementById("insp-close").click()`);

    // ------------------------------------------------------------------ 14. V5 · Mode spatial (aperçu en arc)
    await clickSel("#spatial");
    const arc = await waitFor(() => evaluate(`(() => { const c = [...document.querySelectorAll(".card")].map((e) => e.style.getPropertyValue("--arc")).filter(Boolean);
      return document.body.classList.contains("is-spatial") && c.length ? { arcs: c.length, first: c[0] } : null; })()`), "cartes en arc", 5000).catch(() => null);
    const xrToast = await waitFor(() => evaluate(`(() => { const t = document.getElementById("toast").textContent; return /réalité mixte/.test(t) ? t : null; })()`),
      "message du mode spatial", 5000).catch(() => "");
    check("mode spatial : cartes en arc (perspective, inclinaison, profondeur), réalité mixte détectée ou non", Boolean(arc) && /réalité mixte/.test(xrToast),
      arc ? `${arc.arcs} cartes · ${arc.first} · ${xrToast.slice(0, 70)}` : "aucun arc");
    await clickSel("#spatial");
    check("mode spatial quitté : cartes remises à plat", await evaluate(`!document.body.classList.contains("is-spatial") && [...document.querySelectorAll(".card")].every((e) => !e.style.getPropertyValue("--arc"))`));

    // ------------------------------------------------------------------ 15. V5 · Aura sonore (réglage) et Mode Miroir (serveur)
    await clickSel("#btn-prefs");
    await waitFor(() => evaluate(`document.getElementById("prefs").open`), "paramètres", 5000);
    await evaluate(`document.querySelector('#prefs [data-tab="ecosystem"]').click()`);
    const auraBox = await waitFor(() => evaluate(`(() => { const l = [...document.querySelectorAll("#prefs-body label")].find((x) => x.textContent.includes("aura sonore"));
      if (!l) return null; l.querySelector("input").click(); return { on: l.querySelector("input").checked, stored: localStorage.getItem("prism:aura") }; })()`), "réglage de l'aura", 5000);
    check("aura sonore et haptique : désactivée par défaut, activée sur demande (mémorisé)", auraBox.on && auraBox.stored === "true", JSON.stringify(auraBox));
    if (serverMode) {
      const sparksMirror = await sparksNow();
      const mirrorButton = await waitFor(() => evaluate(`[...document.querySelectorAll("#prefs-body button")].some((b) => b.textContent === "Créer mon Engramme")`), "Mode Miroir débloqué", 8000).catch(() => false);
      const mirrorText = await evaluate(`document.querySelector("#prefs-body .prefs-mirror")?.textContent || ""`);
      check("Mode Miroir : débloqué après les Sparks dépensés, données utilisées expliquées", mirrorButton && mirrorText.includes("Jamais votre adresse"), mirrorText.slice(0, 120));
      const before = await cardCount();
      await evaluate(`[...document.querySelectorAll("#prefs-body button")].find((b) => b.textContent === "Créer mon Engramme").click()`);
      await waitFor(async () => (await cardCount()) === before + 1 && allReady(), "Engramme miroir prêt", 30000);
      const MF = await findFrame(`Boolean(window.__engram) && window.__engram.data.mirror === true`, "document du miroir");
      const mirrorDoc = await evaluate(`(() => { const d = window.__engram.data; return { person: d.person, kicker: document.querySelector('[data-t="kicker"]').textContent,
        chat: document.getElementById("chat-btn").hidden, events: d.nodes.filter((n) => n.category === "artifact").length, total: d.nodes.length,
        first: d.nodes.find((n) => n.category === "artifact").title }; })()`, MF);
      check("Mode Miroir : « Miroir · Vous », dix jalons réels, pas de conversation, gratuit", mirrorDoc.person === "Vous" && mirrorDoc.kicker.startsWith("Miroir")
        && mirrorDoc.chat && mirrorDoc.events === 10 && mirrorDoc.total >= 36 && (await sparksNow()) === sparksMirror, JSON.stringify(mirrorDoc));
      const heart = await evaluate(`window.__engram.sim.nodes.find((n) => n.category === "heart").id`, MF);
      await evaluate(`window.__engram.pin(${JSON.stringify(heart)})`, MF);
      const dnaMeta = await waitFor(() => evaluate(`(() => { const d = document.getElementById("dna"); return !d.hidden ? document.getElementById("dna-meta").textContent : null; })()`), "filtre ADN du miroir", 5000).catch(() => "");
      check("votre Engramme devient un filtre ADN pour vos créations", dnaMeta.includes("Vous") && !dnaMeta.includes("undefined"), dnaMeta);
      await evaluate(`window.__engram.pin(null)`, MF);
    } else {
      await evaluate(`document.getElementById("prefs-close").click()`);
    }
    await evaluate(`document.getElementById("prefs").open && document.getElementById("prefs-close").click()`);
    if (serverMode) {
      // Bouton « Tester » : compte d'essai immédiat, sans e-mail, utilisable comme un vrai compte.
      await evaluate(`document.getElementById("btn-logout").click()`);
      await waitFor(() => evaluate(`!document.getElementById("btn-try").hidden`), "bouton Tester", 5000);
      await clickSel("#btn-try");
      const trial = await waitFor(() => evaluate(`(() => { const s = document.getElementById("sparks"); return !s.hidden
        ? { sparks: document.getElementById("sparks-count").textContent, email: document.getElementById("account-email").textContent,
            tryHidden: document.getElementById("btn-try").hidden } : null; })()`), "compte d'essai", 10000)
        .catch(async (err) => { throw new Error(`${err.message} — ${await evaluate(`JSON.stringify({ sparksHidden: document.getElementById("sparks").hidden,
          tryHidden: document.getElementById("btn-try").hidden, email: document.getElementById("account-email").textContent, toast: document.getElementById("toast").textContent,
          dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.id), toasts: (window.__toasts || []).slice(-4) })`)}`); });
      check("bouton « Tester » : connecté aussitôt avec un compte d'essai (10 Sparks)", trial.sparks === "10" && trial.email.startsWith("Compte d'essai") && trial.tryHidden,
        JSON.stringify(trial));
    }
    if (SHOT) {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
      writeFileSync(SHOT, Buffer.from(data, "base64"));
    }
    check("aucune erreur JavaScript dans la page", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  } finally {
    // Profil Chrome jetable : attendre la fin du navigateur (ses processus verrouillent le dossier sous Windows),
    // puis supprimer en plusieurs essais ; un reste est signalé, jamais ignoré (des centaines de Mo par passage).
    const exited = browser.exitCode !== null ? Promise.resolve() : new Promise((resolve) => browser.once("exit", resolve));
    // Windows : kill() n'arrête que le processus principal, ses enfants (rendu, GPU) gardent le profil ouvert.
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
    else browser.kill();
    await Promise.race([exited, sleep(5000)]);
    try { rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 400 }); } catch (err) { console.warn(`Profil temporaire non supprimé : ${work} (${err.code || err.message})`); }
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
