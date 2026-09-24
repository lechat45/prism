"""Composants de démonstration servis quand GROQ_API_KEY n'est pas renseignée.

Chaque gabarit est un document HTML autonome qui respecte le même contrat que
la sortie attendue du LLM (aucune ressource externe, JS vanilla, thème verre).
Le choix du gabarit se fait par mots-clés sur la demande de l'utilisateur.
"""
from __future__ import annotations

import html
import json
import re
import unicodedata

BASE_CSS = """
:root{color-scheme:dark;--bg:#0b0d12;--glass:rgba(255,255,255,.06);--glass-2:rgba(255,255,255,.1);
--line:rgba(255,255,255,.14);--text:#f4f6fb;--muted:#9aa3b5;--accent:#7cc4ff}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--text);
background:radial-gradient(circle at 20% 10%,#1d2a4a 0,transparent 45%),radial-gradient(circle at 85% 90%,#3a1d4a 0,transparent 45%),var(--bg);
display:grid;place-items:center;padding:24px;min-height:100vh}
.card{width:min(560px,100%);background:var(--glass);border:1px solid var(--line);border-radius:22px;padding:28px;
backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);
box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 20px 50px rgba(0,0,0,.45)}
h1{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0 0 22px;font-size:13px}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""


def _page(title: str, body: str, css: str = "", js: str = "") -> str:
    return (
        "<!DOCTYPE html>\n<html lang=\"fr\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"<title>{html.escape(title)}</title>\n<style>{BASE_CSS}{css}</style>\n</head>\n<body>\n"
        f"{body}\n<script>\n{js}\n</script>\n</body>\n</html>"
    )


def _js_value(value: object) -> str:
    """JSON sûr à injecter dans un <script> (pas de fermeture de balise possible)."""
    return json.dumps(value, ensure_ascii=False).replace("</", "<\\/")


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


# --------------------------------------------------------------------------- #
# Gabarits
# --------------------------------------------------------------------------- #

def _counter() -> str:
    css = """
.stage{display:flex;flex-direction:column;align-items:center;gap:20px;padding:12px 0 4px}
#magic{width:190px;height:190px;border-radius:50%;border:1px solid rgba(255,255,255,.35);
background:var(--c,#5b8cff);font-size:18px;font-weight:600;letter-spacing:.02em;
box-shadow:0 0 0 6px rgba(255,255,255,.04),0 18px 50px -8px var(--c,#5b8cff),inset 0 2px 0 rgba(255,255,255,.35);
transition:background .3s ease,box-shadow .3s ease,transform .12s ease}
#magic:active{transform:scale(.95)}
.count{font-size:44px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1}
.label{color:var(--muted);font-size:13px}
.row{display:flex;gap:10px}
.ghost{background:var(--glass-2);border:1px solid var(--line);border-radius:12px;padding:8px 14px;font-size:13px}
.swatch{width:14px;height:14px;border-radius:50%;display:inline-block;vertical-align:-2px;margin-right:6px;background:var(--c,#5b8cff)}
"""
    body = """
<main class="card">
  <h1>Bouton caméléon</h1>
  <p class="sub">Chaque clic change la couleur et incrémente le compteur.</p>
  <div class="stage">
    <button id="magic" type="button" aria-describedby="count-label">Clique-moi</button>
    <div class="count" id="count" aria-live="polite">0</div>
    <div class="label" id="count-label">clics · <span class="swatch" id="swatch"></span><span id="hex">#5B8CFF</span></div>
    <div class="row"><button class="ghost" id="reset" type="button">Réinitialiser</button></div>
  </div>
</main>"""
    js = """
const palette = ["#5B8CFF", "#FF5B8C", "#35D0A5", "#FFB547", "#A66BFF", "#3EC7FF", "#FF7A45"];
const btn = document.getElementById("magic");
const countEl = document.getElementById("count");
const hexEl = document.getElementById("hex");
let clicks = 0;

function paint(color) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.style.setProperty("--c", color);
  btn.style.color = luminance > 0.6 ? "#0b0d12" : "#ffffff";
  hexEl.textContent = color;
}

btn.addEventListener("click", () => {
  clicks += 1;
  countEl.textContent = clicks;
  paint(palette[clicks % palette.length]);
  btn.textContent = clicks === 1 ? "Encore !" : "Clic n°" + (clicks + 1);
});

document.getElementById("reset").addEventListener("click", () => {
  clicks = 0;
  countEl.textContent = "0";
  btn.textContent = "Clique-moi";
  paint(palette[0]);
});

paint(palette[0]);
"""
    return _page("Bouton caméléon", body, css, js)


def _calculator() -> str:
    css = """
.display{background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:16px;padding:14px 18px;text-align:right;margin-bottom:14px}
.expr{color:var(--muted);font-size:13px;min-height:20px}
.value{font-size:38px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.keys{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.keys button{height:58px;border-radius:16px;border:1px solid var(--line);background:var(--glass-2);font-size:18px;transition:background .15s,transform .1s}
.keys button:hover{background:rgba(255,255,255,.16)}
.keys button:active{transform:scale(.96)}
.keys .op{background:rgba(124,196,255,.18);color:#bfe3ff}
.keys .eq{background:linear-gradient(135deg,#5b8cff,#a66bff);border-color:rgba(255,255,255,.3)}
.keys .wide{grid-column:span 2}
"""
    body = """
<main class="card">
  <h1>Calculatrice</h1>
  <p class="sub">Clavier physique pris en charge (chiffres, + − × ÷, Entrée, Échap).</p>
  <div class="display" aria-live="polite"><div class="expr" id="expr"></div><div class="value" id="value">0</div></div>
  <div class="keys" id="keys">
    <button data-k="C">C</button><button data-k="±">±</button><button data-k="%">%</button><button class="op" data-k="/">÷</button>
    <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button><button class="op" data-k="*">×</button>
    <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button><button class="op" data-k="-">−</button>
    <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button><button class="op" data-k="+">+</button>
    <button class="wide" data-k="0">0</button><button data-k=".">,</button><button class="eq" data-k="=">=</button>
  </div>
</main>"""
    js = """
const valueEl = document.getElementById("value");
const exprEl = document.getElementById("expr");
const symbols = { "+": "+", "-": "−", "*": "×", "/": "÷" };
let current = "0", stored = null, op = null, fresh = false;

const fmt = (n) => Number.isFinite(n) ? String(Number(n.toPrecision(12))).replace(".", ",") : "Erreur";
function render() {
  valueEl.textContent = current.replace(".", ",");
  exprEl.textContent = stored !== null && op ? fmt(stored) + " " + symbols[op] : "";
}
function compute(a, b, o) {
  if (o === "+") return a + b;
  if (o === "-") return a - b;
  if (o === "*") return a * b;
  if (o === "/") return b === 0 ? NaN : a / b;
  return b;
}
function press(k) {
  if (/^[0-9]$/.test(k)) {
    current = fresh || current === "0" ? k : current + k;
    fresh = false;
  } else if (k === ".") {
    if (fresh) { current = "0"; fresh = false; }
    if (!current.includes(".")) current += ".";
  } else if (k in symbols) {
    if (op && !fresh) current = String(compute(stored, parseFloat(current), op));
    stored = parseFloat(current); op = k; fresh = true;
  } else if (k === "=") {
    if (op === null) return;
    const result = compute(stored, parseFloat(current), op);
    current = Number.isFinite(result) ? String(Number(result.toPrecision(12))) : "Erreur";
    stored = null; op = null; fresh = true;
  } else if (k === "C") {
    current = "0"; stored = null; op = null; fresh = false;
  } else if (k === "±") {
    current = current.startsWith("-") ? current.slice(1) : (current === "0" ? "0" : "-" + current);
  } else if (k === "%") {
    current = String(parseFloat(current) / 100);
  }
  if (current === "NaN") current = "Erreur";
  render();
}
document.getElementById("keys").addEventListener("click", (e) => {
  const key = e.target.closest("button");
  if (key) press(key.dataset.k);
});
document.addEventListener("keydown", (e) => {
  const map = { Enter: "=", Escape: "C", ",": "." };
  const k = map[e.key] || e.key;
  if (/^[0-9.+\\-*\\/=%C]$/.test(k)) { e.preventDefault(); press(k); }
});
render();
"""
    return _page("Calculatrice", body, css, js)


_PAIR_RE = re.compile(
    r"([A-Za-zÀ-ÖØ-öø-ÿ][\wÀ-ÖØ-öø-ÿ '’-]{0,28}?)\s*[:=;,\t]?\s*(-?\d+(?:[.,]\d+)?)"
)


def extract_series(prompt: str) -> list[dict[str, float | str]]:
    """Récupère des paires « libellé : valeur » dans le texte collé par l'utilisateur."""
    series = []
    for label, value in _PAIR_RE.findall(prompt):
        label = label.strip(" '’-")
        if label and len(series) < 12:
            series.append({"label": label[:24], "value": float(value.replace(",", "."))})
    return series


def _dashboard(prompt: str) -> str:
    series = extract_series(prompt)
    source = "vos données" if len(series) >= 2 else "données d'exemple"
    if len(series) < 2:
        series = [
            {"label": m, "value": v}
            for m, v in zip(
                ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin"], [12400, 15100, 13850, 18200, 21400, 19750]
            )
        ]
    css = """
.card{width:min(760px,100%)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:var(--glass-2);border:1px solid var(--line);border-radius:16px;padding:12px 14px}
.kpi span{display:block;color:var(--muted);font-size:12px}
.kpi strong{font-size:22px;font-variant-numeric:tabular-nums}
.chart{background:rgba(0,0,0,.25);border:1px solid var(--line);border-radius:16px;padding:12px}
svg{width:100%;height:auto;display:block}
.bar{transition:opacity .15s}
.bar:hover{opacity:.8}
.tip{fill:var(--text);font-size:11px;text-anchor:middle}
.axis{fill:var(--muted);font-size:11px;text-anchor:middle}
.toolbar{display:flex;gap:8px;margin:0 0 14px}
.toolbar button{background:var(--glass-2);border:1px solid var(--line);border-radius:10px;padding:6px 12px;font-size:13px}
.toolbar button[aria-pressed="true"]{background:rgba(124,196,255,.22);border-color:rgba(124,196,255,.5)}
"""
    body = f"""
<main class="card">
  <h1>Tableau de bord</h1>
  <p class="sub">Généré à partir de {html.escape(source)} · survolez les barres.</p>
  <section class="kpis" id="kpis" aria-label="Indicateurs clés"></section>
  <div class="toolbar" role="group" aria-label="Tri">
    <button type="button" data-sort="none" aria-pressed="true">Ordre d'origine</button>
    <button type="button" data-sort="desc" aria-pressed="false">Tri décroissant</button>
  </div>
  <div class="chart"><svg id="chart" viewBox="0 0 700 280" role="img" aria-label="Histogramme"></svg></div>
</main>"""
    js = f"""
const DATA = {_js_value(series)};
const NS = "http://www.w3.org/2000/svg";
const nf = new Intl.NumberFormat("fr-FR", {{ maximumFractionDigits: 2 }});
const values = DATA.map((d) => d.value);
const total = values.reduce((a, b) => a + b, 0);
const kpis = [
  ["Total", total],
  ["Moyenne", total / values.length],
  ["Maximum", Math.max(...values)],
  ["Minimum", Math.min(...values)],
];
document.getElementById("kpis").innerHTML = kpis
  .map(([k, v]) => '<div class="kpi"><span>' + k + "</span><strong>" + nf.format(v) + "</strong></div>")
  .join("");

function el(name, attrs, text) {{
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}}

function draw(rows) {{
  const svg = document.getElementById("chart");
  svg.replaceChildren();
  const W = 700, H = 280, pad = 34, max = Math.max(...rows.map((r) => r.value), 1);
  const slot = (W - pad * 2) / rows.length, bw = Math.min(56, slot * 0.62);
  const grad = el("linearGradient", {{ id: "g", x1: 0, y1: 0, x2: 0, y2: 1 }});
  grad.append(el("stop", {{ offset: "0%", "stop-color": "#7cc4ff" }}), el("stop", {{ offset: "100%", "stop-color": "#a66bff" }}));
  const defs = el("defs", {{}});
  defs.append(grad);
  svg.append(defs);
  rows.forEach((r, i) => {{
    const h = Math.max(0, (r.value / max) * (H - pad * 2));
    const x = pad + i * slot + (slot - bw) / 2, y = H - pad - h;
    const bar = el("rect", {{ class: "bar", x, y, width: bw, height: h, rx: 8, fill: "url(#g)" }});
    bar.append(el("title", {{}}, r.label + " : " + nf.format(r.value)));
    svg.append(bar, el("text", {{ class: "tip", x: x + bw / 2, y: y - 6 }}, nf.format(r.value)),
      el("text", {{ class: "axis", x: x + bw / 2, y: H - pad + 16 }}, r.label));
  }});
}}

document.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {{
  document.querySelectorAll("[data-sort]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
  draw(b.dataset.sort === "desc" ? [...DATA].sort((a, c) => c.value - a.value) : DATA);
}}));
draw(DATA);
"""
    return _page("Tableau de bord", body, css, js)


def _generic(prompt: str) -> str:
    css = """
blockquote{margin:0 0 18px;padding:14px 16px;border-left:3px solid var(--accent);background:rgba(0,0,0,.25);border-radius:0 14px 14px 0;white-space:pre-wrap;overflow-wrap:anywhere}
ol{padding-left:20px;color:var(--muted);margin:0 0 18px}
code{background:var(--glass-2);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:12px;color:var(--text)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:var(--glass-2);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px}
.chip[aria-pressed="true"]{background:rgba(124,196,255,.22);border-color:rgba(124,196,255,.5)}
"""
    body = f"""
<main class="card">
  <h1>Mode démo</h1>
  <p class="sub">Aucune clé Groq détectée : voici un aperçu statique de votre demande.</p>
  <blockquote>{html.escape(prompt)}</blockquote>
  <ol>
    <li>Créez une clé gratuite sur console.groq.com.</li>
    <li>Ajoutez <code>GROQ_API_KEY=…</code> dans <code>backend/.env</code>.</li>
    <li>Relancez le serveur : Prism générera un composant sur mesure.</li>
  </ol>
  <p class="sub">Essayez les démos intégrées :</p>
  <div class="chips" id="chips">
    <button class="chip" type="button" aria-pressed="false">compteur de clics</button>
    <button class="chip" type="button" aria-pressed="false">calculatrice</button>
    <button class="chip" type="button" aria-pressed="false">tableau de bord</button>
  </div>
</main>"""
    js = """
document.getElementById("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
});
"""
    return _page("Prism · démo", body, css, js)


_ROUTES = (
    ("dashboard", ("dashboard", "tableau de bord", "donnees", "data", "graph", "chart", "vente", "stat", "csv", "kpi")),
    ("calculator", ("calcul", "calculator", "calculette", "addition")),
    ("counter", ("bouton", "button", "clic", "click", "compteur", "counter")),
)


def mock_component(prompt: str) -> tuple[str, str]:
    """Retourne (html, nom_du_gabarit) pour une demande donnée."""
    text = _normalize(prompt)
    for name, keywords in _ROUTES:
        if any(k in text for k in keywords):
            if name == "dashboard":
                return _dashboard(prompt), name
            if name == "calculator":
                return _calculator(), name
            return _counter(), name
    if len(extract_series(prompt)) >= 2:
        return _dashboard(prompt), "dashboard"
    return _generic(prompt), "generic"
