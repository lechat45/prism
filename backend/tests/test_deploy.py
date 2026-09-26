"""Mise en production : adresse PostgreSQL, garde-fous au démarrage, en-têtes, CORS, port de l'hébergeur."""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient
from helpers import DbTestCase
from sqlalchemy import create_engine
from sqlalchemy.schema import CreateTable

import app as prism
import db
import security

BACKEND = Path(__file__).resolve().parents[1]
GOOD_SECRET = "s" * 48
PG_URL = "postgresql://prism:motdepasse@ep-exemple.eu-central-1.aws.neon.tech/prism?sslmode=require"


class DatabaseUrlTests(unittest.TestCase):
    def test_hosted_postgres_urls_get_the_psycopg_driver(self):
        self.assertEqual(db.normalize_url("postgres://u:p@h/d"), "postgresql+psycopg://u:p@h/d")
        self.assertEqual(db.normalize_url(PG_URL), PG_URL.replace("postgresql://", "postgresql+psycopg://"))
        for kept in ("postgresql+psycopg://u:p@h/d", "sqlite:///data/prism.db"):
            self.assertEqual(db.normalize_url(kept), kept)

    def test_postgresql_engine_options(self):
        saved = db._engine
        with mock.patch.object(db, "create_engine") as create, mock.patch.object(db.Base.metadata, "create_all"), \
                mock.patch.object(db, "_add_missing_columns"):
            db.configure(PG_URL)
            url, kwargs = create.call_args.args[0], create.call_args.kwargs
        db._engine = saved
        db.SessionLocal.configure(bind=saved)
        self.assertTrue(url.startswith("postgresql+psycopg://"))
        self.assertEqual(kwargs["connect_args"], {"prepare_threshold": None}, "compatible PgBouncer")
        self.assertTrue(kwargs["pool_pre_ping"])

    def test_schema_compiles_for_postgresql(self):
        engine = create_engine(db.normalize_url(PG_URL))  # aucune connexion : compilation seulement
        for table in db.Base.metadata.sorted_tables:
            ddl = str(CreateTable(table).compile(engine))
            self.assertIn(f"CREATE TABLE {table.name}", ddl)
        self.assertIn("CHECK (sparks_cents >= 0)", str(CreateTable(db.Base.metadata.tables["users"]).compile(engine)))
        # La mini-migration compile ses types pour le dialecte visé.
        column = db.Base.metadata.tables["widgets"].c.file_data_json
        self.assertEqual(column.type.compile(engine.dialect), "TEXT")


class ProductionConfigTests(DbTestCase):
    def test_problems_listed_until_the_configuration_is_complete(self):
        with mock.patch.dict(os.environ, {"PRISM_JWT_SECRET": "", "PRISM_DATABASE_URL": ""}):
            problems = prism.production_problems()
        self.assertEqual(len(problems), 2, problems)
        self.assertIn("PRISM_JWT_SECRET", problems[0])
        self.assertIn("PostgreSQL", problems[1])
        with mock.patch.dict(os.environ, {"PRISM_JWT_SECRET": "court", "PRISM_DATABASE_URL": PG_URL}):
            self.assertEqual(len(prism.production_problems()), 1, "secret trop court")
        with mock.patch.dict(os.environ, {"PRISM_JWT_SECRET": GOOD_SECRET, "PRISM_DATABASE_URL": PG_URL}):
            self.assertEqual(prism.production_problems(), [])
        with mock.patch.dict(os.environ, {"PRISM_JWT_SECRET": GOOD_SECRET, "PRISM_DATABASE_URL": "", "PRISM_ALLOW_SQLITE": "1"}):
            self.assertEqual(prism.production_problems(), [], "disque persistant assumé")

    def test_production_refuses_to_start_with_an_incomplete_configuration(self):
        with mock.patch.object(prism, "IS_PRODUCTION", True), mock.patch.dict(os.environ, {"PRISM_JWT_SECRET": ""}):
            with self.assertRaisesRegex(RuntimeError, "Configuration de production incomplète"):
                with TestClient(prism.app):
                    pass

    def test_no_development_secret_in_production(self):
        with mock.patch.dict(os.environ, {"PRISM_ENV": "production", "PRISM_JWT_SECRET": ""}):
            with self.assertRaisesRegex(RuntimeError, "PRISM_JWT_SECRET"):
                security._load_secret()

    def test_host_port_is_used_when_prism_port_is_absent(self):
        env = {k: v for k, v in os.environ.items() if k not in ("PRISM_PORT", "PORT")}
        code = "import app; print(app.PORT)"
        run = lambda extra: subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env={**env, **extra},  # noqa: E731
                                           capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]
        self.assertEqual(run({"PORT": "10000"}), "10000")
        self.assertEqual(run({"PORT": "10000", "PRISM_PORT": "8123"}), "8123")


class HeadersTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(prism.app)

    def test_security_headers_on_api_and_frontend(self):
        for path in ("/api/health", "/"):
            with self.subTest(path=path):
                res = self.client.get(path)
                self.assertEqual(res.status_code, 200)
                self.assertEqual(res.headers["x-content-type-options"], "nosniff")
                self.assertEqual(res.headers["x-frame-options"], "DENY")
                self.assertEqual(res.headers["referrer-policy"], "no-referrer")
        self.assertEqual(self.client.get("/").headers["cache-control"], "no-cache")

    def test_cors_preflight_from_github_pages_allows_every_verb_used(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                res = self.client.options("/api/widgets/x/file", headers={
                    "Origin": "https://lechat45.github.io",
                    "Access-Control-Request-Method": method,
                    "Access-Control-Request-Headers": "authorization,content-type",
                })
                self.assertEqual(res.status_code, 200, res.text)
                self.assertIn(method, res.headers["access-control-allow-methods"])
                self.assertIn("authorization", res.headers["access-control-allow-headers"].lower())


if __name__ == "__main__":
    unittest.main()
