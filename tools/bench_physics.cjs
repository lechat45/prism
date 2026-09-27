// Coût du moteur physique seul (engine/engram/physics.js), sans navigateur : temps moyen d'une image de 1/60 s.
// Usage : node tools/bench_physics.cjs [nombre de bulles…]   (défaut : 40 100 200 400)
"use strict";

const fs = require("fs");
const path = require("path");
const P = require("../frontend/engine/engram/physics.js");
const E = require("../frontend/engine/engram/engram.js");

const demo = E.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, "../frontend/engine/engram/demo-marie-curie.json"), "utf8")));

function synthetic(n) {
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

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const n of sizes.length ? sizes : [40, 100, 200, 400]) {
  const sim = P.createSimulation(synthetic(n), { width: 780, height: 560, seed: 7 });
  for (let i = 0; i < 120; i++) sim.advance(1 / 60); // chauffe (compilation, mise en place)
  sim.setPointer(390, 280);
  const frames = 600;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < frames; i++) sim.advance(1 / 60);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / frames;
  // Image lente (100 ms) : combien coûte le rattrapage ?
  const t1 = process.hrtime.bigint();
  sim.advance(0.1);
  const slow = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`${String(n).padStart(4)} bulles : ${ms.toFixed(3)} ms par image de 1/60 s · rattrapage d'une image de 100 ms : ${slow.toFixed(2)} ms`);
}
