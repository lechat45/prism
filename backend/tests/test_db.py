"""Mini-migration : une base créée par une version antérieure reçoit les colonnes nouvelles."""
from __future__ import annotations

import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from helpers import DbTestCase  # noqa: F401 — chemin du backend et secret de test
from sqlalchemy import inspect

import db

# Table « widgets » telle que créée en v3 phase 1 (sans file_data_json).
PHASE1_WIDGETS = """CREATE TABLE widgets (
    id VARCHAR(36) PRIMARY KEY, user_id INTEGER, title VARCHAR(120), prompt TEXT, html TEXT,
    history_json TEXT, file_json TEXT, storage_json TEXT, layout_json TEXT, accent VARCHAR(7),
    thumbnail TEXT, mode VARCHAR(20), model VARCHAR(100), created_at DATETIME, updated_at DATETIME)"""


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="prism-migration-")
        self.path = Path(self.tmp, "ancienne.db")

    def tearDown(self):
        db.engine().dispose()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_new_nullable_columns_are_added_and_rows_kept(self):
        con = sqlite3.connect(self.path)
        con.execute(PHASE1_WIDGETS)
        con.execute("INSERT INTO widgets (id, user_id, title, html) VALUES ('w1', 1, 'Ancien', '<p>1</p>')")
        con.commit()
        con.close()
        engine = db.configure(f"sqlite:///{self.path.as_posix()}")
        columns = {c["name"] for c in inspect(engine).get_columns("widgets")}
        self.assertIn("file_data_json", columns)
        with engine.connect() as conn:
            row = conn.exec_driver_sql("SELECT title, file_data_json FROM widgets WHERE id = 'w1'").one()
        self.assertEqual(tuple(row), ("Ancien", None))
        db.configure(f"sqlite:///{self.path.as_posix()}")  # idempotent


if __name__ == "__main__":
    unittest.main()
