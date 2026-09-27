// Fuites de mémoire à la fermeture des cartes (V5, phase 1 · point 2) : on ouvre N widgets, on les ferme, on force le
// ramasse-miettes, trois fois de suite ; rien ne doit s'accumuler (mémoire JS, nœuds DOM, écouteurs, iframes).
//
// Usage : node tools/bench_memory.mjs [--base http://127.0.0.1:8001/frontend/] [--cards 12] [--cycles 3] [--assert]
//   --assert : échec (code 1) si quelque chose s'accumule d'un cycle à l'autre (garde-fou de la CI).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const BASE = opt("base", "http://127.0.0.1:8001/frontend/");
const CARDS = Number(opt("cards", 12));
const CYCLES = Number(opt("cycles", 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = [process.env.PRISM_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map(); this.listeners = []; }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const w = m.id && this.pending.get(m.id);
      if (w) { this.pending.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } else if (m.method) this.listeners.forEach((f) => f(m));
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

export async function measureLeaks({ base = BASE, cards = CARDS, cycles = CYCLES, log = console.log } = {}) {
  const work = mkdtempSync(join(tmpdir(), "prism-e2e-memory-"));
  const browser = spawn(BROWSER, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`, "--no-first-run",
    "--disable-gpu-shader-disk-cache", "--window-size=1440,900", "--js-flags=--expose-gc", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
    const evaluate = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (fn, label, timeout = 30000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch { /* en cours */ } await sleep(150); }
      throw new Error(`délai dépassé : ${label}`);
    };
    await cdp.send("Page.enable", {}, S);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);
    await cdp.send("Page.navigate", { url: BASE }, S);
    await waitFor(() => evaluate(`document.body.classList.contains("is-ready") && document.getElementById("engine").dataset.state !== "pending"`), "chargement", 90000);

    /** Ramasse-miettes forcé (deux passes), puis compteurs : mémoire JS, nœuds, écouteurs, iframes vivantes. */
    const snapshot = async () => {
      for (let i = 0; i < 2; i++) { await cdp.send("HeapProfiler.collectGarbage", {}, S); await sleep(300); }
      const counters = await cdp.send("Memory.getDOMCounters", {}, S);
      const heap = await evaluate("performance.memory ? performance.memory.usedJSHeapSize : 0");
      const { targetInfos: all } = await cdp.send("Target.getTargets");
      const frames = await evaluate(`document.querySelectorAll("iframe").length`);
      return { heap, nodes: counters.nodes, listeners: counters.jsEventListeners, documents: counters.documents, frames,
        oopif: all.filter((t) => t.type === "iframe").length };
    };
    const prompts = ["Compteur de clics", "Liste de tâches", "Minuteur pomodoro", "Calculatrice", "Horloge analogique", "Convertisseur d'unités"];
    const rows = [];
    rows.push({ step: "départ", ...(await snapshot()) });
    for (let cycle = 1; cycle <= cycles; cycle++) {
      for (let i = 0; i < cards; i++) {
        await evaluate(`(() => { const p = document.getElementById("prompt"); p.value = ${JSON.stringify(prompts[i % prompts.length] + " n°" + i)};
          p.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("generate").click(); })()`);
        await sleep(60);
      }
      await waitFor(() => evaluate(`document.querySelectorAll(".card").length === ${cards} && [...document.querySelectorAll(".card")].every((c) => /ready|warn/.test(c.dataset.state))`), `cycle ${cycle} : cartes prêtes`, 120000);
      await sleep(1500);
      rows.push({ step: `cycle ${cycle} : ${cards} cartes ouvertes`, ...(await snapshot()) });
      await evaluate(`document.querySelectorAll('.card [data-action="close"]').forEach((b) => b.click())`);
      await waitFor(() => evaluate(`document.querySelectorAll(".card").length === 0`), `cycle ${cycle} : cartes fermées`);
      await evaluate(`document.getElementById("toast").hidden = true`);
      await sleep(10000); // délais (« Rétablir », sauvegardes, miniatures) écoulés
      rows.push({ step: `cycle ${cycle} : tout fermé`, ...(await snapshot()) });
    }
    for (const r of rows) {
      log(`${r.step.padEnd(28)} mémoire JS ${(r.heap / 1048576).toFixed(2).padStart(6)} Mo · nœuds ${String(r.nodes).padStart(5)} · écouteurs ${String(r.listeners).padStart(4)} · iframes ${r.frames} (documents isolés ${r.oopif})`);
    }
    return rows;
  } finally {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
    else browser.kill();
    await sleep(1500);
    try { rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 400 }); } catch (err) { console.warn(`Profil temporaire non supprimé : ${work} (${err.code})`); }
  }
}

/** Rien ne doit s'accumuler : après fermeture, mêmes compteurs qu'après le premier cycle (et proches du départ). */
export function leaks(rows) {
  const closed = rows.filter((r) => r.step.endsWith("tout fermé"));
  const [start, first, last] = [rows[0], closed[0], closed[closed.length - 1]];
  const problems = [];
  if (last.frames || last.oopif) problems.push(`${last.frames} iframe(s), ${last.oopif} document(s) isolé(s) encore vivants`);
  if (last.nodes > start.nodes + 30) problems.push(`nœuds DOM : ${start.nodes} → ${last.nodes}`);
  if (last.listeners > start.listeners + 10) problems.push(`écouteurs : ${start.listeners} → ${last.listeners}`);
  if (last.listeners > first.listeners + 2 || last.nodes > first.nodes + 10) problems.push("croissance d'un cycle à l'autre");
  if (last.heap - first.heap > 256 * 1024) problems.push(`mémoire JS : +${((last.heap - first.heap) / 1024).toFixed(0)} Ko d'un cycle à l'autre`);
  return problems;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  measureLeaks()
    .then((rows) => {
      const problems = leaks(rows);
      console.log(problems.length ? `\nFUITE : ${problems.join(" ; ")}` : "\nAucune accumulation : cartes, écouteurs, iframes et mémoire rendus à chaque fermeture.");
      if (problems.length && argv.includes("--assert")) process.exit(1);
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
