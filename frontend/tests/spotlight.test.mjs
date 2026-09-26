// Tests du classement du Spotlight (js/spotlight.js) et des reflets (js/reflections.js).
// Lancement : node --test frontend/tests/spotlight.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { fold, rank, score } from "../js/spotlight.js";
import { glowAt } from "../js/reflections.js";

const item = (label, extra = {}) => ({ label, ...extra });

test("recherche insensible à la casse et aux accents", () => {
  assert.equal(fold("Écran Événement"), "ecran evenement");
  assert.ok(score("evenement", item("Bus d'évènements")) > 0);
  assert.ok(score("ÉVÈN", item("bus d'évènements")) > 0);
});

test("pertinence : exact > début > début de mot > mots > sous-séquence > rien", () => {
  const s = (q, label, extra) => score(q, item(label, extra));
  assert.equal(s("tout voir", "Tout voir"), 120);
  assert.equal(s("tout", "Tout voir"), 100);
  assert.equal(s("voir", "Tout voir"), 70);
  assert.equal(s("voir tout", "Tout voir"), 40);
  assert.equal(s("tv", "Tout voir"), 15);
  assert.equal(s("xyz", "Tout voir"), 0);
  assert.equal(s("cadrer", "Tout voir", { keywords: ["cadrer"] }), 120, "mots-clés");
});

test("classement : une commande bien nommée passe devant « Générer », sinon « Générer » d'abord", () => {
  const items = (q) => [
    item(`Générer « ${q} »`, { always: true, base: 50, id: "gen" }),
    item("Ranger les cartes", { id: "ranger" }),
    item("Tout voir", { id: "fit" }),
    item("Compteur de clics", { id: "card" }),
  ];
  assert.deepEqual(rank("ranger", items("ranger")).map((i) => i.id), ["ranger", "gen"]);
  assert.deepEqual(rank("un minuteur pomodoro", items("un minuteur pomodoro")).map((i) => i.id), ["gen"]);
  assert.equal(rank("compteur", items("compteur"))[0].id, "card");
});

test("requête vide : tout, selon la priorité donnée par le fournisseur, 12 au plus", () => {
  const many = Array.from({ length: 20 }, (_, i) => item(`n°${i}`, { base: i % 3, id: i }));
  const out = rank("", many);
  assert.equal(out.length, 12);
  assert.ok(out.every((x, i) => i === 0 || x.base <= out[i - 1].base));
});

test("reflets : éclat maximal sur la carte, nul au-delà de la portée, point en coordonnées de la carte", () => {
  const card = { x: 100, y: 50, w: 400, h: 300 };
  const view = { x: 20, y: 10, z: 0.5 }; // carte à l'écran : x 70→270, y 35→185
  assert.deepEqual(glowAt(card, view, 170, 60), { glow: 1, mx: 200, my: 50 });
  assert.equal(glowAt(card, view, 270 + 140, 100).glow, 0.5);
  assert.equal(glowAt(card, view, 2000, 2000).glow, 0);
});
