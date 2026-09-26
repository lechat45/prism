/* Prism V4 — moteur physique de l'Engramme cognitif (ressort-masse natif, sans bibliothèque).
 *
 * Pur calcul, aucun accès au DOM : testé sous Node, puis inscrit tel quel dans le document du widget.
 * Unités : pixels et secondes. Intégration d'Euler semi-implicite à pas fixe (1/120 s), stable et
 * déterministe (graine) ; les forces sont des accélérations (divisées par la masse quand il le faut).
 *
 *   A. core      masse énorme, rappelée au centre par un ressort très raide : ne bouge presque pas.
 *   B. engine    ressort vers le noyau (orbite proche), dérive tangentielle lente, amortissement fort :
 *                mouvement fluide et prévisible.
 *   C. shadow    ressort plus lâche (orbite moyenne), bruit lissé propre à chaque bulle, sursauts
 *                aléatoires, répulsion forte entre ombres et fuite devant le pointeur : erratiques.
 *   D. artifact  minuscules, orbite lointaine, vitesse tangentielle élevée : satellites rapides.
 * Toutes les bulles se repoussent à courte portée (aucun chevauchement) ; les liens « forge / nourrit /
 * contredit » ajoutent des ressorts faibles. La bulle survolée s'arrête et grossit.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrismEngramPhysics = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STEP = 1 / 120;
  const MAX_FRAME = 0.1; // au-delà (onglet en veille…), on ne rattrape pas le retard

  // Paramètres par catégorie. orbit : fraction de l'ellipse inscrite dans la zone (1 = bords), pour
  // que les anneaux épousent une carte non carrée au lieu d'être rognés par ses bords.
  const PHYSICS = {
    core: { mass: 60, radius: 38, orbit: 0, k: 0, damping: 3.5, tangential: 0, noise: 0 },
    engine: { mass: 3, radius: 15, orbit: 0.44, k: 9, damping: 2.2, tangential: 26, noise: 0 },
    shadow: { mass: 2, radius: 13, orbit: 0.68, k: 4, damping: 1.1, tangential: 0, noise: 190 },
    artifact: { mass: 0.6, radius: 5.5, orbit: 0.92, k: 7, damping: 0.9, tangential: 210, noise: 0 },
  };
  const EDGE = 26; // marge entre l'anneau extérieur et les bords
  const REPULSION = 2600; // entre deux bulles quelconques (px³/s²), courte portée
  const SHADOW_REPULSION = 14000; // entre ombres : elles ne se mélangent pas
  const REPULSION_RANGE = 170;
  const POINTER_RANGE = 150;
  const POINTER_REPULSION = 900000; // les ombres fuient le pointeur
  const LINK_K = { forge: 1.2, nourrit: 1.6, contredit: 0.8 };
  const HOVER_SCALE = 1.7;
  const CORE_HOVER_SCALE = 1.15; // le noyau, déjà massif, grossit à peine

  /** Générateur pseudo-aléatoire déterministe (mulberry32). */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createSimulation(engram, options = {}) {
    const random = rng(options.seed == null ? 7 : options.seed);
    let width = options.width || 800;
    let height = options.height || 600;
    let pointer = null;
    let hoverId = null;
    let time = 0;
    let acc = 0;

    const size = () => Math.min(width, height);
    const center = () => ({ x: width / 2, y: height / 2 });
    /** Rayon de l'ellipse inscrite (demi-axes : demi-zone moins la marge) dans la direction (ux, uy). */
    const ellipse = (ux, uy) => {
      const a = Math.max(40, width / 2 - EDGE);
      const b = Math.max(40, height / 2 - EDGE);
      return (a * b) / Math.hypot(b * ux, a * uy);
    };

    const nodes = (engram.nodes || []).map((data, i) => {
      const p = PHYSICS[data.category] || PHYSICS.engine;
      const intensity = typeof data.intensity === "number" ? data.intensity : 0.5;
      const baseR = data.category === "core" ? p.radius : p.radius * (0.8 + 0.45 * intensity);
      const angle = random() * Math.PI * 2;
      const dist = p.orbit * ellipse(Math.cos(angle), Math.sin(angle)) * (0.9 + random() * 0.2);
      return {
        id: data.id,
        index: i,
        category: data.category,
        data,
        p,
        x: width / 2 + Math.cos(angle) * dist,
        y: height / 2 + Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
        baseR,
        r: baseR,
        phase: random() * Math.PI * 2,
        // Bruit lissé : deux fréquences propres par bulle (ombres), sursauts à intervalles irréguliers.
        w1: 0.6 + random() * 1.4,
        w2: 0.5 + random() * 1.6,
        pulse: 0.7 + random() * 1.8,
        nextJolt: 1 + random() * 3,
        spin: random() < 0.5 ? -1 : 1,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const core = nodes.find((n) => n.category === "core") || null;
    if (core) {
      core.x = width / 2;
      core.y = height / 2;
    }
    const links = [];
    for (const n of nodes) if (n !== core && core) links.push({ a: core, b: n, kind: "core" });
    for (const l of engram.links || []) {
      const a = byId.get(l.from);
      const b = byId.get(l.to);
      if (a && b && a !== b) links.push({ a, b, kind: l.kind, rest: size() * 0.28 });
    }

    function forces(n, ax, ay) {
      const p = n.p;
      const c = core || center();
      // Noyau : rappel très raide vers le centre de la zone.
      if (n === core) {
        const cc = center();
        return [ax + (cc.x - n.x) * 40, ay + (cc.y - n.y) * 40];
      }
      const dx = n.x - c.x;
      const dy = n.y - c.y;
      const d = Math.hypot(dx, dy) || 0.001;
      const ux = dx / d;
      const uy = dy / d;
      // Ressort vers le noyau, longueur au repos = anneau elliptique de la catégorie.
      const stretch = d - p.orbit * ellipse(ux, uy);
      ax -= p.k * stretch * ux;
      ay -= p.k * stretch * uy;
      // Dérive tangentielle (orbite) : lente pour les moteurs, rapide pour les artefacts.
      if (p.tangential) {
        ax += -uy * p.tangential * n.spin;
        ay += ux * p.tangential * n.spin;
      }
      // Ombres : bruit lissé asynchrone + sursauts.
      if (p.noise) {
        ax += Math.sin(time * n.w1 + n.phase) * p.noise;
        ay += Math.cos(time * n.w2 + n.phase * 1.3) * p.noise;
      }
      return [ax, ay];
    }

    function step(dt) {
      time += dt;
      const ax = new Float64Array(nodes.length);
      const ay = new Float64Array(nodes.length);
      for (let i = 0; i < nodes.length; i++) [ax[i], ay[i]] = forces(nodes[i], 0, 0);

      // Répulsion à courte portée entre toutes les bulles (le noyau, trop massif, ne bouge pas).
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > REPULSION_RANGE * REPULSION_RANGE) continue;
          const d = Math.sqrt(d2) || 0.01;
          const contact = Math.max(d - (a.r + b.r) * 0.9, 4);
          const strength = (a.category === "shadow" && b.category === "shadow" ? SHADOW_REPULSION : REPULSION) / (contact * contact) * 40;
          const fx = (dx / d) * strength;
          const fy = (dy / d) * strength;
          ax[i] -= fx / a.p.mass;
          ay[i] -= fy / a.p.mass;
          ax[j] += fx / b.p.mass;
          ay[j] += fy / b.p.mass;
        }
      }

      // Ressorts des liens thématiques (faibles).
      for (const l of links) {
        if (l.kind === "core") continue;
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (LINK_K[l.kind] || 1) * (d - l.rest);
        const ia = l.a.index;
        const ib = l.b.index;
        ax[ia] += (f * dx) / d / l.a.p.mass;
        ay[ia] += (f * dy) / d / l.a.p.mass;
        ax[ib] -= (f * dx) / d / l.b.p.mass;
        ay[ib] -= (f * dy) / d / l.b.p.mass;
      }

      // Le pointeur repousse les ombres.
      if (pointer) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (n.category !== "shadow") continue;
          const dx = n.x - pointer.x;
          const dy = n.y - pointer.y;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d > POINTER_RANGE) continue;
          const f = POINTER_REPULSION / Math.max(d * d, 400) * (1 - d / POINTER_RANGE);
          ax[i] += (dx / d) * f;
          ay[i] += (dy / d) * f;
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const target = n.id === hoverId ? n.baseR * (n === core ? CORE_HOVER_SCALE : HOVER_SCALE) : n.baseR;
        n.r += (target - n.r) * Math.min(1, dt * 12);
        if (n.id === hoverId) {
          n.vx = 0; // la bulle survolée s'arrête
          n.vy = 0;
          continue;
        }
        // Sursaut des ombres : impulsion brève dans une direction aléatoire.
        if (n.category === "shadow" && time >= n.nextJolt) {
          const a = random() * Math.PI * 2;
          n.vx += Math.cos(a) * 90;
          n.vy += Math.sin(a) * 90;
          n.nextJolt = time + 1.5 + random() * 3.5;
        }
        const damp = Math.exp(-n.p.damping * dt);
        n.vx = (n.vx + ax[i] * dt) * damp;
        n.vy = (n.vy + ay[i] * dt) * damp;
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        // Murs souples : la bulle reste dans la zone.
        const m = n.r + 4;
        if (n.x < m) { n.x = m; n.vx = Math.abs(n.vx) * 0.5; }
        if (n.x > width - m) { n.x = width - m; n.vx = -Math.abs(n.vx) * 0.5; }
        if (n.y < m) { n.y = m; n.vy = Math.abs(n.vy) * 0.5; }
        if (n.y > height - m) { n.y = height - m; n.vy = -Math.abs(n.vy) * 0.5; }
      }
    }

    return {
      nodes,
      links,
      get time() { return time; },
      /** Avance de dt secondes (pas fixes internes). */
      advance(dt) {
        acc += Math.min(Math.max(dt, 0), MAX_FRAME);
        while (acc >= STEP) {
          step(STEP);
          acc -= STEP;
        }
      },
      resize(w, h) {
        const sx = w / width;
        const sy = h / height;
        width = w;
        height = h;
        for (const n of nodes) {
          n.x *= sx;
          n.y *= sy;
        }
        for (const l of links) if (l.kind !== "core") l.rest = size() * 0.28;
      },
      setPointer(x, y) {
        pointer = x == null ? null : { x, y };
      },
      setHover(id) {
        hoverId = id == null ? null : id;
      },
      /** Bulle sous le point (la plus proche, dans son rayon agrandi). */
      nodeAt(x, y, slack = 6) {
        let best = null;
        let bestD = Infinity;
        for (const n of nodes) {
          const d = Math.hypot(n.x - x, n.y - y);
          if (d <= n.r + slack && d < bestD) {
            best = n;
            bestD = d;
          }
        }
        return best;
      },
      /** Pulsation d'affichage (asynchrone pour les ombres, respiration lente sinon). */
      pulseOf(n) {
        if (n.category === "shadow") return 1 + 0.14 * Math.sin(time * n.pulse * 2.4 + n.phase);
        if (n.category === "core") return 1 + 0.03 * Math.sin(time * 0.8);
        return 1 + 0.03 * Math.sin(time * 1.3 + n.phase);
      },
    };
  }

  return { createSimulation, PHYSICS, rng };
});
