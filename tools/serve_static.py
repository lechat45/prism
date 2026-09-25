"""Sert Prism en fichiers purement statiques, comme GitHub Pages : aucun /api (404), donc le
frontend bascule sur son moteur navigateur. Uvicorn + keep-alive : bien plus rapide que
`python -m http.server` (une connexion par requête), qui faisait expirer les tests E2E.

Usage :  python tools/serve_static.py   → http://127.0.0.1:8001/  (n'écoute que sur 127.0.0.1)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import FileResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.getenv("PRISM_STATIC_PORT", "8001"))


async def root_index(request):
    return FileResponse(ROOT / "index.html")  # la redirection vers frontend/, comme sur Pages


app = Starlette(routes=[
    Route("/", root_index),
    Mount("/frontend", StaticFiles(directory=ROOT / "frontend", html=True)),
])

if __name__ == "__main__":
    print(f"Prism statique sur http://127.0.0.1:{PORT}/", flush=True)
    # Boucle « selector » sous Windows : voir UVICORN_LOOP dans backend/app.py.
    uvicorn.run(app, host="127.0.0.1", port=PORT, loop="asyncio:SelectorEventLoop" if sys.platform == "win32" else "auto")
