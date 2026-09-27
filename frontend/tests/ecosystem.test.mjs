// Tests de l'« Écosystème vivant » (V5) : confusion du pointeur (js/confusion.js) et sédimentation (js/sediment.js).
// Lancement : node --test frontend/tests/ecosystem.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { analyzePointer, CONFUSION, ConfusionWatcher } from "../js/confusion.js";
import { CELL, cellOf, keywordsOf, MAX_GHOST, MAX_USES, SedimentStore } from "../js/sediment.js";
import { tasks } from "../js/tasks.js";

/** Pointeur qui tourne autour de (cx, cy), un échantillon toutes les 33 ms (cadence du prélude). */
function circles({ seconds = 6, radius = 70, turnsPerSecond = 0.6, cx = 200, cy = 180, t0 = 0 } = {}) {
  const out = [];
  for (let t = 0; t <= seconds * 1000; t += 33) {
    const a = (t / 1000) * turnsPerSecond * 2 * Math.PI;
    out.push({ t: t0 + t, x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return out;
}

/** Trajet rectiligne d'un bord à l'autre, en aller-retour : quelqu'un qui parcourt le widget. */
function sweep({ seconds = 6, width = 900, t0 = 0 } = {}) {
  const out = [];
  for (let t = 0; t <= seconds * 1000; t += 33) {
    const phase = (t / 1500) % 2;
    out.push({ t: t0 + t, x: 20 + width * (phase < 1 ? phase : 2 - phase), y: 200 + (t % 400) / 40 });
  }
  return out;
}

const endOf = (samples) => samples[samples.length - 1].t;

test("confusion : des cercles pendant plus de 5 s sans clic", () => {
  const samples = circles();
  const verdict = analyzePointer(samples, [], endOf(samples) + 100);
  assert.equal(verdict.confused, true);
  assert.equal(verdict.reason, "circles");
  assert.ok(verdict.turns >= CONFUSION.MIN_TURNS, `tours : ${verdict.turns}`);
  assert.ok(verdict.duration >= CONFUSION.WINDOW_MS);
});

test("confusion : errance rapide dans une petite zone", () => {
  // Zigzags sur 200 px : aucun tour complet, mais 1 500 px parcourus au même endroit.
  const samples = [];
  for (let t = 0; t <= 6000; t += 33) samples.push({ t, x: 100 + ((t / 5) % 200), y: 100 + ((t / 7) % 120) });
  const verdict = analyzePointer(samples, [], 6050);
  assert.equal(verdict.confused, true);
  assert.equal(verdict.reason, "wander");
});

test("confusion : pas d'alerte trop tôt, après un clic, à l'arrêt, ni pour un simple parcours", () => {
  const short = circles({ seconds: 4 });
  assert.equal(analyzePointer(short, [], endOf(short) + 50).confused, false, "moins de 5 s");
  const long = circles();
  assert.equal(analyzePointer(long, [3000], endOf(long) + 50).confused, false, "clic il y a moins de 5 s");
  assert.equal(analyzePointer(long, [], endOf(long) + 2000).confused, false, "pointeur immobile depuis 2 s");
  const across = sweep();
  assert.equal(analyzePointer(across, [], endOf(across) + 50).confused, false, "parcours large");
  // Une pause (lecture) coupe la série : 3 s + pause de 2 s + 3 s ≠ 5 s continues.
  const paused = [...circles({ seconds: 3 }), ...circles({ seconds: 3, t0: 5000 })];
  assert.equal(analyzePointer(paused, [], endOf(paused) + 50).confused, false, "pause");
  assert.equal(analyzePointer([], [], 1000).confused, false);
  assert.equal(analyzePointer(null, null ?? [], 1000).confused, false);
});

test("confusion : mesures d'hésitation et de vitesse", () => {
  const samples = circles({ turnsPerSecond: 0.5 });
  const verdict = analyzePointer(samples, [], endOf(samples));
  assert.ok(verdict.speed > 150 && verdict.speed < 300, `vitesse ${verdict.speed}`); // 2π·70·0,5 ≈ 220 px/s
  assert.ok(verdict.hesitation < 0.1);
  const still = circles({ turnsPerSecond: 0.05, radius: 20 }); // ~6 px/s : hésitation
  assert.ok(analyzePointer(still, [], endOf(still)).hesitation > 0.9);
});

test("ConfusionWatcher : une alerte, puis délai de grâce ; un clic remet à zéro", async () => {
  let now = 0;
  const alerts = [];
  const watcher = new ConfusionWatcher({
    analyze: (samples, clicks, at) => tasks.confusion({ samples, clicks, now: at }), // même chemin que le Worker
    onConfused: (id, verdict) => alerts.push([id, verdict.reason]),
    now: () => now, setTimer: () => 1, clearTimer: () => {},
  });
  const feed = (id, samples) => {
    for (const p of samples) {
      now = p.t;
      watcher.pointer(id, p.x, p.y);
    }
  };
  feed("a", circles({ seconds: 3 }));
  await watcher.tick();
  assert.deepEqual(alerts, []);
  feed("a", circles({ seconds: 3, t0: 3033 }));
  await watcher.tick();
  assert.deepEqual(alerts, [["a", "circles"]]);
  feed("a", circles({ seconds: 7, t0: 7000 }));
  await watcher.tick();
  assert.equal(alerts.length, 1, "délai de grâce de 10 min");

  feed("b", circles({ seconds: 4, t0: 20000 }));
  watcher.click("b");
  feed("b", circles({ seconds: 3, t0: 24100 }));
  await watcher.tick();
  assert.equal(alerts.length, 1, "le clic a remis la série à zéro");

  watcher.enabled = false;
  feed("c", circles({ seconds: 7, t0: 30000 }));
  await watcher.tick();
  assert.equal(alerts.length, 1, "détection désactivée");
});

test("sédiments : mots-clés sans mots vides", () => {
  assert.deepEqual(keywordsOf("Tracker d'humeur", "Crée-moi un tracker d'humeur quotidien avec un graphique"), ["tracker", "humeur", "quotidien", "graphique"]);
  assert.deepEqual(keywordsOf("Engramme · Marie Curie", "Engramme : Marie Curie"), ["marie", "curie"]);
  assert.deepEqual(keywordsOf("Météo", "météo meteo 2024 à Paris"), ["météo", "paris"]);
  assert.equal(keywordsOf("un deux trois quatre cinq six sept huit neuf dix").length, 6);
  assert.deepEqual(keywordsOf("", null, undefined), []);
});

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}

test("sédiments : grille spatiale, contexte fantôme et usure", () => {
  assert.equal(cellOf(10, 10), "0:0");
  assert.equal(cellOf(CELL + 1, -1), "1:-1");
  const store = new SedimentStore(memoryStorage());
  assert.equal(store.deposit({ id: "vide", x: 0, y: 0, words: [] }), null);
  store.deposit({ id: "a", x: 100, y: 100, words: ["humeur", "tracker"], title: "Humeur" });
  store.deposit({ id: "b", x: 300, y: 200, words: ["graphique", "humeur"] });
  store.deposit({ id: "loin", x: 2000, y: 100, words: ["budget"] });
  const ghost = store.ghostAt(240, 240);
  assert.deepEqual(ghost.words, ["graphique", "humeur", "tracker"], "plus récents d'abord, sans doublon");
  assert.deepEqual(ghost.ids.sort(), ["a", "b"]);
  assert.equal(store.ghostAt(CELL * 3 + 5, 5), null, "autre case : rien");
  for (let i = 1; i < MAX_USES; i += 1) assert.deepEqual(store.consume(ghost.ids), []);
  assert.deepEqual(store.consume(ghost.ids).sort(), ["a", "b"], `effacés après ${MAX_USES} usages`);
  assert.equal(store.ghostAt(240, 240), null);
  assert.deepEqual(store.all().map((s) => s.id), ["loin"]);
  store.remove("loin");
  assert.deepEqual(store.all(), []);
});

test("sédiments : au plus MAX_GHOST mots, stockage abîmé ou absent", () => {
  const storage = memoryStorage();
  const store = new SedimentStore(storage);
  for (let i = 0; i < 5; i += 1) store.deposit({ id: `s${i}`, x: 10, y: 10, words: [`mot${i}a`, `mot${i}b`, `mot${i}c`] });
  assert.equal(store.ghostAt(10, 10).words.length, MAX_GHOST);
  storage.setItem("prism:sediments", "{pas du json");
  assert.deepEqual(store.all(), []);
  const none = new SedimentStore(null);
  assert.deepEqual(none.all(), []);
  assert.equal(none.deposit({ id: "x", x: 1, y: 1, words: ["ok"] }).cell, "0:0"); // pas d'exception
  store.clear();
  assert.deepEqual(store.all(), []);
});
