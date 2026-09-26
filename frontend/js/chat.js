// « Discuter avec … » (V4) : conversation avec la simulation d'une personnalité, fondée sur toutes les données
// écrites de son Engramme. Chaque réponse arrive avec sa trace logique (les bulles qui l'ont guidée, dans l'ordre du
// raisonnement) : ronds numérotés dans ce panneau, et sur la carte, où ils s'écrivent un à un.
// L'historique est gardé avec la carte (card.chat) ; les appels au modèle passent par la page (options.ask).

const $ = (id) => document.getElementById(id);
const HISTORY_MAX = 40;
const SUGGESTIONS = [
  "Qu'est-ce qui vous guide, au fond ?",
  "Quel moment a tout changé pour vous ?",
  "De quoi avez-vous le plus peur ?",
  "Comment attaquez-vous un problème difficile ?",
];
const CATEGORY_COLORS = { core: "#e8f1ff", heart: "#fb7185", engine: "#22d3ee", shadow: "#c026d3", artifact: "#fbbf24" };

export class EngramChat {
  /**
   * options.ask(card, history, message, signal) → Promise<{ reply, trace }> (vérifie compte et Sparks, lève une erreur
   * sinon) ; options.onTrace(card, trace) : montrer la trace sur la carte ([] l'efface) ; options.onSave(card) ;
   * options.onOpen() / options.onClose() ; options.toast(message, opts).
   */
  constructor(options) {
    this.o = options;
    this.card = null;
    this.engram = null;
    this.controller = null;
    $("chat-close").addEventListener("click", () => this.close());
    $("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.send($("chat-input").value);
    });
    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send($("chat-input").value);
      }
    });
    $("chat-suggest").addEventListener("click", (e) => {
      const chip = e.target.closest("button[data-text]");
      if (chip) this.send(chip.dataset.text);
    });
    $("chat-log").addEventListener("click", (e) => {
      const step = e.target.closest("[data-trace]");
      if (step && this.card) this.o.onTrace(this.card, JSON.parse(step.dataset.trace));
    });
  }

  get isOpen() {
    return !$("chat").hidden;
  }

  open(card, engram) {
    if (this.card && this.card !== card) this.o.onTrace(this.card, []);
    this.controller?.abort();
    this.card = card;
    this.engram = engram;
    card.chat = Array.isArray(card.chat) ? card.chat : [];
    $("chat-title").textContent = engram.person || "?";
    $("chat-orb").textContent = (engram.person || "?").trim()[0] || "?";
    $("chat").hidden = false;
    document.body.classList.add("has-chat");
    this.o.onOpen?.();
    this.render();
    const last = [...card.chat].reverse().find((m) => m.role === "persona" && m.trace?.length);
    if (last) this.o.onTrace(card, last.trace);
    $("chat-input").focus();
  }

  close() {
    if (!this.isOpen) return;
    this.controller?.abort();
    if (this.card) this.o.onTrace(this.card, []);
    $("chat").hidden = true;
    document.body.classList.remove("has-chat");
    this.card = null;
    this.engram = null;
    this.o.onClose?.();
  }

  titleOf(id) {
    return (this.engram?.nodes || []).find((n) => n.id === id)?.title || id;
  }

  categoryOf(id) {
    return (this.engram?.nodes || []).find((n) => n.id === id)?.category || "engine";
  }

  message(entry) {
    const li = document.createElement("li");
    li.className = `msg msg-${entry.role}`;
    const text = document.createElement("p");
    text.className = "msg-text";
    text.textContent = entry.text;
    li.append(text);
    if (entry.role === "persona" && entry.trace?.length) {
      const steps = document.createElement("ol");
      steps.className = "msg-trace";
      steps.setAttribute("aria-label", "Logique de la réponse");
      entry.trace.forEach((s, i) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.trace = JSON.stringify(entry.trace);
        button.title = "Montrer cette logique sur l'Engramme";
        const round = document.createElement("span");
        round.className = "trace-round";
        round.textContent = String(i + 1);
        round.style.setProperty("--round", CATEGORY_COLORS[this.categoryOf(s.id)] || "#fbbf24");
        const label = document.createElement("span");
        label.className = "trace-text";
        const name = document.createElement("strong");
        name.textContent = this.titleOf(s.id);
        label.append(name, document.createTextNode(s.why ? ` — ${s.why}` : ""));
        button.append(round, label);
        item.append(button);
        steps.append(item);
      });
      li.append(steps);
    }
    return li;
  }

  render(pending = false) {
    const history = this.card?.chat || [];
    const items = history.map((entry) => this.message(entry));
    if (pending) {
      const li = document.createElement("li");
      li.className = "msg msg-persona is-pending";
      li.innerHTML = '<p class="msg-text"><span class="dots" aria-label="Réflexion en cours"><i></i><i></i><i></i></span></p>';
      items.push(li);
    }
    $("chat-log").replaceChildren(...items);
    $("chat-log").scrollTop = $("chat-log").scrollHeight;
    const suggest = $("chat-suggest");
    suggest.hidden = history.length > 0 || pending;
    suggest.replaceChildren(...SUGGESTIONS.map((text) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.text = text;
      chip.textContent = text;
      return chip;
    }));
    $("chat-send").disabled = pending;
    $("chat-input").disabled = pending;
  }

  async send(value) {
    const message = String(value || "").trim().slice(0, 2000);
    const card = this.card;
    if (!message || !card || this.controller) return;
    const history = card.chat.map(({ role, text }) => ({ role, text }));
    card.chat.push({ role: "user", text: message });
    $("chat-input").value = "";
    this.render(true);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const answer = await this.o.ask(card, history, message, controller.signal);
      if (this.card !== card) return;
      card.chat.push({ role: "persona", text: answer.reply, trace: answer.trace || [] });
      card.chat = card.chat.slice(-HISTORY_MAX);
      this.o.onTrace(card, answer.trace || []);
    } catch (err) {
      if (this.card === card && card.chat.at(-1)?.text === message) card.chat.pop(); // la question retourne dans la saisie
      if (this.card === card) $("chat-input").value = message;
      if (err.name !== "AbortError" && !err.handled) this.o.toast(`Réponse impossible : ${err.message}`, { tone: "error", timeout: 7000 });
    } finally {
      if (this.controller === controller) this.controller = null;
      this.o.onSave(card);
      if (this.card === card) {
        this.render(false);
        $("chat-input").focus();
      }
    }
  }
}
