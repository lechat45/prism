// V6 · Mode Nexus (frontend/nexus.html) : porte d'entrée, vrais Engrammes vivants (moteur du Mode Focus), flux Contexte →
// Engramme → Rendu, glisser, synapses tirées à la souris, sens du flux, plongée dans un Engramme, fil coupé qui efface la
// mémoire en aval, Hub au lasso et débat, scène retrouvée ; V6.2 : atmosphère, inventaire (sans fil, fusion, prisme,
// horloge), roue de réactions, bulles de dialogue, Paramètres (Ctrl + K, aperçu, Appliquer), streaming prédictif des
// Engrammes, canaux et fils de la War Room ; avec serveur : Gemini, débat, réponse en fil, création d'un Engramme.
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
const headOf = (name) => center(`__nexus.find(${JSON.stringify(name)}).el.querySelector('.ename')`); // en-tête d'un Engramme
const mindOf = (name) => center(`__nexus.find(${JSON.stringify(name)}).el.querySelector('.mind')`); // l'Engramme vivant
const engramsLive = "[...__nexus.nodes.values()].filter(n=>n.type==='engram').every(n=>n.el.classList.contains('is-live'))";
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
  const rclick = async (pointExpr) => { // clic droit (menu contextuel)
    const [x, y] = await evaluate(pointExpr);
    await mouse("mouseMoved", x, y, { buttons: 0 });
    await mouse("mousePressed", x, y, { button: "right", buttons: 2, clickCount: 1 });
    await mouse("mouseReleased", x, y, { button: "right", buttons: 0, clickCount: 1 });
  };
  const ctrlK = async () => {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 }, S);
  };
  const typeText = (text) => cdp.send("Input.insertText", { text }, S);
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
    writeFileSync(join(SHOTS, name), Buffer.from(data, "base64"));
  };
  // La vue ne bouge plus (cadrage animé terminé) : deux relevés identiques à 250 ms.
  const viewStill = async () => {
    let prev = "";
    for (const t0 = Date.now(); Date.now() - t0 < 15000; ) {
      const v = await evaluate("JSON.stringify(__nexus.view)");
      if (v === prev) return;
      prev = v;
      await sleep(250);
    }
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

  // --- Nexus : la scène de départ se relie, les vrais Engrammes s'animent, le flux s'écoule ------------------------------
  await click(center("document.getElementById('door-nexus')"));
  await waitFor("document.getElementById('gate').hidden && __nexus.links.size === 4", "entrée dans le Nexus", 20000);
  await waitFor(`${engramsLive} && [...__nexus.nodes.values()].every(n=>!!n.memory) && ${flowSettled}`, "Engrammes vivants et flux initial", 90000);
  await check("flux Contexte → Engrammes → Rendu", "[...__nexus.nodes.values()].map(n=>n.type+':'+!!n.memory).join(' ')",
    "context:true engram:true engram:true render:true");
  await check("les Engrammes sont de vrais Engrammes (36 bulles et plus, document vivant du Mode Focus)",
    "[...__nexus.nodes.values()].filter(n=>n.type==='engram').map(n=>n.engram.nodes.length>=36 && /prism-engram/.test(n.el.querySelector('.engram-frame').srcdoc)).join()", "true,true");
  await check("la pensée part de l'Engramme et allume ses bulles (axiome, méthode…)",
    "(()=>{const n=__nexus.find('Marie Curie');const ids=new Set(n.engram.nodes.map(x=>x.id));return n.memory.trace.length>=2 && n.memory.trace.every(t=>ids.has(t.id))})()", true);
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
  await sleep(300);
  await viewStill();

  // --- Glisser un Engramme par son en-tête ----------------------------------------------------------------------------------
  await evaluate("window.__j0 = [__nexus.find('Ada Lovelace').x, __nexus.find('Ada Lovelace').y]");
  await drag(`(()=>{const [x,y]=${headOf("Ada Lovelace")};return [[x,y],[x+90,y+30]]})()`);
  await check("un Engramme se glisse par son en-tête (et ses synapses le suivent)",
    "(()=>{const n=__nexus.find('Ada Lovelace');const l=[...__nexus.links.values()].find(l=>l.to===n.id);return n.x!==__j0[0] && n.y!==__j0[1] && Math.abs(l.b.x-n.x)<2})()", true);

  // --- Retirer un Engramme, le reprendre depuis le menu, tirer deux synapses -------------------------------------------------
  await click(center("__nexus.find('Ada Lovelace').el.querySelector('.close')"));
  await waitFor("!__nexus.find('Ada Lovelace') && __nexus.links.size === 2", "Ada retirée");
  await click(center("document.getElementById('add-engram')"));
  await waitFor("!document.getElementById('engram-menu').hidden && !/Recherche/.test(document.getElementById('engram-menu').textContent)", "menu des Engrammes");
  await check("menu : démonstrations, vos Engrammes, création au prix affiché",
    "(()=>{const m=document.getElementById('engram-menu');return [[...m.querySelectorAll('.menu-sec')].map(s=>s.textContent).join(' / '), m.querySelector('.custom-mind button').textContent]})()",
    ["Démonstrations / Vos Engrammes / Créer un Engramme", "Créer · 2 Sparks"]);
  await click(center("[...document.querySelectorAll('#engram-menu button')].find(b=>b.textContent.includes('Ada Lovelace'))"));
  await waitFor("!!__nexus.find('Ada Lovelace') && document.getElementById('engram-menu').hidden", "Ada reprise depuis le menu");
  await evaluate("(()=>{const n=__nexus.find('Ada Lovelace');n.x=-600;n.y=260;n.el.style.left=n.x+'px';n.el.style.top=n.y+'px';document.getElementById('fit').click()})()");
  await waitFor(engramsLive, "Ada vivante", 90000);
  await sleep(1000);
  await drag(`[${portOf("context", "out")}, ${mindOf("Ada Lovelace")}]`);
  await drag(`[${portOf("Ada Lovelace", "out")}, ${portOf("render", "in")}]`);
  await check("deux synapses tirées à la souris (port → Engramme vivant, port → port)", "__nexus.links.size", 4);
  await drag(`[${portOf("Ada Lovelace", "out")}, ${center("__nexus.find('context').el.querySelector('.shell')")}]`);
  await check("fil refusé vers un Contexte (le flux va Contexte → Engramme → Rendu)", "[__nexus.links.size, document.getElementById('toast').hidden]", [4, false]);
  await waitFor(`__nexus.find('render').memory && __nexus.find('render').memory.thoughts.length === 2 && ${flowSettled}`, "le rendu reçoit Ada", 30000);
  await check("l'écran entend les deux Engrammes", "__nexus.find('render').memory.thoughts.map(t=>t.author).join(' + ')", "Marie Curie + Ada Lovelace");
  await shot("nexus-3-synapses.png");

  // --- Plongée : l'Engramme vivant en grand ------------------------------------------------------------------------------------
  await click(headOf("Marie Curie"), 2);
  await waitFor("document.getElementById('anatomy').classList.contains('is-on')", "plongée dans l'Engramme");
  await check("double-clic sur l'en-tête : plongée dans l'Engramme de Marie Curie, sans bulle créée",
    "[document.getElementById('anat-name').textContent, __nexus.nodes.size, document.getElementById('dive-frame').srcdoc.length > 1000]", ["Marie Curie", 4, true]);
  await check("la plongée montre son climat, sa pensée, ses entrées et les évènements de sa vie",
    "[document.querySelectorAll('#anat-climate .chip').length >= 2, document.querySelectorAll('#anat-preview p').length >= 2, document.querySelectorAll('#anat-inputs li').length, document.querySelectorAll('#memories li').length]",
    [true, true, 1, 10]);
  await sleep(2500);
  await shot("nexus-4-plongee.png");
  await key("Escape");
  // La caméra revient en glissant (0,85 s) : on attend qu'elle soit posée avant de viser un fil.
  await waitFor("document.getElementById('anatomy').hidden && __nexus.view.z < 3 && !document.getElementById('dive-frame').srcdoc && !document.getElementById('world').classList.contains('is-diving')", "remontée", 15000);
  await check("remontée : l'Engramme en grand s'arrête, le Nexus revient", "document.getElementById('world').style.opacity", "1");

  // --- Couper un fil : la mémoire en aval s'efface à l'instant ------------------------------------------------------------
  await waitFor(flowSettled, "flux reposé");
  // Un point du fil que le Nexus lui-même attribue à ce fil (sa géométrie, cf. linkAt), stable d'une mesure à l'autre :
  // juste après la remontée, la mise en page peut encore bouger (CI).
  const cutAt = `(()=>{const c=__nexus.find('Marie Curie').id,x=__nexus.find('context').id;const l=[...__nexus.links.values()].find(l=>l.from===x&&l.to===c);
    const p=l.paths[3];const len=p.getTotalLength();const m=p.getScreenCTM();
    for(const u of [0.5,0.4,0.6,0.3,0.7,0.2,0.8]){const pt=p.getPointAtLength(len*u);const q=new DOMPoint(pt.x,pt.y).matrixTransform(m);
      const e=document.elementFromPoint(q.x,q.y);const hit=__nexus.linkAt(q.x,q.y);
      if(hit&&hit.id===l.id&&e&&(e.closest('.link')===l.el||e.id==='viewport'))return [Math.round(q.x),Math.round(q.y)]}
    return null})()`;
  let [cx, cy] = [0, 0];
  for (let t0 = Date.now(); ; ) {
    const a = await evaluate(cutAt);
    await sleep(300);
    const b = await evaluate(cutAt);
    if (a && b && a[0] === b[0] && a[1] === b[1]) { [cx, cy] = b; break; }
    if (Date.now() - t0 > 15000) throw new Error("délai dépassé : point du fil stable");
  }
  const under = await evaluate(`(()=>{const c=__nexus.find('Marie Curie').id,x=__nexus.find('context').id;const want=[...__nexus.links.values()].find(l=>l.from===x&&l.to===c).id;
    const top=document.elementFromPoint(${cx},${cy});const got=top&&top.closest('.link');
    window.__ev=[];for(const t of ['pointerdown','pointerup','click'])addEventListener(t,(e)=>{const l=e.target.closest&&e.target.closest('.link');const nd=e.target.closest&&e.target.closest('.node');window.__ev.push(t+':'+(e.target.tagName||'?')+'.'+String(e.target.className||'').slice(0,30)+(e.target.id?'#'+e.target.id:'')+(l?' fil '+l.dataset.id:'')+(nd?' carte '+nd.dataset.id:'')+' @'+Math.round(e.clientX)+','+Math.round(e.clientY))},true);
    return document.elementsFromPoint(${cx},${cy}).slice(0,3).map(e=>e.tagName+'.'+[...e.classList].join('.')).join(' > ')+' ; fil visé '+want+', fil sous le point '+(got?got.dataset.id:'aucun')})()`);
  await click(`[${cx},${cy}]`);
  if (await evaluate("__nexus.links.size") !== 3) console.log(`  diagnostic : clic en ${Math.round(cx)}, ${Math.round(cy)} sur ${under} ; évènements : ${await evaluate("(window.__ev||[]).join(', ')")}`);
  await check("fil coupé au clic : Curie perd sa mémoire, l'écran perd sa voix, sans délai",
    "(()=>{const c=__nexus.find('Marie Curie'),r=__nexus.find('render');return [__nexus.links.size,c.memory===null,c.el.querySelector('.thought').textContent,r.memory.thoughts.map(t=>t.author).join(' + '),document.querySelector('#nodes .render .voices').textContent.includes('Marie Curie')]})()",
    [3, true, "", "Ada Lovelace", false]);
  await sleep(500);
  await shot("nexus-5-coupe.png");

  // --- Hub : lasso autour des Engrammes, War Room, débat -----------------------------------------------------------------
  await drag(`(()=>{const cs=[...__nexus.nodes.values()].filter(n=>n.type==='engram').map(n=>{const r=n.el.querySelector('.mind').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]});
    const xs=cs.map(c=>c[0]),ys=cs.map(c=>c[1]);const cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
    const rx=(Math.max(...xs)-Math.min(...xs))/2+150,ry=(Math.max(...ys)-Math.min(...ys))/2+150;const pts=[];
    for(let i=0;i<=36;i++){const a=i/36*Math.PI*2;pts.push([cx+Math.cos(a)*rx,cy+Math.sin(a)*ry])}
    let k=pts.findIndex(p=>{const e=document.elementFromPoint(p[0],p[1]);return e&&e.id==='viewport'});if(k<0)k=0;return pts.slice(k).concat(pts.slice(1,k+1))})()`, { alt: true });
  await waitFor("__nexus.hubs.size === 1 && !document.getElementById('room').hidden", "Hub et War Room");
  await check("Alt + lasso : un Hub réunit les 2 Engrammes", "[...__nexus.hubs.values()][0].members.length", 2);
  await check("débat en deux tours puis synthèse, à partir des Engrammes",
    "__nexus.debate('Comment rendre ce tableau lisible par les enfants ?').then(()=>[document.querySelectorAll('#log .msg.mind').length, !!document.querySelector('#log .msg.synth')])", [4, true]);
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
  await waitFor("window.__nexus && __nexus.nodes.size === 4 && __nexus.links.size === 3 && __nexus.hubs.size === 1", "scène restaurée", 30000);
  await waitFor(`${engramsLive} && __nexus.find('render').memory`, "Engrammes de retour", 90000);
  await check("scène retrouvée après rechargement (Engrammes, fils, Hub, fil coupé, position)",
    "[__nexus.find('Marie Curie').memory === null, __nexus.find('render').memory.thoughts.length, __nexus.find('Ada Lovelace').x, __nexus.find('Ada Lovelace').engram.nodes.length >= 36]",
    [true, 1, -600, true]);

  // --- V6.2 · Atmosphère : brume volumétrique sous le canvas, éclairée par les bulles -------------------------------------
  await check("atmosphère active sous le canvas (WebGL, ou lueurs 2D sans WebGL matériel)",
    "(()=>{const a=__nexus.atmos();const c=document.getElementById('atmos');return [!!a&&a.enabled, !!a&&['webgl','2d'].includes(a.mode), c.width>1&&c.style.display!=='none']})()",
    [true, true, true]);

  // --- V6.2 · Inventaire : paire sans fil, fusion bionique, prisme holographique, horloge chrono-quantique -----------------
  const fromInventory = async (label) => {
    await click(center("document.getElementById('inventory')"));
    await waitFor("!document.getElementById('inventory-menu').hidden", "inventaire ouvert");
    await click(center(`[...document.querySelectorAll('#inventory-menu .inv-item')].find(b=>b.querySelector('b').textContent===${JSON.stringify(label)})`));
    await waitFor("document.getElementById('inventory-menu').hidden", `inventaire : ${label}`);
  };
  await click(center("document.getElementById('inventory')"));
  await waitFor("!document.getElementById('inventory-menu').hidden", "inventaire ouvert");
  await check("inventaire : les essentiels et les blocs avancés",
    "[...document.querySelectorAll('#inventory-menu .inv-item b')].map(b=>b.textContent).join(' / ')",
    "Contexte / Engramme / Rendu / Prisme holographique / Horloge chrono-quantique / Fusion bionique / Paire sans fil / Émetteur sans fil / Récepteur sans fil");
  await key("Escape");
  await fromInventory("Paire sans fil");
  await waitFor("!!__nexus.find('tx') && !!__nexus.find('rx') && document.querySelectorAll('#wireless path').length === 1", "paire sans fil");
  // Sous la scène, à l'écart des autres bulles ; un second écran au bout du récepteur.
  await evaluate(`(()=>{const N=__nexus;const y=Math.max(...[...N.nodes.values()].map(n=>n.y+n.el.offsetHeight))+160;const x0=N.find('context').x;
    const put=(n,x,yy)=>{n.x=x;n.y=yy;n.el.style.left=x+'px';n.el.style.top=yy+'px'};
    put(N.find('tx'),x0,y);put(N.find('rx'),x0+560,y);window.__r2=N.add('render',x0+1040,y-40).id;document.getElementById('fit').click()})()`);
  await sleep(1000);
  await drag(`[${portOf("context", "out")}, ${portOf("tx", "in")}]`);
  await drag(`[${portOf("rx", "out")}, ${center("__nexus.nodes.get(__r2).el.querySelector('.port.in')")}]`);
  await waitFor(`(()=>{const m=__nexus.memory(__r2);return !!m && m.contexts.length===1 && ${flowSettled}})()`, "flux sans fil jusqu'à l'écran", 20000);
  await check("sans fil : le contexte entre dans l'émetteur et ressort du récepteur (canal A), jusqu'à l'écran",
    "[__nexus.memory(__r2).contexts[0].title, __nexus.find('rx').el.querySelector('.note').textContent]", ["Brief", "Reçoit 1 contexte de 1 émetteur (« A »)."]);
  await click(center("__nexus.find('rx').el.querySelector('.channel')"));
  await evaluate("__nexus.find('rx').el.querySelector('.channel').select()");
  await typeText("B");
  await check("changer de canal rompt la liaison : l'écran s'efface aussitôt", "[document.querySelectorAll('#wireless path').length, __nexus.memory(__r2)]", [0, null]);
  await evaluate("__nexus.find('rx').el.querySelector('.channel').select()");
  await typeText("A");
  await waitFor(`!!__nexus.memory(__r2) && document.querySelectorAll('#wireless path').length === 1 && ${flowSettled}`, "canal A retrouvé", 20000);
  await fromInventory("Fusion bionique");
  await fromInventory("Prisme holographique");
  await fromInventory("Horloge chrono-quantique");
  // Les nouveaux blocs, rangés à l'écart (ils naissent au centre de la vue, parfois sur une autre bulle).
  await evaluate(`(()=>{const N=__nexus;const tx=N.find('tx'),rx=N.find('rx');const put=(n,x,y)=>{n.x=x;n.y=y;n.el.style.left=x+'px';n.el.style.top=y+'px'};
    put(N.find('fuse'),rx.x,rx.y+320);put(N.find('holo'),rx.x+480,rx.y+380);put(N.find('chrono'),tx.x-460,tx.y);document.getElementById('fit').click()})()`);
  await sleep(1000);
  await check("fils vers la fusion (Ada et le récepteur), la fusion vers le prisme, le prisme vers l'écran",
    "(()=>{const N=__nexus;const f=N.find('fuse'),h=N.find('holo');return [N.connect(N.find('Ada Lovelace').id,f.id),N.connect(N.find('rx').id,f.id),N.connect(f.id,h.id),N.connect(h.id,__r2)].every(Boolean)})()", true);
  // Les mémoires sont calculées d'un coup ; les bulles se redessinent quand l'impulsion arrive (on attend le prisme).
  await waitFor(`(()=>{const m=__nexus.memory(__r2);return !!m && m.thoughts.length===1 && /^Projette/.test(__nexus.find('holo').el.querySelector('.note').textContent) && ${flowSettled}})()`, "fusion jusqu'à l'écran", 20000);
  await check("fusion bionique : Ada et le contexte sans fil fondus en une pensée, que le prisme projette jusqu'à l'écran",
    "(()=>{const f=__nexus.memory(__nexus.find('fuse').id);return [f.author, /^Fusion de Ada Lovelace/.test(f.lines[0]), f.lines.length>=3, __nexus.memory(__r2).thoughts[0].author, /^Projette 1 pensée/.test(__nexus.find('holo').el.querySelector('.note').textContent)]})()",
    ["Fusion", true, true, "Fusion", true]);
  await evaluate(`(()=>{const N=__nexus,c=N.find('chrono');window.__ch=c.id;const p=c.el.querySelector('input[type=range]');p.value=3;p.dispatchEvent(new Event('input',{bubbles:true}));
    const s=c.el.getBoundingClientRect();return !!N.connect(c.id,N.find('Ada Lovelace').id)})()`);
  await check("règles des blocs : un écran n'émet rien, une horloge ne reçoit rien, pas de boucle",
    "(()=>{const N=__nexus;return [N.connect(__r2,N.find('tx').id), N.connect(N.find('holo').id,__ch), N.connect(N.find('holo').id,N.find('fuse').id)]})()", [null, null, null]);
  const phase0 = await evaluate("__nexus.memory(__ch).text");
  await waitFor(`__nexus.memory(__ch).text !== ${JSON.stringify(phase0)}`, "l'horloge change d'état", 15000);
  await waitFor("[...document.querySelectorAll('#says .say:not(.is-emoji)')].some(s=>/^Avec « /.test(s.textContent))", "bulle de dialogue au-dessus d'Ada", 15000);
  await check("bulle de dialogue dans l'espace : Ada dit sa pensée au-dessus d'elle, à taille lisible",
    "(()=>{const b=[...document.querySelectorAll('#says .say')].find(s=>/^Avec « /.test(s.textContent));const n=__nexus.find('Ada Lovelace');return [Math.abs(parseFloat(b.style.left)-(n.x+n.el.offsetWidth/2))<2, parseFloat(b.style.top)===n.y]})()", [true, true]);
  await click(center("__nexus.nodes.get(__ch).el.querySelector('.chrono-ring')"));
  await check("un clic sur l'anneau fige l'horloge (l'état observé ne change plus)", "__nexus.nodes.get(__ch).el.querySelector('.chrono-top small').textContent.includes('figé')", true);
  await waitFor(`(()=>{const m=__nexus.memory(__nexus.find('Ada Lovelace').id);return !!m && m.lines[1].includes(__nexus.memory(__ch).text) && ${flowSettled}})()`, "Ada pense avec le moment", 20000);
  await check("horloge chrono-quantique : Ada pense avec le moment présent", "__nexus.inputs(__nexus.find('Ada Lovelace').id).map(m=>m.title).join(' + ')", "Brief + Horloge");
  await shot("nexus-8-blocs.png");

  // --- V6.2 · Roue de réactions : clic droit, ping ; touche R ----------------------------------------------------------------
  await rclick(headOf("Ada Lovelace"));
  await waitFor("!document.getElementById('wheel').hidden", "roue de réactions");
  await check("clic droit sur une bulle : la roue de réactions", "[...document.querySelectorAll('#wheel .wheel-item')].map(b=>b.getAttribute('aria-label')).join(', ')",
    "Approuver, Une idée, Une question, Attention, Ping, Épingler");
  await shot("nexus-9-roue.png");
  // Les gestes de la roue arrivent en glissant depuis son centre : on clique une fois posés.
  await waitFor("[...document.querySelectorAll('#wheel .wheel-item')].every(b=>b.getAnimations().every(a=>a.playState!=='running'))", "roue posée", 10000);
  await click(center("document.querySelector('#wheel [data-reaction=\"📍\"]')"));
  await check("ping : la bulle s'illumine et le dit dans l'espace",
    "[document.getElementById('wheel').hidden, __nexus.find('Ada Lovelace').el.classList.contains('is-pinged'), [...document.querySelectorAll('#says .say.is-emoji')].some(s=>s.textContent==='📍')]",
    [true, true, true]);
  await key("r");
  await check("touche R : la roue s'ouvre sur la bulle choisie", "[!document.getElementById('wheel').hidden, document.querySelector('#wheel .wheel-center').textContent]", [true, "Ada Lovelace"]);
  await key("Escape");
  await check("Échap ferme la roue", "document.getElementById('wheel').hidden", true);

  // --- V6.2 · Paramètres « Liquid Glass » : Ctrl + K, recherche, aperçu en direct, Appliquer, Annuler, par défaut ----------------
  await ctrlK();
  await waitFor("!document.getElementById('settings').hidden && document.activeElement === document.getElementById('settings-q')", "Ctrl + K : Paramètres");
  await typeText("brume");
  await check("Ctrl + K : recherche instantanée parmi les réglages", "[...document.querySelectorAll('#settings-list .setting b')].map(b=>b.textContent).join(' / ')",
    "Atmosphère volumétrique / Météo / Densité de la brume / Éclairage volumétrique");
  await check("aperçu en direct : l'atmosphère du réglage, avant de l'appliquer", "/^Rendu (WebGL|2D)/.test(document.getElementById('preview-meta').textContent)", true);
  await shot("nexus-10-parametres.png");
  await evaluate("document.getElementById('settings-q').select()");
  await typeText("zzzz");
  await check("recherche sans résultat", "document.querySelector('#settings-list .settings-empty').textContent", "Aucun réglage pour « zzzz ».");
  await evaluate("document.getElementById('settings-q').select()");
  await typeText("dialogue");
  await click(center("document.querySelector('#settings-list .setting[data-key=says] .switch')"));
  await check("un réglage modifié s'essaie dans l'aperçu sans être appliqué",
    "[document.querySelector('.setting[data-key=says]').classList.contains('is-dirty'), document.getElementById('settings-apply').disabled, document.getElementById('pv-say').hidden, __nexus.settings().says]",
    [true, false, true, true]);
  await click(center("document.getElementById('settings-apply')"));
  await check("« Appliquer » : le réglage vaut dans le Nexus et reste enregistré sur l'appareil",
    "[__nexus.settings().says, JSON.parse(localStorage.getItem('prism:nexus:settings')).says, document.getElementById('settings-apply').disabled, document.querySelectorAll('#says .say').length]",
    [false, false, true, 0]);
  await evaluate("document.getElementById('settings-q').select()");
  await typeText("orage");
  await click(center("[...document.querySelectorAll('.setting[data-key=weather] .segmented button')].find(b=>b.textContent==='Orage')"));
  await click(center("document.getElementById('settings-cancel')"));
  await check("« Annuler » : rien n'est appliqué", "[document.getElementById('settings').hidden, __nexus.settings().weather]", [true, "auto"]);
  await click(center("document.getElementById('settings-btn')"));
  await waitFor("!document.getElementById('settings').hidden", "Paramètres (bouton)");
  await click(center("document.getElementById('settings-reset')"));
  await click(center("document.getElementById('settings-apply')"));
  await check("« Réglages par défaut » puis « Appliquer »", "[__nexus.settings().says, __nexus.settings().atmos]", [true, true]);
  await key("Escape");
  await check("Échap ferme les Paramètres", "document.getElementById('settings').hidden", true);

  // --- V6.2 · Anti-lag : Engrammes endormis hors champ, réveillés avant d'entrer à l'écran (caméra suivie) ------------------------
  await evaluate("__nexus.setView(-40000, -40000, 1)");
  await waitFor("(()=>{const s=__nexus.stream();return s.asleep===s.engrams && s.culled===__nexus.nodes.size})()", "Engrammes endormis hors champ", 12000);
  await check("hors champ : les Engrammes s'endorment, les bulles ne sont plus peintes", "(()=>{const s=__nexus.stream();return [s.live, s.asleep]})()", [0, 2]);
  // La caméra glisse vers Ada, image par image : elle doit se réveiller alors qu'elle est encore au-delà de la marge.
  await check("streaming prédictif : la caméra file vers Ada, qui se réveille avant d'entrer à l'écran",
    `(async()=>{const N=__nexus,n=N.find('Ada Lovelace'),z=1,W=innerWidth,H=innerHeight;const y=H/2-(n.y+n.el.offsetHeight/2)*z;
      const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      let x=W+1900-n.x*z,early=false,asleep0=n.asleep;
      while(x+n.x*z>W){x-=60;N.setView(x,y,z);await frame();if(!n.asleep&&x+n.x*z>W+220)early=true}
      return [asleep0, early]})()`, [true, true]);
  await click(center("document.getElementById('fit')"));
  await waitFor(`${engramsLive} && __nexus.stream().asleep === 0`, "Engrammes réveillés", 90000);

  // --- V6.2 · War Room : un canal par Hub, effacée pendant un geste, réponses en fil ----------------------------------------------
  await evaluate("__nexus.room([...__nexus.hubs.keys()][0])");
  await waitFor("!document.getElementById('room').hidden", "War Room");
  await sleep(900);
  const [fx, fy] = await evaluate(`(()=>{const free=(x,y)=>{const e=document.elementFromPoint(x,y);return e&&e.id==='viewport'};
    for(let y=140;y<innerHeight-60;y+=20)for(let x=60;x<innerWidth-60;x+=20)if(free(x,y)&&free(x+60,y))return [x,y];return null})()`);
  await mouse("mouseMoved", fx, fy, { buttons: 0 });
  await mouse("mousePressed", fx, fy, { clickCount: 1 });
  for (let k = 1; k <= 6; k++) { await mouse("mouseMoved", fx + k * 10, fy); await sleep(16); }
  await sleep(700);
  const during = await evaluate("+getComputedStyle(document.getElementById('room')).opacity");
  await mouse("mouseReleased", fx + 60, fy, { clickCount: 1 });
  await sleep(600);
  const after = await evaluate("+getComputedStyle(document.getElementById('room')).opacity");
  await check("la War Room s'efface pendant un geste, puis revient", JSON.stringify([during < 0.3, after === 1]), [true, true]);
  await check("un canal par Hub", "[...document.querySelectorAll('#channels button')].map(b=>b.getAttribute('aria-selected')).join()", "true");
  await evaluate("__nexus.debate('Qui lit le tableau en premier ?')");
  await evaluate("[...document.querySelectorAll('#log .page > .msg.mind .reply-btn')].pop().scrollIntoView({ block: 'center', behavior: 'instant' })");
  await click(center("[...document.querySelectorAll('#log .page > .msg.mind .reply-btn')].pop()"));
  await check("« Répondre en fil » vise un esprit", "[!document.getElementById('reply-to').hidden, document.getElementById('ask-send').textContent, document.activeElement.id]", [true, "Répondre", "question"]);
  await typeText("Et pour les plus petits ?");
  await click(center("document.getElementById('ask-send')"));
  await waitFor("document.querySelectorAll('#log .thread .msg:not(.typing)').length === 2 && !document.getElementById('ask-send').disabled", "réponse en fil", 20000);
  await check("fil : votre question et sa réponse, sous le message visé",
    "[...document.querySelectorAll('#log .thread .msg')].map(m=>m.classList.contains('user')?'vous':m.querySelector('b').textContent.split(' · ').pop())", ["vous", "en fil"]);
  await shot("nexus-11-fil.png");
  await evaluate("window.__h2 = __nexus.hub([__nexus.find('Ada Lovelace').id, __nexus.find('Marie Curie').id]).id");
  await click(center("document.querySelector('#channels button[data-hub=\"' + __h2 + '\"]')"));
  await check("deux Hubs : deux canaux, chacun sa discussion", "[document.querySelectorAll('#channels button').length, document.querySelectorAll('#log .msg').length]", [2, 0]);
  await click(center("document.querySelector('#channels button')"));
  await check("retour au premier canal : sa discussion est intacte", "document.querySelectorAll('#log .thread .msg').length", 2);
  await evaluate("__nexus.unhub(__h2)");
  await key("Escape");

  // Les blocs repartent : la scène redevient celle d'avant.
  await evaluate("['tx','rx','fuse','holo','chrono'].forEach(t=>__nexus.remove(__nexus.find(t).id)); __nexus.remove(__r2)");
  await waitFor(`__nexus.nodes.size === 4 && __nexus.links.size === 3 && __nexus.hubs.size === 1 && document.getElementById('room').hidden && ${flowSettled}`, "blocs retirés", 20000);

  // --- Créer un Engramme demande le serveur et un compte : sans eux, rien n'est tenté -----------------------------------------
  if (!SERVER) {
    await click(center("document.getElementById('add-engram')"));
    await waitFor("!document.getElementById('engram-menu').hidden", "menu des Engrammes");
    await evaluate("document.querySelector('.custom-mind input').value = 'Léonard de Vinci'; document.querySelector('.custom-mind button').scrollIntoView({ block: 'center' })");
    await click(center("document.querySelector('.custom-mind button')"));
    await check("« Créer un Engramme » sans serveur : aucune création, le menu Intelligence explique",
      "[__nexus.nodes.size, !document.getElementById('intel-menu').hidden]", [4, true]);
    await key("Escape");
  }

  // --- Avec le serveur Prism : penser avec Gemini, débattre, créer un Engramme (compte, prix affichés, Sparks au clic) ---------
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
    await check("« Penser » annonce son prix, rien n'est encore dépensé", "[document.getElementById('think-all').textContent, __prismLink.account.user.sparks]", ["Penser · 0,25 Spark", start]);
    await check("en attente, l'Engramme le dit", "__nexus.find('Ada Lovelace').el.querySelector('.thought').textContent.startsWith('Prêt à penser')", true);
    await click(center("document.getElementById('think-all')"));
    await waitFor("document.getElementById('think-all').hidden && [...__nexus.nodes.values()].every(n=>!n.el.classList.contains('is-thinking'))", "pensée reçue", 90000);
    await check("Ada a pensé par l'API, à partir de son Engramme (0,25 Spark ; bulles mobilisées)",
      "(()=>{const n=__nexus.find('Ada Lovelace');const ids=new Set(n.engram.nodes.map(x=>x.id));return [n.memory.source, n.memory.trace.length>0 && n.memory.trace.every(t=>ids.has(t.id)), __prismLink.account.user.sparks]})()",
      ["api", true, start - 0.25]);
    // L'écran se redessine quand l'impulsion arrive au bout du fil (≈ 0,8 s après la pensée) : on attend l'écran lui-même.
    await waitFor(`__nexus.find('render').memory && __nexus.find('render').memory.thoughts.every(t=>t.source==='api') && ${flowSettled}
      && / · /.test((document.querySelector('#nodes .render .by') || {}).textContent || '')`, "écran nourri par l'API", 20000);
    await check("l'écran dit d'où vient la pensée", "/ · (Gemini|serveur \\(mode démo\\))$/.test(document.querySelector('#nodes .render .by').textContent)", true);
    await click(center("document.getElementById('fit')")); // « Tout voir » cadre aussi l'anneau du Hub et son étiquette
    await sleep(1100);
    await check("« Tout voir » montre le bouton de la War Room",
      `(()=>{const [x,y]=${center("document.querySelector('.hub .label button')")};return document.elementFromPoint(x,y)===document.querySelector('.hub .label button')})()`, true);
    await click(center("document.querySelector('.hub .label button')"));
    await waitFor("!document.getElementById('room').hidden", "War Room");
    await check("« Débattre » annonce son prix", "document.getElementById('ask-send').textContent", "Débattre · 1 Spark");
    await evaluate("document.querySelector('#log .page').replaceChildren(); document.getElementById('question').value = 'Par quoi commencer ?'");
    await click(center("document.getElementById('ask-send')"));
    await waitFor("!!document.querySelector('#log .msg.synth') && !document.getElementById('ask-send').disabled", "débat par l'API", 90000);
    await check("débat par l'API : 2 positions, 2 réponses, une synthèse (1 Spark)",
      "[document.querySelectorAll('#log .msg.mind:not(.typing):not(.error)').length, __prismLink.account.user.sparks]", [4, start - 1.25]);
    await evaluate("[...document.querySelectorAll('#log .page > .msg.mind .reply-btn')].pop().scrollIntoView({ block: 'center', behavior: 'instant' })");
    await click(center("[...document.querySelectorAll('#log .page > .msg.mind .reply-btn')].pop()"));
    await check("répondre en fil avec Gemini annonce son prix (une pensée)", "document.getElementById('ask-send').textContent", "Répondre · 0,25 Spark");
    await typeText("Et concrètement, lundi ?");
    await click(center("document.getElementById('ask-send')"));
    await waitFor("document.querySelectorAll('#log .thread .msg.mind:not(.typing)').length === 1 && !document.getElementById('ask-send').disabled", "réponse en fil par l'API", 60000);
    await check("réponse en fil par l'API, à partir de l'Engramme (0,25 Spark)",
      "[document.querySelector('#log .thread .msg.mind:not(.typing)').classList.contains('error'), __prismLink.account.user.sparks]", [false, start - 1.5]);
    await shot("nexus-7-gemini.png");
    await key("Escape");
    // Créer un Engramme (serveur en mode démo : un Engramme de démonstration, facturé comme un vrai).
    if (await evaluate("__prismLink.info.mode === 'mock'")) {
      await click(center("document.getElementById('add-engram')"));
      // « Vos Engrammes » arrive après l'ouverture (Mon Hub) et décale le formulaire : on attend la liste.
      await waitFor("!document.getElementById('engram-menu').hidden && !!document.querySelector('.custom-mind') && !/Recherche/.test(document.getElementById('engram-menu').textContent)", "menu des Engrammes");
      await evaluate("document.querySelector('.custom-mind input').value = 'Léonard de Vinci'; document.querySelector('.custom-mind button').scrollIntoView({ block: 'center' })");
      await click(center("document.querySelector('.custom-mind button')"));
      await waitFor(`__nexus.nodes.size === 5 && ${engramsLive}`, "Engramme créé par le serveur", 120000).catch(async (err) => {
        const state = await evaluate("JSON.stringify([...__nexus.nodes.values()].filter(n=>n.type==='engram').map(n=>[n.name,n.source,n.status,n.error||'',n.el.classList.contains('is-live')]))");
        throw new Error(`${err.message} — ${state} ; toast : ${await evaluate("document.getElementById('toast').hidden ? '-' : document.getElementById('toast').textContent")}`);
      });
      await check("« Créer un Engramme » : un vrai Engramme vivant rejoint le Nexus (2 Sparks)",
        "[[...__nexus.nodes.values()].filter(n=>n.source==='created').map(n=>n.engram.nodes.length>=36).join(), __prismLink.account.user.sparks]", ["true", start - 3.5]);
    }
    await cdp.send("Page.navigate", { url: `${URL_NEXUS}?retour=2#nexus` }, S);
    await waitFor("window.__nexus && __nexus.nodes.size >= 4 && window.__prismLink && __prismLink.ready && __prismLink.account.user", "retour avec le compte", 30000);
    await waitFor(engramsLive, "Engrammes de retour", 90000);
    await check("au retour, les pensées payées sont gardées : rien à repayer",
      "[__nexus.intel(), __nexus.pendingCount(), document.getElementById('think-all').hidden, __nexus.find('Ada Lovelace').memory.source]", ["gemini", 0, true, "api"]);
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
