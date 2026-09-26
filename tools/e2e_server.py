"""Backend Prism branché sur un FAUX Gemini local, pour les tests E2E du chemin « modèle réel ».

Sans clé ni quota, on exerce toute la chaîne : prompt système, résumé du fichier joint,
nettoyage de la réponse (le faux modèle répond volontairement en Markdown), épinglage de
Chart.js, refactorisation d'une carte. Comptes dans une base SQLite jetable (jamais data/prism.db).

Usage :  python tools/e2e_server.py         → Prism sur http://127.0.0.1:8003 (faux Gemini sur :8002, 3 Sparks)
         python tools/e2e_server.py --demo  → Prism en mode démo (sans modèle) sur http://127.0.0.1:8004
Réservé aux tests : n'écoute que sur 127.0.0.1.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOCKS = ROOT / "frontend" / "engine" / "mocks"
DEMO = "--demo" in sys.argv
FAKE_PORT = int(os.getenv("PRISM_FAKE_GEMINI_PORT", "8002"))
PORT = int(os.getenv("PRISM_E2E_PORT", "8004" if DEMO else "8003"))
DB_PATH = Path(tempfile.mkdtemp(prefix="prism-e2e-")) / "prism.db"

# Doit précéder l'import de app (configuration lue au chargement du module ; backend/.env ne
# remplace pas ces valeurs).
os.environ.update(
    GEMINI_API_KEY="" if DEMO else "fake-e2e-key",
    GEMINI_URL=f"http://127.0.0.1:{FAKE_PORT}/v1beta/models/{{model}}:generateContent",
    GEMINI_MODELS="fake-gemini-e2e",
    GROQ_API_KEY="",
    PRISM_HOST="127.0.0.1",
    PRISM_PORT=str(PORT),
    PRISM_DATABASE_URL=f"sqlite:///{DB_PATH.as_posix()}",
    # Avec modèle, 5 Sparks : quatre générations + une refactorisation (4,5) laissent 0,5 → l'E2E
    # atteint « Prism Pro ». En démo : le cadeau habituel.
    PRISM_SIGNUP_SPARKS=os.getenv("PRISM_SIGNUP_SPARKS", "50" if DEMO else "5"),
)


EMITTER = """<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Émetteur (faux Gemini)</title></head>
<body><main><p>Valeur : <span id="n">0</span></p><button id="emit" type="button">+1</button></main>
<script>
const state = Object.assign({ n: 0 }, JSON.parse(localStorage.getItem("state") || "null"));
function show() { document.getElementById("n").textContent = state.n; prism.emit("demo.valeur", { n: state.n }); }
document.getElementById("emit").addEventListener("click", () => { state.n += 1; localStorage.setItem("state", JSON.stringify(state)); show(); });
show();
</script></body></html>"""

RECEIVER = """<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Récepteur (faux Gemini)</title></head>
<body data-context="{context}"><main><p>Reçu : <output id="recu">rien</output></p></main>
<script>prism.on("demo.valeur", (data) => { document.getElementById("recu").textContent = String(data.n); });</script></body></html>"""


def fake_widget(user_message: str) -> str:
    if "current source of an existing widget" in user_message:
        current = user_message.split("<<<\n", 1)[1].split("\n>>>", 1)[0]
        marker = '<p id="refactored" style="margin:0 0 8px;color:var(--accent)">Refactorisé par le faux Gemini</p>'
        return re.sub(r"(<main[^>]*>)", r"\1" + marker, current, count=1)
    request = user_message.split("<<<\n", 1)[1].split("\n>>>", 1)[0].lower()
    if "émetteur" in request and "récepteur" not in request:
        return EMITTER
    if "récepteur" in request:
        # Le vrai modèle se brancherait grâce à la section CANVAS : on vérifie qu'elle est arrivée.
        context = "yes" if "CANVAS:" in user_message and "emits demo.valeur" in user_message else "no"
        return RECEIVER.replace("{context}", context)
    if "ATTACHED FILE" in user_message:
        return (MOCKS / "csv-chart.html").read_text(encoding="utf-8")
    html = (MOCKS / "counter.html").read_text(encoding="utf-8")
    return html.replace("<title>Bouton caméléon</title>", "<title>Compteur (faux Gemini)</title>")


class FakeGemini(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        user = body["contents"][0]["parts"][0]["text"]
        # Réponse « à la LLM » : prose + bloc Markdown, que Prism doit nettoyer.
        content = "Voici le widget demandé :\n```html\n" + fake_widget(user) + "\n```\nBonne utilisation !"
        # Réponse au format generateContent, avec une partie « réflexion » que Prism doit ignorer.
        parts = [{"text": "Je conçois le widget…", "thought": True}, {"text": content}]
        payload = json.dumps({"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):  # silencieux
        pass


def main() -> None:
    if not DEMO:
        server = ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), FakeGemini)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    sys.path.insert(0, str(ROOT / "backend"))
    import uvicorn

    import app  # noqa: E402

    engine = "mode démo" if DEMO else f"faux Gemini :{FAKE_PORT}"
    print(f"Prism ({engine}, base {DB_PATH}) sur http://127.0.0.1:{PORT}", flush=True)
    uvicorn.run(app.app, host="127.0.0.1", port=PORT, loop=app.UVICORN_LOOP)


if __name__ == "__main__":
    main()
