"""Backend Prism branché sur un FAUX Groq local, pour les tests E2E du chemin « modèle réel ».

Sans clé ni quota, on exerce toute la chaîne : prompt système, résumé du fichier joint,
nettoyage de la réponse (le faux modèle répond volontairement en Markdown), épinglage de
Chart.js, refactorisation d'une carte.

Usage :  python tools/e2e_server.py      → Prism sur http://127.0.0.1:8003 (faux Groq sur :8002)
Réservé aux tests : n'écoute que sur 127.0.0.1.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOCKS = ROOT / "frontend" / "engine" / "mocks"
FAKE_PORT = int(os.getenv("PRISM_FAKE_GROQ_PORT", "8002"))
PORT = int(os.getenv("PRISM_E2E_PORT", "8003"))

# Doit précéder l'import de app (configuration lue au chargement du module).
os.environ.update(
    GROQ_API_KEY="fake-e2e-key",
    GROQ_URL=f"http://127.0.0.1:{FAKE_PORT}/openai/v1/chat/completions",
    GROQ_MODELS="fake/e2e-model",
    PRISM_HOST="127.0.0.1",
    PRISM_PORT=str(PORT),
)


def fake_widget(user_message: str) -> str:
    if "current source of an existing widget" in user_message:
        current = user_message.split("<<<\n", 1)[1].split("\n>>>", 1)[0]
        marker = '<p id="refactored" style="margin:0 0 8px;color:var(--accent)">Refactorisé par le faux Groq</p>'
        return re.sub(r"(<main[^>]*>)", r"\1" + marker, current, count=1)
    if "ATTACHED FILE" in user_message:
        return (MOCKS / "csv-chart.html").read_text(encoding="utf-8")
    html = (MOCKS / "counter.html").read_text(encoding="utf-8")
    return html.replace("<title>Bouton caméléon</title>", "<title>Compteur (faux Groq)</title>")


class FakeGroq(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        user = body["messages"][1]["content"]
        # Réponse « à la LLM » : prose + bloc Markdown, que Prism doit nettoyer.
        content = "Voici le widget demandé :\n```html\n" + fake_widget(user) + "\n```\nBonne utilisation !"
        payload = json.dumps({"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):  # silencieux
        pass


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), FakeGroq)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    sys.path.insert(0, str(ROOT / "backend"))
    import uvicorn

    import app  # noqa: E402

    print(f"Prism (faux Groq :{FAKE_PORT}) sur http://127.0.0.1:{PORT}", flush=True)
    uvicorn.run(app.app, host="127.0.0.1", port=PORT, loop=app.UVICORN_LOOP)


if __name__ == "__main__":
    main()
