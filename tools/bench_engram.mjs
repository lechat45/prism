// Banc de mesure des Engrammes (Phase 1 · moteur physique asynchrone) : où part le temps d'une image ?
//
// Chrome headless, cartes Engramme dans des iframes sandbox « allow-scripts » sous la CSP des cartes (comme dans
// Prism), document de carte réel (viewer.html + physics.js), instrumenté : temps de physique et de dessin par image,
// images par seconde de chaque carte et de la page, retard des évènements du pointeur (event.timeStamp → gestion).
//
// Usage : node tools/bench_engram.mjs [--scenario 5x40|1x200|3x40+widget|all] [--seconds 6] [--dpr 1] [--inline]
//   --inline : CSP sans « worker-src blob: » (le Worker est refusé) → rendu sur le fil de la carte, pour comparer.
//   3x40+widget : le pointeur tourne sur un widget ordinaire (première carte) pendant que 3 Engrammes s'animent.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = join(ROOT, "frontend", "engine");
const require = createRequire(import.meta.url);
const E = require(join(ENGINE, "engram", "engram.js"));
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const SECONDS = Number(opt("seconds", 6));
const DPR = Number(opt("dpr", 1));
const SCENARIO = opt("scenario", "all");
const VIEWER = join(ENGINE, "engram", "viewer.html");
const INLINE = argv.includes("--inline");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = [process.env.PRISM_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));

// CSP des cartes (frontend/js/sandbox.js), sans Tailwind : le coût mesuré est celui du canevas.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'"
  + (INLINE ? "" : "; worker-src blob:");

/** Engramme de n bulles : la démo Marie Curie répétée (un seul noyau), liens compris. */
function synthetic(n) {
  const demo = E.normalize(JSON.parse(readFileSync(join(ENGINE, "engram", "demo-marie-curie.json"), "utf8")));
  const others = demo.nodes.filter((x) => x.category !== "core");
  const nodes = [demo.nodes.find((x) => x.category === "core")];
  const links = [];
  for (let copy = 0; nodes.length < n; copy++) {
    for (const node of others) {
      if (nodes.length >= n) break;
      nodes.push({ ...node, id: copy ? `${node.id}_${copy}` : node.id });
    }
    const ids = new Set(nodes.map((x) => x.id));
    for (const l of demo.links) {
      const from = copy ? `${l.from}_${copy}` : l.from;
      const to = copy ? `${l.to}_${copy}` : l.to;
      if (ids.has(from) && ids.has(to)) links.push({ ...l, from, to });
    }
  }
  return { ...demo, nodes, links };
}

/** Document de carte instrumenté : chronomètre de la physique et du dessin, compte-images, retard du pointeur. */
function cardDocument(nodes) {
  const template = readFileSync(VIEWER, "utf8");
  const physics = readFileSync(join(ENGINE, "engram", "physics.js"), "utf8");
  const render = readFileSync(join(ENGINE, "engram", "render.js"), "utf8");
  const html = E.buildViewer(template, { physics, render }, synthetic(nodes), { tailwind: { url: "about:blank", integrity: "" } }, "fr");
  const probe = `<script>
(function () {
  var input = [];
  addEventListener("pointermove", function (e) { input.push(performance.now() - e.timeStamp); }, true);
  // Mesures publiées par la carte elle-même (__engram.perf : fil qui dessine, Worker ou page).
  setInterval(function () {
    var perf = window.__engram && window.__engram.perf();
    if (perf) parent.postMessage({ bench: { fps: perf.fps, physics: perf.physics, draw: perf.draw, input: input.slice(), mode: window.__engram.mode } }, "*");
    input = [];
  }, 1000);
})();
</script>`;
  return html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">${probe}`);
}

/** Widget ordinaire (sans animation), sous la même CSP : mesure le retard du pointeur hors des Engrammes. */
const WIDGET = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>
(function () {
  var input = [];
  addEventListener("pointermove", function (e) { input.push(performance.now() - e.timeStamp); }, true);
  setInterval(function () { parent.postMessage({ bench: { fps: 0, physics: 0, draw: 0, input: input.slice(), mode: "widget" } }, "*"); input = []; }, 1000);
})();
</script></head><body style="margin:0;background:#111;color:#eee;font:16px sans-serif"><main style="padding:24px"><h1>Tableau de bord</h1><p>Widget ordinaire.</p></main></body></html>`;

function page(cards, nodes, widget = false) {
  const doc = cardDocument(nodes).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const plain = WIDGET.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  // Cartes de 780 × 560 (taille d'un Engramme), réduites de moitié comme après « Tout voir » : toutes à l'écran.
  const frames = (widget ? `<iframe sandbox="allow-scripts" srcdoc="${plain}"></iframe>` : "")
    + Array.from({ length: cards }, () => `<iframe sandbox="allow-scripts" srcdoc="${doc}"></iframe>`).join("");
  return `<!DOCTYPE html><html><head><style>
    body { margin: 0; background: #05060a; }
    .grid { display: grid; grid-template-columns: repeat(3, 780px); gap: 16px; transform: scale(0.5); transform-origin: 0 0; padding: 16px; }
    iframe { width: 780px; height: 560px; border: 0; }
  </style></head><body><div class="grid">${frames}</div><script>
    window.__cards = []; window.__page = { frames: 0, since: performance.now(), long: 0 };
    addEventListener("message", function (e) {
      var i = [].indexOf.call(document.querySelectorAll("iframe"), [].find.call(document.querySelectorAll("iframe"), function (f) { return f.contentWindow === e.source; }));
      if (e.data && e.data.bench) (window.__cards[i] = window.__cards[i] || []).push(e.data.bench);
    });
    (function tick() { window.__page.frames++; requestAnimationFrame(tick); })();
    try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (x) { window.__page.long += x.duration; }); }).observe({ entryTypes: ["longtask"] }); } catch (e) {}
  </script></body></html>`;
}

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map(); }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const w = m.id && this.pending.get(m.id);
      if (w) { this.pending.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function run(cdp, S, cards, nodes, widget = false) {
  const { frameTree } = await cdp.send("Page.getFrameTree", {}, S);
  await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: page(cards, nodes, widget) }, S);
  await sleep(2500); // chargement et mise en place
  await cdp.send("Runtime.evaluate", { expression: "window.__cards = []; window.__page = { frames: 0, since: performance.now(), long: 0 }" }, S);
  // Pointeur qui tourne au-dessus de la première carte pendant toute la mesure (survol, fuite des ombres).
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    const a = ((Date.now() - t0) / 1000) * 2 * Math.PI * 0.5;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 16 + 195 + 90 * Math.cos(a), y: 8 + 140 + 60 * Math.sin(a), button: "none", buttons: 0 }, S);
    await sleep(16);
  }
  const { result } = await cdp.send("Runtime.evaluate", { expression: "JSON.stringify({ cards: window.__cards, page: window.__page, now: performance.now() })", returnByValue: true }, S);
  const data = JSON.parse(result.value);
  const samples = data.cards.filter(Boolean).map((list) => list.slice(1)); // première seconde écartée (mise en route)
  const all = (widget ? samples.slice(1) : samples).flat();
  const input = samples[0] ? samples[0].flatMap((x) => x.input) : [];
  return {
    scenario: `${cards} carte${cards > 1 ? "s" : ""} × ${nodes} bulles${widget ? ", pointeur sur un widget ordinaire" : ""}`,
    mode: [...new Set(all.map((x) => x.mode))].join("/"),
    fpsCard: mean(all.map((x) => x.fps)),
    physics: mean(all.map((x) => x.physics)),
    draw: mean(all.map((x) => x.draw)),
    fpsPage: data.page.frames / ((data.now - data.page.since) / 1000),
    longPage: data.page.long,
    input: { mean: mean(input), p95: pct(input, 0.95), max: Math.max(0, ...input), n: input.length },
  };
}

const work = mkdtempSync(join(tmpdir(), "prism-e2e-bench-"));
const browser = spawn(BROWSER, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`, "--no-first-run",
  "--disable-gpu-shader-disk-cache", "--window-size=1440,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
try {
  const ws = await new Promise((res, rej) => {
    let b = "";
    browser.stderr.on("data", (c) => { b += c; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
    setTimeout(() => rej(new Error("le navigateur n'a pas ouvert DevTools")), 60000);
  });
  const cdp = new CDP(ws);
  await cdp.open();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  await cdp.send("Page.enable", {}, S);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: DPR, mobile: false }, S);
  const scenarios = { "5x40": [5, 40], "1x200": [1, 200], "1x40": [1, 40], "3x40+widget": [3, 40, true] };
  const chosen = SCENARIO === "all" ? ["1x40", "5x40", "1x200"] : [SCENARIO];
  const gpu = await cdp.send("SystemInfo.getInfo").then((i) => i.gpu.featureStatus["2d_canvas"] + " · " + ((i.gpu.devices || [])[0] || {}).deviceString, () => "?");
  console.log(`Canevas 2D du navigateur : ${gpu}`);
  console.log(`Gabarit : ${VIEWER.replace(ROOT, ".")} · ${SECONDS} s par scénario · dpr ${DPR} · ${(await cdp.send("Runtime.evaluate", { expression: "navigator.hardwareConcurrency", returnByValue: true }, S)).result.value} cœurs logiques`);
  for (const key of chosen) {
    const r = await run(cdp, S, ...scenarios[key]);
    console.log(`\n${r.scenario} — rendu : ${r.mode === "worker" ? "Worker (OffscreenCanvas)" : "fil de la carte"}`);
    console.log(`  carte : ${r.fpsCard.toFixed(1)} img/s · physique ${r.physics.toFixed(2)} ms · dessin ${r.draw.toFixed(2)} ms par image (fil de la carte)`);
    console.log(`  page  : ${r.fpsPage.toFixed(1)} img/s · tâches longues ${Math.round(r.longPage)} ms`);
    console.log(`  pointeur sur la 1re carte : retard moyen ${r.input.mean.toFixed(1)} ms · p95 ${r.input.p95.toFixed(1)} ms · max ${r.input.max.toFixed(1)} ms (${r.input.n} évènements)`);
  }
} finally {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
  else browser.kill();
  await sleep(1500);
  try { rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 400 }); } catch (err) { console.warn(`Profil temporaire non supprimé : ${work} (${err.code})`); }
}
