// Rendu des Engrammes hors du DOM (engine/engram/render.js) et échanges Worker ↔ page (instantanés de physics.js).
// node --test frontend/tests/engram-render.test.cjs
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const P = require("../engine/engram/physics.js");
const R = require("../engine/engram/render.js");
const E = require("../engine/engram/engram.js");

const demo = E.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, "../engine/engram/demo-marie-curie.json"), "utf8")));
const W = 780;
const H = 560;

/** Contexte 2D factice : accepte tout appel, compte les dessins (Node n'a ni DOM ni canevas). */
function fakeCanvas() {
  const calls = { fill: 0, stroke: 0, fillText: 0, drawImage: 0 };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createRadialGradient" || key === "createLinearGradient") return () => gradient;
      if (key === "measureText") return (s) => ({ width: String(s).length * 6 });
      if (key === "getImageData") return () => ({ data: [12, 34, 56, 255] });
      if (key in calls) return () => { calls[key] += 1; };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return { canvas, ctx, calls };
}

function renderer(data = demo, options = {}) {
  const sim = P.createSimulation(data, { width: W, height: H, seed: 5, ...options });
  const { canvas, ctx, calls } = fakeCanvas();
  const r = R.createRenderer({ canvas, ctx, sim, data, reduced: false, makeCanvas: () => fakeCanvas().canvas, rng: P.rng, seed: 5 });
  r.resize(W, H, 2);
  return { sim, r, canvas, calls };
}

test("rendu sans DOM : il dessine une image dans un fil sans document ni fenêtre (Worker)", () => {
  assert.equal(typeof document, "undefined");
  const { r, canvas, calls } = renderer();
  assert.deepEqual([canvas.width, canvas.height], [W * 2, H * 2], "toile à la densité de pixels");
  const out = r.tick(1000);
  r.tick(1016);
  assert.deepEqual(out, { fusing: false, merged: false });
  assert.ok(calls.fill > demo.nodes.length, "chaque bulle dessinée");
  assert.ok(calls.fillText >= 1, "libellés");
  const stats = r.stats();
  assert.ok(stats.fps > 0 && stats.physics >= 0 && stats.draw >= 0);
  assert.deepEqual(r.pixels([[10, 10]]), [[12, 34, 56, 255]]);
});

test("état d'affichage piloté par identifiants (ce qui traverse les fils)", () => {
  const { sim, r } = renderer();
  const engine = sim.nodes.find((n) => n.category === "engine");
  const shadow = sim.nodes.find((n) => n.category === "shadow");
  assert.doesNotThrow(() => r.set({ hover: engine.id, pinned: shadow.id, drop: null, focus: "engine" }));
  assert.doesNotThrow(() => r.set({ trace: [{ id: engine.id, why: "parce que" }, { id: "inconnue", why: "x" }] }));
  assert.doesNotThrow(() => r.set({ hover: "inconnue", trace: null }));
  r.flash(engine.id);
  assert.ok(engine.flash > 0);
  assert.doesNotThrow(() => r.tick(2000));
});

test("fusion : le rendu signale l'animation, puis une seule fois la fin de l'introduction", () => {
  const data = { ...demo, parents: ["Ada Lovelace", "Marie Curie"] };
  const { r } = renderer(data, { fusion: true });
  let now = 0;
  const first = r.tick(now);
  assert.equal(first.fusing, true);
  let merged = 0;
  for (let i = 0; i < 400; i++) { now += 16; if (r.tick(now).merged) merged += 1; }
  assert.equal(merged, 1, "fin de l'introduction signalée une fois (mémorisée par la page)");
  assert.equal(r.tick(now + 16).fusing, false);
});

test("instantané du Worker → réplique de la page : positions, rayons et temps identiques", () => {
  const worker = P.createSimulation(demo, { width: W, height: H, seed: 9 });
  const page = P.createSimulation(demo, { width: W, height: H, seed: 9 });
  for (let i = 0; i < 90; i++) worker.advance(1 / 60);
  worker.setHover(worker.nodes[3].id);
  worker.advance(0.5);
  const buf = worker.snapshot();
  assert.ok(buf instanceof Float32Array);
  assert.equal(buf.length, 1 + worker.nodes.length * 3);
  page.sync(buf);
  assert.ok(Math.abs(page.time - worker.time) < 1e-4);
  for (let i = 0; i < worker.nodes.length; i++) {
    assert.ok(Math.abs(page.nodes[i].x - worker.nodes[i].x) < 1e-3);
    assert.ok(Math.abs(page.nodes[i].r - worker.nodes[i].r) < 1e-3);
  }
  const n = worker.nodes[3];
  assert.equal(page.nodeAt(n.x, n.y).id, n.id, "le survol se décide sur la réplique");
  assert.equal(worker.snapshot(buf), buf, "tampon rendu réutilisé (aucune allocation)");
  page.sync(new Float32Array(3)); // instantané tronqué : ignoré
  assert.ok(Math.abs(page.nodes[0].x - worker.nodes[0].x) < 1e-3);
});

test("pas de physique : 4 au plus par image, davantage quand la cadence est volontairement espacée", () => {
  const a = P.createSimulation(demo, { width: W, height: H, seed: 2 });
  const t0 = a.time;
  a.advance(0.1); // image lente : pas de rattrapage au-delà de MAX_STEPS
  assert.ok(Math.abs(a.time - t0 - P.MAX_STEPS / 120) < 1e-9);
  const b = P.createSimulation(demo, { width: W, height: H, seed: 2 });
  b.advance(0.08, 12); // carte au repos dessinée à 12,5 images/s : le mouvement couvre tout le temps écoulé
  assert.ok(Math.abs(b.time - 9 / 120) < 1e-9);
});

test("cadence : pleine vitesse quand la carte est manipulée, part d'un cœur au repos", () => {
  const pacer = R.createPacer();
  assert.equal(pacer.due(0, false), true, "première image");
  pacer.done(0, 3);
  assert.equal(pacer.due(16, true), true, "manipulée : chaque image");
  assert.equal(pacer.due(16, false), false, "au repos : 30 images/s au plus");
  assert.equal(pacer.due(34, false), true);
  let t = 34;
  for (let i = 0; i < 20; i++) { pacer.done(t, 20); t += 70; } // images chères (moyenne glissante ≈ 20 ms)
  t -= 70;
  assert.equal(pacer.due(t + 40, false), false, "au repos : 20 ms par image pour 30 % d'un cœur → une image toutes les 67 ms");
  assert.equal(pacer.due(t + 70, false), true);
  pacer.share(0.05); // budget commun serré (beaucoup d'Engrammes)
  assert.equal(pacer.due(t + 100, false), false);
  assert.equal(pacer.due(t + 126, false), true, "jamais moins de 8 images/s");
  assert.ok(pacer.steps(t + 126) >= 12, "assez de pas pour couvrir 126 ms");
  pacer.share(Number.NaN); // valeur invalide : ignorée
  pacer.reset();
  assert.equal(pacer.due(t + 500, false), true);
});

test("halos pré-rendus (Worker) : une image par couleur, posée à chaque bulle", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 5 });
  const { canvas, ctx, calls } = fakeCanvas();
  let sprites = 0;
  const makeCanvas = () => { sprites += 1; return fakeCanvas().canvas; };
  const r = R.createRenderer({ canvas, ctx, sim, data: demo, reduced: false, makeCanvas, rng: P.rng, seed: 5, sprites: true });
  r.resize(W, H, 1);
  r.tick(0);
  const afterFirst = sprites;
  for (let t = 16; t < 400; t += 16) r.tick(t);
  assert.ok(calls.drawImage > demo.nodes.length, "halos posés en images");
  assert.ok(afterFirst <= 24, `une image par couleur (${afterFirst})`);
  assert.equal(sprites, afterFirst, "réutilisées d'une image à l'autre (aucune nouvelle toile)");
});
