"""Outils de test partagés : base SQLite temporaire par test et comptes prêts à l'emploi."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import auth  # noqa: E402
import db  # noqa: E402
import security  # noqa: E402

# Secret fixe : les tests n'écrivent jamais de secret dans data/.
security._SECRET = "secret-de-test-" + "x" * 48

PASSWORD = "motdepasse-solide"


# PRISM_TEST_DATABASE_URL (ex. PostgreSQL de la CI) : toute la suite tourne sur cette base,
# vidée avant chaque test. Sinon : un fichier SQLite temporaire par test.
TEST_DATABASE_URL = os.getenv("PRISM_TEST_DATABASE_URL", "").strip()


class DbTestCase(unittest.TestCase):
    """Chaque test part d'une base vide et de limiteurs de débit remis à zéro."""

    def setUp(self):
        import app  # noqa: PLC0415 — clés des fournisseurs neutralisées : seuls les tests les activent

        self._keys = (app.GEMINI_API_KEY, app.GROQ_API_KEY, app.GEMINI_RETRY_DELAY)
        app.GEMINI_API_KEY = app.GROQ_API_KEY = ""
        app.GEMINI_RETRY_DELAY = 0  # nouvelle tentative immédiate après une surcharge simulée
        self._tmp = tempfile.mkdtemp(prefix="prism-test-")
        if TEST_DATABASE_URL:
            engine = db.configure(TEST_DATABASE_URL)
            db.Base.metadata.drop_all(engine)
            db.Base.metadata.create_all(engine)
        else:
            db.configure(f"sqlite:///{Path(self._tmp, 'test.db').as_posix()}")
        auth.login_failures.reset()
        auth.registrations.reset()

    def tearDown(self):
        import app  # noqa: PLC0415

        app.GEMINI_API_KEY, app.GROQ_API_KEY, app.GEMINI_RETRY_DELAY = self._keys
        db.engine().dispose()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def register(self, client, email: str = "alice@exemple.fr", password: str = PASSWORD) -> dict[str, str]:
        res = client.post("/api/auth/register", json={"email": email, "password": password})
        self.assertEqual(res.status_code, 201, res.text)
        return {"Authorization": f"Bearer {res.json()['token']}"}
