/* Prism V4 — moteur physique de l'Engramme cognitif (ressort-masse natif, sans bibliothèque).
 *
 * Pur calcul, aucun accès au DOM : testé sous Node, puis inscrit tel quel dans le document du widget.
 * Unités : pixels et secondes. Intégration d'Euler semi-implicite à pas fixe (1/120 s), stable et
 * déterministe (graine).
 *
 * LOGIQUE : chaque bulle a une PLACE calculée une fois pour toutes, puis suit cette place.
 *   - Anneaux concentriques (fractions de l'ellipse inscrite) : cœur, moteurs, ombres, artefacts.
 *   - D. artefacts : une horloge — ordre chronologique, dans le sens des aiguilles d'une montre depuis midi.
 *   - E. cœur, B. moteurs, C. ombres (placés dans cet ordre) : chaque bulle se tourne vers les bulles déjà
 *     placées auxquelles elle est liée (un deuil vers la mort qui l'a forgé, une peur vers le trait qu'elle
 *     contredit) ; sans lien, vers le secteur de son type (les types restent groupés). Les places d'un anneau
 *     sont ensuite réparties à intervalles égaux, dans l'ordre de ces préférences : aucune bulle n'en chevauche
 *     une autre, et une lecture radiale (évènement → émotion → trait → noyau) reste toujours vraie.
 *   - Tout le système tourne d'un bloc, lentement : les alignements ne se défont jamais.
 * ORGANIQUE : le noyau respire à peine ; le cœur respire et bat (« lub-dub ») au rythme de son émotion ;
 *   les moteurs ondulent doucement ; les ombres sont erratiques (bruit lissé, sursauts), se repoussent et
 *   fuient le pointeur, puis regagnent leur place ; les artefacts, satellites vifs, décrivent de petits
 *   épicycles autour de leur place. La bulle survolée s'arrête et grossit.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrismEngramPhysics = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STEP = 1 / 120;
  const MAX_FRAME = 0.1; // au-delà (onglet en veille…), on ne rattrape pas le retard
  const TAU = Math.PI * 2;
  const TOP = -Math.PI / 2; // midi (l'axe y de l'écran descend : les angles croissent dans le sens horaire)

  // Paramètres par catégorie. orbit : fraction de l'ellipse inscrite dans la zone (1 = bords) ; k : raideur
  // du ressort vers la place ; breath : respiration radiale ; wobble : rayon de l'épicycle (px).
  const PHYSICS = {
    core: { mass: 60, radius: 38, orbit: 0, k: 0, damping: 3.5, noise: 0 },
    heart: { mass: 2.5, radius: 12, orbit: 0.27, k: 9, damping: 3.2, noise: 0, breath: 0.05 },
    engine: { mass: 3, radius: 15, orbit: 0.44, k: 7, damping: 3, noise: 0, breath: 0.02 },
    shadow: { mass: 2, radius: 13, orbit: 0.68, k: 3.2, damping: 1.2, noise: 190 },
    artifact: { mass: 0.6, radius: 5.5, orbit: 0.92, k: 16, damping: 2.4, noise: 0, wobble: 10, wobbleSpeed: 3.2 },
  };
  // Ordre des types dans chaque anneau (secteurs par défaut, sans lien).
  const TYPE_ORDER = {
    heart: ["trait", "emotion", "attachement"],
    engine: ["algorithme_resolution", "empreinte_syntaxique", "matrice_esthetique", "methode_travail"],
    shadow: ["paradoxe", "peur_primaire", "biais_cognitif"],
    artifact: ["succes", "echec", "tournant"],
  };
  const PLACEMENT = ["artifact", "heart", "engine", "shadow"]; // les évènements d'abord : ils ancrent le reste
  const DRIFT = 0.035; // rad/s : rotation commune de tout l'Engramme (un tour en trois minutes)
  const EDGE = 26; // marge entre l'anneau extérieur et les bords
  const REPULSION = 2600; // entre deux bulles quelconques (px³/s²), courte portée
  const SHADOW_REPULSION = 14000; // entre ombres : elles ne se mélangent pas
  const REPULSION_RANGE = 170;
  const POINTER_RANGE = 150;
  const POINTER_REPULSION = 900000; // les ombres fuient le pointeur
  const HOVER_SCALE = 1.7;
  const CORE_HOVER_SCALE = 1.15; // le noyau, déjà massif, grossit à peine
  // Battements par seconde selon l'émotion portée (bulles du cœur) : l'éveil de l'émotion.
  const AROUSAL = {
    colere: 1.6, passion: 1.5, angoisse: 1.5, peur: 1.4, joie: 1.3, fierte: 1.1, emerveillement: 1.0,
    tendresse: 0.9, tristesse: 0.75, solitude: 0.7, melancolie: 0.7, serenite: 0.6,
  };

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

  const wrap = (a) => ((a % TAU) + TAU) % TAU;
  function circularMean(angles) {
    let x = 0;
    let y = 0;
    for (const a of angles) {
      x += Math.cos(a);
      y += Math.sin(a);
    }
    return Math.atan2(y, x);
  }
  /** « 1898-12-26 », « 1903 », « -44-03 » → clé de tri chronologique. */
  function dateKey(date) {
    const text = String(date || "");
    const negative = text.startsWith("-");
    const parts = text.replace(/^-+/, "").split("-").map((p) => parseInt(p, 10) || 0).concat([0, 0]);
    return (negative ? -parts[0] : parts[0]) * 10000 + parts[1] * 100 + parts[2];
  }

  /** Places logiques (angles) de toutes les bulles hors noyau : cf. en-tête. */
  function computeSlots(nodes, links) {
    const neighbours = new Map();
    for (const l of links) {
      if (l.kind === "core") continue;
      if (!neighbours.has(l.a.id)) neighbours.set(l.a.id, []);
      if (!neighbours.has(l.b.id)) neighbours.set(l.b.id, []);
      neighbours.get(l.a.id).push(l.b.id);
      neighbours.get(l.b.id).push(l.a.id);
    }
    const placed = new Map();
    for (const cat of PLACEMENT) {
      const ring = nodes.filter((n) => n.category === cat);
      const count = ring.length;
      if (!count) continue;
      const step = TAU / count;
      if (cat === "artifact") {
        ring.slice().sort((a, b) => dateKey(a.data.date) - dateKey(b.data.date) || a.index - b.index)
          .forEach((n, i) => placed.set(n.id, TOP + (i + 0.5) * step));
        continue;
      }
      const types = TYPE_ORDER[cat] || [];
      const prefs = ring.map((n) => {
        const same = ring.filter((m) => m.data.type === n.data.type);
        const t = Math.max(0, types.indexOf(n.data.type));
        const sector = TOP + (t + (same.indexOf(n) + 0.5) / same.length) * (TAU / Math.max(1, types.length));
        const linked = (neighbours.get(n.id) || []).filter((id) => placed.has(id)).map((id) => placed.get(id));
        // Liens prépondérants (deux voix chacun), secteur du type en appoint.
        return linked.length ? circularMean(linked.concat(linked, [sector])) : sector;
      });
      const order = ring.map((_, i) => i).sort((a, b) => wrap(prefs[a]) - wrap(prefs[b]) || a - b);
      // Places équidistantes, dans l'ordre des préférences, décalées au mieux vers elles.
      const offset = circularMean(order.map((i, j) => prefs[i] - j * step));
      order.forEach((i, j) => placed.set(ring[i].id, offset + j * step));
    }
    return placed;
  }

  function createSimulation(engram, options = {}) {
    const random = rng(options.seed == null ? 7 : options.seed);
    let width = options.width || 800;
    let height = options.height || 600;
    let pointer = null;
    let hoverId = null;
    let time = 0;
    let acc = 0;

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
      return {
        id: data.id,
        index: i,
        category: data.category,
        data,
        p,
        x: width / 2,
        y: height / 2,
        vx: 0,
        vy: 0,
        baseR,
        r: baseR,
        phase: random() * TAU,
        // Bruit lissé : deux fréquences propres par bulle (ombres), sursauts à intervalles irréguliers.
        w1: 0.6 + random() * 1.4,
        w2: 0.5 + random() * 1.6,
        pulse: 0.7 + random() * 1.8,
        nextJolt: 1 + random() * 3,
        spin: random() < 0.5 ? -1 : 1,
        bpm: (AROUSAL[data.emotion] || 1) * (0.94 + random() * 0.12),
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const core = nodes.find((n) => n.category === "core") || null;
    const links = [];
    for (const n of nodes) if (n !== core && core) links.push({ a: core, b: n, kind: "core" });
    for (const l of engram.links || []) {
      const a = byId.get(l.from);
      const b = byId.get(l.to);
      if (a && b && a !== b) links.push({ a, b, kind: l.kind });
    }
    const slots = computeSlots(nodes, links);

    /** Point que la bulle doit suivre à l'instant présent. */
    function target(n) {
      const p = n.p;
      const c = core || center();
      const angle = (slots.get(n.id) || 0) + DRIFT * time;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      let radius = p.orbit * ellipse(ux, uy);
      if (p.breath) radius *= 1 + p.breath * Math.sin(time * 0.6 + n.phase);
      let x = c.x + ux * radius;
      let y = c.y + uy * radius;
      if (p.wobble) {
        const w = time * p.wobbleSpeed * n.spin + n.phase;
        x += Math.cos(w) * p.wobble;
        y += Math.sin(w) * p.wobble;
      }
      return [x, y];
    }

    // Départ : chaque bulle à sa place, à quelques pixels près (le mouvement naît organiquement).
    for (const n of nodes) {
      if (n === core) {
        n.x = width / 2;
        n.y = height / 2;
        continue;
      }
      const [x, y] = target(n);
      n.x = x + (random() - 0.5) * 12;
      n.y = y + (random() - 0.5) * 12;
    }

    function step(dt) {
      time += dt;
      const ax = new Float64Array(nodes.length);
      const ay = new Float64Array(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n === core) {
          const cc = center();
          ax[i] = (cc.x - n.x) * 40;
          ay[i] = (cc.y - n.y) * 40;
          continue;
        }
        // Ressort vers la place logique (qui tourne avec tout l'Engramme).
        const [tx, ty] = target(n);
        ax[i] = n.p.k * (tx - n.x);
        ay[i] = n.p.k * (ty - n.y);
        // Ombres : bruit lissé asynchrone.
        if (n.p.noise) {
          ax[i] += Math.sin(time * n.w1 + n.phase) * n.p.noise;
          ay[i] += Math.cos(time * n.w2 + n.phase * 1.3) * n.p.noise;
        }
      }

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
        const scale = n === core ? CORE_HOVER_SCALE : HOVER_SCALE;
        const goal = n.id === hoverId ? n.baseR * scale : n.baseR;
        n.r += (goal - n.r) * Math.min(1, dt * 12);
        if (n.id === hoverId) {
          n.vx = 0; // la bulle survolée s'arrête
          n.vy = 0;
          continue;
        }
        // Sursaut des ombres : impulsion brève dans une direction aléatoire.
        if (n.category === "shadow" && time >= n.nextJolt) {
          const a = random() * TAU;
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
      },
      setPointer(x, y) {
        pointer = x == null ? null : { x, y };
      },
      setHover(id) {
        hoverId = id == null ? null : id;
      },
      /** Place logique d'une bulle (angle en radians, à l'instant présent), null pour le noyau. */
      slotAngle(id) {
        return slots.has(id) ? slots.get(id) + DRIFT * time : null;
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
      /** Pulsation d'affichage (lub-dub du cœur, asynchrone pour les ombres, respiration lente sinon). */
      pulseOf(n) {
        if (n.category === "heart") {
          // « Lub-dub » : deux contractions rapprochées, puis un repos ; fréquence = éveil de l'émotion.
          const beat = (time * n.bpm + n.phase / TAU) % 1;
          return 1 + 0.2 * Math.exp(-((beat - 0.1) ** 2) / 0.0016) + 0.12 * Math.exp(-((beat - 0.3) ** 2) / 0.0016);
        }
        if (n.category === "shadow") return 1 + 0.14 * Math.sin(time * n.pulse * 2.4 + n.phase);
        if (n.category === "core") return 1 + 0.03 * Math.sin(time * 0.8);
        return 1 + 0.03 * Math.sin(time * 1.3 + n.phase);
      },
    };
  }

  return { createSimulation, computeSlots, PHYSICS, AROUSAL, DRIFT, rng };
});
