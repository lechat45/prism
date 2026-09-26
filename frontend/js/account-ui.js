// Interface du compte (mode serveur) : jauge de Sparks en anneau, menu du compte,
// fenêtre de connexion/inscription et fenêtre « Prism Pro ».

import { account, needsSignIn, onAccountChange, signIn, signOut } from "./account.js";

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const plural = (n, word) => `${nf.format(n)} ${word}${Math.abs(n) >= 2 ? "s" : ""}`;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

let notify = () => {};
let pending = null; // action à reprendre après connexion (ex. la génération demandée)
let authMode = "login";

// --------------------------------------------------------------------------
// Barre du haut : bouton « Se connecter » ou anneau de Sparks
// --------------------------------------------------------------------------
function render(state, change = {}) {
  $("account").hidden = !state.enabled;
  if (!state.enabled) return;
  const user = state.user;
  $("btn-login").hidden = Boolean(user);
  $("sparks").hidden = !user;
  if (!user) {
    $("account-menu").hidePopover?.();
    return;
  }
  const sparks = user.sparks;
  // Anneau plein = le cadeau de bienvenue ; au-delà (achats futurs), il reste plein.
  const ratio = Math.max(0, Math.min(1, sparks / Math.max(state.signupSparks, 1)));
  $("ring-value").style.strokeDashoffset = String(100 - ratio * 100);
  const level = sparks < state.pricing.generate ? "empty" : ratio <= 0.2 ? "low" : "ok";
  $("sparks").dataset.level = level;
  $("sparks-count").textContent = nf.format(sparks);
  const prices = `génération ${plural(state.pricing.generate, "Spark")} · refactorisation ${plural(state.pricing.refactor, "Spark")}`;
  $("sparks").title = `${plural(sparks, "Spark")} restant${sparks >= 2 ? "s" : ""} · ${prices}`;
  $("sparks").setAttribute("aria-label", `${plural(sparks, "Spark")}, menu du compte`);
  $("account-email").textContent = user.email;
  $("account-sparks").textContent = `${plural(sparks, "Spark")}`;
  $("account-pricing").textContent = prices;
  if (change.delta) showDelta(change.delta);
}

function showDelta(delta) {
  const el = $("sparks-delta");
  el.textContent = `${delta > 0 ? "+" : "−"}${nf.format(Math.abs(delta))}`;
  el.dataset.sign = delta > 0 ? "up" : "down";
  el.classList.remove("is-shown");
  void el.offsetWidth; // relance l'animation
  el.classList.add("is-shown");
}

function placeMenu() {
  const r = $("sparks").getBoundingClientRect();
  const menu = $("account-menu");
  menu.style.top = `${Math.round(r.bottom + 10)}px`;
  menu.style.right = `${Math.round(innerWidth - r.right)}px`;
}

// --------------------------------------------------------------------------
// Connexion / inscription
// --------------------------------------------------------------------------
function setMode(mode) {
  authMode = mode;
  const register = mode === "register";
  $("tab-login").setAttribute("aria-selected", String(!register));
  $("tab-register").setAttribute("aria-selected", String(register));
  $("auth-password").autocomplete = register ? "new-password" : "current-password";
  $("auth-password-hint").hidden = !register;
  $("auth-gift").hidden = !register;
  $("auth-gift").textContent = `${plural(account.signupSparks, "Spark")} offerts : ${plural(account.signupSparks / account.pricing.generate, "génération")} ou ${plural(account.signupSparks / account.pricing.refactor, "refactorisation")}.`;
  $("auth-submit").querySelector(".cta-label").textContent = register ? "Créer mon compte" : "Se connecter";
  showError("");
}

function showError(message) {
  $("auth-error").textContent = message;
  $("auth-error").hidden = !message;
}

/** Ouvre la fenêtre ; then() est rappelé après une connexion réussie. */
export function openAuth({ mode = "login", reason = "", then = null } = {}) {
  pending = then;
  $("auth-reason").textContent = reason || "Connectez-vous pour générer vos widgets.";
  setMode(mode);
  $("auth-password").value = "";
  if (!$("auth").open) $("auth").showModal();
  $("auth-email").focus();
}

/** Vrai si l'action peut partir ; sinon ouvre la connexion et la reprendra ensuite. */
export function requireAccount(then, reason) {
  if (!needsSignIn()) return true;
  openAuth({ mode: "register", reason, then });
  return false;
}

async function submitAuth(e) {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  if (!EMAIL_RE.test(email)) return showError("Adresse e-mail invalide."), $("auth-email").focus();
  if (password.length < 8) return showError("Mot de passe : 8 caractères minimum."), $("auth-password").focus();
  const button = $("auth-submit");
  button.disabled = true;
  showError("");
  try {
    const user = await signIn(authMode, email, password, $("auth-remember").checked);
    const then = pending;
    pending = null;
    $("auth-password").value = "";
    $("auth").close();
    notify(authMode === "register" ? `Bienvenue ! ${plural(user.sparks, "Spark")} offerts.` : `Connecté : ${user.email}`);
    then?.();
  } catch (err) {
    if (err.code === "email_taken") {
      setMode("login");
      showError("Un compte existe déjà avec cet e-mail : connectez-vous.");
    } else {
      showError(err.message);
    }
  } finally {
    button.disabled = false;
  }
}

// --------------------------------------------------------------------------
// Prism Pro
// --------------------------------------------------------------------------
/** detail : réponse 403 insufficient_sparks ({ sparks, required }) ou rien (ouverture depuis le menu). */
export function openPro(detail = null) {
  const sparks = detail && Number.isFinite(detail.sparks) ? detail.sparks : account.user?.sparks;
  const required = detail && Number.isFinite(detail.required) ? detail.required : null;
  const exhausted = required !== null && sparks < required;
  $("pro-title").textContent = exhausted ? "Vos Sparks sont épuisés" : "Prism Pro";
  $("pro-reason").textContent = exhausted
    ? `Il vous reste ${plural(sparks, "Spark")} : cette action en demande ${nf.format(required)}.`
    : `Solde actuel : ${plural(sparks ?? 0, "Spark")}.`;
  $("account-menu").hidePopover?.();
  if (!$("pro").open) $("pro").showModal();
  $("pro-close").focus();
}

// --------------------------------------------------------------------------
export function initAccountUi({ toast }) {
  notify = toast;
  onAccountChange(render);
  $("btn-login").addEventListener("click", () => openAuth({ mode: "login" }));
  $("tab-login").addEventListener("click", () => setMode("login"));
  $("tab-register").addEventListener("click", () => setMode("register"));
  $("auth-form").addEventListener("submit", submitAuth);
  $("auth-cancel").addEventListener("click", () => {
    pending = null;
    $("auth").close();
  });
  $("auth").addEventListener("close", () => { pending = null; });
  $("account-menu").addEventListener("toggle", (e) => {
    $("sparks").setAttribute("aria-expanded", String(e.newState === "open"));
  });
  $("account-menu").addEventListener("beforetoggle", (e) => {
    if (e.newState === "open") placeMenu();
  });
  $("btn-pro").addEventListener("click", () => openPro());
  $("btn-logout").addEventListener("click", () => {
    $("account-menu").hidePopover?.();
    signOut();
    notify("Déconnecté");
  });
  $("pro-close").addEventListener("click", () => $("pro").close());
  render(account);
}
