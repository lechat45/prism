// E2E « GitHub Pages → API distante » : la page est servie comme https://lechat45.github.io/prism/
// (réponses fabriquées depuis le dépôt local via le domaine Fetch du CDP : le vrai site n'est jamais
// contacté), sa balise <meta name="prism-api"> vise un serveur Prism local, d'abord « endormi ».
//
// Vérifie : démarrage en moteur navigateur pendant le sommeil (« Réveil du serveur… »), bascule en
// mode serveur au réveil, inscription et génération à travers la CORS avec jeton Bearer, anneau de Sparks.
//
// Usage : python tools/e2e_server.py --demo &   puis   node tools/e2e_pages_api.mjs [--api http://127.0.0.1:8004]

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const argv = process.argv.slice(2);
const API = (argv.includes("--api") ? argv[argv.indexOf("--api") + 1] : "http://127.0.0.1:8004").replace(/\/+$/, "");
const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PAGES = "https://lechat45.github.io/prism/";
const SLEEP_MS = 14000; // serveur « endormi » : /api/health échoue pendant ce temps
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = [process.env.PRISM_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon" };

const results = [];
const check = (label, ok, detail = "") => results.push({ label, ok: Boolean(ok), detail });

/** Réponse « GitHub Pages » fabriquée depuis le dépôt (la balise prism-api pointe vers l'API locale). */
function pagesResponse(url) {
  let rel = decodeURIComponent(new URL(url).pathname.replace(/^\/prism\//, ""));
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) return { status: 404, type: "text/plain", body: Buffer.from("introuvable") };
  let body = readFileSync(file);
  if (rel === "frontend/index.html") {
    body = Buffer.from(body.toString("utf8").replace('<meta name="prism-api" content="">', `<meta name="prism-api" content="${API}">`));
  }
  return { status: 200, type: TYPES[extname(file)] || "application/octet-stream", body };
}

const work = mkdtempSync(join(tmpdir(), "prism-pages-"));
// L'« API distante » du test tourne sur 127.0.0.1 : un site public (github.io) qui appelle le réseau
// local est bloqué par Chrome (Local/Private Network Access). Artefact du test seulement — une API
// déployée est publique — d'où ces contrôles désactivés ici.
const LOCAL_NETWORK_CHECKS = "LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests";
const browser = spawn(BROWSER, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "p")}`,
  "--no-first-run", "--window-size=1440,900", `--disable-features=${LOCAL_NETWORK_CHECKS}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });

try {
  const wsUrl = await new Promise((resolveUrl, reject) => {
    let buf = "";
    browser.stderr.on("data", (c) => { buf += c; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolveUrl(m[1]); });
    setTimeout(() => reject(new Error("pas de DevTools")), 60000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  const handlers = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); } else if (m.method) handlers.forEach((h) => h(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((r, j) => { const id = ++seq; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

  const t0 = Date.now();
  const stats = { pages: 0, healthRefused: 0, apiCalls: new Set() };
  const patterns = [{ urlPattern: "https://lechat45.github.io/*" }, { urlPattern: `${API}/*` }];
  const consoleErrors = [];
  handlers.push(async (m) => {
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") consoleErrors.push(m.params.entry.text.slice(0, 160));
    if (m.method === "Target.attachedToTarget") {
      // Workers (Web Worker de Prism) : mêmes règles, avant l'exécution de leur premier octet.
      const s = m.params.sessionId;
      if (m.params.targetInfo.type === "worker") await send("Fetch.enable", { patterns }, s).catch(() => {});
      await send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
      return;
    }
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const s = m.sessionId;
    try {
      if (request.url.startsWith("https://lechat45.github.io/")) {
        stats.pages += 1;
        const r = pagesResponse(request.url);
        await send("Fetch.fulfillRequest", { requestId, responseCode: r.status, body: r.body.toString("base64"),
          responseHeaders: [{ name: "Content-Type", value: r.type }, { name: "Cache-Control", value: "no-cache" }] }, s);
      } else if (request.url.endsWith("/api/health") && Date.now() - t0 < SLEEP_MS) {
        stats.healthRefused += 1; // service gratuit endormi
        await send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }, s);
      } else {
        stats.apiCalls.add(`${request.method} ${new URL(request.url).pathname.replace(/[0-9a-f-]{36}/g, "…")}`);
        await send("Fetch.continueRequest", { requestId }, s);
      }
    } catch { /* requête abandonnée entre-temps */ }
  });

  const { targetInfos } = await send("Target.getTargets");
  const { sessionId: S } = await send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  await send("Fetch.enable", { patterns }, S);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, S);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);
  await send("Page.enable", {}, S);
  await send("Log.enable", {}, S);
  process.on("exit", () => { if (results.some((r) => !r.ok) && consoleErrors.length) console.log(`  console : ${[...new Set(consoleErrors)].slice(0, 5).join(" | ")}`); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, label, ms = 60000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { try { const v = await ev(expr); if (v) return v; } catch { /* navigation */ } await sleep(250); }
    throw new Error(`délai dépassé : ${label}`);
  };

  await send("Page.navigate", { url: PAGES }, S);
  await until(`location.pathname === "/prism/frontend/" && document.body && document.body.classList.contains("is-ready")`, "Prism chargé sur GitHub Pages");
  const origin = await ev("location.origin");
  const waking = await until(`document.getElementById("engine-text").textContent === "Réveil du serveur…" && document.getElementById("engine-text").textContent`, "badge de réveil", 20000).catch(() => null);
  check("page servie comme GitHub Pages, API configurée par la balise prism-api", origin === "https://lechat45.github.io", origin);
  check("serveur endormi : démarrage en moteur navigateur, « Réveil du serveur… »", waking === "Réveil du serveur…", `${stats.healthRefused} appel(s) refusé(s)`);

  const awake = await until(`!document.getElementById("account").hidden && document.getElementById("engine").dataset.state !== "pending" && document.getElementById("engine-text").textContent`, "réveil", 60000).catch(() => null);
  check("serveur réveillé : bascule en mode serveur (comptes, badge du serveur)", Boolean(awake), awake || "");

  // Inscription et génération à travers la CORS (jeton Bearer), comme depuis le vrai site.
  const email = `pages-${Date.now()}@prism.test`;
  await ev(`(() => { document.getElementById("prompt").value = "Crée un bouton interactif qui compte les clics"; document.getElementById("form").requestSubmit(); return true; })()`);
  await until(`document.getElementById("auth").open`, "fenêtre d'inscription", 10000);
  await ev(`(() => { document.getElementById("tab-register").click(); document.getElementById("auth-email").value = ${JSON.stringify(email)};
    document.getElementById("auth-password").value = "mot-de-passe-pages"; document.getElementById("auth-form").requestSubmit(); return true; })()`);
  const generated = await until(`document.querySelectorAll('.card[data-state="ready"]').length === 1 && document.getElementById("sparks-count").textContent`, "génération", 90000).catch(() => null);
  check("inscription puis génération depuis github.io vers l'API (CORS + Bearer)", generated === "49", `${generated ?? "échec"} Sparks`);
  const calls = [...stats.apiCalls];
  check("appels partis vers l'API configurée, pas vers GitHub Pages",
    ["POST /api/auth/register", "POST /api/generate"].every((c) => calls.includes(c)), calls.join(", "));
} catch (err) {
  check("scénario complet", false, err.message);
} finally {
  browser.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* verrou Windows */ }
}

for (const { label, ok, detail } of results) console.log(`  ${ok ? "OK   " : "ÉCHEC"}  ${label}${detail ? `  (${detail})` : ""}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
