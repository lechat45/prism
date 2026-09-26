// Paramètres (roue dentée de la barre du haut) : un seul endroit pour le compte, « Mes écrits » (conversations
// avec les Engrammes, demandes, export), le moteur de génération et la version.

import { account, onAccountChange, signOut } from "./account.js";
import { engine, onEngineChange, readKey } from "./engine.js";

const $ = (id) => document.getElementById(id);
const REPO = "https://github.com/lechat45/prism";
let hooks = null; // { cards(), engramOf(card), openChat(card), focusCard(card), openHub(), openPro(), openAuth(), openSettings(), toast }
let tab = "account";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (label, onClick, className = "tool") => {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
};
const row = (...children) => {
  const r = el("div", "row wrap");
  r.append(...children);
  return r;
};
const fact = (label, value) => {
  const p = el("p", "prefs-fact");
  p.append(el("span", "prefs-label", label), el("strong", "", value));
  return p;
};
const sparks = (value) => `${String(Math.round(value * 100) / 100).replace(".", ",")} Spark${value > 1 ? "s" : ""}`;
const version = () => $("app-version").textContent.trim();

function accountPanel() {
  const panel = [];
  if (engine.kind !== "server") {
    panel.push(el("p", "hint", engine.waking
      ? "Le serveur Prism se réveille (hébergement gratuit, environ une minute) : les comptes arrivent dans un instant."
      : "Les comptes (Sparks, Mon Hub, synchronisation entre appareils) fonctionnent quand le serveur Prism est en ligne. Ici, Prism utilise le moteur du navigateur."));
    return panel;
  }
  if (!account.user) {
    panel.push(el("p", "hint", `Créez un compte (${sparks(account.signupSparks)} offerts) ou connectez-vous pour générer, garder vos widgets dans Mon Hub et discuter avec les Engrammes.`));
    panel.push(row(button("Se connecter", () => { close(); hooks.openAuth(); }, "cta cta-small")));
    return panel;
  }
  const prices = account.pricing || {};
  panel.push(fact("Compte", account.user.email), fact("Solde", sparks(account.user.sparks)));
  panel.push(el("p", "fine", [
    `Widget : ${sparks(prices.generate ?? 1)}`, `refactorisation : ${sparks(prices.refactor ?? 0.5)}`,
    prices.engram !== undefined ? `Engramme : ${sparks(prices.engram)}` : "",
    prices.engram_chat !== undefined ? `message à un Engramme : ${sparks(prices.engram_chat)}` : "",
  ].filter(Boolean).join(" · ")));
  panel.push(row(
    button("Mon Hub", () => { close(); hooks.openHub(); }),
    button("Prism Pro", () => { close(); hooks.openPro(); }),
    button("Se déconnecter", () => { signOut(); hooks.toast("Déconnecté"); render(); }, "tool danger"),
  ));
  return panel;
}

function writingsPanel() {
  const cards = [...hooks.cards()];
  const panel = [];
  const talks = cards.filter((card) => card.chat?.length && hooks.engramOf(card));
  panel.push(el("h3", "prefs-sub", "Conversations"));
  if (!talks.length) panel.push(el("p", "fine", "Aucune conversation : ouvrez un Engramme et cliquez « Discuter avec … »."));
  const list = el("ul", "prefs-list");
  for (const card of talks) {
    const person = hooks.engramOf(card).person;
    const last = [...card.chat].reverse().find((m) => m.role === "user");
    const item = el("li", "prefs-item");
    const text = el("div", "prefs-item-text");
    text.append(el("strong", "", person), el("span", "", `${card.chat.length} message${card.chat.length > 1 ? "s" : ""}${last ? ` · « ${last.text.slice(0, 70)}${last.text.length > 70 ? "…" : ""} »` : ""}`));
    item.append(text, button("Reprendre", () => { close(); hooks.openChat(card); }));
    list.append(item);
  }
  panel.push(list);

  const asked = cards.filter((card) => card.prompt && !hooks.engramOf(card));
  panel.push(el("h3", "prefs-sub", "Vos demandes"));
  if (!asked.length) panel.push(el("p", "fine", "Vos demandes de widgets apparaîtront ici."));
  const prompts = el("ul", "prefs-list");
  for (const card of asked.slice(-30).reverse()) {
    const item = el("li", "prefs-item");
    const text = el("div", "prefs-item-text");
    text.append(el("strong", "", card.title || "Sans titre"), el("span", "", card.prompt.slice(0, 110) + (card.prompt.length > 110 ? "…" : "")));
    item.append(text, button("Afficher", () => { close(); hooks.focusCard(card); }));
    prompts.append(item);
  }
  panel.push(prompts);
  panel.push(row(button("Tout exporter (.json)", () => exportWritings(cards))));
  panel.push(el("p", "fine", "Export : titres, demandes et conversations des cartes de ce canvas (sans les données des fichiers joints)."));
  return panel;
}

function exportWritings(cards) {
  const data = {
    prism: version(),
    exportedAt: new Date().toISOString(),
    cards: cards.map((card) => {
      const engram = hooks.engramOf(card);
      return {
        title: card.title, prompt: card.prompt, kind: engram ? "engramme" : "widget",
        ...(engram ? { person: engram.person } : {}), ...(card.chat?.length ? { conversation: card.chat } : {}),
        createdAt: card.createdAt ? new Date(card.createdAt).toISOString() : null,
      };
    }),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `prism-mes-ecrits-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  hooks.toast(`Export : ${a.download}`);
}

function enginePanel() {
  const panel = [];
  if (engine.kind === "server") {
    const info = engine.info || {};
    panel.push(fact("Moteur", info.mode === "mock" ? "Serveur Prism, mode démo (sans clé)" : "Serveur Prism"));
    panel.push(fact("Modèles", (info.models || []).join(" → ") || "—"));
    panel.push(el("p", "fine", "Les clés Gemini sont celles du serveur : elles ne quittent jamais le serveur et servent à tour de rôle (une clé au quota passe la main à la suivante)."));
  } else {
    const keys = readKey().split(",").map((k) => k.trim()).filter(Boolean);
    panel.push(fact("Moteur", engine.waking ? "Navigateur (serveur en cours de réveil)" : "Navigateur"));
    panel.push(fact("Clé Gemini", keys.length ? `${keys.length} clé${keys.length > 1 ? "s" : ""} enregistrée${keys.length > 1 ? "s" : ""} dans ce navigateur` : "aucune : mode démo"));
    panel.push(row(button("Gérer la clé…", () => { close(); hooks.openSettings(); })));
  }
  return panel;
}

function aboutPanel() {
  const panel = [fact("Interface", version())];
  if (engine.kind === "server" && engine.info?.version) panel.push(fact("Serveur", engine.info.version));
  panel.push(el("p", "fine", "Prism génère des interfaces éphémères sur un canvas spatial. Les Engrammes cognitifs sont des portraits interprétatifs générés par IA d'après des sources publiques ; leurs conversations sont des simulations, jamais la personne."));
  const links = el("p", "prefs-links");
  for (const [label, href] of [["Code source", REPO], ["Nouveautés", `${REPO}/blob/v3/CHANGELOG.md`], ["Déployer", `${REPO}/blob/v3/DEPLOY.md`]]) {
    const a = el("a", "", label);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    links.append(a);
  }
  panel.push(links);
  return panel;
}

const PANELS = { account: accountPanel, writings: writingsPanel, engine: enginePanel, about: aboutPanel };

function render() {
  if (!$("prefs").open) return;
  document.querySelectorAll("#prefs [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
  $("prefs-body").replaceChildren(...PANELS[tab]());
}

function close() {
  if ($("prefs").open) $("prefs").close();
}

export function openPrefs(which = null) {
  if (which) tab = which;
  if (!$("prefs").open) $("prefs").showModal();
  render();
}

export function initPrefs(options) {
  hooks = options;
  $("btn-prefs").addEventListener("click", () => openPrefs());
  $("prefs-close").addEventListener("click", close);
  $("prefs-tabs").addEventListener("click", (e) => {
    const t = e.target.closest("[role=tab]");
    if (!t) return;
    tab = t.dataset.tab;
    render();
  });
  $("prefs").addEventListener("click", (e) => { if (e.target === $("prefs")) close(); }); // clic sur le fond
  onAccountChange(() => render());
  onEngineChange(() => render());
}
