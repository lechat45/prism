/*
 * Rendu d'un Engramme sur une toile 2D — sans DOM : le même code dessine dans un Web Worker (OffscreenCanvas,
 * fil séparé : le fil de la carte reste libre pour le pointeur et les autres cartes) ou, à défaut, sur le fil
 * de la carte (navigateur sans OffscreenCanvas, Worker refusé).
 *
 * createRenderer({ canvas, ctx, sim, data, reduced, makeCanvas, rng, seed }) → {
 *   resize(w, h, dpr)  taille CSS et densité de pixels (repeint le ciel pré-rendu) ;
 *   set(patch)         état d'affichage : { hover, pinned, drop } (identifiants de bulles), focus (catégorie),
 *                      trace ([{ id, why }] ou null) ;
 *   flash(id)          anneau bref (dépôt sur une bulle) ;
 *   tick(nowMs, steps) avance la physique (steps : pas autorisés) et dessine une image → { fusing, merged } ;
 *   pixels(points)     couleurs [r, g, b, a] aux points CSS donnés (tests) ;
 *   stats()            images/s et millisecondes de physique et de dessin par image, depuis l'appel précédent.
 * }
 * Les couleurs (COLOR, EMOTION_COLOR, LEGEND, colorOf, rgba) servent aussi aux éléments DOM de la carte.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PrismEngramRender = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Couleurs [r, g, b] par catégorie (et par type pour les ombres et les artefacts).
  var COLOR = {
    core: [214, 232, 255], heart: [251, 113, 133], engine: [34, 211, 238],
    paradoxe: [168, 85, 247], peur_primaire: [244, 63, 94], biais_cognitif: [139, 92, 246],
    succes: [251, 191, 36], echec: [251, 146, 60], tournant: [253, 230, 138]
  };
  // Couleur de chaque émotion : halos des bulles, aura du climat, puces de l'en-tête et de la fiche.
  var EMOTION_COLOR = {
    joie: [253, 224, 71], emerveillement: [125, 211, 252], passion: [251, 113, 133], tendresse: [249, 168, 212],
    serenite: [94, 234, 212], fierte: [251, 191, 36], melancolie: [129, 140, 248], tristesse: [96, 165, 250],
    colere: [239, 68, 68], peur: [167, 139, 250], angoisse: [192, 132, 252], solitude: [148, 163, 184]
  };
  var LEGEND = { core: [255, 255, 255], heart: COLOR.heart, engine: COLOR.engine, shadow: [192, 38, 211], artifact: COLOR.succes };
  var LINKS = {
    forge: { c: [255, 255, 255], a: 0.2, w: 1.1, dash: null },
    nourrit: { c: [34, 211, 238], a: 0.3, w: 1.3, dash: null },
    contredit: { c: [244, 63, 94], a: 0.35, w: 1.1, dash: [4, 4] }
  };
  var RANK = { core: 0, heart: 1, engine: 2, artifact: 3, shadow: 4 };
  var ORDER = ["artifact", "shadow", "engine", "heart", "core"];
  var STEP_S = 0.9; // trace : délai entre deux ronds
  var TYPE_RATE = 45; // trace : caractères écrits par seconde
  var FONT = "px Inter, ui-sans-serif, system-ui, sans-serif";

  function rgba(c, a) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function emotionOf(n) { return EMOTION_COLOR[n.data.emotion] || null; }
  function colorOf(n) {
    if (n.category === "heart") return emotionOf(n) || COLOR.heart;
    return COLOR[n.category === "core" || n.category === "engine" ? n.category : n.data.type] || COLOR.engine;
  }
  function short(s, max) { return s.length > max ? s.slice(0, max - 1) + "…" : s; }
  function clock() { return performance.now(); }

  function createRenderer(o) {
    var canvas = o.canvas;
    var ctx = o.ctx;
    var sim = o.sim;
    var DATA = o.data;
    var reduced = Boolean(o.reduced);
    var W = 1;
    var H = 1;
    var dpr = 1;
    var PARENTS = Array.isArray(DATA.parents) && DATA.parents.length === 2 ? DATA.parents : null;

    var byId = {};
    var neighbours = {};
    var core = null;
    sim.nodes.forEach(function (n) {
      byId[n.id] = n;
      neighbours[n.id] = {};
      if (n.category === "core") core = n;
      // État d'affichage propre à chaque bulle : traînée (artefacts), glitch (ombres), éclair (dépôt).
      n.trail = [];
      n.glitchAt = 1 + Math.random() * 4;
      n.glitchUntil = 0;
      n.flash = 0;
    });
    sim.links.forEach(function (l) { neighbours[l.a.id][l.b.id] = true; neighbours[l.b.id][l.a.id] = true; });
    var climate = (DATA.climate || []).filter(function (c) { return EMOTION_COLOR[c.emotion]; });
    var LABEL_ORDER = sim.nodes.slice().sort(function (a, b) {
      return RANK[a.category] - RANK[b.category] || (b.data.intensity || 0) - (a.data.intensity || 0);
    });

    // État d'affichage, piloté par la carte (set) : bulles survolée, épinglée, visée par un dépôt ; catégorie en
    // avant (légende) ; trace logique d'une réponse de la conversation.
    var hover = null;
    var pinned = null;
    var dropTarget = null;
    var focusCategory = null;
    var trace = null; // { steps: [{ node, why }], start }
    var mergedAt = null;
    var mergedSent = false;

    // ---------------------------------------------------------------- ciel (pré-rendu)
    var sky = o.makeCanvas(1, 1);
    var stars = [];
    (function () {
      var r = o.rng((o.seed >>> 0) ^ 0x9e3779b9);
      for (var i = 0; i < 170; i++) stars.push({ x: r(), y: r(), s: 0.25 + r() * r() * 1.3, a: 0.15 + r() * 0.6 });
    })();

    function paintSky() {
      sky.width = Math.round(W * dpr);
      sky.height = Math.round(H * dpr);
      var g = sky.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      var bg = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
      bg.addColorStop(0, "#0c1024");
      bg.addColorStop(0.55, "#070814");
      bg.addColorStop(1, "#020206");
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      stars.forEach(function (s) {
        g.fillStyle = "rgba(220,230,255," + s.a + ")";
        g.beginPath();
        g.arc(s.x * W, s.y * H, s.s, 0, Math.PI * 2);
        g.fill();
      });
      // Anneaux des catégories : l'architecture de l'esprit, à peine visible.
      var a = Math.max(40, W / 2 - 26);
      var b = Math.max(40, H / 2 - 26);
      [[0.27, "rgba(251,113,133,0.07)"], [0.44, "rgba(34,211,238,0.07)"], [0.68, "rgba(168,85,247,0.06)"], [0.92, "rgba(251,191,36,0.05)"]].forEach(function (ring) {
        g.strokeStyle = ring[1];
        g.lineWidth = 1;
        g.setLineDash([2, 6]);
        g.beginPath();
        g.ellipse(W / 2, H / 2, a * ring[0], b * ring[0], 0, 0, Math.PI * 2);
        g.stroke();
      });
    }

    // ---------------------------------------------------------------- formes
    function glow(x, y, radius, c, alpha) {
      var g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, rgba(c, alpha));
      g.addColorStop(0.4, rgba(c, alpha * 0.35));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    function traced(n) {
      if (!trace) return false;
      for (var i = 0; i < trace.steps.length; i++) if (trace.steps[i].node === n) return true;
      return false;
    }

    function focusAlpha(n) {
      if (focusCategory) return n.category === focusCategory ? 1 : 0.18;
      if (trace && !hover) return traced(n) || n.category === "core" ? 1 : 0.32;
      var f = hover || pinned;
      if (!f || f === n) return 1;
      return neighbours[f.id][n.id] ? 1 : 0.42;
    }

    function drawLinks() {
      var f = hover || pinned;
      sim.links.forEach(function (l) {
        var a = l.a;
        var b = l.b;
        var lit = f && (a === f || b === f);
        var fade = Math.min(focusAlpha(a), focusAlpha(b));
        ctx.setLineDash([]);
        if (l.kind === "core") {
          if (b.category === "engine") {
            var g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
            g.addColorStop(0, "rgba(255,255,255," + (lit ? 0.7 : 0.26) * fade + ")");
            g.addColorStop(1, "rgba(34,211,238," + (lit ? 0.9 : 0.38) * fade + ")");
            ctx.strokeStyle = g;
            ctx.lineWidth = lit ? 3.4 : 2.4;
          } else if (b.category === "heart") {
            // Liens du cœur : courts, chauds, teintés par l'émotion de la bulle.
            ctx.strokeStyle = rgba(colorOf(b), (lit ? 0.85 : 0.42) * fade);
            ctx.lineWidth = lit ? 2.6 : 1.8;
          } else if (b.category === "shadow") {
            ctx.strokeStyle = rgba(colorOf(b), (lit ? 0.5 : 0.1) * fade);
            ctx.lineWidth = 0.8;
            ctx.setLineDash([3, 5]);
          } else {
            if (!lit) return;
            ctx.strokeStyle = rgba(COLOR.succes, 0.35);
            ctx.lineWidth = 0.6;
          }
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          return;
        }
        var s = LINKS[l.kind] || LINKS.forge;
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        // Liens thématiques : légère courbe, pour se distinguer des rayons du noyau.
        var mx = (a.x + b.x) / 2 - dy * 0.14;
        var my = (a.y + b.y) / 2 + dx * 0.14;
        ctx.strokeStyle = rgba(s.c, Math.min(0.95, s.a * (lit ? 2.6 : 1)) * fade);
        ctx.lineWidth = s.w + (lit ? 0.7 : 0);
        if (s.dash) ctx.setLineDash(s.dash);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.stroke();
      });
      ctx.setLineDash([]);
    }

    /** Fusion : deux noyaux fantômes (A à gauche, B à droite) précipités l'un vers l'autre, puis un éclair. */
    function drawFusion(t) {
      var f = sim.fusion;
      if (f === null || !core || !PARENTS) return;
      if (f < 1) {
        var e = f * f * f; // accélération gravitationnelle
        [[W * 0.16, [191, 227, 255], PARENTS[0]], [W * 0.84, [255, 217, 160], PARENTS[1]]].forEach(function (g) {
          var x = g[0] + (core.x - g[0]) * e;
          var y = core.y + Math.sin(t * 9 + g[0]) * (1 - e) * 6;
          var r = 26 + 10 * e;
          ctx.globalCompositeOperation = "lighter";
          glow(x, y, r * 3.2, g[1], 0.35 + 0.4 * e);
          ctx.globalCompositeOperation = "source-over";
          var body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
          body.addColorStop(0, "#ffffff");
          body.addColorStop(1, rgba(g[1], 1));
          ctx.fillStyle = body;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          label(g[2], x, y + r + 6, 11.5, "rgba(255,255,255,0.85)", 600);
        });
      } else if (mergedAt === null) {
        mergedAt = t; // la carte mémorise que l'introduction a été jouée (merged, renvoyé par tick)
      }
      if (mergedAt !== null && t - mergedAt < 0.9) {
        var age = (t - mergedAt) / 0.9;
        ctx.strokeStyle = "rgba(255,255,255," + (1 - age) + ")";
        ctx.lineWidth = 3 * (1 - age) + 1;
        ctx.beginPath();
        ctx.arc(core.x, core.y, 30 + age * Math.min(W, H) * 0.45, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    function drawCore(n, t, alpha) {
      if (sim.fusion !== null && sim.fusion < 1) alpha *= Math.max(0, (sim.fusion - 0.85) / 0.15); // né de la fusion
      var r = n.r * sim.pulseOf(n);
      ctx.globalCompositeOperation = "lighter";
      glow(n.x, n.y, r * 3.4, [150, 190, 255], 0.3 * alpha);
      glow(n.x, n.y, r * 1.9, [235, 245, 255], 0.35 * alpha);
      ctx.globalCompositeOperation = "source-over";
      var g = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.35, r * 0.1, n.x, n.y, r);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.6, "#e0ecff");
      g.addColorStop(1, "#9cc2ff");
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 7]);
      ctx.beginPath();
      ctx.ellipse(n.x, n.y, r * 1.45, r * 1.45, reduced ? 0 : t * 0.25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    function drawEngine(n, alpha) {
      var r = n.r * sim.pulseOf(n);
      ctx.globalCompositeOperation = "lighter";
      glow(n.x, n.y, r * 2.7, COLOR.engine, 0.32 * alpha);
      ctx.globalCompositeOperation = "source-over";
      var g = ctx.createRadialGradient(n.x - r * 0.35, n.y - r * 0.4, r * 0.1, n.x, n.y, r);
      g.addColorStop(0, "rgba(236,254,255," + alpha + ")");
      g.addColorStop(0.55, "rgba(34,211,238," + alpha + ")");
      g.addColorStop(1, "rgba(14,116,144," + alpha + ")");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(165,243,252," + 0.85 * alpha + ")";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /** Cœur : orbe chaud qui bat (« lub-dub », rythme de l'émotion), teinté par son émotion. */
    function drawHeart(n, alpha) {
      var c = colorOf(n);
      var pulse = sim.pulseOf(n);
      var r = n.r * pulse;
      ctx.globalCompositeOperation = "lighter";
      glow(n.x, n.y, r * (2.4 + (pulse - 1) * 4), c, (0.3 + (pulse - 1) * 1.2) * alpha);
      ctx.globalCompositeOperation = "source-over";
      var g = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.35, r * 0.1, n.x, n.y, r);
      g.addColorStop(0, "rgba(255,241,242," + alpha + ")");
      g.addColorStop(0.5, rgba(c, alpha));
      g.addColorStop(1, rgba([Math.round(c[0] * 0.55), Math.round(c[1] * 0.35), Math.round(c[2] * 0.45)], alpha));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,228,230," + 0.8 * alpha + ")";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /** Charge émotionnelle d'une bulle d'une autre catégorie : fin halo de la couleur de l'émotion. */
    function drawEmotionHalo(n, t, alpha) {
      var em = emotionOf(n);
      if (!em || n.category === "heart") return;
      ctx.strokeStyle = rgba(em, (0.45 + 0.2 * Math.sin(t * 1.7 + n.phase)) * alpha);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * sim.pulseOf(n) + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    /** Aura du climat émotionnel : un voile par émotion, pondéré, qui tourne et respire lentement autour du noyau. */
    function drawAura(t) {
      var base = Math.min(W, H);
      if (!climate.length) {
        glow(core.x, core.y, base * 0.5, [70, 110, 255], 0.09);
        return;
      }
      climate.forEach(function (c, i) {
        var angle = (reduced ? 0 : t * 0.06) + (i * Math.PI * 2) / climate.length;
        var breath = reduced ? 1 : 1 + 0.06 * Math.sin(t * 0.5 + i * 1.3);
        var x = core.x + Math.cos(angle) * base * 0.1;
        var y = core.y + Math.sin(angle) * base * 0.08;
        glow(x, y, base * (0.32 + 0.3 * c.weight) * breath, EMOTION_COLOR[c.emotion], 0.05 + 0.12 * c.weight);
      });
    }

    function drawShadow(n, t, alpha) {
      var c = colorOf(n);
      var pulse = sim.pulseOf(n);
      var r = n.r * pulse;
      var glitching = !reduced && t < n.glitchUntil;
      ctx.globalCompositeOperation = "lighter";
      glow(n.x, n.y, r * 2.5, c, (0.18 + 0.2 * (pulse - 0.86) / 0.28) * alpha);
      if (glitching) {
        // Aberration chromatique : copies décalées rouge et cyan.
        ctx.strokeStyle = "rgba(255,40,90," + 0.75 * alpha + ")";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(n.x - 3, n.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(40,240,255," + 0.6 * alpha + ")";
        ctx.beginPath();
        ctx.arc(n.x + 3, n.y + 1, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
      var g = ctx.createRadialGradient(n.x, n.y, r * 0.15, n.x, n.y, r);
      g.addColorStop(0, "rgba(6,2,12," + alpha + ")");
      g.addColorStop(0.7, rgba([Math.round(c[0] * 0.35), Math.round(c[1] * 0.2), Math.round(c[2] * 0.4)], 0.95 * alpha));
      g.addColorStop(1, rgba(c, 0.9 * alpha));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(c, alpha);
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }

    function drawArtifact(n, alpha) {
      var c = colorOf(n);
      var trail = n.trail;
      if (trail.length > 1) {
        for (var i = 1; i < trail.length; i++) {
          ctx.strokeStyle = rgba(c, (i / trail.length) * 0.4 * alpha);
          ctx.lineWidth = n.r * 0.9 * (i / trail.length);
          ctx.beginPath();
          ctx.moveTo(trail[i - 1][0], trail[i - 1][1]);
          ctx.lineTo(trail[i][0], trail[i][1]);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = "lighter";
      glow(n.x, n.y, n.r * 3.4, c, 0.5 * alpha);
      ctx.globalCompositeOperation = "source-over";
      var g = ctx.createRadialGradient(n.x - n.r * 0.3, n.y - n.r * 0.3, 0, n.x, n.y, n.r);
      g.addColorStop(0, "rgba(255,251,235," + alpha + ")");
      g.addColorStop(1, rgba(c, alpha));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    /** Glitch des ombres : tranches horizontales du rendu décalées (copie de la toile sur elle-même). */
    function glitchSlices(n) {
      var r = n.r * 1.9;
      for (var k = 0; k < 3; k++) {
        var y = n.y - r + Math.random() * r * 2;
        var h = 1.5 + Math.random() * 4;
        var x = n.x - r;
        var off = (Math.random() - 0.5) * 16;
        ctx.drawImage(canvas, x * dpr, y * dpr, r * 2 * dpr, h * dpr, x + off, y, r * 2, h);
      }
    }

    /** Libellé détouré ; placed : rectangles déjà posés (un chevauchement l'omet). */
    function label(textValue, x, y, size, color, weight, placed) {
      ctx.font = (weight || 500) + " " + size + FONT;
      if (placed) {
        var half = ctx.measureText(textValue).width / 2 + 3;
        var box = [x - half, y - 1, x + half, y + size + 2];
        for (var i = 0; i < placed.length; i++) {
          var p = placed[i];
          if (box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]) return;
        }
        placed.push(box);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(2,2,8,0.75)";
      ctx.strokeText(textValue, x, y);
      ctx.fillStyle = color;
      ctx.fillText(textValue, x, y);
    }

    /** Texte coupé en lignes d'au plus maxWidth pixels (trois lignes au plus). */
    function wrapLines(textValue, maxWidth) {
      var lines = [];
      var line = "";
      textValue.split(" ").forEach(function (word) {
        var probe = line ? line + " " + word : word;
        if (line && ctx.measureText(probe).width > maxWidth) {
          lines.push(line);
          line = word;
        } else line = probe;
      });
      if (line) lines.push(line);
      return lines.slice(0, 3);
    }

    /** Ronds de la logique : fil tracé de bulle en bulle, rond numéroté, puis explication écrite lettre à lettre. */
    function drawTrace(now) {
      if (!trace) return;
      var elapsed = now - trace.start;
      var steps = trace.steps;
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      for (var i = 1; i < steps.length; i++) {
        var p = Math.min(1, Math.max(0, (elapsed - i * STEP_S + 0.5) / 0.5));
        if (p <= 0) break;
        var a = steps[i - 1].node;
        var b = steps[i].node;
        var x = a.x + (b.x - a.x) * p;
        var y = a.y + (b.y - a.y) * p;
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = "rgba(255,214,120,0.22)";
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(255,244,214,0.9)";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      steps.forEach(function (s, i) {
        var appear = elapsed - i * STEP_S;
        if (appear < 0) return;
        var n = s.node;
        var grow = Math.min(1, appear / 0.35);
        ctx.strokeStyle = "rgba(255,236,179," + (0.45 + 0.3 * Math.sin(now * 4 + i)) + ")";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * sim.pulseOf(n) + 5, 0, Math.PI * 2);
        ctx.stroke();
        // Rond numéroté, en haut à droite de la bulle.
        var rx = n.x + (n.r + 12) * Math.SQRT1_2;
        var ry = n.y - (n.r + 12) * Math.SQRT1_2;
        var g = ctx.createRadialGradient(rx - 3, ry - 3, 1, rx, ry, 10);
        g.addColorStop(0, "#fff7e0");
        g.addColorStop(1, "#f5b544");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(rx, ry, 9 * grow, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (grow < 1) return;
        ctx.font = "700 10.5" + FONT;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#3a2600";
        ctx.fillText(String(i + 1), rx, ry + 0.5);
        // L'explication s'écrit lettre à lettre.
        var written = s.why.slice(0, Math.floor(Math.max(0, appear - 0.3) * TYPE_RATE));
        if (!written) return;
        ctx.font = "500 10.5" + FONT;
        var lines = wrapLines(written, 170);
        var bw = 12;
        lines.forEach(function (l) { bw = Math.max(bw, ctx.measureText(l).width + 14); });
        var bh = lines.length * 13 + 8;
        var bx = rx + 13 + bw > W - 6 ? rx - 13 - bw : rx + 13;
        var by = Math.max(6, Math.min(H - bh - 6, ry - bh / 2));
        ctx.fillStyle = "rgba(10,10,20,0.8)";
        ctx.strokeStyle = "rgba(255,236,179,0.55)";
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 7);
        else ctx.rect(bx, by, bw, bh);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "rgba(255,244,214,0.96)";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        lines.forEach(function (l, k) { ctx.fillText(l, bx + 7, by + 4 + k * 13); });
      });
    }

    function drawRing(n, t, color, extra) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = reduced ? 0 : -t * 18;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + extra, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }

    function draw(t) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(sky, 0, 0, W, H);
      if (core) {
        ctx.globalCompositeOperation = "lighter";
        drawAura(t);
        ctx.globalCompositeOperation = "source-over";
      }
      drawLinks();
      var glitching = [];
      ORDER.forEach(function (cat) {
        sim.nodes.forEach(function (n) {
          if (n.category !== cat) return;
          var alpha = focusAlpha(n);
          if (cat === "core") drawCore(n, t, alpha);
          else if (cat === "heart") drawHeart(n, alpha);
          else if (cat === "engine") drawEngine(n, alpha);
          else if (cat === "shadow") {
            drawShadow(n, t, alpha);
            if (!reduced && t < n.glitchUntil) glitching.push(n);
          } else drawArtifact(n, alpha);
          drawEmotionHalo(n, t, alpha);
        });
      });
      glitching.forEach(glitchSlices);
      // Libellés : noyau, puis cœur et moteurs (du plus intense au moins intense, si la carte est assez grande),
      // puis années des artefacts ; un libellé qui en chevaucherait un autre déjà posé est omis.
      var roomy = W >= 560 && H >= 400;
      var placed = [];
      LABEL_ORDER.forEach(function (n) {
        var a = focusAlpha(n);
        if (n.category === "core") label(short(n.data.title, 34), n.x, n.y + n.r * 1.55 + 4, 12.5, "rgba(255,255,255," + 0.92 * a + ")", 600, placed);
        else if (n.category === "heart" && roomy) label(short(n.data.title, 22), n.x, n.y + n.r + 4, 10, "rgba(255,228,230," + 0.85 * a + ")", 500, placed);
        else if (n.category === "engine" && roomy) label(short(n.data.title, 24), n.x, n.y + n.r + 5, 10.5, "rgba(207,250,254," + 0.8 * a + ")", 500, placed);
        else if (n.category === "artifact" && W >= 640 && n.data.date) {
          var year = n.data.date.charAt(0) === "-" ? n.data.date.split("-")[1] : n.data.date.split("-")[0];
          label(year, n.x, n.y + n.r + 3, 9, "rgba(253,230,138," + 0.6 * a + ")", 500, placed);
        }
      });
      if (pinned) drawRing(pinned, t, "rgba(255,255,255,0.85)", 7);
      if (dropTarget) {
        var beat = 0.5 + 0.5 * Math.sin(t * 8);
        drawRing(dropTarget, t, "rgba(125,249,255," + (0.6 + 0.4 * beat) + ")", 9 + beat * 4);
      }
      var nowMs = clock();
      sim.nodes.forEach(function (n) {
        if (!n.flash) return;
        var age = (nowMs - n.flash) / 700;
        if (age >= 1) { n.flash = 0; return; }
        ctx.strokeStyle = "rgba(125,249,255," + (1 - age) + ")";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 6 + age * 40, 0, Math.PI * 2);
        ctx.stroke();
      });
      drawFusion(t);
      drawTrace(nowMs / 1000);
    }

    // ---------------------------------------------------------------- boucle
    var last = null;
    var perf = { frames: 0, physics: 0, draw: 0, since: clock() };

    return {
      resize: function (w, h, ratio) {
        dpr = ratio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        if (w !== W || h !== H) sim.resize(w, h);
        W = w;
        H = h;
        paintSky();
      },
      set: function (patch) {
        if (!patch) return;
        if ("hover" in patch) hover = byId[patch.hover] || null;
        if ("pinned" in patch) pinned = byId[patch.pinned] || null;
        if ("drop" in patch) dropTarget = byId[patch.drop] || null;
        if ("focus" in patch) focusCategory = patch.focus || null;
        if ("trace" in patch) {
          var steps = (Array.isArray(patch.trace) ? patch.trace : []).map(function (s) {
            return s && byId[s.id] ? { node: byId[s.id], why: String(s.why || "").slice(0, 120) } : null;
          }).filter(Boolean).slice(0, 4);
          trace = steps.length ? { steps: steps, start: clock() / 1000 } : null;
        }
      },
      flash: function (id) {
        if (byId[id]) byId[id].flash = clock();
      },
      tick: function (nowMs, steps) {
        var dt = last === null ? 0 : Math.min(0.1, Math.max(0, (nowMs - last) / 1000));
        last = nowMs;
        var t0 = clock();
        sim.advance(reduced ? dt * 0.35 : dt, steps);
        var t1 = clock();
        var t = nowMs / 1000;
        var fusing = sim.fusion !== null && sim.fusion < 1;
        sim.nodes.forEach(function (n) {
          if (n.category === "artifact") {
            n.trail.push([n.x, n.y]);
            if (n.trail.length > 12) n.trail.shift();
          } else if (n.category === "shadow" && fusing) {
            n.glitchUntil = t + 0.12; // fusion : les ombres se heurtent et glitchent sans répit
          } else if (n.category === "shadow" && t >= n.glitchAt) {
            n.glitchUntil = t + 0.08 + Math.random() * 0.2;
            n.glitchAt = t + 1.5 + Math.random() * 4.5;
          }
        });
        draw(t);
        perf.frames += 1;
        perf.physics += t1 - t0;
        perf.draw += clock() - t1;
        var merged = mergedAt !== null && !mergedSent;
        if (merged) mergedSent = true;
        return { fusing: fusing, merged: merged };
      },
      /** Reprise après une pause (carte cachée) : pas de bond de la physique. */
      resume: function () { last = null; },
      pixels: function (points) {
        return (points || []).map(function (p) {
          var x = Math.max(0, Math.min(canvas.width - 1, Math.round(p[0] * dpr)));
          var y = Math.max(0, Math.min(canvas.height - 1, Math.round(p[1] * dpr)));
          return Array.from(ctx.getImageData(x, y, 1, 1).data);
        });
      },
      stats: function () {
        var now = clock();
        var span = Math.max(1, now - perf.since) / 1000;
        var out = {
          fps: perf.frames / span,
          physics: perf.frames ? perf.physics / perf.frames : 0,
          draw: perf.frames ? perf.draw / perf.frames : 0
        };
        perf = { frames: 0, physics: 0, draw: 0, since: now };
        return out;
      }
    };
  }

  /**
   * Cadence des images d'une carte : pleine vitesse quand elle est manipulée (pointeur dessus, fiche, dépôt) ;
   * au repos, 30 images/s au plus, et moins quand une image coûte cher : une carte au repos prend au plus sa part
   * (share) d'un cœur — la page la fixe selon le nombre d'Engrammes (budget commun) : sur une petite machine,
   * dix Engrammes vivants ne privent ni la page ni les autres cartes.
   */
  function createPacer() {
    var last = null; // instant de la dernière image (null : aucune encore)
    var cost = 0;
    var share = 0.3;
    return {
      /** Faut-il dessiner à cet instant ? */
      due: function (now, interactive) {
        var interval = interactive ? 0 : Math.min(1000 / 8, Math.max(1000 / 30, cost / share));
        return last === null || now - last >= interval - 4;
      },
      /** Part d'un cœur accordée au repos (0,05 à 0,5). */
      share: function (value) {
        if (typeof value === "number" && value === value) share = Math.min(0.5, Math.max(0.05, value));
      },
      /** Pas de physique autorisés pour couvrir le temps écoulé depuis la dernière image (pas de 1/120 s). */
      steps: function (now) {
        return Math.max(4, Math.ceil((last === null ? 16 : now - last) / (1000 / 120)) + 1);
      },
      done: function (now, ms) {
        last = now;
        cost = cost ? cost * 0.8 + ms * 0.2 : ms;
      },
      reset: function () { last = null; }
    };
  }

  return { createRenderer: createRenderer, createPacer: createPacer, COLOR: COLOR, EMOTION_COLOR: EMOTION_COLOR, LEGEND: LEGEND, colorOf: colorOf, rgba: rgba };
});
