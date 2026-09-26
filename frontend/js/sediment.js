// V5 · Sédimentation : une carte dissoute se brise en particules qui s'incrustent dans le fond du canvas ;
// ses mots-clés restent à cet endroit, dans une grille spatiale (cases de CELL px du monde). Une génération
// lancée plus tard dans la même case reçoit ces mots comme « contexte fantôme » (cf. engine/ghost-template.txt) :
// visible dans l'inspecteur de la carte produite, désactivable dans les Paramètres, jamais caché.

export const CELL = 480; // px du monde
export const MAX_USES = 3; // une case nourrit trois générations, puis ses sédiments s'effacent
const MAX_SEDIMENTS = 60;
const MAX_WORDS = 6; // par carte dissoute
export const MAX_GHOST = 12; // par génération (limite du serveur)
const KEY = "prism:sediments";

const STOP = new Set(`a à au aux avec ce ces cet cette dans de des du elle en et est il ils je la le les leur lui mais me mes
mon ne nos notre nous on ou où par pas pour qu que qui sa se ses son sur ta te tes ton tu un une vos votre vous y
d l j m n s t c qu plus moins très tout tous toute toutes bien fait faire crée créer crée-moi moi widget widgets carte
cartes prism engramme hyper affiche afficher montre montrer permet permettre simple petit petite grand grande avec
sans entre comme depuis chaque the and for with from that this into your you are was were can will make create show
build app about using use of to in on at by an is it as or be my me our new`.split(/\s+/));

/** Mots-clés d'une carte : titre puis demande, sans mots vides, 6 au plus. */
export function keywordsOf(...texts) {
  const words = [];
  const seen = new Set();
  for (const text of texts) {
    for (const raw of String(text || "").toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
      const word = raw.replace(/^-+|-+$/g, "");
      const plain = word.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      if (word.length < 3 || word.length > 40 || /^\d+$/.test(word) || STOP.has(word) || STOP.has(plain) || seen.has(plain)) continue;
      seen.add(plain);
      words.push(word);
      if (words.length === MAX_WORDS) return words;
    }
  }
  return words;
}

export const cellOf = (x, y) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

/** Dépôt de sédiments (localStorage par défaut ; un stockage de test peut le remplacer). */
export class SedimentStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
  }

  all() {
    try {
      const list = JSON.parse(this.storage?.getItem(KEY) || "[]");
      return Array.isArray(list) ? list.filter((s) => s && Array.isArray(s.words) && [s.x, s.y].every(Number.isFinite)) : [];
    } catch {
      return [];
    }
  }

  save(list) {
    try {
      this.storage?.setItem(KEY, JSON.stringify(list.slice(-MAX_SEDIMENTS)));
    } catch { /* stockage indisponible : les sédiments ne survivront pas au rechargement */ }
  }

  /** Nouveau sédiment au point (x, y) du monde ; null s'il n'y a aucun mot à garder. */
  deposit({ id, x, y, words, title = "" }) {
    const kept = (words || []).filter((w) => typeof w === "string" && w.length > 0 && w.length <= 40).slice(0, MAX_WORDS);
    if (!kept.length) return null;
    const sediment = { id, x: Math.round(x), y: Math.round(y), cell: cellOf(x, y), words: kept, title: String(title).slice(0, 80), uses: 0, at: Date.now() };
    this.save([...this.all().filter((s) => s.id !== id), sediment]);
    return sediment;
  }

  remove(id) {
    this.save(this.all().filter((s) => s.id !== id));
  }

  clear() {
    this.save([]);
  }

  /** Contexte fantôme d'un point du monde : mots des sédiments de sa case (les plus récents d'abord). */
  ghostAt(x, y) {
    const cell = cellOf(x, y);
    const words = [];
    const ids = [];
    for (const s of this.all().filter((s) => s.cell === cell && s.uses < MAX_USES).reverse()) {
      ids.push(s.id);
      for (const w of s.words) if (!words.includes(w) && words.length < MAX_GHOST) words.push(w);
    }
    return words.length ? { cell, words, ids } : null;
  }

  /** Une génération a puisé dans ces sédiments : ils s'usent (et s'effacent au bout de MAX_USES). */
  consume(ids) {
    const used = new Set(ids);
    const list = this.all().map((s) => (used.has(s.id) ? { ...s, uses: s.uses + 1 } : s));
    const spent = list.filter((s) => s.uses >= MAX_USES).map((s) => s.id);
    this.save(list.filter((s) => s.uses < MAX_USES));
    return spent;
  }
}

// ------------------------------------------------------------------------------------------------ rendu
/** Points de sédiment dans le monde (#world) : décor, sans interaction. */
export function drawSediments(world, list) {
  world.querySelectorAll(".sediment").forEach((el) => el.remove());
  for (const s of list) world.append(sedimentDot(s));
}

export function sedimentDot(s, fresh = false) {
  const dot = document.createElement("div");
  dot.className = `sediment${fresh ? " is-fresh" : ""}`;
  dot.dataset.id = s.id;
  dot.dataset.uses = String(s.uses);
  dot.setAttribute("aria-hidden", "true");
  dot.style.left = `${s.x}px`;
  dot.style.top = `${s.y}px`;
  dot.style.setProperty("--wear", String(1 - s.uses / MAX_USES));
  return dot;
}

/**
 * La carte se brise en particules (couleur d'accent, blanc, gris) qui s'éparpillent puis s'enfoncent vers
 * le point de sédiment en s'éteignant. rect : rectangle écran de la carte ; target : point écran. Promesse
 * résolue à la fin (tout de suite si l'utilisateur préfère moins d'animations).
 */
export function shatter(rect, target, accent = "#7cc4ff") {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || rect.width < 2 || rect.height < 2) return Promise.resolve();
  const canvas = document.createElement("canvas");
  canvas.className = "shatter";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const colors = [accent, accent, "#e8eef7", "#9aa7b8", "#5b6677"];
  const step = Math.max(7, Math.sqrt((rect.width * rect.height) / 1400));
  const parts = [];
  for (let y = rect.top; y < rect.bottom; y += step) {
    for (let x = rect.left; x < rect.right; x += step) {
      const angle = Math.atan2(y - (rect.top + rect.height / 2), x - (rect.left + rect.width / 2)) + (Math.random() - 0.5) * 1.2;
      const burst = 60 + Math.random() * 260;
      parts.push({
        x: x + Math.random() * step, y: y + Math.random() * step, vx: Math.cos(angle) * burst, vy: Math.sin(angle) * burst - 40,
        size: step * (0.35 + Math.random() * 0.45), color: colors[(Math.random() * colors.length) | 0],
        land: { x: target.x + (Math.random() - 0.5) * 70, y: target.y + (Math.random() - 0.5) * 70 },
        spin: (Math.random() - 0.5) * 8, delay: Math.random() * 0.18,
      });
    }
  }
  const DURATION = 1.5;
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0;
    const frame = (now) => {
      const t = (now - t0) / 1000;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        const local = Math.max(0, t - p.delay);
        if (local < 0.35) {
          p.vx *= 0.93; // éclatement freiné
          p.vy = p.vy * 0.93 + 260 * dt;
        } else {
          const pull = 10 + 40 * (local - 0.35); // puis tout s'enfonce vers le sédiment
          p.vx = (p.vx + (p.land.x - p.x) * pull * dt) * 0.86;
          p.vy = (p.vy + (p.land.y - p.y) * pull * dt) * 0.86;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const fade = Math.max(0, Math.min(1, (DURATION - t) / 0.55));
        const size = p.size * (0.35 + 0.65 * fade);
        ctx.globalAlpha = fade;
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin * local);
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.restore();
      }
      if (t < DURATION) requestAnimationFrame(frame);
      else {
        canvas.remove();
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}
