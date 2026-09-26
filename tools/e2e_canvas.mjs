// Test E2E de Prism v2 : Chrome/Edge headless piloté par le protocole DevTools (CDP).
//
// Scénario : deux widgets sur le canvas — un compteur (saisie clavier réelle) et un graphique
// issu d'un CSV déposé par un vrai glisser-déposer navigateur — puis clics réels dans la sandbox,
// pan/zoom, déplacement et redimensionnement, inspecteur (accent, téléchargement, refactorisation),
// isolation, persistance après rechargement et fermeture d'une carte. Face à un serveur Prism (v3) :
// inscription par la fenêtre de compte, reprise de la demande, anneau de Sparks, session conservée,
// fenêtre « Prism Pro » (depuis le menu, et sur solde épuisé si le serveur en offre peu).
//
// Usage : node tools/e2e_canvas.mjs [--base URL] [--screenshot capture.png] [--refactor]
//   --refactor : exige un modèle (ex. tools/e2e_server.py, faux Gemini) et teste la refactorisation.
// Aucune dépendance : WebSocket natif de Node >= 22. Navigateur : PRISM_BROWSER ou détection auto.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };
const BASE = opt("base") || "http://127.0.0.1:8000";
const SHOT = opt("screenshot");
const REFACTOR = argv.includes("--refactor");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCENT = "#ff5e8a";
const E2E_EMAIL = `e2e-${Date.now()}@prism.test`; // compte jetable (base temporaire de tools/e2e_server.py)
const E2E_PASSWORD = "mot-de-passe-e2e";

const BROWSER = [
  process.env.PRISM_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));

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
  const work = mkdtempSync(join(tmpdir(), "prism-e2e-"));
  const downloads = join(work, "downloads");
  // Dossier créé d'avance : sinon Chrome headless prend parfois ce chemin pour un préfixe de nom (« downloads.htm »).
  mkdirSync(downloads);
  const csvPath = join(work, "ventes-test.csv");
  const csvRows = [["region", "mois", "ventes"]];
  ["Nord", "Sud", "Est"].forEach((r, i) => [1, 2, 3, 4].forEach((m) => csvRows.push([r, `2025-0${m}`, String(1000 + i * 300 + m * 120)])));
  writeFileSync(csvPath, csvRows.map((r) => r.join(";")).join("\n"));

  const browser = spawn(BROWSER, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const pageErrors = [];

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
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
    const { targetInfos } = await cdp.send("Target.getTargets");
    const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });

    // Iframes sandbox isolées (OOPIF) : une session CDP chacune.
    const frames = new Map(); // session de l'iframe -> session de la page qui la contient
    const downloadEvents = [];
    const inflight = new Map(); // requêtes réseau de la page non terminées (diagnostic)
    cdp.listeners.push((msg) => {
      if (msg.sessionId === S && msg.method === "Network.requestWillBeSent") inflight.set(msg.params.requestId, msg.params.request.url);
      if (msg.sessionId === S && (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed")) inflight.delete(msg.params.requestId);
      if (msg.method === "Browser.downloadWillBegin") downloadEvents.push(`début ${msg.params.suggestedFilename}`);
      if (msg.method === "Browser.downloadProgress" && msg.params.state !== "inProgress") downloadEvents.push(msg.params.state);
      if (msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "iframe") frames.set(msg.params.sessionId, msg.sessionId);
      if (msg.method === "Target.detachedFromTarget") frames.delete(msg.params.sessionId);
      if (msg.method === "Runtime.exceptionThrown" && msg.sessionId === S) {
        const d = msg.params.exceptionDetails;
        pageErrors.push(`${d.exception?.description || d.text} @${d.url || ""}:${d.lineNumber}`);
      }
    });
    await cdp.send("Runtime.enable", {}, S);
    await cdp.send("Network.enable", {}, S);
    await cdp.send("Page.enable", {}, S);
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
    const findFrame = (predicate, label, page = S) => waitFor(async () => {
      for (const [session, parent] of frames) {
        if (parent !== page) continue;
        try { if (await evaluate(`document.readyState === "complete" && (${predicate})`, session)) return session; } catch { /* iframe en cours de chargement */ }
      }
      return null;
    }, label);

    const mouse = (type, x, y, extra = {}) =>
      cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1, ...extra }, S);
    const click = async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
    const drag = async (x1, y1, x2, y2, steps = 10) => {
      await mouse("mouseMoved", x1, y1);
      await mouse("mousePressed", x1, y1);
      for (let i = 1; i <= steps; i++) await mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, { buttons: 1 });
      await mouse("mouseReleased", x2, y2);
    };
    const box = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    // Machine chargée : on attend que la cible ne bouge plus (animations d'entrée, cadrage…) avant de cliquer.
    const stableBox = (selector) => waitFor(async () => {
      const a = await box(selector);
      await sleep(120);
      const b = await box(selector);
      return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && a.w > 0 ? b : null;
    }, `position stable de ${selector}`);
    const clickSel = async (selector) => { const b = await stableBox(selector); await click(b.cx, b.cy); };
    const typeText = (text) => cdp.send("Input.insertText", { text }, S);
    const pressEnter = async () => {
      const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" }, S);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, S);
    };
    const cards = () => evaluate(`[...document.querySelectorAll(".card")].map((c) => ({ id: c.dataset.id, state: c.dataset.state,
      title: c.querySelector(".card-title").textContent, left: parseFloat(c.style.left), top: parseFloat(c.style.top),
      width: parseFloat(c.style.width), height: parseFloat(c.style.height), rect: c.getBoundingClientRect().toJSON() }))`);
    const readyCount = () => evaluate(`document.querySelectorAll('.card[data-state="ready"], .card[data-state="warn"]').length`);
    const zoom = () => evaluate(`document.getElementById("zoom-reset").textContent`);
    const loaded = async () => {
      await waitFor(() => evaluate(`document.body.classList.contains("is-ready") && document.getElementById("engine").dataset.state !== "pending"`), "chargement de Prism", 90000)
        .catch(async (err) => {
          const state = await evaluate(`JSON.stringify({ url: location.href, ready: document.readyState, body: document.body && document.body.className, engine: document.getElementById("engine") && document.getElementById("engine").dataset.state })`).catch((e) => e.message);
          throw new Error(`${err.message} — ${state} — requêtes en attente : ${[...inflight.values()].join(", ") || "aucune"}`);
        });
      return evaluate(`document.getElementById("engine-text").textContent`);
    };

    // ------------------------------------------------------------------ 1. Chargement
    await cdp.send("Page.navigate", { url: BASE }, S);
    const engineLabel = await loaded();
    check("Prism chargé, canvas vide", (await evaluate(`!document.getElementById("canvas-empty").hidden`)), `moteur : ${engineLabel}`);
    const hasModel = !/démo/i.test(engineLabel);
    // Serveur Prism (v3) : comptes et Sparks. GitHub Pages / statique : pas de compte.
    const serverMode = await evaluate(`!document.getElementById("account").hidden`);
    const sparksShown = () => evaluate(`document.getElementById("sparks").hidden ? null : document.getElementById("sparks-count").textContent`);
    const health = serverMode ? await evaluate(`fetch("/api/health").then((r) => r.json())`) : null;

    // ------------------------------------------------------------------ 2. Widget 1 : saisie clavier réelle
    await clickSel("#prompt");
    await evaluate(`document.getElementById("prompt").value = ""`);
    await typeText("Crée un bouton interactif qui change de couleur au clic et compte le nombre de clics");
    await clickSel("#generate");
    if (serverMode) {
      // Première génération sans compte : fenêtre d'inscription, demande conservée, reprise automatique.
      await waitFor(() => evaluate(`document.getElementById("auth").open`), "fenêtre de compte", 10000);
      check("sans compte : fenêtre d'inscription, demande conservée",
        (await evaluate(`document.getElementById("prompt").value.includes("bouton interactif") && document.querySelectorAll(".card").length === 0`)),
        await evaluate(`document.getElementById("auth-gift").textContent`));
      await clickSel("#tab-register");
      await clickSel("#auth-email");
      await typeText(E2E_EMAIL);
      await clickSel("#auth-password");
      await typeText(E2E_PASSWORD);
      await clickSel("#auth-submit");
      await waitFor(() => evaluate(`!document.getElementById("auth").open`), "inscription", 20000).catch(async (err) => {
        throw new Error(`${err.message} — ${await evaluate(`document.getElementById("auth-error").textContent`)}`);
      });
      check("compte créé depuis la fenêtre, anneau de Sparks affiché", (await sparksShown()) !== null, `${await sparksShown()} Sparks`);
    }
    await waitFor(async () => (await readyCount()) === 1, "widget 1 prêt", 60000).catch(async (err) => {
      const state = await evaluate(`JSON.stringify([...document.querySelectorAll(".card")].map((c) => [c.dataset.state, c.querySelector(".card-error-text").textContent, c.querySelector(".card-elapsed").textContent]))`);
      throw new Error(`${err.message} — cartes : ${state} — requêtes en attente : ${[...inflight.values()].join(", ") || "aucune"}`);
    });
    const [counterCard] = await cards();
    check("widget 1 généré (saisie clavier + bouton Générer)", counterCard.state === "ready", counterCard.title);
    if (serverMode) {
      const expected = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(health.signup_sparks - health.pricing.generate);
      const shown = await waitFor(async () => ((await sparksShown()) === expected ? expected : null), "solde après génération", 10000)
        .catch(async () => sparksShown());
      check("génération débitée : anneau mis à jour", shown === expected, `${shown} (attendu ${expected})`);
    }

    // ------------------------------------------------------------------ 3. Widget 2 : CSV glissé-déposé
    const dock = await stableBox("#dock");
    const dragData = { items: [], files: [csvPath], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", { type, x: dock.cx, y: dock.cy, data: dragData }, S);
    }
    let dropMode = "glisser-déposer natif (Input.dispatchDragEvent)";
    // Le fichier s'affiche tout de suite (« Analyse en cours… »), puis le Web Worker livre son analyse.
    await waitFor(() => evaluate(`!document.getElementById("attachment").hidden`), "fichier joint", 4000)
      .catch(async () => {
        dropMode = "évènement drop synthétique (repli)";
        await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(readFileSync(csvPath, "utf8"))}], "ventes-test.csv", { type: "text/csv" }));
          for (const t of ["dragenter", "dragover", "drop"]) document.getElementById("dock").dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
        return waitFor(() => evaluate(`!document.getElementById("attachment").hidden`), "fichier joint (repli)");
      });
    const attached = await waitFor(() => evaluate(`(() => { const a = document.getElementById("attachment");
      return !a.hidden && a.dataset.state !== "reading" && document.getElementById("file-meta").textContent; })()`), "analyse du fichier (Web Worker)", 30000);
    check("CSV joint par glisser-déposer et analysé", /12 lignes × 3 colonnes/.test(attached), `${attached} — ${dropMode}`);
    await clickSel("#prompt");
    await typeText("Visualise les ventes par région");
    await pressEnter();
    await waitFor(async () => (await readyCount()) === 2, "widget 2 prêt", 60000);
    const [, csvCard] = await cards();
    check("deux widgets sur le canvas", (await cards()).length === 2, `${counterCard.title} + ${csvCard.title}`);
    // Squelette holographique jusqu'au signal « ready » du widget, puis iframe révélée.
    const live = await waitFor(() => evaluate(`(() => { const b = [...document.querySelectorAll(".card-body")];
      const o = b.map((x) => getComputedStyle(x.querySelector(".card-frame")).opacity);
      return b.length === 2 && b.every((x) => x.dataset.frame === "live") && o.every((v) => v === "1") && o.join("/"); })()`), "iframes révélées (fondu terminé)", 20000);
    check("widgets révélés après leur signal « ready » (squelette → iframe)", live === "1/1", `opacité ${live}`);
    const [a, b] = await cards();
    const overlap = !(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top);
    check("placement automatique sans chevauchement", !overlap);

    // ------------------------------------------------------------------ 4. Interactions réelles dans la sandbox
    const counterFrame = await findFrame(`!!document.getElementById("magic")`, "iframe du compteur");
    // La vue a suivi la carte 2 : on recadre pour que la carte 1 soit entièrement visible.
    await clickSel("#zoom-fit");
    await sleep(800); // fin des animations (cadrage, apparition)
    const rawFrameBox = (id) => evaluate(`(() => { const f = document.querySelector('.card[data-id="${id}"] iframe'); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, s: r.width / f.offsetWidth }; })()`);
    // Position de l'iframe une fois immobile (fin du cadrage animé), pour convertir ses coordonnées.
    const frameBox = (id) => waitFor(async () => {
      const a = await rawFrameBox(id);
      await sleep(150);
      const b = await rawFrameBox(id);
      return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.s - b.s) < 0.001 ? b : null;
    }, "iframe immobile");
    const inner = await evaluate(`(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.getElementById("magic").getBoundingClientRect())`, counterFrame);
    const fb = await frameBox(counterCard.id);
    // Sondes : où arrivent réellement les évènements pointeur (widget ou page) ?
    await evaluate(`window.__pd = 0; addEventListener("pointerdown", () => window.__pd++, true)`, counterFrame);
    await evaluate(`window.__ppd = []; document.addEventListener("pointerdown", (e) => window.__ppd.push(e.target.tagName + "." + e.target.className), true)`);
    // Carte non sélectionnée : le 1er clic la sélectionne (remontée au premier plan) sans perdre les suivants.
    const countIs = (value, label) => waitFor(async () => {
      const v = await evaluate(`document.getElementById("count").textContent`, counterFrame);
      return v === value ? v : null;
    }, label, 8000).catch(() => evaluate(`document.getElementById("count").textContent`, counterFrame));
    for (let i = 0; i < 3; i++) { await click(fb.x + inner.x * fb.s, fb.y + inner.y * fb.s); await sleep(100); }
    const first = await countIs("3", "3 clics");
    if (first !== "3") {
      const probe = {
        widgetPointerdowns: await evaluate(`window.__pd`, counterFrame),
        pagePointerdowns: await evaluate(`window.__ppd.join(" | ") || "aucun"`),
        bodyClasses: await evaluate(`document.body.className`),
        cardState: await evaluate(`document.querySelector('.card[data-id="${counterCard.id}"]').dataset.state`),
        listenersOk: await evaluate(`(() => { const before = document.getElementById("count").textContent; document.getElementById("magic").click(); return before + " → " + document.getElementById("count").textContent; })()`, counterFrame),
      };
      console.log("  [diagnostic clics]", JSON.stringify(probe));
    }
    const selected = await evaluate(`document.querySelector('.card[data-id="${counterCard.id}"]').classList.contains("is-selected")`);
    const px = fb.x + inner.x * fb.s;
    const py = fb.y + inner.y * fb.s;
    const under = await evaluate(`(() => { const el = document.elementFromPoint(${px}, ${py}); return el ? el.tagName + "." + el.className + (el.closest(".card") ? " dans carte " + (el.closest(".card").dataset.id === ${JSON.stringify(counterCard.id)} ? "compteur" : "autre") : "") : "rien"; })()`);
    check("3 clics rapides sur une carte non sélectionnée : tous comptés, carte sélectionnée", first === "3" && selected,
      `compteur = ${first}, clic en (${Math.round(px)}, ${Math.round(py)}) sur ${under}, bouton à (${Math.round(inner.x)}, ${Math.round(inner.y)}) dans l'iframe, échelle ${fb.s.toFixed(2)}`);
    for (let i = 0; i < 4; i++) { await click(fb.x + inner.x * fb.s, fb.y + inner.y * fb.s); await sleep(80); }
    const burst = await countIs("7", "rafale");
    check("rafale de 4 clics rapides (80 ms) sur la carte sélectionnée", burst === "7", `compteur = ${burst}`);
    await evaluate(`document.getElementById("reset").click()`, counterFrame);
    await countIs("0", "remise à zéro");
    for (let i = 0; i < 3; i++) { await click(fb.x + inner.x * fb.s, fb.y + inner.y * fb.s); await sleep(120); }
    check("compteur remis à 0 puis 3 clics (état à persister)", (await countIs("3", "état à persister")) === "3");

    const csvFrame = await findFrame(`window.PRISM_FILE && window.PRISM_FILE.kind === "csv"`, "iframe du CSV");
    const chart = await waitFor(() => evaluate(`typeof Chart === "function" && Chart.getChart(document.getElementById("chart")) ? { rows: PRISM_FILE.rowCount, points: Chart.getChart(document.getElementById("chart")).data.labels.length } : null`, csvFrame), "graphique Chart.js");
    check("graphique Chart.js (CDN épinglé) rendu depuis PRISM_FILE", chart.rows === 12 && chart.points > 0, `${chart.rows} lignes, ${chart.points} points`);

    // ------------------------------------------------------------------ 5. Canvas : pan, zoom, « Tout voir »
    const before = await evaluate(`document.getElementById("world").style.transform`);
    await drag(1400, 820, 1300, 760); // coin libre du fond
    const afterPan = await evaluate(`document.getElementById("world").style.transform`);
    check("pan en glissant le fond", before !== afterPan);
    const z0 = await zoom();
    const overWidget = await frameBox(counterCard.id);
    await mouse("mouseWheel", overWidget.x + 40, overWidget.y + 40, { deltaX: 0, deltaY: -300, modifiers: 2 });
    const z1 = await waitFor(async () => { const v = await zoom(); return v !== z0 && v; }, "zoom au-dessus d'un widget", 3000).catch(() => z0);
    check("Ctrl + molette au-dessus d'un widget : zoom du canvas (relayé par la sandbox)", z1 !== z0, `${z0} → ${z1}`);
    const topbar = await stableBox(".topbar .tagline");
    await mouse("mouseWheel", topbar.cx, topbar.cy, { deltaX: 0, deltaY: 200, modifiers: 2 });
    await sleep(150);
    const z2 = await zoom();
    check("Ctrl + molette sur la barre du haut : zoom du canvas, pas de la page", z2 !== z1, `${z1} → ${z2}`);
    await clickSel("#zoom-fit");
    const allVisible = async () => (await cards()).every((c) => c.rect.x >= 0 && c.rect.y >= 60 && c.rect.x + c.rect.width <= 1440 && c.rect.y + c.rect.height <= 900);
    const inView = await waitFor(allVisible, "cadrage", 8000).catch(() => false);
    // Vue immobile (fin de l'animation de cadrage) : .world n'a pas de taille propre, on compare sa transformation.
    const transform = () => evaluate(`document.getElementById("world").style.transform`);
    await waitFor(async () => { const a = await transform(); await sleep(150); return a === (await transform()); }, "vue immobile", 8000);
    check("« Tout voir » cadre les deux cartes", inView, await zoom());

    // ------------------------------------------------------------------ 6. Déplacer et redimensionner
    let c1 = (await cards())[0];
    const z = parseFloat(await zoom()) / 100;
    const bar = await stableBox(`.card[data-id="${c1.id}"] .card-title`);
    await drag(bar.cx, bar.cy, bar.cx + 90, bar.cy + 40);
    const moved = await waitFor(async () => { const c = (await cards()).find((x) => x.id === c1.id); return c.left !== c1.left ? c : null; }, "déplacement", 8000)
      .catch(async () => (await cards()).find((x) => x.id === c1.id));
    check("carte déplacée par sa barre de titre", Math.abs(moved.left - c1.left - 90 / z) < 3 && Math.abs(moved.top - c1.top - 40 / z) < 3,
      `Δ monde = ${Math.round(moved.left - c1.left)}, ${Math.round(moved.top - c1.top)} (zoom ${Math.round(z * 100)} %)`);
    let c2 = (await cards())[1];
    const handle = await stableBox(`.card[data-id="${c2.id}"] .card-resize`);
    await drag(handle.cx, handle.cy, handle.cx + 60, handle.cy + 50);
    const resized = await waitFor(async () => { const c = (await cards()).find((x) => x.id === c2.id); return c.width !== c2.width ? c : null; }, "redimensionnement", 8000)
      .catch(async () => (await cards()).find((x) => x.id === c2.id));
    check("carte redimensionnée par la poignée", resized.width > c2.width + 40 && resized.height > c2.height + 30,
      `${Math.round(c2.width)}×${Math.round(c2.height)} → ${Math.round(resized.width)}×${Math.round(resized.height)}`);

    // ------------------------------------------------------------------ 7. Inspecteur : accent et export
    await clickSel(`.card[data-id="${c2.id}"] .card-title`);
    await waitFor(() => evaluate(`!document.getElementById("inspector").hidden`), "inspecteur");
    check("clic sur la carte : inspecteur ouvert", (await evaluate(`document.getElementById("insp-title").textContent`)) === resized.title);
    await sleep(500); // fin du glissement d'entrée du volet, sinon on mesure une position intermédiaire
    const sw = await stableBox(`#swatches .swatch[data-accent="${ACCENT}"]`);
    const hit = await evaluate(`(() => { const el = document.elementFromPoint(${sw.cx}, ${sw.cy}); return el ? (el.dataset.accent ?? el.tagName + "." + el.className) : "rien"; })()`);
    await click(sw.cx, sw.cy);
    const hitAfter = await evaluate(`(() => { const el = document.elementFromPoint(${sw.cx}, ${sw.cy}); const r = document.querySelector('#swatches .swatch[data-accent="${ACCENT}"]').getBoundingClientRect(); return (el ? (el.dataset.accent ?? el.tagName) : "rien") + " ; rose désormais en x=" + Math.round(r.x + r.width / 2); })()`);
    const accent = await waitFor(() => evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "${ACCENT}" && "${ACCENT}"`, csvFrame), "accent appliqué", 5000)
      .catch(async (err) => {
        const inFrame = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`, csvFrame).catch((e) => `session morte : ${e.message}`);
        const onCard = await evaluate(`document.querySelector('.card[data-id="${c2.id}"]').style.getPropertyValue("--card-accent") + " / checked=" + document.querySelector('#swatches [aria-checked="true"]')?.dataset.accent`);
        throw new Error(`${err.message} — iframe : ${inFrame} ; carte : ${onCard} ; clic en x=${Math.round(sw.cx)} sur ${hit}, après : ${hitAfter}`);
      });
    check("couleur d'accent appliquée à chaud dans le widget", accent === ACCENT);

    const dl = await stableBox("#download-html");
    const dlHit = await evaluate(`document.elementFromPoint(${dl.cx}, ${dl.cy})?.id || "autre"`);
    await click(dl.cx, dl.cy);
    const file = await waitFor(() => downloadEvents.includes("completed") && existsSync(downloads) && readdirSync(downloads).find((f) => f.endsWith(".html")), "fichier téléchargé", 30000)
      .catch(async (err) => {
        const toastText = await evaluate(`document.getElementById("toast").textContent`);
        const listing = existsSync(downloads) ? readdirSync(downloads).join(",") : "dossier absent";
        throw new Error(`${err.message} — cible du clic : ${dlHit} ; toast : « ${toastText} » ; évènements : ${downloadEvents.join(", ") || "aucun"} ; dossier : ${listing}`);
      });
    const exported = readFileSync(join(downloads, file), "utf8");
    const libs = await evaluate(`fetch("engine/libs.json").then((r) => r.json())`);
    check("export .html autonome (données, accent, Chart.js épinglé, sans CSP)",
      exported.startsWith("<!DOCTYPE html>") && exported.includes("window.PRISM_FILE=") && exported.includes(`--accent:${ACCENT}`)
        && exported.includes(libs.chartjs.integrity) && !exported.includes("Content-Security-Policy"), `${file}, ${exported.length} car.`);

    // ------------------------------------------------------------------ 8. Refactorisation
    await clickSel(`.card[data-id="${c1.id}"] .card-title`);
    await waitFor(() => evaluate(`document.getElementById("insp-title").textContent === ${JSON.stringify(moved.title)}`), "inspecteur sur la carte 1");
    if (!hasModel) {
      const disabled = await evaluate(`document.getElementById("refactor-btn").disabled && !document.getElementById("refactor-note").hidden`);
      check("refactorisation désactivée en mode démo, avec explication", disabled);
    } else {
      await clickSel("#refactor-input");
      await typeText("Ajoute un sous-titre qui indique que le widget a été refactorisé");
      await clickSel("#refactor-btn");
      await waitFor(() => evaluate(`document.querySelector('.card[data-id="${c1.id}"]').dataset.state === "ready"`), "refactorisation", 60000);
      const refFrame = await findFrame(`!!document.getElementById("refactored")`, "widget refactorisé");
      check("refactorisation : seule la carte ciblée change", !(await evaluate(`!!document.getElementById("refactored")`, csvFrame)));
      check("refactorisation : les données du widget sont conservées", (await evaluate(`document.getElementById("count").textContent`, refFrame)) === "3");
      await clickSel("#undo-btn");
      await findFrame(`!!document.getElementById("magic") && !document.getElementById("refactored")`, "version restaurée");
      check("annulation de la refactorisation", true);
    }

    // ------------------------------------------------------------------ 9. Isolation
    const cf = await findFrame(`!!document.getElementById("magic")`, "iframe du compteur");
    check("le parent ne peut pas lire les widgets", await evaluate(`[...document.querySelectorAll(".card iframe")].every((f) => f.contentDocument === null && f.getAttribute("sandbox") === "allow-scripts")`));
    check("un widget ne peut pas lire Prism", (await evaluate(`(() => { try { return typeof parent.document.body; } catch (e) { return "bloqué"; } })()`, cf)) === "bloqué");
    check("réseau bloqué par la CSP", (await evaluate(`fetch("https://example.com/").then(() => "autorisé", () => "bloqué")`, cf)) === "bloqué");

    if (SHOT) {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
      writeFileSync(SHOT, Buffer.from(data, "base64"));
    }

    // ------------------------------------------------------------------ 10. Persistance après rechargement
    // Par identifiant : après rechargement, les cartes reviennent dans l'ordre de superposition.
    const geometry = (list) => list.map((c) => `${c.id}:${[c.left, c.top, c.width, c.height].map(Math.round).join(",")}`).sort();
    const beforeReload = await cards();
    await sleep(600); // regroupement des écritures IndexedDB
    await cdp.send("Page.reload", {}, S);
    await loaded();
    await waitFor(async () => (await readyCount()) === 2, "cartes restaurées");
    const afterReload = await cards();
    check("cartes restaurées avec leur position et leur taille", geometry(afterReload).join("|") === geometry(beforeReload).join("|"));
    const cf2 = await findFrame(`!!document.getElementById("magic")`, "compteur restauré");
    check("état du widget conservé (localStorage persistant)", (await evaluate(`document.getElementById("count").textContent`, cf2)) === "3");
    const csv2 = await findFrame(`window.PRISM_FILE && window.PRISM_FILE.kind === "csv"`, "CSV restauré");
    check("accent et données du fichier conservés", (await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`, csv2)) === ACCENT);
    if (serverMode) {
      const kept = await waitFor(() => sparksShown(), "session restaurée", 10000).catch(() => null);
      check("session conservée après rechargement (« Rester connecté »)", kept !== null, `${kept} Sparks`);
    }

    // ------------------------------------------------------------------ 11. Fermeture
    await clickSel(`.card[data-id="${counterCard.id}"] [data-action="close"]`);
    await waitFor(async () => (await cards()).length === 1, "carte fermée");
    const undoOffered = await evaluate(`!document.getElementById("toast").hidden && document.querySelector("#toast button")?.textContent`);
    check("carte fermée, « Rétablir » proposé", undoOffered === "Rétablir");
    await sleep(300);
    await cdp.send("Page.reload", {}, S);
    await loaded();
    await sleep(800);
    check("fermeture persistée après rechargement", (await cards()).length === 1);

    // ------------------------------------------------------------------ 12. Sparks et Prism Pro (serveur)
    if (serverMode) {
      await waitFor(() => sparksShown(), "anneau de Sparks");
      await clickSel("#sparks");
      await waitFor(() => evaluate(`document.getElementById("account-menu").matches(":popover-open")`), "menu du compte");
      const menu = await evaluate(`document.getElementById("account-email").textContent + " · " + document.getElementById("account-pricing").textContent`);
      await clickSel("#btn-pro");
      await waitFor(() => evaluate(`document.getElementById("pro").open`), "fenêtre Prism Pro");
      check("menu du compte → fenêtre « Prism Pro »", (await evaluate(`document.getElementById("pro-title").textContent`)) === "Prism Pro", menu);
      await clickSel("#pro-close");
      const balance = await evaluate(`parseFloat(document.getElementById("sparks-count").textContent.replace(",", "."))`);
      if (balance < health.pricing.generate) {
        // Solde insuffisant : la fenêtre s'ouvre sans créer de carte, la demande reste dans le dock.
        await clickSel("#prompt");
        await typeText("Un minuteur Pomodoro");
        await pressEnter();
        await waitFor(() => evaluate(`document.getElementById("pro").open`), "fenêtre Prism Pro (solde épuisé)");
        check("Sparks épuisés : fenêtre « Prism Pro », aucune carte créée",
          (await evaluate(`document.getElementById("pro-title").textContent === "Vos Sparks sont épuisés" && document.querySelectorAll(".card").length === 1 && document.getElementById("prompt").value.includes("Pomodoro")`)),
          await evaluate(`document.getElementById("pro-reason").textContent`));
        await clickSel("#pro-close");
      }
    }

    // ------------------------------------------------------------------ 13. Mon Hub (serveur)
    if (serverMode) {
      // Miniatures fabriquées dans la sandbox de chaque widget, puis envoyées au serveur.
      const token = await evaluate(`JSON.parse(localStorage.getItem("prism:session")).token`);
      await waitFor(async () => {
        const page = await evaluate(`fetch("/api/widgets", { headers: { Authorization: "Bearer ${token}" } }).then((r) => r.json())`);
        return page.items.length === 2 && page.items.every((i) => i.thumbnail && i.thumbnail.startsWith("data:image/"));
      }, "miniatures envoyées", 40000).catch(() => null);
      await clickSel("#btn-hub");
      await waitFor(() => evaluate(`document.getElementById("hub").open && document.getElementById("hub").dataset.state === "ready" && document.querySelectorAll(".hub-item").length === 2`), "Mon Hub chargé");
      const hub = await evaluate(`[...document.querySelectorAll(".hub-item")].map((el) => ({ id: el.dataset.id, title: el.querySelector(".hub-title").textContent,
        meta: el.querySelector(".hub-meta").textContent, onCanvas: !!el.querySelector(".hub-badge"), thumb: !!el.querySelector(".hub-thumb img") }))`);
      check("Mon Hub : 2 widgets avec miniatures fabriquées dans la sandbox, carte fermée hors canvas",
        hub.every((h) => h.thumb) && hub.filter((h) => h.onCanvas).length === 1, hub.map((h) => `${h.title}${h.onCanvas ? " (canvas)" : ""}${h.thumb ? " 🖼" : ""}`).join(", "));

      // Réouverture de la carte fermée : code et état du widget repris du serveur.
      const closedItem = hub.find((h) => !h.onCanvas);
      await clickSel(`.hub-item[data-id="${closedItem.id}"] .hub-actions [data-action="open"]`);
      await waitFor(() => evaluate(`!document.getElementById("hub").open && document.querySelectorAll('.card-body[data-frame="live"]').length === 2`), "carte rouverte");
      const reopened = await findFrame(`!!document.getElementById("magic")`, "compteur rouvert");
      check("réouverture depuis Mon Hub : état du widget conservé par le serveur", (await evaluate(`document.getElementById("count").textContent`, reopened)) === "3");
      await sleep(2000); // disposition de la carte rouverte envoyée (regroupement 1,2 s)

      // Second appareil : autre contexte de navigateur (stockage vierge), même compte.
      const { browserContextId } = await cdp.send("Target.createBrowserContext");
      const { targetId: remoteTarget } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId: S2 } = await cdp.send("Target.attachToTarget", { targetId: remoteTarget, flatten: true });
      await cdp.send("Page.enable", {}, S2);
      await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, S2);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S2);
      await cdp.send("Page.bringToFront", {}, S2);
      await cdp.send("Page.navigate", { url: BASE }, S2);
      await waitFor(() => evaluate(`document.body.classList.contains("is-ready") && !document.getElementById("btn-login").hidden`, S2), "second appareil chargé", 60000);
      await evaluate(`(() => { document.getElementById("btn-login").click(); document.getElementById("auth-email").value = ${JSON.stringify(E2E_EMAIL)};
        document.getElementById("auth-password").value = ${JSON.stringify(E2E_PASSWORD)}; document.getElementById("auth-form").requestSubmit(); return true; })()`, S2);
      const remoteCards = await waitFor(async () => {
        const n = await evaluate(`document.querySelectorAll('.card-body[data-frame="live"]').length`, S2);
        return n === 2 ? n : null;
      }, "canvas restauré sur le second appareil", 60000).catch(async () => evaluate(`document.querySelectorAll(".card").length + " carte(s)"`, S2));
      const csvRemote = await findFrame(`window.PRISM_FILE && window.PRISM_FILE.rowCount === 12`, "CSV sur le second appareil", S2).catch(() => null);
      const counterRemote = await findFrame(`!!document.getElementById("magic")`, "compteur sur le second appareil", S2).catch(() => null);
      const remoteCount = counterRemote ? await evaluate(`document.getElementById("count").textContent`, counterRemote) : "absent";
      check("second appareil : canvas restauré à la connexion (données du fichier et état compris)",
        remoteCards === 2 && Boolean(csvRemote) && remoteCount === "3", `${remoteCards} cartes, CSV ${csvRemote ? "avec" : "sans"} données, compteur ${remoteCount}`);
      await cdp.send("Target.disposeBrowserContext", { browserContextId });
      await cdp.send("Page.bringToFront", {}, S);

      // Suppression définitive depuis le Hub : retirée du Hub et du canvas.
      await clickSel("#btn-hub");
      await waitFor(() => evaluate(`document.getElementById("hub").dataset.state === "ready" && document.querySelectorAll(".hub-item").length === 2`), "Mon Hub rechargé");
      const csvItem = hub.find((h) => h.meta.includes("ventes-test.csv"));
      const del = `.hub-item[data-id="${csvItem.id}"] [data-action="delete"]`;
      await clickSel(del);
      await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(del)}).textContent === "Confirmer ?"`), "confirmation");
      await clickSel(del);
      await waitFor(() => evaluate(`document.querySelectorAll(".hub-item").length === 1`), "widget supprimé du Hub");
      await waitFor(async () => (await cards()).length === 1, "carte retirée du canvas");
      check("suppression depuis Mon Hub (double confirmation) : retiré du Hub et du canvas", true, csvItem.title);
      await clickSel("#hub-close");
    }
  } catch (err) {
    check("scénario complet", false, err.message);
  } finally {
    check("aucune exception JS dans Prism", !pageErrors.length, pageErrors.join(" | "));
    browser.kill();
    await sleep(600);
    try { rmSync(work, { recursive: true, force: true }); } catch { /* verrou Windows */ }
  }

  for (const { label, ok, detail } of results) console.log(`  ${ok ? "OK   " : "ÉCHEC"}  ${label}${detail ? `  (${detail})` : ""}`);
  return results.every((r) => r.ok);
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((err) => { console.error(`ÉCHEC  ${err.message}`); process.exit(1); });
