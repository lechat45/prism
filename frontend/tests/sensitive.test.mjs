// V5 « Écosystème sensitif » : portée des cartes (js/scope.js), aura sonore (js/aura.js), mode spatial (js/spatial.js).
// Lancement : node --test frontend/tests/sensitive.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Aura, SOUNDS } from "../js/aura.js";
import { Scope } from "../js/scope.js";
import { arcOf } from "../js/spatial.js";

test("portée d'une carte : écouteurs, minuteurs, URL de Blob et nettoyages défaits d'un coup", async () => {
  const scope = new Scope();
  const target = new EventTarget();
  let heard = 0;
  scope.on(target, "ping", () => { heard += 1; });
  target.dispatchEvent(new Event("ping"));
  let fired = 0;
  scope.timeout(() => { fired += 1; }, 5);
  const ticking = scope.interval(() => { fired += 100; }, 5);
  const url = scope.url(new Blob(["données"]));
  const order = [];
  scope.add(() => order.push("premier"));
  scope.add(() => order.push("second"));
  scope.add(() => { throw new Error("un nettoyage en échec n'arrête pas les autres"); });
  assert.ok(ticking);
  scope.dispose();
  target.dispatchEvent(new Event("ping"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(heard, 1, "écouteur retiré (AbortController)");
  assert.equal(fired, 0, "minuteurs annulés");
  assert.deepEqual(order, ["second", "premier"], "ordre inverse de l'ajout");
  await assert.rejects(fetch(url), "URL de Blob révoquée");
  assert.equal(scope.timers.size + scope.intervals.size + scope.urls.size + scope.cleanups.length, 0, "plus aucune référence");
  // Après la fin : rien ne s'installe, un nettoyage ajouté s'exécute aussitôt.
  scope.on(target, "ping", () => { heard += 1; });
  target.dispatchEvent(new Event("ping"));
  assert.equal(heard, 1);
  let late = false;
  scope.add(() => { late = true; });
  assert.equal(late, true);
  scope.dispose(); // idempotent
});

/** Contexte audio factice : compte les nœuds créés et les sons démarrés. */
function fakeAudio() {
  const log = { started: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect: (next) => next || node(), gain: param(), frequency: param(), Q: param(), type: "" });
  const ctx = {
    state: "running", currentTime: 0, sampleRate: 8000, destination: node(),
    createGain: node, createBiquadFilter: node,
    createOscillator: () => ({ ...node(), start() { log.started += 1; }, stop() {} }),
    createBuffer: (_c, length) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => ({ ...node(), start() { log.started += 1; } }),
    resume: async () => {}, suspend: async () => {},
  };
  return { ctx, log };
}

test("aura : silencieuse par défaut, sons espacés, chaque son se synthétise sans fichier", () => {
  const aura = new Aura();
  assert.equal(aura.play("link", 0), false, "désactivée par défaut");
  const { ctx, log } = fakeAudio();
  aura.enabled = true;
  aura.ctx = ctx;
  aura.master = ctx.createGain();
  assert.equal(aura.play("link", 1000), true);
  assert.equal(aura.play("link", 1100), false, "pas de rafale");
  assert.equal(aura.play("link", 1500), true);
  assert.equal(aura.play("shadow", 1500), true, "chaque évènement a son propre rythme");
  assert.equal(aura.play("inconnu", 1500), false);
  for (const kind of Object.keys(SOUNDS)) assert.doesNotThrow(() => SOUNDS[kind](ctx, aura.master, 0), kind);
  assert.ok(log.started >= 8, "oscillateurs et souffle démarrés");
  assert.deepEqual(aura.played.slice(0, 3), ["link", "link", "shadow"]);
  aura.setEnabled(false);
  assert.equal(aura.play("fusion", 9000), false);
});

test("mode spatial : arc symétrique, cartes du bord inclinées vers le centre et en retrait", () => {
  assert.deepEqual(arcOf(0), { tilt: -0, depth: -0, lift: 0 });
  const left = arcOf(-1);
  const right = arcOf(1);
  assert.ok(left.tilt > 0 && right.tilt < 0, "tournées vers vous");
  assert.equal(left.tilt, -right.tilt);
  assert.ok(left.depth < 0 && left.depth === right.depth, "en retrait");
  assert.deepEqual(arcOf(5), arcOf(1), "borné");
});
