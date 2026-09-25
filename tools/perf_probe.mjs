// Sonde de performance du frontend (Chrome headless via CDP).
//
// Mesure, sur le fil principal de Prism :
//   1. au repos, avec 3 cartes affichées : images par seconde et temps de calcul par seconde ;
//   2. le blocage le plus long (« long task ») pendant le dépôt d'un CSV de ~5 Mo ;
//   3. le blocage le plus long entre l'envoi d'une demande et l'affichage de la carte.
// Usage : node tools/perf_probe.mjs [--base http://127.0.0.1:8001/] [--profile dossier]
//   --profile : enregistre un profil CPU (.cpuprofile, lisible dans DevTools) de chaque étape.
// Chiffres relatifs : à comparer avant/après sur la même machine.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => { const k = process.argv.indexOf(name); return k === -1 ? fallback : process.argv[k + 1]; };
const BASE = arg("--base", "http://127.0.0.1:8001/");
const PROFILE_DIR = arg("--profile", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = [process.env.PRISM_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));

const work = mkdtempSync(join(tmpdir(), "prism-perf-"));
const browser = spawn(BROWSER, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "p")}`,
  "--no-first-run", "--window-size=1440,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });

try {
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    browser.stderr.on("data", (c) => { buf += c; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error("pas de DevTools")), 60000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = m.id && pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((r, j) => { const id = ++seq; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetInfos } = await send("Target.getTargets");
  const { sessionId: S } = await send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return; } catch { /* chargement */ } await sleep(200); } throw new Error(`délai : ${expr}`); };

  await send("Page.enable", {}, S);
  await send("Page.navigate", { url: BASE }, S);
  await until(`document.body && document.body.classList.contains("is-ready")`);
  // Observateur de blocages du fil principal (tâches > 50 ms).
  // name : « self » = la page Prism ; « *-descendant » = le code d'un widget (même processus que la page).
  await ev(`window.__lt = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => __lt.push([Math.round(e.duration), e.name]))).observe({ type: "longtask", buffered: false }); true`);
  const takeLong = () => ev(`(() => { const v = __lt.slice(); __lt.length = 0; const d = v.map((x) => x[0]); const page = v.filter((x) => x[1] === "self").map((x) => x[0]);
    return { max: d.length ? Math.max(...d) : 0, total: d.reduce((a, b) => a + b, 0), count: d.length, page_max: page.length ? Math.max(...page) : 0, page_total: page.reduce((a, b) => a + b, 0) }; })()`);
  const profile = {
    start: async () => { if (PROFILE_DIR) { await send("Profiler.enable", {}, S); await send("Profiler.start", {}, S); } },
    stop: async (name) => { if (PROFILE_DIR) writeFileSync(join(PROFILE_DIR, `${name}.cpuprofile`), JSON.stringify((await send("Profiler.stop", {}, S)).profile)); },
  };

  // Trois cartes de démo pour un canvas réaliste.
  for (const p of ["un compteur", "une calculatrice", "un tableau de bord des ventes : Jan 10, Fev 20, Mar 15"]) {
    await ev(`(() => { const t = document.getElementById("prompt"); t.value = ${JSON.stringify(p)}; document.getElementById("form").requestSubmit(); })()`);
  }
  await until(`document.querySelectorAll('.card[data-state="ready"]').length === 3 && document.querySelectorAll('.card-body[data-frame="pending"]').length === 0`);
  await sleep(2500);
  await takeLong();

  // 1. Repos
  const idle = await ev(`new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve(Math.round(n / ((performance.now() - t0) / 1000))); }; requestAnimationFrame(tick); })`);
  const m0 = Object.fromEntries((await send("Performance.enable", {}, S), await send("Performance.getMetrics", {}, S)).metrics.map((m) => [m.name, m.value]));
  await sleep(3000);
  const m1 = Object.fromEntries((await send("Performance.getMetrics", {}, S)).metrics.map((m) => [m.name, m.value]));
  const perSec = (k) => Math.round(((m1[k] - m0[k]) / 3) * 1000);
  const idleLong = await takeLong();

  // 2. Dépôt d'un CSV de ~5 Mo (fichier construit dans la page, puis évènement drop)
  await ev(`(() => { const rows = ["id;date;montant;texte"]; for (let k = 0; k < 60000; k++) rows.push(k + ";2025-01-" + String(k % 28 + 1).padStart(2, "0") + ";" + (k * 1.5).toFixed(2).replace(".", ",") + ";" + "x".repeat(60));
    window.__csv = new File([rows.join("\\n")], "gros.csv", { type: "text/csv" }); return true; })()`);
  await takeLong();
  await profile.start();
  const t0 = Date.now();
  await ev(`(() => { const dt = new DataTransfer(); dt.items.add(__csv); for (const t of ["dragenter", "dragover", "drop"]) document.getElementById("dock").dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
  await until(`(() => { const a = document.getElementById("attachment"); return !a.hidden && a.dataset.state !== "reading"; })()`, 120000);
  const attachMs = Date.now() - t0;
  const attachLong = await takeLong();
  await profile.stop("depot");

  // 3. Génération du widget CSV
  await profile.start();
  const t1 = Date.now();
  await ev(`(() => { document.getElementById("prompt").value = "graphique"; document.getElementById("form").requestSubmit(); return true; })()`);
  await until(`document.querySelectorAll('.card[data-state="ready"]').length === 4 && document.querySelectorAll('.card-body[data-frame="pending"]').length === 0`, 120000);
  const genMs = Date.now() - t1;
  await sleep(1500);
  const genLong = await takeLong();
  await profile.stop("generation");

  console.log(JSON.stringify({
    repos: { images_par_s: idle, calcul_ms_par_s: perSec("TaskDuration"), style_ms_par_s: perSec("RecalcStyleDuration"), mise_en_page_ms_par_s: perSec("LayoutDuration"), blocages: idleLong },
    depot_csv_5Mo: { duree_ms: attachMs, blocages: attachLong },
    generation_widget_csv: { duree_ms: genMs, blocages: genLong },
    processus_des_widgets: (await send("Target.getTargets")).targetInfos.some((t) => t.type === "iframe") ? "séparé (OOPIF)" : "celui de la page",
  }, null, 2));
} finally {
  browser.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* verrou Windows */ }
}
