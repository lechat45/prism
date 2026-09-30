/*
 * Atmosphère du Nexus (V6.2) : brume volumétrique éclairée par les bulles, sur une toile WebGL derrière le canvas.
 *
 * Chaque bulle est une source de lumière (position à l'écran, rayon, couleur, intensité) : la lumière se diffuse dans la
 * brume (plus la brume est dense, plus elle s'y voit), et les cartes de verre, floutées par-dessus, laissent passer cette
 * lueur (transmission à travers le verre). La météo évolue d'elle-même (clair, brume, aurore, orage : éclairs brefs) ou
 * se fixe dans les Paramètres. Calcul à demi-résolution, cadence plafonnée (30 ou 60 images/s), pause si la page est
 * cachée ; figée si l'on réduit les animations. Sans WebGL matériel (rendu logiciel, pilote capricieux) : lueurs en
 * dégradés 2D, bien moins coûteuses. fps : 30, 60, 144… ou 0 pour suivre la fréquence de l'écran.
 *
 * PrismAtmosphere.create(canvas, { lights: () => [{ x, y, r, color: [r,g,b] (0-1), i }] }) → {
 *   set({ enabled, density, weather, light, fps, reduced }) ; frame() ; destroy() ; weather() → nom courant ; mode ("webgl" | "2d")
 * }
 */
(function (root) {
  "use strict";

  var WEATHERS = {
    clair: { tint: [0.32, 0.42, 0.78], density: 0.5, aurora: 0, storm: 0, speed: 1 },
    brume: { tint: [0.52, 0.58, 0.74], density: 1.25, aurora: 0, storm: 0, speed: 0.6 },
    aurore: { tint: [0.26, 0.5, 0.62], density: 0.8, aurora: 1, storm: 0, speed: 0.9 },
    orage: { tint: [0.3, 0.3, 0.5], density: 1.05, aurora: 0, storm: 1, speed: 1.6 }
  };
  var CYCLE = ["clair", "brume", "aurore", "clair", "orage"];
  var CYCLE_S = 75; // durée d'une météo en mode automatique
  var FADE_S = 12; // fondu d'une météo à l'autre
  var MAX_LIGHTS = 12;

  var VERTEX = "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }";
  var FRAGMENT = [
    "precision mediump float;",
    "uniform vec2 res; uniform float time; uniform float density; uniform float aurora; uniform float flash; uniform float light;",
    "uniform vec3 tint; uniform int count; uniform vec4 lights[" + MAX_LIGHTS + "]; uniform vec3 colors[" + MAX_LIGHTS + "];",
    "float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
    "float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);",
    "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }",
    "float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int k = 0; k < 5; k++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }",
    "void main() {",
    "  vec2 frag = gl_FragCoord.xy; vec2 q = frag / res.y;",
    "  vec2 drift = vec2(time * 0.018, time * 0.009);",
    "  float warp = fbm(q * 1.6 + drift);",
    "  float fog = fbm(q * 2.4 + vec2(warp * 1.3) - drift * 1.4);", // brume en volutes (domaine déformé)
    "  fog = smoothstep(0.28, 0.95, fog) * density;",
    "  vec3 col = tint * fog * 0.46;",
    "  for (int i = 0; i < " + MAX_LIGHTS + "; i++) {",
    "    if (i >= count) break;",
    "    vec4 L = lights[i]; float d = distance(frag, L.xy); float r = max(L.z, 1.0);",
    "    float core = exp(-d * d / (r * r * 0.9));", // lueur de la bulle
    "    float halo = exp(-d / (r * 3.4));", // diffusion lointaine, portée par la brume
    "    col += colors[i] * L.w * light * (core * (0.3 + fog * 1.1) + halo * (0.08 + fog * 1.15));",
    "  }",
    "  if (aurora > 0.0) {",
    "    float band = sin(q.x * 3.2 + time * 0.12 + fbm(q * 1.2 + time * 0.03) * 3.4) * 0.5 + 0.5;",
    "    float veil = smoothstep(0.55, 1.0, band) * smoothstep(0.15, 0.85, q.y / (res.x / res.y) * 1.2 + 0.25);",
    "    col += aurora * veil * mix(vec3(0.1, 0.9, 0.6), vec3(0.55, 0.3, 0.95), q.x / (res.x / res.y)) * 0.22;",
    "  }",
    "  col += flash * vec3(0.75, 0.82, 1.0) * (0.25 + fog * 0.9);",
    "  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);",
    "  gl_FragColor = vec4(col, a);",
    "}"
  ].join("\n");

  function lerp(a, b, t) { return a + (b - a) * t; }
  function mixW(a, b, t) {
    return {
      tint: [lerp(a.tint[0], b.tint[0], t), lerp(a.tint[1], b.tint[1], t), lerp(a.tint[2], b.tint[2], t)],
      density: lerp(a.density, b.density, t), aurora: lerp(a.aurora, b.aurora, t), storm: lerp(a.storm, b.storm, t),
      speed: lerp(a.speed, b.speed, t)
    };
  }

  function create(canvas, o) {
    var opts = { enabled: true, density: 0.55, weather: "auto", light: 0.7, fps: 30, reduced: false };
    var gl = null;
    // failIfMajorPerformanceCaveat : pas de WebGL « logiciel » (il chargerait le processeur à chaque image).
    try { gl = canvas.getContext("webgl", { premultipliedAlpha: false, alpha: true, antialias: false, failIfMajorPerformanceCaveat: true }); } catch (e) { gl = null; }
    var ctx2d = gl ? null : canvas.getContext("2d");
    var prog = null;
    var loc = {};
    if (gl) {
      var compile = function (type, src) {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAGMENT));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        var p = gl.getAttribLocation(prog, "p");
        gl.enableVertexAttribArray(p);
        gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
        ["res", "time", "density", "aurora", "flash", "light", "tint", "count", "lights", "colors"].forEach(function (name) {
          loc[name] = gl.getUniformLocation(prog, name);
        });
      } catch (err) {
        gl = null; // pilote capricieux : repli 2D, sur une toile neuve (celle-ci garde son contexte WebGL)
        var fresh = canvas.cloneNode(false);
        if (canvas.parentNode) canvas.parentNode.replaceChild(fresh, canvas);
        canvas = fresh;
        ctx2d = canvas.getContext("2d");
      }
    }
    var lightBuf = new Float32Array(MAX_LIGHTS * 4);
    var colorBuf = new Float32Array(MAX_LIGHTS * 3);
    var start = performance.now();
    var last = 0;
    var raf = 0;
    var flash = 0;
    var nextFlash = 4 + Math.random() * 6;
    var current = "clair";

    function weatherAt(t) {
      if (opts.weather !== "auto" && WEATHERS[opts.weather]) { current = opts.weather; return WEATHERS[opts.weather]; }
      var k = Math.floor(t / CYCLE_S);
      var into = t - k * CYCLE_S;
      var a = CYCLE[((k % CYCLE.length) + CYCLE.length) % CYCLE.length];
      var b = CYCLE[(((k + 1) % CYCLE.length) + CYCLE.length) % CYCLE.length];
      current = into > CYCLE_S - FADE_S / 2 ? b : a;
      if (into < CYCLE_S - FADE_S) return WEATHERS[a];
      return mixW(WEATHERS[a], WEATHERS[b], (into - (CYCLE_S - FADE_S)) / FADE_S);
    }

    function resize() {
      var scale = 0.5; // demi-résolution : la brume est floue par nature
      var w = Math.max(1, Math.round(canvas.clientWidth * scale));
      var h = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      return scale;
    }

    function draw(now) {
      var scale = resize();
      // L'horodatage d'une image peut précéder la création (rAF) : jamais de temps négatif.
      var t = (opts.reduced ? 12000 : Math.max(0, now - start)) / 1000;
      var w = weatherAt(t);
      var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      // Orage : éclairs brefs, espacés au hasard.
      if (w.storm > 0.2 && !opts.reduced) {
        nextFlash -= dt;
        if (nextFlash <= 0) { flash = 1; nextFlash = 5 + Math.random() * 10; }
      }
      flash *= Math.pow(0.02, dt);
      var list = (o.lights ? o.lights() : []).slice(0, MAX_LIGHTS);
      if (gl) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        lightBuf.fill(0);
        colorBuf.fill(0);
        list.forEach(function (L, i) {
          lightBuf[i * 4] = L.x * scale;
          lightBuf[i * 4 + 1] = canvas.height - L.y * scale; // repère WebGL : origine en bas
          lightBuf[i * 4 + 2] = L.r * scale;
          lightBuf[i * 4 + 3] = L.i;
          colorBuf[i * 3] = L.color[0];
          colorBuf[i * 3 + 1] = L.color[1];
          colorBuf[i * 3 + 2] = L.color[2];
        });
        gl.uniform2f(loc.res, canvas.width, canvas.height);
        gl.uniform1f(loc.time, t * w.speed);
        gl.uniform1f(loc.density, opts.density * w.density);
        gl.uniform1f(loc.aurora, w.aurora);
        gl.uniform1f(loc.flash, flash * w.storm);
        gl.uniform1f(loc.light, opts.light);
        gl.uniform3f(loc.tint, w.tint[0], w.tint[1], w.tint[2]);
        gl.uniform1i(loc.count, list.length);
        gl.uniform4fv(loc.lights, lightBuf);
        gl.uniform3fv(loc.colors, colorBuf);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else if (ctx2d) {
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        ctx2d.globalCompositeOperation = "lighter";
        list.forEach(function (L) {
          var r = L.r * scale * 2.4;
          var g = ctx2d.createRadialGradient(L.x * scale, L.y * scale, 0, L.x * scale, L.y * scale, r);
          var c = L.color.map(function (v) { return Math.round(v * 255); }).join(",");
          g.addColorStop(0, "rgba(" + c + "," + 0.35 * L.i * opts.light * (0.4 + opts.density) + ")");
          g.addColorStop(1, "rgba(" + c + ",0)");
          ctx2d.fillStyle = g;
          ctx2d.fillRect(L.x * scale - r, L.y * scale - r, r * 2, r * 2);
        });
        ctx2d.globalCompositeOperation = "source-over";
      }
    }

    function loop(now) {
      raf = 0;
      if (!opts.enabled) return;
      var interval = opts.fps > 0 ? 1000 / opts.fps : 0; // 0 : fréquence de l'écran
      if (!document.hidden && now - last >= interval - 2) {
        draw(now);
        last = now;
      }
      if (!opts.reduced || flash > 0.01) raf = requestAnimationFrame(loop);
    }
    function kick() {
      canvas.style.display = opts.enabled ? "" : "none";
      if (!opts.enabled) return;
      if (opts.reduced) { draw(performance.now()); return; } // image fixe
      if (!raf) raf = requestAnimationFrame(loop);
    }
    function onVisible() { if (!document.hidden) kick(); }
    document.addEventListener("visibilitychange", onVisible);
    kick();

    return {
      mode: gl ? "webgl" : "2d",
      set: function (patch) {
        Object.keys(patch || {}).forEach(function (k) { if (patch[k] !== undefined) opts[k] = patch[k]; });
        last = 0;
        kick();
      },
      frame: function () { if (opts.enabled) draw(performance.now()); },
      weather: function () { return current; },
      options: function () { return Object.assign({}, opts); },
      destroy: function () {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }

  root.PrismAtmosphere = { create: create, WEATHERS: Object.keys(WEATHERS) };
})(typeof self !== "undefined" ? self : this);
