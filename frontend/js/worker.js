// Web Worker (module) : les traitements lourds (tasks.js) tournent hors du fil principal,
// l'interface garde ses 60 images/s pendant l'analyse d'un gros CSV ou le traitement d'une réponse.
// Protocole : { id, op, args } → { id, result } | { id, error } ; { id, op: "abort" } annule.

import "../engine/sanitize.js"; // scripts classiques : définissent self.PrismSanitize puis self.PrismLocal
import "../engine/local.js";
import { tasks } from "./tasks.js";

const running = new Map();

self.onmessage = async ({ data }) => {
  const { id, op, args } = data;
  if (op === "abort") {
    running.get(id)?.abort();
    return;
  }
  const controller = new AbortController();
  running.set(id, controller);
  try {
    if (!Object.hasOwn(tasks, op)) throw new Error(`tâche inconnue : ${op}`);
    self.postMessage({ id, result: await tasks[op](args, controller.signal) });
  } catch (err) {
    self.postMessage({ id, error: { name: err.name, message: err.message, code: err.code } });
  } finally {
    running.delete(id);
  }
};

self.postMessage({ ready: true });
