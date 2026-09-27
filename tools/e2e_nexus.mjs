// V6 · Mode Nexus (frontend/nexus.html) : porte d'entrée, flux Contexte → Engramme → Rendu, glisser, synapses tirées à la
// souris, sens du flux, anatomie (Core, State, Memories), fil coupé qui efface la mémoire en aval, Hub au lasso et débat.
// Tous les gestes passent par de vrais évènements souris (CDP), comme un utilisateur.
//
// Usage : node tools/e2e_nexus.mjs [--base http://127.0.0.1:8001/frontend/] [--shots dossier] [--width 1440 --height 900]
//         node tools/e2e_nexus.mjs --base http://127.0.0.1:8004/ --server   (serveur démo ; 8003 : faux Gemini)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const BASE = opt("base", "http://127.0.0.1:8001/frontend/");
const SHOTS = opt("shots", "");
// --server : la page est servie par un serveur Prism (tools/e2e_server.py) : compte d'essai, Gemini (faux ou démo), Sparks.
const SERVER = argv.includes("--server");
const WIDTH = Number(opt("width", 1440));
const HEIGHT = Number(opt("height", 900));
const URL_NEXUS = new URL("nexus.html", BASE.endsWith("/") ? BASE : BASE + "/").href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = [process.env.PRISM_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map(); this.events = []; }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const w = m.id && this.pending.get(m.id);
      if (w) { this.pending.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } else if (m.method) this.events.push(m);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

// Centre d'un élément à l'écran (expression évaluée dans la page).
const center = (selectorExpr) => `(()=>{const r=(${selectorExpr}).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`;
const orbOf = (name) => center(`__nexus.find(${JSON.stringify(name)}).el.querySelector('.orb')`);
const portOf = (name, kind) => center(`__nexus.find(${JSON.stringify(name)}).el.querySelector('.port.${kind}')`);

const work = mkdtempSync(join(tmpdir(), "prism-e2e-nexus-"));
const browser = spawn(BROWSER, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`, "--no-first-run",
  "--disable-gpu-shader-disk-cache", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let failures = 0;
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
  await cdp.send("Runtime.enable", {}, S);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, S);

  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, label, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = await evaluate(expression); if (v) return v; } catch { /* en cours */ } await sleep(150); }
    throw new Error(`délai dépassé : ${label}`);
  };
  const check = async (label, expression, expected) => {
    const got = await evaluate(expression);
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "ÉCHEC"} ${label}${ok ? "" : ` : ${JSON.stringify(got)} (attendu ${JSON.stringify(expected)})`}`);
  };
  const mouse = (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent",
    { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, ...extra }, S);
  const drag = async (pointsExpr, { alt = false } = {}) => {
    const pts = await evaluate(pointsExpr);
    const modifiers = alt ? 1 : 0;
    await mouse("mouseMoved", pts[0][0], pts[0][1], { buttons: 0, modifiers });
    await mouse("mousePressed", pts[0][0], pts[0][1], { clickCount: 1, modifiers });
    for (let i = 1; i < pts.length; i++) {
      for (let k = 1; k <= 6; k++) {
        await mouse("mouseMoved", pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / 6, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / 6, { modifiers });
        await sleep(10);
      }
    }
    const last = pts[pts.length - 1];
    await mouse("mouseReleased", last[0], last[1], { clickCount: 1, modifiers });
  };
  const click = async (pointExpr, count = 1) => {
    const [x, y] = await evaluate(pointExpr);
    await mouse("mouseMoved", x, y, { buttons: 0 });
    for (let i = 1; i <= count; i++) {
      await mouse("mousePressed", x, y, { clickCount: i });
      await mouse("mouseReleased", x, y, { clickCount: i });
    }
  };
  const key = async (k) => {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 }, S);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
    writeFileSync(join(SHOTS, name), Buffer.from(data, "base64"));
  };
  const flowSettled = "[...__nexus.nodes.values()].every(n=>!n.el.classList.contains('is-thinking')) && !document.querySelector('#pulses .pulse')";

  // --- Porte d'entrée ---------------------------------------------------------------------------------------------
  await cdp.send("Page.navigate", { url: URL_NEXUS }, S);
  await waitFor("document.readyState === 'complete' && !!window.__nexus", "chargement de nexus.html", 60000);
  await check("porte : logo, titre et deux portes (Focus → index.html)",
    "[!!document.querySelector('.lens img').naturalWidth, document.querySelector('.brand-title').textContent, document.getElementById('door-focus').getAttribute('href'), !!document.getElementById('door-nexus')]",
    [true, "Prism", "index.html", true]);
  await check("porte : aucun défilement horizontal", "document.documentElement.scrollWidth <= innerWidth", true);
  await sleep(1200);
  await shot("nexus-1-porte.png");

  // --- Nexus : la scène de départ se relie et le flux s'écoule ------------------------------------------------------
  await click(center("document.getElementById('door-nexus')"));
  await waitFor("document.getElementById('gate').hidden && __nexus.links.size === 4", "entrée dans le Nexus", 20000);
  await waitFor(`[...__nexus.nodes.values()].every(n=>!!n.memory) && ${flowSettled}`, "flux initial", 20000);
  await check("flux Contexte → Engrammes → Rendu", "[...__nexus.nodes.values()].map(n=>n.type+':'+!!n.memory).join(' ')",
    "context:true engram:true engram:true render:true");
  await check("l'écran porte le sujet et les données du brief", "[__nexus.find('render').memory.title, __nexus.find('render').memory.keys.join(', ')]",
    ["Un tableau de bord pour suivre la qualité de l'air dans une école primaire", "CO₂, température, bruit"]);
  await shot("nexus-2-flux.png");

  // --- Pincer à deux doigts (écran tactile) : zoom autour du milieu des doigts --------------------------------------------
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, S);
  await evaluate("window.__z0 = __nexus.view.z");
  // Un endroit vide du canvas, où les deux doigts se posent sans toucher de bulle.
  const [px, py] = await evaluate(`(()=>{const free=(x,y)=>{const e=document.elementFromPoint(x,y);return e&&e.id==='viewport'};
    for(let y=120;y<innerHeight-60;y+=20)for(let x=140;x<innerWidth-140;x+=20)if([-90,-40,0,40,90].every(d=>free(x+d,y)))return [x,y];return [innerWidth/2,innerHeight/2]})()`);
  const fingers = (spread) => [{ x: px - spread, y: py, id: 0 }, { x: px + spread, y: py, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(40) }, S);
  for (let k = 1; k <= 8; k++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(40 + k * 5) }, S); await sleep(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, S);
  await check("pincer à deux doigts zoome (×2 entre les doigts)", "Math.round(__nexus.view.z / __z0 * 10) / 10", 2);
  await click(center("document.getElementById('fit')"));
  await sleep(900);

  // --- Glisser une bulle ------------------------------------------------------------------------------------------------
  await evaluate("window.__j0 = [__nexus.find('Steve Jobs').x, __nexus.find('Steve Jobs').y]");
  await drag(`(()=>{const [x,y]=${orbOf("Steve Jobs")};return [[x,y],[x+90,y+30]]})()`);
  await check("un Engramme se glisse (et ses synapses le suivent)",
    "(()=>{const n=__nexus.find('Steve Jobs');const l=[...__nexus.links.values()].find(l=>l.to===n.id);return n.x!==__j0[0] && n.y!==__j0[1] && Math.abs(l.b.x-(n.x+20))<2})()", true);

  // --- Ajouter un Engramme depuis le menu, tirer deux synapses ---------------------------------------------------------
  await click(center("document.getElementById('add-engram')"));
  await waitFor("!document.getElementById('engram-menu').hidden", "menu des Engrammes");
  await click(center("document.querySelectorAll('#engram-menu button')[3]"));
  await waitFor("!!__nexus.find('Ada Lovelace')", "Ada Lovelace ajoutée");
  await evaluate("(()=>{const n=__nexus.find('Ada Lovelace');n.x=-560;n.y=200;n.el.style.left=n.x+'px';n.el.style.top=n.y+'px';document.getElementById('fit').click()})()");
  await sleep(1000);
  await drag(`[${portOf("context", "out")}, ${orbOf("Ada Lovelace")}]`);
  await drag(`[${portOf("Ada Lovelace", "out")}, ${portOf("render", "in")}]`);
  await check("deux synapses tirées à la souris (port → bulle, port → port)", "__nexus.links.size", 6);
  await drag(`[${portOf("Ada Lovelace", "out")}, ${center("__nexus.find('context').el.querySelector('.shell')")}]`);
  await check("fil refusé vers un Contexte (le flux va Contexte → Engramme → Rendu)", "[__nexus.links.size, document.getElementById('toast').hidden]", [6, false]);
  await waitFor(`__nexus.find('render').memory.thoughts.length === 3 && ${flowSettled}`, "le rendu reçoit Ada", 20000);
  await check("l'écran entend les trois esprits", "__nexus.find('render').memory.thoughts.map(t=>t.author).join(' + ')",
    "Marie Curie + Steve Jobs + Ada Lovelace");
  await shot("nexus-3-synapses.png");

  // --- Anatomie d'un Engramme ------------------------------------------------------------------------------------------
  await click(orbOf("Marie Curie"), 2);
  await waitFor("document.getElementById('anatomy').classList.contains('is-on')", "plongée dans l'anatomie");
  // Les organes entrent en scène (animation) : on attend qu'ils soient posés avant de cliquer dedans.
  await waitFor("[...document.querySelectorAll('.organ')].every(o=>o.getAnimations().every(a=>a.playState!=='running'))", "organes posés");
  await check("double-clic : anatomie de Marie Curie, sans bulle créée", "[document.getElementById('anat-name').textContent, __nexus.nodes.size]", ["Marie Curie", 5]);
  await check("State : énergie à 10 → humeur « Fatiguée »",
    "(()=>{const s=document.querySelector('#sliders input');s.value=10;s.dispatchEvent(new Event('input'));return document.querySelector('#anat-mood span').textContent})()",
    "Fatiguée · Méthode scientifique stricte");
  await click(center("[...document.querySelectorAll('#core-modes button')].find(b=>b.textContent==='Pensée systémique')"));
  await check("Core : un autre mode de raisonnement au clic", "document.getElementById('core-label').textContent", "Pensée systémique");
  await check("Memories : un souvenir s'ajoute",
    "(()=>{document.getElementById('mem-input').value='1906 : première femme professeure à la Sorbonne';document.getElementById('mem-form').requestSubmit();return document.querySelectorAll('#memories .chip').length})()", 5);
  await check("la pensée en direct suit l'anatomie", "document.getElementById('anat-preview').textContent.includes('système')", true);
  await sleep(600);
  await shot("nexus-4-anatomie.png");
  await key("Escape");
  await waitFor("document.getElementById('anatomy').hidden && __nexus.view.z < 3", "remontée");
  await check("remontée : l'Engramme garde son anatomie modifiée",
    "[__nexus.find('Marie Curie').core, __nexus.find('Marie Curie').el.querySelector('.mood span').textContent]", ["systems", "Fatiguée"]);

  // --- Couper un fil : la mémoire en aval s'efface à l'instant ------------------------------------------------------------
  await waitFor(flowSettled, "flux reposé");
  await click(`(()=>{const c=__nexus.find('Marie Curie').id,x=__nexus.find('context').id;const l=[...__nexus.links.values()].find(l=>l.from===x&&l.to===c);
    const p=l.paths[3];const pt=p.getPointAtLength(p.getTotalLength()/2);const q=new DOMPoint(pt.x,pt.y).matrixTransform(p.getScreenCTM());return [q.x,q.y]})()`);
  await check("fil coupé au clic : Curie perd sa mémoire, l'écran perd sa voix, sans délai",
    "(()=>{const c=__nexus.find('Marie Curie'),r=__nexus.find('render');return [__nexus.links.size,c.memory===null,c.el.querySelector('.thought').textContent,r.memory.thoughts.map(t=>t.author).join(' + '),document.querySelector('#nodes .render .voices').textContent.includes('Marie Curie')]})()",
    [5, true, "", "Steve Jobs + Ada Lovelace", false]);
  await sleep(500);
  await shot("nexus-5-coupe.png");

  // --- Hub : lasso autour des Engrammes, War Room, débat -----------------------------------------------------------------
  await drag(`(()=>{const cs=[...__nexus.nodes.values()].filter(n=>n.type==='engram').map(n=>{const r=n.el.querySelector('.orb').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]});
    const xs=cs.map(c=>c[0]),ys=cs.map(c=>c[1]);const cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
    const rx=(Math.max(...xs)-Math.min(...xs))/2+110,ry=(Math.max(...ys)-Math.min(...ys))/2+110;const pts=[];
    for(let i=0;i<=36;i++){const a=i/36*Math.PI*2;pts.push([cx+Math.cos(a)*rx,cy+Math.sin(a)*ry])}
    let k=pts.findIndex(p=>{const e=document.elementFromPoint(p[0],p[1]);return e&&e.id==='viewport'});if(k<0)k=0;return pts.slice(k).concat(pts.slice(1,k+1))})()`, { alt: true });
  await waitFor("__nexus.hubs.size === 1 && !document.getElementById('room').hidden", "Hub et War Room");
  await check("Alt + lasso : un Hub réunit les 3 Engrammes", "[...__nexus.hubs.values()][0].members.length", 3);
  await check("débat en deux tours puis synthèse",
    "__nexus.debate('Comment rendre ce tableau lisible par les enfants ?').then(()=>[document.querySelectorAll('#log .msg.mind').length, !!document.querySelector('#log .msg.synth')])", [6, true]);
  await check("le débat s'accroche aux données du brief", "document.getElementById('log').textContent.includes('« CO₂ »')", true);
  await sleep(700);
  await shot("nexus-6-war-room.png");

  // --- Retour à la porte ------------------------------------------------------------------------------------------------
  await key("Escape");
  await click(center("document.getElementById('to-gate')"));
  await waitFor("!document.getElementById('gate').hidden && document.getElementById('nexus').hidden", "retour à la porte");
  await check("retour à la porte (War Room fermée)", "document.getElementById('room').hidden", true);

  // --- La scène est enregistrée sur l'appareil : on revient, tout est là --------------------------------------------------
  await cdp.send("Page.navigate", { url: `${URL_NEXUS}?retour=1#nexus` }, S);
  await waitFor("window.__nexus && __nexus.nodes.size === 5 && __nexus.links.size === 5 && __nexus.hubs.size === 1", "scène restaurée", 20000);
  await check("scène retrouvée après rechargement (bulles, fils, Hub, anatomie, fil coupé)",
    "[__nexus.find('Marie Curie').core, __nexus.find('Marie Curie').memory === null, __nexus.find('render').memory.thoughts.length, __nexus.find('Ada Lovelace').x]",
    ["systems", true, 2, -560]);

  // --- Un autre esprit, par son nom -------------------------------------------------------------------------------------------
  await click(center("document.getElementById('add-engram')"));
  await waitFor("!document.getElementById('engram-menu').hidden", "menu des Engrammes");
  await evaluate("document.querySelector('.custom-mind input').value = 'Léonard de Vinci'");
  await click(center("document.querySelector('.custom-mind button')"));
  await check("« Autre esprit » : un Engramme au nom libre", "(()=>{const n=__nexus.find('Léonard de Vinci');return !!n && n.role === 'Esprit libre' && document.getElementById('engram-menu').hidden})()", true);
  await evaluate("__nexus.find('Léonard de Vinci').el.querySelector('.close').click()");

  // --- Avec le serveur Prism : penser avec Gemini (compte, prix affiché, Sparks au clic) ---------------------------------------
  if (SERVER) {
    await waitFor("window.__prismLink && __prismLink.ready", "API Prism détectée", 30000);
    await check("sans compte, Gemini ne dépense rien : l'intelligence reste locale", "[__nexus.intel(), document.getElementById('think-all').hidden]", ["local", true]);
    await click(center("document.getElementById('intel')"));
    await waitFor("!document.getElementById('intel-menu').hidden && !!document.getElementById('intel-guest')", "menu Intelligence : connexion requise");
    await click(center("document.getElementById('intel-guest')"));
    await waitFor("__prismLink.account.user && __prismLink.account.user.sparks > 0 && !document.querySelector('#intel-menu .opt[data-mode=gemini]').disabled", "compte d'essai");
    const start = await evaluate("__prismLink.account.user.sparks");
    await click(center("document.querySelector('#intel-menu .opt[data-mode=gemini]')"));
    await waitFor("!document.getElementById('think-all').hidden", "bouton « Penser »");
    await check("« Penser » annonce son prix, rien n'est encore dépensé", "[document.getElementById('think-all').textContent, __prismLink.account.user.sparks]", ["Penser · 0,5 Spark", start]);
    await check("en attente, l'Engramme le dit", "__nexus.find('Steve Jobs').el.querySelector('.thought').textContent.startsWith('Prêt à penser')", true);
    await click(center("document.getElementById('think-all')"));
    await waitFor("document.getElementById('think-all').hidden && [...__nexus.nodes.values()].every(n=>!n.el.classList.contains('is-thinking'))", "pensées reçues", 90000);
    await check("Jobs et Ada ont pensé par l'API (2 × 0,25 Spark)",
      "[['Steve Jobs','Ada Lovelace'].every(n=>__nexus.find(n).memory && __nexus.find(n).memory.source==='api'), __prismLink.account.user.sparks]", [true, start - 0.5]);
    await waitFor(`__nexus.find('render').memory && __nexus.find('render').memory.thoughts.every(t=>t.source==='api') && ${flowSettled}`, "écran nourri par l'API", 20000);
    await check("l'écran dit d'où vient la pensée", "/ · (Gemini|serveur \\(mode démo\\))$/.test(document.querySelector('#nodes .render .by').textContent)", true);
    await click(center("document.getElementById('fit')")); // « Tout voir » cadre aussi l'anneau du Hub et son étiquette
    await sleep(1100);
    await check("« Tout voir » montre le bouton de la War Room",
      `(()=>{const [x,y]=${center("document.querySelector('.hub .label button')")};return document.elementFromPoint(x,y)===document.querySelector('.hub .label button')})()`, true);
    await click(center("document.querySelector('.hub .label button')"));
    await waitFor("!document.getElementById('room').hidden", "War Room");
    await check("« Débattre » annonce son prix", "document.getElementById('ask-send').textContent", "Débattre · 1 Spark");
    await evaluate("document.getElementById('log').replaceChildren(); document.getElementById('question').value = 'Par quoi commencer ?'");
    await click(center("document.getElementById('ask-send')"));
    await waitFor("!!document.querySelector('#log .msg.synth') && !document.getElementById('ask-send').disabled", "débat par l'API", 90000);
    await check("débat par l'API : 3 positions, 3 réponses, une synthèse (1 Spark)",
      "[document.querySelectorAll('#log .msg.mind:not(.typing):not(.error)').length, __prismLink.account.user.sparks]", [6, start - 1.5]);
    await shot("nexus-7-gemini.png");
    await key("Escape");
    await cdp.send("Page.navigate", { url: `${URL_NEXUS}?retour=2#nexus` }, S);
    await waitFor("window.__nexus && __nexus.nodes.size === 5 && window.__prismLink && __prismLink.ready && __prismLink.account.user", "retour avec le compte", 30000);
    await check("au retour, les pensées payées sont gardées : rien à repayer",
      "[__nexus.intel(), __nexus.pendingCount(), document.getElementById('think-all').hidden, __nexus.find('Steve Jobs').memory.source]", ["gemini", 0, true, "api"]);
  }

  const errors = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  if (errors.length) { failures++; console.log("ÉCHEC erreurs JavaScript :", errors.join(" | ").slice(0, 1200)); }
  console.log(failures ? `\n${failures} échec(s)` : "\nNexus : tout est vert");
} catch (err) {
  failures++;
  console.log("ÉCHEC", err.message);
} finally {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
  else browser.kill("SIGKILL");
  // Chrome relâche son profil un peu après sa mort (Windows) : plusieurs essais avant d'abandonner.
  let removed = false;
  for (let i = 0; i < 12 && !removed; i++) {
    await sleep(500);
    try { rmSync(work, { recursive: true, force: true }); removed = true; } catch { /* encore verrouillé */ }
  }
  if (!removed) console.log(`profil laissé : ${work}`);
}
process.exitCode = failures ? 1 : 0;
