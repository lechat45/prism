// Durée de vie d'une carte (V5, phase 1 · point 2) : tout ce qu'elle installe — écouteurs, minuteurs, images
// d'animation, observateurs, URL de Blob, nettoyages particuliers — est rattaché à sa portée ; dispose() défait tout
// d'un coup, dans l'ordre inverse, et oublie ses références. Rien ne dépend de la discipline de chaque ligne.
//
// Les écouteurs passent par un AbortController (option `signal`) : un seul abort() les retire tous, y compris ceux
// ajoutés pendant un geste (glisser) qui n'aurait jamais reçu son relâchement.

export class Scope {
  constructor() {
    this.controller = new AbortController();
    this.timers = new Set();
    this.intervals = new Set();
    this.frames = new Set();
    this.urls = new Set();
    this.cleanups = [];
    this.disposed = false;
  }

  get signal() {
    return this.controller.signal;
  }

  /** addEventListener retiré automatiquement à la fin de la portée. */
  on(target, type, listener, options = {}) {
    if (this.disposed) return;
    target.addEventListener(type, listener, { ...options, signal: this.signal });
  }

  timeout(fn, ms) {
    if (this.disposed) return 0;
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  clearTimeout(id) {
    clearTimeout(id);
    this.timers.delete(id);
  }

  interval(fn, ms) {
    if (this.disposed) return 0;
    const id = setInterval(fn, ms);
    this.intervals.add(id);
    return id;
  }

  clearInterval(id) {
    clearInterval(id);
    this.intervals.delete(id);
  }

  frame(fn) {
    if (this.disposed) return 0;
    const id = requestAnimationFrame((t) => {
      this.frames.delete(id);
      fn(t);
    });
    this.frames.add(id);
    return id;
  }

  /** URL de Blob révoquée à la fin de la portée (la mémoire du Blob est rendue au navigateur). */
  url(blob) {
    const url = URL.createObjectURL(blob);
    if (this.disposed) URL.revokeObjectURL(url);
    else this.urls.add(url);
    return url;
  }

  /** Observateur (Resize, Intersection, Mutation…) déconnecté à la fin de la portée. */
  observe(observer) {
    this.add(() => observer.disconnect());
    return observer;
  }

  /** Nettoyage particulier, exécuté à la fin (ordre inverse de l'ajout). */
  add(fn) {
    if (this.disposed) {
      fn();
      return;
    }
    this.cleanups.push(fn);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const id of this.timers) clearTimeout(id);
    for (const id of this.intervals) clearInterval(id);
    for (const id of this.frames) cancelAnimationFrame(id);
    for (const url of this.urls) URL.revokeObjectURL(url);
    const cleanups = this.cleanups.reverse();
    this.timers.clear();
    this.intervals.clear();
    this.frames.clear();
    this.urls.clear();
    this.cleanups = [];
    for (const fn of cleanups) {
      try {
        fn();
      } catch (err) {
        console.warn("Prism : nettoyage d'une carte en échec", err);
      }
    }
  }
}

/**
 * Détruit une iframe tout de suite : document déchargé (ses minuteurs, Workers et connexions s'arrêtent), puis
 * élément retiré. Le navigateur peut alors rendre la mémoire du processus isolé du widget.
 */
export function destroyFrame(frame) {
  if (!frame) return;
  try {
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
  } catch { /* déjà détachée */ }
  frame.remove();
}
