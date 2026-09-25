"""Prism Sparks : coûts, refus à solde insuffisant, remboursement, courses entre requêtes."""
from __future__ import annotations

import json
import threading
import unittest

import httpx
from fastapi.testclient import TestClient
from helpers import DbTestCase
from sqlalchemy import func, select

import app as prism
import billing
import db
from models import SparkLedger, User

GOOD = "<!DOCTYPE html><html><head><title>Compteur</title></head><body><p>ok</p></body></html>"


def completion(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}, "finish_reason": "stop"}]})


class SparksTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self._saved = (prism.GROQ_API_KEY, prism.GROQ_MODELS, prism._http_client)
        prism.GROQ_API_KEY = "test-key"
        prism.GROQ_MODELS = ["modele/test"]
        self.responses: list[httpx.Response] = []
        self.calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            self.calls += 1
            return self.responses.pop(0) if self.responses else completion(GOOD)

        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(prism.app)
        self.auth = self.register(self.client)

    def tearDown(self):
        prism.GROQ_API_KEY, prism.GROQ_MODELS, prism._http_client = self._saved
        super().tearDown()

    def set_sparks(self, sparks: float):
        with db.session() as s, s.begin():
            s.query(User).one().sparks_cents = round(sparks * 100)

    def sparks(self) -> float:
        return self.client.get("/api/auth/me", headers=self.auth).json()["sparks"]

    def post(self, body: dict):
        return self.client.post("/api/generate", json=body, headers=self.auth)

    def test_generate_costs_one_spark_refactor_half(self):
        first = self.post({"prompt": "un compteur"}).json()
        self.assertEqual((first["cost"], first["sparks"]), (1, 49))
        refactor = self.post({"prompt": "en rouge", "widget_id": first["widget"]["id"]}).json()
        self.assertEqual((refactor["cost"], refactor["sparks"]), (0.5, 48.5))
        self.assertEqual(self.sparks(), 48.5)

    def test_insufficient_sparks_returns_403_without_calling_the_model(self):
        self.set_sparks(0.5)
        res = self.post({"prompt": "un compteur"})
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["detail"], {
            "code": "insufficient_sparks", "message": "Plus assez de Sparks pour cette action.",
            "sparks": 0.5, "required": 1,
        })
        self.assertEqual(self.calls, 0, "aucun appel au modèle sans crédit")
        self.assertEqual(self.sparks(), 0.5)

    def test_half_spark_still_allows_a_refactor(self):
        widget_id = self.post({"prompt": "un compteur"}).json()["widget"]["id"]
        self.set_sparks(0.5)
        self.assertEqual(self.post({"prompt": "encore"}).status_code, 403)
        refactor = self.post({"prompt": "en vert", "widget_id": widget_id})
        self.assertEqual(refactor.status_code, 200)
        self.assertEqual(refactor.json()["sparks"], 0)
        self.assertEqual(self.post({"prompt": "et en bleu", "widget_id": widget_id}).status_code, 403)

    def test_failed_generation_is_refunded(self):
        self.responses = [httpx.Response(500, text="panne")]
        res = self.post({"prompt": "un compteur"})
        self.assertEqual(res.status_code, 502)
        self.assertEqual(self.sparks(), 50)
        reasons = [e["reason"] for e in self.client.get("/api/sparks", headers=self.auth).json()["ledger"]]
        self.assertEqual(reasons, ["refund", "generate", "signup_bonus"])

    def test_refactor_of_someone_elses_widget_is_404_and_free(self):
        widget_id = self.post({"prompt": "un compteur"}).json()["widget"]["id"]
        other = self.register(self.client, email="bob@exemple.fr")
        res = self.client.post("/api/generate", json={"prompt": "pirate", "widget_id": widget_id}, headers=other)
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self.client.get("/api/auth/me", headers=other).json()["sparks"], 50)

    def test_ledger_matches_balance(self):
        widget_id = self.post({"prompt": "un compteur"}).json()["widget"]["id"]
        self.post({"prompt": "en rouge", "widget_id": widget_id})
        self.responses = [httpx.Response(500, text="panne")]
        self.post({"prompt": "raté"})
        with db.session() as s:
            total = s.scalar(select(func.sum(SparkLedger.delta_cents)))
            balance = s.scalar(select(User.sparks_cents))
        self.assertEqual(total, balance)
        self.assertEqual(billing.as_sparks(balance), 48.5)
        entries = self.client.get("/api/sparks", headers=self.auth).json()["ledger"]
        spent = [e for e in entries if e["reason"] in ("generate", "refactor")]
        # Dépenses abouties rattachées au widget ; celle de la génération ratée n'a pas de widget et est remboursée.
        self.assertEqual([e["widget_id"] for e in spent], [None, widget_id, widget_id], json.dumps(spent))
        self.assertEqual([e["reason"] for e in entries].count("refund"), 1)


class ConcurrencyTests(DbTestCase):
    def test_parallel_reservations_never_overdraw(self):
        client = TestClient(prism.app)
        self.register(client)
        with db.session() as s:
            user_id = s.scalar(select(User.id))
        results: list[str] = []
        lock = threading.Lock()

        def worker():
            try:
                billing.reserve(user_id, "generate")
                outcome = "ok"
            except billing.InsufficientSparks:
                outcome = "refusé"
            with lock:
                results.append(outcome)

        threads = [threading.Thread(target=worker) for _ in range(60)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results.count("ok"), 50)
        self.assertEqual(results.count("refusé"), 10)
        self.assertEqual(billing.balance(user_id), 0)

    def test_database_forbids_negative_balance(self):
        client = TestClient(prism.app)
        self.register(client)
        from sqlalchemy.exc import IntegrityError

        with self.assertRaises(IntegrityError), db.session() as s, s.begin():
            s.query(User).one().sparks_cents = -1


if __name__ == "__main__":
    unittest.main()
