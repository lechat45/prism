// Tests du moteur physique de l'Engramme (engine/engram/physics.js).  node --test frontend/tests/engram.test.cjs
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../engine/engram/physics.js");
const demo = require("../engine/engram/demo-marie-curie.json");

const W = 760;
const H = 560;
const EDGE = 26;
const run = (sim, seconds) => { const end = sim.time + seconds; while (sim.time < end) sim.advance(1 / 60); };
const core = (sim) => sim.nodes.find((n) => n.category === "core");
const of = (sim, cat) => sim.nodes.filter((n) => n.category === cat);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Distance au noyau rapportée à l'ellipse inscrite : 1 = bord de la zone (moins la marge). */
function ring(sim, n) {
  const c = core(sim);
  const dx = n.x - c.x;
  const dy = n.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  const a = W / 2 - EDGE;
  const b = H / 2 - EDGE;
  return d / ((a * b) / Math.hypot((b * dx) / d, (a * dy) / d));
}
const speed = (n) => Math.hypot(n.vx, n.vy);

test("déterministe : même graine, mêmes trajectoires", () => {
  const a = P.createSimulation(demo, { width: W, height: H, seed: 11 });
  const b = P.createSimulation(demo, { width: W, height: H, seed: 11 });
  run(a, 3);
  run(b, 3);
  assert.deepEqual(a.nodes.map((n) => [n.x, n.y]), b.nodes.map((n) => [n.x, n.y]));
  const c = P.createSimulation(demo, { width: W, height: H, seed: 12 });
  run(c, 3);
  assert.notDeepEqual(a.nodes.map((n) => [n.x, n.y]), c.nodes.map((n) => [n.x, n.y]));
});

test("A. le noyau reste au centre (masse énorme, rappel raide)", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 3 });
  for (let t = 0; t < 10; t++) {
    run(sim, 1);
    const c = core(sim);
    assert.ok(Math.hypot(c.x - W / 2, c.y - H / 2) < 2, `noyau à ${Math.round(c.x)},${Math.round(c.y)}`);
  }
});

test("anneaux : moteurs proches, ombres au milieu, artefacts au loin", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 3 });
  run(sim, 6);
  const samples = { engine: [], shadow: [], artifact: [] };
  for (let i = 0; i < 20; i++) {
    run(sim, 0.5);
    for (const cat of Object.keys(samples)) samples[cat].push(mean(of(sim, cat).map((n) => ring(sim, n))));
  }
  const r = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, mean(v)]));
  assert.ok(r.engine < r.shadow && r.shadow < r.artifact, JSON.stringify(r));
  for (const [cat, target] of Object.entries({ engine: 0.44, shadow: 0.68, artifact: 0.92 })) {
    assert.ok(Math.abs(r[cat] - target) < target * 0.25, `${cat} : ${r[cat].toFixed(2)} pour ${target}`);
  }
});

test("B/C/D. moteurs sages, ombres erratiques, artefacts rapides", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 5 });
  run(sim, 6);
  const v = { engine: [], shadow: [], artifact: [] };
  for (let i = 0; i < 40; i++) {
    run(sim, 0.25);
    for (const cat of Object.keys(v)) v[cat].push(mean(of(sim, cat).map(speed)));
  }
  const s = Object.fromEntries(Object.entries(v).map(([k, xs]) => [k, mean(xs)]));
  assert.ok(s.engine < 30, `moteurs : ${s.engine.toFixed(0)} px/s`);
  assert.ok(s.shadow > s.engine * 3, `ombres : ${s.shadow.toFixed(0)} px/s`);
  assert.ok(s.artifact > s.shadow, `artefacts : ${s.artifact.toFixed(0)} px/s`);
  // Erratique = direction imprévisible : la vitesse des ombres change beaucoup d'un instant à l'autre.
  const spread = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
  assert.ok(spread(v.shadow) > spread(v.engine), "ombres plus irrégulières que les moteurs");
});

test("aucun chevauchement ; les ombres se repoussent entre elles", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 9 });
  run(sim, 4);
  for (let i = 0; i < 30; i++) {
    run(sim, 0.3);
    for (let a = 0; a < sim.nodes.length; a++) {
      for (let b = a + 1; b < sim.nodes.length; b++) {
        const n = sim.nodes[a];
        const m = sim.nodes[b];
        const d = Math.hypot(n.x - m.x, n.y - m.y);
        assert.ok(d > (n.r + m.r) * 0.8, `${n.id}/${m.id} à ${d.toFixed(1)} px`);
        if (n.category === "shadow" && m.category === "shadow") assert.ok(d > n.r + m.r + 8, `ombres ${n.id}/${m.id} collées`);
      }
    }
  }
});

test("le pointeur fait fuir les ombres, pas les moteurs", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 4 });
  run(sim, 4);
  // Pointeur immobile posé à 20 px d'une bulle : où en est-elle une seconde plus tard ?
  const after = (node) => {
    const px = node.x + 20;
    const py = node.y;
    sim.setPointer(px, py);
    run(sim, 1);
    sim.setPointer(null);
    return Math.hypot(node.x - px, node.y - py);
  };
  // Même tirage sans pointeur, pour isoler l'effet de la répulsion.
  const twin = P.createSimulation(demo, { width: W, height: H, seed: 4 });
  run(twin, 4);
  const shadowIdx = sim.nodes.findIndex((n) => n.category === "shadow");
  const engineIdx = sim.nodes.findIndex((n) => n.category === "engine");
  const fled = after(sim.nodes[shadowIdx]);
  const px = twin.nodes[shadowIdx].x + 20;
  const py = twin.nodes[shadowIdx].y;
  run(twin, 1);
  const baseline = Math.hypot(twin.nodes[shadowIdx].x - px, twin.nodes[shadowIdx].y - py);
  assert.ok(fled > 80 && fled > baseline + 30, `ombre à ${fled.toFixed(0)} px du pointeur (sans pointeur : ${baseline.toFixed(0)} px)`);
  const engine = sim.nodes[engineIdx];
  const ex = engine.x;
  const ey = engine.y;
  after(engine);
  // Un moteur ne fuit pas : il suit seulement sa lente orbite (≈ 11 px/s).
  assert.ok(Math.hypot(engine.x - ex, engine.y - ey) < 40, "le moteur n'est pas repoussé");
});

test("survol : la bulle s'arrête et grossit, puis repart", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 2 });
  run(sim, 3);
  const n = of(sim, "artifact")[3];
  const before = [n.x, n.y];
  sim.setHover(n.id);
  run(sim, 1);
  assert.deepEqual([n.x, n.y], before, "immobile pendant le survol");
  assert.ok(Math.abs(n.r - n.baseR * 1.7) < 0.05, `rayon ${n.r.toFixed(2)} pour ${(n.baseR * 1.7).toFixed(2)}`);
  assert.equal(sim.nodeAt(n.x + n.r - 1, n.y), n, "trouvée sous le pointeur");
  sim.setHover(null);
  run(sim, 1);
  assert.notDeepEqual([n.x, n.y], before, "repart après le survol");
  assert.ok(Math.abs(n.r - n.baseR) < 0.1);
});

test("stable : 60 s, redimensionnements, aucune valeur aberrante, tout reste dans la zone", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 1 });
  let w = W;
  let h = H;
  for (let i = 0; i < 60; i++) {
    if (i === 20) { sim.resize(420, 640); w = 420; h = 640; }
    if (i === 40) { sim.resize(1200, 500); w = 1200; h = 500; }
    run(sim, 1);
    for (const n of sim.nodes) {
      assert.ok(Number.isFinite(n.x + n.y + n.vx + n.vy), `${n.id} : valeur aberrante`);
      assert.ok(n.x >= 0 && n.x <= w && n.y >= 0 && n.y <= h, `${n.id} hors zone (${n.x.toFixed(0)}, ${n.y.toFixed(0)})`);
      assert.ok(speed(n) < 2000, `${n.id} : ${speed(n).toFixed(0)} px/s`);
    }
  }
});

test("pas de bond après une longue pause (onglet en veille)", () => {
  const sim = P.createSimulation(demo, { width: W, height: H, seed: 1 });
  run(sim, 2);
  const t = sim.time;
  sim.advance(30); // 30 s d'un coup : plafonné
  assert.ok(sim.time - t <= 0.11);
});
