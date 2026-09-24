// Test E2E de la sandbox : pilote Chrome/Edge headless via le protocole DevTools (CDP).
//
// Vérifie ce qu'un simple curl ne peut pas voir : le composant généré s'exécute
// réellement dans l'iframe, réagit à de vrais clics souris, et reste isolé
// (pas d'accès au parent, pas de réseau, stockage remplacé par une version mémoire).
//
// Usage : node tools/e2e_sandbox.mjs [--base http://127.0.0.1:8000] [--screenshot capture.png]
// Aucune dépendance : WebSocket natif de Node >= 22. Navigateur : PRISM_BROWSER ou détection auto.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base || "http://127.0.0.1:8000";
const PROMPT = "Crée un bouton interactif qui change de couleur au clic et compte le nombre de clics";
const CLICKS = 3;
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

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const waiter = msg.id && this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((fn) => fn(msg));
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function main() {
  if (!BROWSER) throw new Error("Aucun Chrome/Edge trouvé : définissez PRISM_BROWSER.");
  const profile = mkdtempSync(join(tmpdir(), "prism-e2e-"));
  const browser = spawn(
    BROWSER,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--window-size=1440,900", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const results = [];
  const check = (label, ok, detail = "") => results.push({ label, ok, detail });

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buffer = "";
      browser.stderr.on("data", (chunk) => {
        buffer += chunk;
        const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      setTimeout(() => reject(new Error("le navigateur n'a pas ouvert DevTools")), 20000);
    });

    const cdp = new CDP(wsUrl);
    await cdp.open();
    const { targetInfos } = await cdp.send("Target.getTargets");
    const { sessionId: page } = await cdp.send("Target.attachToTarget", {
      targetId: targetInfos.find((t) => t.type === "page").targetId,
      flatten: true,
    });

    // Une iframe sandbox est souvent isolée dans son propre processus (OOPIF) : on s'y attache.
    let frameSession = null;
    cdp.listeners.push((msg) => {
      if (msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "iframe") {
        frameSession = msg.params.sessionId;
      }
    });
    await cdp.send("Page.enable", {}, page);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page);

    const evaluate = async (expression, session = page, contextId) => {
      const res = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) },
        session,
      );
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      return res.result.value;
    };
    const waitFor = async (fn, label, timeout = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          const value = await fn();
          if (value) return value;
        } catch { /* pas encore prêt */ }
        await sleep(150);
      }
      throw new Error(`délai dépassé : ${label}`);
    };

    // 1. Chargement de l'interface
    await cdp.send("Page.navigate", { url: BASE }, page);
    await waitFor(() => evaluate("document.readyState === 'complete' && !!document.getElementById('prompt')"), "chargement");
    const engine = await waitFor(
      () => evaluate("document.getElementById('engine').dataset.state !== 'pending' && document.getElementById('engine-text').textContent"),
      "état du moteur",
    );
    check("interface chargée", true, `moteur : ${engine}`);

    // 2. Génération
    await evaluate(`(() => {
      const p = document.getElementById("prompt");
      p.value = ${JSON.stringify(PROMPT)};
      p.dispatchEvent(new Event("input"));
      document.getElementById("form").requestSubmit();
    })()`);
    const status = await waitFor(
      () => evaluate("(s => ['success','warn','error'].includes(s) && s)(document.getElementById('status').dataset.state)"),
      "fin de génération",
      120000,
    );
    check("génération réussie", status === "success", await evaluate("document.getElementById('status-text').textContent"));
    check(
      'iframe sandbox="allow-scripts" (sans allow-same-origin)',
      await evaluate("document.getElementById('frame').getAttribute('sandbox') === 'allow-scripts'"),
    );

    // 3. Accès au DOM de l'iframe (OOPIF, sinon monde isolé dans le même processus)
    await sleep(1500);
    let contextId;
    if (!frameSession) {
      const { frameTree } = await cdp.send("Page.getFrameTree", {}, page);
      const child = frameTree.childFrames?.[0]?.frame;
      if (!child) throw new Error("iframe introuvable");
      ({ executionContextId: contextId } = await cdp.send("Page.createIsolatedWorld", { frameId: child.id, worldName: "prism-e2e" }, page));
    }
    const mainWorld = Boolean(frameSession);
    const inFrame = (expr) => (mainWorld ? evaluate(expr, frameSession) : evaluate(expr, page, contextId));
    await waitFor(() => inFrame("!!document.getElementById('magic')"), "composant dans l'iframe");

    // 4. Vrais clics souris, routés par le navigateur jusque dans l'iframe
    const frameBox = await evaluate("(r => ({ x: r.x, y: r.y }))(document.getElementById('frame').getBoundingClientRect())");
    const button = await inFrame("(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.getElementById('magic').getBoundingClientRect())");
    const colorBefore = await inFrame("getComputedStyle(document.getElementById('magic')).backgroundColor");
    for (let i = 0; i < CLICKS; i++) {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, x: frameBox.x + button.x, y: frameBox.y + button.y, button: "left", clickCount: 1 }, page);
      }
      await sleep(120);
    }
    await sleep(400);
    const count = await inFrame("document.getElementById('count').textContent.trim()");
    const colorAfter = await inFrame("getComputedStyle(document.getElementById('magic')).backgroundColor");
    check(`${CLICKS} clics comptés dans l'iframe`, count === String(CLICKS), `compteur = ${count}`);
    check("la couleur change au clic", colorBefore !== colorAfter, `${colorBefore} → ${colorAfter}`);
    check("aucune erreur JS remontée", (await evaluate("document.getElementById('status').dataset.state")) === "success");

    // 5. Isolation
    check("le parent ne peut pas lire l'iframe", await evaluate("document.getElementById('frame').contentDocument === null"));
    check(
      "l'iframe ne peut pas lire le parent",
      (await inFrame("(() => { try { return typeof parent.document.body; } catch (e) { return 'bloqué'; } })()")) === "bloqué",
    );
    if (mainWorld) {
      check(
        "réseau bloqué par la CSP",
        (await inFrame("fetch('https://example.com/').then(() => 'autorisé', () => 'bloqué')")) === "bloqué",
      );
      check(
        "localStorage remplacé par un stockage mémoire",
        (await inFrame("(() => { localStorage.setItem('k', 'v'); return localStorage.getItem('k'); })()")) === "v",
      );
    } else {
      check("CSP / stockage : non vérifiables depuis un monde isolé", true, "iframe dans le même processus");
    }

    if (args.screenshot) {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
      writeFileSync(args.screenshot, Buffer.from(data, "base64"));
      check("capture enregistrée", true, args.screenshot);
    }
  } finally {
    browser.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* verrou Windows : dossier temporaire */ }
  }

  for (const { label, ok, detail } of results) {
    console.log(`  ${ok ? "OK   " : "ÉCHEC"}  ${label}${detail ? `  (${detail})` : ""}`);
  }
  return results.every((r) => r.ok);
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(`ÉCHEC  ${err.message}`);
    process.exit(1);
  });
