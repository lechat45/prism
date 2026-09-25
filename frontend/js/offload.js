// Client du Web Worker : run("attach" | "sample" | "generate", args, { signal }) → Promise.
// Si le worker ne démarre pas (page ouverte en file://, navigateur ancien), les mêmes tâches
// tournent sur le fil principal : plus lent pour les gros fichiers, mais rien ne casse.

let worker = null;
let local = null; // Promise<tasks> du repli
let seq = 0;
const pending = new Map(); // id -> { op, args, signal, resolve, reject }

const abortError = () => new DOMException("Opération annulée", "AbortError");

function toError({ name, message, code }) {
  const err = new Error(message);
  err.name = name || "Error";
  if (code) err.code = code;
  return err;
}

function runLocally(job) {
  local ||= import("./tasks.js").then((m) => m.tasks);
  local.then((tasks) => tasks[job.op](job.args, job.signal)).then(job.resolve, job.reject);
}

function degrade(reason) {
  if (!worker) return;
  console.warn("Prism : Web Worker indisponible, traitements sur le fil principal.", reason);
  worker.terminate();
  worker = null;
  for (const [id, job] of pending) {
    pending.delete(id);
    if (!job.signal?.aborted) runLocally(job);
  }
}

try {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "prism" });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return; // message « ready », ou tâche déjà annulée
    pending.delete(data.id);
    if (data.error) job.reject(toError(data.error));
    else job.resolve(data.result);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    degrade(event.message || "échec du chargement");
  };
} catch (err) {
  worker = null;
  console.warn("Prism : Web Worker indisponible, traitements sur le fil principal.", err);
}

export function run(op, args = {}, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const job = { op, args, signal, resolve, reject };
    if (!worker) return runLocally(job);
    const id = ++seq;
    pending.set(id, job);
    signal?.addEventListener("abort", () => {
      if (!pending.delete(id)) return;
      worker?.postMessage({ id, op: "abort" });
      reject(abortError());
    }, { once: true });
    try {
      worker.postMessage({ id, op, args });
    } catch (err) {
      pending.delete(id);
      reject(err); // données non transférables (DataCloneError)
    }
  });
}
