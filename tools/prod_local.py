"""Prism en configuration de PRODUCTION, en local, pour éprouver le déploiement sans hébergeur.

Même réglages que l'image Docker (PRISM_ENV=production, en-têtes, proxy), sauf : base SQLite
temporaire (PRISM_ALLOW_SQLITE=1) et secret de session éphémère. Mode démo (aucune clé de modèle).

Usage :  python tools/prod_local.py   → http://127.0.0.1:8005
         python tools/check_deploy.py http://127.0.0.1:8005
"""
from __future__ import annotations

import os
import secrets
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(tempfile.mkdtemp(prefix="prism-prod-")) / "prism.db"
os.environ.update(
    PRISM_ENV="production",
    PRISM_JWT_SECRET=secrets.token_urlsafe(48),
    PRISM_DATABASE_URL=f"sqlite:///{DB_PATH.as_posix()}",
    PRISM_ALLOW_SQLITE="1",
    PRISM_HOST="127.0.0.1",
    PRISM_PORT=os.getenv("PRISM_PROD_PORT", "8005"),
    PRISM_CORS_ORIGINS="https://lechat45.github.io",
    GEMINI_API_KEY="",
    GROQ_API_KEY="",
)

if __name__ == "__main__":
    sys.path.insert(0, str(ROOT / "backend"))
    import uvicorn

    import app  # noqa: E402

    print(f"Prism (production locale, base {DB_PATH}) sur http://127.0.0.1:{app.PORT}", flush=True)
    uvicorn.run(app.app, host="127.0.0.1", port=app.PORT, loop=app.UVICORN_LOOP, proxy_headers=True, forwarded_allow_ips="127.0.0.1")
