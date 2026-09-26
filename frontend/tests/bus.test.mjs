// Tests du bus d'évènements entre widgets (js/bus.js) et du tracé des liaisons (js/links.js).
// Lancement : node --test frontend/tests/bus.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Bus, isTopic, MAX_EVENT_BYTES, preview, scanTopics } from "../js/bus.js";
import { curve } from "../js/links.js";

function setup() {
  const cards = new Map();
  const sent = []; // [id carte, message]
  const flows = [];
  const floods = [];
  const bus = new Bus({
    cards: () => cards.values(),
    post: (card, message) => sent.push([card.id, message]),
    onFlow: (from, to, topic) => flows.push(`${from.id}>${to.id}:${topic}`),
    onFlood: (card) => floods.push(card.id),
  });
  const add = (id, html = "") => {
    const card = { id, title: `Carte ${id}`, html, x: 0, y: 0, w: 300, h: 200 };
    cards.set(id, card);
    return card;
  };
  return { bus, cards, sent, flows, floods, add };
}

test("sujets : format, lecture dans le code, aperçu", () => {
  for (const ok of ["sales.region.selected", "todo:count", "a", "Timer-1"]) assert.ok(isTopic(ok), ok);
  for (const bad of ["", ".a", "a b", "é", "x".repeat(65), 42, null, "*"]) assert.equal(isTopic(bad), false, String(bad));
  const html = `<script>prism.emit("a.b", 1); window.prism . emit( 'c.d' , {}); prism.on("e.f", f); prism.on("*", g);
    prism.emit(topicVariable, 2); prism.emit("pas valide !", 3);</script>`;
  assert.deepEqual(scanTopics(html), { emits: ["a.b", "c.d"], listens: ["e.f", "*"] });
  assert.equal(preview({ region: "Nord" }), '{"region":"Nord"}');
  assert.equal(preview("x".repeat(500), 20).length, 20);
  assert.equal(preview(undefined), "null");
});

test("relais : seulement aux abonnés, jamais à l'émetteur, avec le titre de la source", () => {
  const { bus, sent, flows, add } = setup();
  const a = add("A");
  const b = add("B");
  const c = add("C");
  bus.subscribe(b, "sales.region");
  bus.subscribe(a, "sales.region"); // l'émetteur est abonné à son propre sujet : pas d'écho
  const delivered = bus.emit(a, "sales.region", { region: "Nord" });
  assert.equal(delivered, 1);
  assert.deepEqual(sent, [["B", { prism: "event", topic: "sales.region", data: { region: "Nord" }, from: { title: "Carte A" } }]]);
  assert.deepEqual(flows, ["A>B:sales.region"]);
  assert.deepEqual(a.topics, { emits: ["sales.region"], listens: ["sales.region"] });
  assert.equal(c.topics, undefined, "C n'a rien fait");
  assert.deepEqual(a.busStats["sales.region"], { count: 1, last: '{"region":"Nord"}' });
});

test("abonnement « * » et rejeu de la dernière valeur au nouvel abonné", () => {
  const { bus, sent, add } = setup();
  const a = add("A");
  const b = add("B");
  bus.emit(a, "t.one", 1);
  bus.emit(a, "t.two", 2);
  bus.emit(a, "t.one", 3);
  bus.subscribe(b, "t.one");
  assert.deepEqual(sent.map(([, m]) => [m.topic, m.data, m.replay]), [["t.one", 3, true]]);
  sent.length = 0;
  bus.subscribe(b, "*");
  assert.deepEqual(sent.map(([, m]) => m.topic).sort(), ["t.one", "t.two"]);
  sent.length = 0;
  bus.subscribe(b, "t.two", false);
  assert.equal(sent.length, 0, "replay: false");
  bus.emit(a, "t.three", "x");
  assert.deepEqual(sent.map(([id, m]) => [id, m.topic]), [["B", "t.three"]], "« * » reçoit tout");
});

test("données refusées : sujet invalide, non sérialisable, trop lourde ; carte isolée", () => {
  const { bus, sent, add } = setup();
  const a = add("A");
  const b = add("B");
  bus.subscribe(b, "*");
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(bus.emit(a, "bad topic", 1), 0);
  assert.equal(bus.emit(a, "ok", cyclic), 0);
  assert.equal(bus.emit(a, "ok", "x".repeat(MAX_EVENT_BYTES)), 0);
  b.busMuted = true;
  assert.equal(bus.emit(a, "ok", 1), 0, "destinataire isolé");
  b.busMuted = false;
  a.busMuted = true;
  assert.equal(bus.emit(a, "ok", 1), 0, "émetteur isolé");
  assert.equal(sent.length, 0);
});

test("débit plafonné : une boucle infinie est coupée et signalée une fois", () => {
  const { bus, floods, add } = setup();
  const a = add("A");
  const b = add("B");
  bus.subscribe(b, "loop");
  let delivered = 0;
  for (let i = 0; i < 500; i++) delivered += bus.emit(a, "loop", i);
  assert.ok(delivered >= 30 && delivered < 100, `${delivered} livrés sur 500`);
  assert.deepEqual(floods, ["A"]);
});

test("nouveau document : abonnements repartis de zéro ; carte fermée : valeurs retenues oubliées", () => {
  const { bus, sent, add } = setup();
  const a = add("A");
  const b = add("B");
  bus.subscribe(b, "x");
  bus.reset(b);
  bus.emit(a, "x", 1);
  assert.equal(sent.length, 0);
  bus.drop(a);
  bus.subscribe(b, "x");
  assert.equal(sent.length, 0, "la valeur de A a disparu avec A");
});

test("liaisons et contexte du modèle", () => {
  const { bus, cards, add } = setup();
  const a = add("A", `<script>prism.emit("sales.region", r)</script>`);
  const b = add("B", `<script>prism.on("sales.region", f)</script>`);
  const c = add("C", `<script>prism.on("*", f)</script>`);
  add("D", "<p>muet</p>");
  for (const card of cards.values()) bus.learn(card);
  bus.emit(a, "sales.region", { region: "Sud" });
  assert.deepEqual(bus.links().map((l) => `${l.from.id}>${l.to.id}:${l.topics}`), ["A>B:sales.region", "A>C:sales.region"]);
  const ctx = bus.context(b);
  assert.deepEqual(ctx, [
    { title: "Carte A", emits: ["sales.region"], listens: [], samples: { "sales.region": '{"region":"Sud"}' } },
    { title: "Carte C", emits: [], listens: ["*"], samples: {} },
  ]);
  c.busMuted = true;
  assert.equal(bus.links().find((l) => l.to === c).muted, true);
});

test("courbe de liaison : du bord de l'émetteur au bord en vis-à-vis", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  assert.match(curve(a, { x: 300, y: 0, w: 100, h: 100 }), /^M100,50 C.* 300,50$/);
  assert.match(curve(a, { x: -300, y: 0, w: 100, h: 100 }), /^M0,50 C.* -200,50$/);
  assert.match(curve(a, { x: 0, y: 400, w: 100, h: 100 }), /^M50,100 C.* 50,400$/);
});
