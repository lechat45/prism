// Atmosphère du Nexus (engine/nexus/atmosphere.js) : repli 2D, demi-résolution, cycle météo, pause et image figée.
// node --test frontend/tests/atmosphere.test.cjs
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Node n'a ni DOM ni boucle d'affichage : le strict nécessaire, piloté par le test.
let frames = [];
let clock = 1000;
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
const { PrismAtmosphere } = require("../engine/nexus/atmosphere.js");

/** Contexte 2D factice : compte les lueurs peintes. */
function fake2d() {
  const calls = { fillRect: 0, clearRect: 0 };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createRadialGradient") return () => ({ addColorStop() {} });
      if (key in calls) return () => { calls[key] += 1; };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return { ctx, calls };
}
function canvas({ webgl = null } = {}) {
  const two = fake2d();
  const c = {
    clientWidth: 800, clientHeight: 400, width: 0, height: 0, style: {}, two, parentNode: null,
    getContext: (kind) => (kind === "webgl" ? webgl : two.ctx),
    cloneNode: () => canvas(),
  };
  return c;
}
const lights = () => [
  { x: 100, y: 100, r: 60, color: [0.5, 0.86, 1], i: 1 },
  { x: 500, y: 300, r: 80, color: [0.98, 0.44, 0.52], i: 1.2 },
];
const runFrame = (now) => { const due = frames; frames = []; due.forEach((cb) => cb(now)); };

test("sans WebGL : lueurs en dégradés 2D, une par bulle, à demi-résolution", () => {
  frames = [];
  const c = canvas();
  const a = PrismAtmosphere.create(c, { lights });
  assert.equal(a.mode, "2d");
  a.frame();
  assert.equal(c.two.calls.fillRect, 2);
  assert.deepEqual([c.width, c.height], [400, 200]);
  a.destroy();
});

test("WebGL qui échoue à la compilation : repli 2D sur une toile neuve", () => {
  frames = [];
  const broken = new Proxy({}, { get: (t, k) => (k === "createShader" || k === "createProgram" ? () => { throw new Error("pilote"); } : () => ({})) });
  const c = canvas({ webgl: broken });
  let replaced = null;
  c.parentNode = { replaceChild: (fresh) => { replaced = fresh; } };
  const a = PrismAtmosphere.create(c, { lights });
  assert.equal(a.mode, "2d");
  assert.ok(replaced, "la toile au contexte WebGL est remplacée");
  a.frame();
  assert.equal(replaced.two.calls.fillRect, 2);
  a.destroy();
});

test("une image datée d'avant la création (rAF) ne casse pas le cycle météo", () => {
  frames = [];
  clock = 5000;
  const a = PrismAtmosphere.create(canvas(), { lights });
  assert.doesNotThrow(() => runFrame(4900));
  assert.ok(PrismAtmosphere.WEATHERS.includes(a.weather()));
  a.destroy();
});

test("météo fixe, cycle automatique ; coupée : toile masquée ; animations réduites : une image figée", () => {
  frames = [];
  const c = canvas();
  const a = PrismAtmosphere.create(c, { lights });
  a.set({ weather: "orage" });
  a.frame();
  assert.equal(a.weather(), "orage");
  a.set({ weather: "auto" });
  clock += 80 * 1000; // une météo dure 75 s
  runFrame(clock);
  assert.ok(PrismAtmosphere.WEATHERS.includes(a.weather()));
  a.set({ enabled: false });
  assert.equal(c.style.display, "none");
  frames = [];
  const before = c.two.calls.fillRect;
  a.set({ enabled: true, reduced: true });
  assert.equal(c.two.calls.fillRect, before + 2, "une image tout de suite");
  assert.equal(frames.length, 0, "puis plus rien à animer");
  a.destroy();
});
