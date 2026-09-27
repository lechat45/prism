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
 * FUSION (V5, options.fusion) : les bulles héritées de chaque parent (data.sources) partent de leur côté ;
 *   une gravité qui croît comme le cube du temps les précipite vers leurs places ; pendant ces secondes, les
 *   ombres ne se repoussent presque plus : elles entrent en collision (le rendu les fait glitcher), puis tout se range.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrismEngramPhysics = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STEP = 1 / 120;
  const MAX_FRAME = 0.1; // au-delà (onglet en veille…), on ne rattrape pas le retard
  // Au plus 4 pas par image (jusqu'à 30 images/s) : sous charge, le temps ralentit un instant au lieu de s'emballer
  // (rattraper 12 pas d'une image lente rendait la suivante plus lente encore).
  const MAX_STEPS = 4;
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
  const INTRO = 3.2; // s : durée de la fusion (attraction, collisions), puis mouvement ordinaire
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
    const fusion = Boolean(options.fusion);

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
    const slotOf = nodes.map((n) => slots.get(n.id) || 0);

    // Tampons du pas de calcul, alloués une fois (aucune allocation par image : pas de pause du ramasse-miettes).
    const count = nodes.length;
    const ax = new Float64Array(count);
    const ay = new Float64Array(count);
    const invMass = Float64Array.from(nodes, (n) => 1 / n.p.mass);
    const isShadow = Uint8Array.from(nodes, (n) => (n.category === "shadow" ? 1 : 0));
    // Grille de voisinage (cases de la portée de répulsion) : seules les bulles des cases voisines sont comparées.
    const nextInCell = new Int32Array(count);
    const cellOf = new Int32Array(count);
    let cells = new Int32Array(1);
    let tx = 0;
    let ty = 0;

    /** Point que la bulle doit suivre à l'instant présent (écrit dans tx, ty). */
    function target(n) {
      const p = n.p;
      const cx = core ? core.x : width / 2;
      const cy = core ? core.y : height / 2;
      const angle = slotOf[n.index] + DRIFT * time;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      let radius = p.orbit * ellipse(ux, uy);
      if (p.breath) radius *= 1 + p.breath * Math.sin(time * 0.6 + n.phase);
      tx = cx + ux * radius;
      ty = cy + uy * radius;
      if (p.wobble) {
        const w = time * p.wobbleSpeed * n.spin + n.phase;
        tx += Math.cos(w) * p.wobble;
        ty += Math.sin(w) * p.wobble;
      }
    }

    // Départ : chaque bulle à sa place, à quelques pixels près (le mouvement naît organiquement) ; en fusion,
    // chaque bulle part du côté de son parent (A à gauche, B à droite, les deux : en haut).
    for (const n of nodes) {
      if (n === core) {
        n.x = width / 2;
        n.y = height / 2;
        continue;
      }
      if (fusion) {
        const sources = Array.isArray(n.data.sources) ? n.data.sources : [];
        const side = sources.length === 1 ? (sources[0] === "a" ? 0.16 : 0.84) : 0.5;
        n.x = width * side + (random() - 0.5) * width * 0.16;
        n.y = height * (side === 0.5 ? 0.18 : 0.5) + (random() - 0.5) * height * 0.3;
        continue;
      }
      target(n);
      n.x = tx + (random() - 0.5) * 12;
      n.y = ty + (random() - 0.5) * 12;
    }
    /** 0 → 1 pendant la fusion (null hors fusion). */
    const progress = () => (fusion ? Math.min(1, time / INTRO) : null);

    function step(dt) {
      time += dt;
      const intro = fusion && time < INTRO;
      const u = time / INTRO;
      const pull = intro ? 0.04 + 3 * u * u * u : 1; // fusion : gravité en cube du temps
      for (let i = 0; i < count; i++) {
        const n = nodes[i];
        if (n === core) {
          ax[i] = (width / 2 - n.x) * 40;
          ay[i] = (height / 2 - n.y) * 40;
          continue;
        }
        // Ressort vers la place logique (qui tourne avec tout l'Engramme) ; en fusion, gravité croissante.
        target(n);
        ax[i] = n.p.k * pull * (tx - n.x);
        ay[i] = n.p.k * pull * (ty - n.y);
        // Ombres : bruit lissé asynchrone.
        if (n.p.noise) {
          ax[i] += Math.sin(time * n.w1 + n.phase) * n.p.noise;
          ay[i] += Math.cos(time * n.w2 + n.phase * 1.3) * n.p.noise;
        }
      }

      // Répulsion à courte portée entre bulles voisines (le noyau, trop massif, ne bouge pas).
      const shadowForce = SHADOW_REPULSION * (intro ? 0.08 : 1) * 40; // fusion : les ombres se heurtent au lieu de s'éviter
      const plainForce = REPULSION * 40;
      const range2 = REPULSION_RANGE * REPULSION_RANGE;
      const cols = Math.max(1, Math.ceil(width / REPULSION_RANGE));
      const rows = Math.max(1, Math.ceil(height / REPULSION_RANGE));
      if (cells.length < cols * rows) cells = new Int32Array(cols * rows);
      cells.fill(-1, 0, cols * rows);
      for (let i = 0; i < count; i++) {
        const gx = Math.min(cols - 1, Math.max(0, Math.floor(nodes[i].x / REPULSION_RANGE)));
        const gy = Math.min(rows - 1, Math.max(0, Math.floor(nodes[i].y / REPULSION_RANGE)));
        const k = gy * cols + gx;
        cellOf[i] = k;
        nextInCell[i] = cells[k];
        cells[k] = i;
      }
      for (let i = 0; i < count; i++) {
        const a = nodes[i];
        const gx = cellOf[i] % cols;
        const gy = (cellOf[i] - gx) / cols;
        for (let yy = Math.max(0, gy - 1); yy <= Math.min(rows - 1, gy + 1); yy++) {
          for (let xx = Math.max(0, gx - 1); xx <= Math.min(cols - 1, gx + 1); xx++) {
            for (let j = cells[yy * cols + xx]; j !== -1; j = nextInCell[j]) {
              if (j <= i) continue; // chaque paire une seule fois
              const b = nodes[j];
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const d2 = dx * dx + dy * dy;
              if (d2 > range2) continue;
              const d = Math.sqrt(d2) || 0.01;
              const contact = Math.max(d - (a.r + b.r) * 0.9, 4);
              const strength = (isShadow[i] && isShadow[j] ? shadowForce : plainForce) / (contact * contact) / d;
              const fx = dx * strength;
              const fy = dy * strength;
              ax[i] -= fx * invMass[i];
              ay[i] -= fy * invMass[i];
              ax[j] += fx * invMass[j];
              ay[j] += fy * invMass[j];
            }
          }
        }
      }

      // Le pointeur repousse les ombres.
      if (pointer) {
        for (let i = 0; i < count; i++) {
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

      for (let i = 0; i < count; i++) {
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
      /** Avancement de la fusion (0 → 1), null hors fusion. */
      get fusion() { return progress(); },
      /** Avance de dt secondes (pas fixes internes, MAX_STEPS au plus par appel ; davantage quand l'appelant espace
       *  volontairement ses images, cf. la cadence du rendu : le mouvement couvre alors tout le temps écoulé). */
      advance(dt, maxSteps = MAX_STEPS) {
        acc += Math.min(Math.max(dt, 0), MAX_FRAME);
        let steps = 0;
        while (acc >= STEP && steps < maxSteps) {
          step(STEP);
          acc -= STEP;
          steps += 1;
        }
        if (acc >= STEP) acc = 0; // retard non rattrapé : le mouvement ralentit un instant, sans à-coup
      },
      /** Instantané pour un autre fil (Worker → page) : [temps, puis x, y, r de chaque bulle]. */
      snapshot(out) {
        const buf = out && out.length >= 1 + count * 3 ? out : new Float32Array(1 + count * 3);
        buf[0] = time;
        for (let i = 0; i < count; i++) {
          buf[1 + i * 3] = nodes[i].x;
          buf[2 + i * 3] = nodes[i].y;
          buf[3 + i * 3] = nodes[i].r;
        }
        return buf;
      },
      /** Réplique passive (page) : positions, rayons et temps repris d'un instantané du Worker. */
      sync(buf) {
        if (!buf || buf.length < 1 + count * 3) return;
        time = buf[0];
        for (let i = 0; i < count; i++) {
          nodes[i].x = buf[1 + i * 3];
          nodes[i].y = buf[2 + i * 3];
          nodes[i].r = buf[3 + i * 3];
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

  return { createSimulation, computeSlots, PHYSICS, AROUSAL, DRIFT, INTRO, MAX_STEPS, rng };
});
