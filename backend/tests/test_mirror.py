"""Mode Miroir (V5, phase 2 · point 4) : l'Engramme de l'utilisateur, tiré de ses propres usages, avec son accord."""
from __future__ import annotations

import json
import unittest

import httpx
from fastapi.testclient import TestClient
from helpers import DbTestCase

import app as prism
import engram
import mirror
import providers
from test_engram import demo


def mirror_answer() -> dict:
    """Réponse du modèle : la démo sans ses artefacts (et un évènement inventé, qui doit être écarté)."""
    raw = json.loads(json.dumps(demo()))
    nodes = [n for n in raw["nodes"] if n["category"] != "artifact"]
    nodes.append({"id": "x", "category": "artifact", "type": "succes", "title": "Inventé", "content": "Inventé.",
                  "directive": "x", "basis": "documente", "evidence": "", "intensity": 1, "date": "2020-01-01", "impact": "x"})
    return {**raw, "person": "Quelqu'un d'autre", "nodes": nodes}


class MirrorTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self._saved = (prism.GEMINI_API_KEY, prism.GEMINI_MODELS, prism._http_client, mirror.MIRROR_SPARKS, mirror.COOLDOWN)
        prism.GEMINI_API_KEY = ""  # démo par défaut
        prism.GEMINI_MODELS = ["gemini-3.8-flash"]
        providers.KEYS.clear()
        mirror.MIRROR_SPARKS = 5
        self.bodies = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            self.bodies.append(body)
            system = body["systemInstruction"]["parts"][0]["text"]
            if "USAGE DATA" in system:
                text = json.dumps(mirror_answer())
            else:
                text = '<!DOCTYPE html><html lang="fr"><head><title>W</title></head><body><main><button id="b">ok</button></main></body></html>'
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}]})

        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(prism.app)
        self.auth = self.register(self.client)

    def tearDown(self):
        prism.GEMINI_API_KEY, prism.GEMINI_MODELS, prism._http_client, mirror.MIRROR_SPARKS, mirror.COOLDOWN = self._saved
        super().tearDown()

    def create(self, count: int, refactor: bool = True):
        """count générations (démo), une refactorisation (avec modèle) et une carte écartée : de la matière."""
        ids = []
        for i in range(count):
            res = self.client.post("/api/generate", json={"prompt": f"Tableau de bord des ventes n°{i}"}, headers=self.auth)
            self.assertEqual(res.status_code, 200, res.text)
            ids.append(res.json()["widget"]["id"])
        if refactor:
            prism.GEMINI_API_KEY = "cle-test"
            res = self.client.post("/api/generate", json={"prompt": "plus sobre", "widget_id": ids[0]}, headers=self.auth)
            self.assertEqual(res.status_code, 200, res.text)
            prism.GEMINI_API_KEY = ""
        for widget_id in ids[1:]:  # posées sur le canvas, sauf la première (écartée)
            self.client.patch(f"/api/widgets/{widget_id}", json={"layout": {"x": 0, "y": 0, "w": 300, "h": 200, "z": 1}}, headers=self.auth)
        return ids

    def ask(self, **body):
        return self.client.post("/api/engram/mirror", json={"consent": True, **body}, headers=self.auth)

    def test_locked_until_enough_sparks_spent(self):
        status = self.client.get("/api/engram/mirror", headers=self.auth).json()
        self.assertEqual((status["spent"], status["unlocked"]), (0, False))
        res = self.ask()
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["detail"]["code"], "mirror_locked")
        self.assertEqual(self.client.get("/api/health").json()["mirror_sparks"], 5)

    def test_consent_is_required(self):
        self.create(10)
        res = self.client.post("/api/engram/mirror", json={}, headers=self.auth)
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json()["detail"]["code"], "consent_required")

    def test_demo_mirror_is_a_valid_engram_with_real_milestones_and_free(self):
        self.create(10)
        before = self.client.get("/api/auth/me", headers=self.auth).json()["sparks"]
        status = self.client.get("/api/engram/mirror", headers=self.auth).json()
        self.assertTrue(status["unlocked"] and status["available"])
        self.assertGreaterEqual(status["spent"], 5)
        res = self.ask()
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        m = body["engram"]
        self.assertEqual((body["mode"], body["cost"], m["person"], m["mirror"]), ("mock", 0.0, "Vous", True))
        self.assertEqual(engram.normalize(m)["nodes"], [{k: v for k, v in n.items()} for n in m["nodes"]], "Engramme conforme")
        events = [n for n in m["nodes"] if n["category"] == "artifact"]
        self.assertEqual(len(events), 10)
        self.assertEqual({n["type"] for n in events}, {"succes", "echec", "tournant"})
        self.assertIn("Premier widget", [n["title"] for n in events])
        self.assertTrue(all(n["date"] == events[0]["date"] for n in events), "toutes datées d'aujourd'hui (activité réelle)")
        self.assertEqual(self.client.get("/api/auth/me", headers=self.auth).json()["sparks"], before, "gratuit")
        again = self.ask()
        self.assertEqual(again.status_code, 429, "une fois par jour")
        self.assertEqual(again.json()["detail"]["code"], "mirror_cooldown")

    def test_model_portrait_keeps_only_real_milestones(self):
        self.create(10)
        prism.GEMINI_API_KEY = "cle-test"
        res = self.ask(language="fr")
        self.assertEqual(res.status_code, 200, res.text)
        m = res.json()["engram"]
        self.assertEqual(m["person"], "Vous", "le libellé est imposé")
        titles = [n["title"] for n in m["nodes"] if n["category"] == "artifact"]
        self.assertNotIn("Inventé", titles, "un évènement proposé par le modèle est écarté")
        self.assertTrue(all(n["basis"] == "interpretation" for n in m["nodes"] if n["category"] != "artifact"))
        body = self.bodies[-1]
        user = body["contents"][0]["parts"][0]["text"]
        self.assertIn("Tableau de bord des ventes", user, "ses propres demandes")
        self.assertNotIn("alice@exemple.fr", user, "jamais l'adresse du compte")
        system = " ".join(body["systemInstruction"]["parts"][0]["text"].split())
        self.assertIn("never diagnose", system)
        self.assertIn("Never infer or mention health", system)
        self.assertNotIn("sources", json.dumps(body["generationConfig"]["responseSchema"]))

    def test_not_enough_material_is_explained(self):
        self.create(6, refactor=False)  # six créations : pas encore dix jalons
        res = self.ask()
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json()["detail"]["code"], "mirror_insufficient")

    def test_milestones_order_and_counts(self):
        self.create(12)
        widgets, ledger = mirror._activity(1)
        events = mirror.milestones(widgets, ledger)
        self.assertEqual([e["id"] for e in events], [f"ev{i}" for i in range(1, 11)])
        self.assertEqual(sorted(e["date"] for e in events), [e["date"] for e in events])
        data = mirror.usage(widgets, ledger)
        self.assertEqual(data["widgets_created"], 12)
        self.assertIn("tableau", data["frequent_words"])
        self.assertEqual(data["refactorings"], 1)


if __name__ == "__main__":
    unittest.main()
