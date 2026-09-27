"""Bouclier API (V5, phase 1 · point 3) : une demande équivalente déjà servie à ce compte revient sans appel au modèle."""
from __future__ import annotations

import json
import unittest

import httpx
from fastapi.testclient import TestClient
from helpers import DbTestCase

import app as prism
import cache
import providers

GOOD = ('<!DOCTYPE html><html lang="fr"><head><title>Minuteur</title></head><body><main><p id="t">25:00</p>'
        '<button id="b" type="button">Lancer</button></main><script>document.getElementById("b").onclick = () => {};</script>'
        '</body></html>')


def gemini_ok(text: str) -> httpx.Response:
    return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}]})


class SimilarityTests(unittest.TestCase):
    def same(self, a: str, b: str) -> bool:
        return cache.same_meaning(cache.features(a), cache.features(b))[0]

    def test_same_request_in_other_words(self):
        self.assertTrue(self.same("Crée-moi un minuteur pomodoro", "fais un minuteur Pomodoro"))
        self.assertTrue(self.same("graphique des ventes en barres", "Graphique des ventes en barres, svp"))
        self.assertTrue(self.same("Tableau de bord météo", "tableau de bord meteo"), "accents")

    def test_different_requests_stay_apart(self):
        self.assertFalse(self.same("un compteur jusqu'à 10", "un compteur jusqu'à 100"), "nombres")
        self.assertFalse(self.same("minuteur pomodoro thème sombre", "minuteur pomodoro thème clair"))
        self.assertFalse(self.same("une liste de courses", "une liste de tâches"))
        self.assertFalse(self.same("calculatrice", "calculatrice scientifique"), "mot porteur en plus")
        self.assertFalse(self.same("crée-moi un widget", "fais une application"), "rien de porteur : jamais")

    def test_vector_is_stable_and_normalised(self):
        a = cache.features("Horloge analogique élégante")
        b = cache.features("Horloge analogique élégante")
        self.assertEqual(a, b, "hachage stable (crc32), pas le hash() salé de Python")
        self.assertAlmostEqual(cache.cosine(a.vector, a.vector), 1.0, places=6)
        self.assertEqual(a.words, frozenset({"horloge", "analogique", "elegante"}))

    def test_context_key(self):
        self.assertEqual(cache.context_key(None, ["b", "a"], []), cache.context_key(None, ["a", "b"], []), "ordre des mots fantômes")
        self.assertNotEqual(cache.context_key(None, [], []), cache.context_key({"title": "x"}, [], []))


class CacheApiTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self._saved = (prism.GEMINI_API_KEY, prism.GEMINI_MODELS, prism._http_client)
        prism.GEMINI_API_KEY = "cle-test"
        prism.GEMINI_MODELS = ["gemini-3.8-flash"]
        providers.KEYS.clear()
        self.calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            self.calls += 1
            return gemini_ok(GOOD)

        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(prism.app)
        self.auth = self.register(self.client)

    def tearDown(self):
        prism.GEMINI_API_KEY, prism.GEMINI_MODELS, prism._http_client = self._saved
        super().tearDown()

    def generate(self, prompt: str, auth=None, **extra):
        res = self.client.post("/api/generate", json={"prompt": prompt, **extra}, headers=auth or self.auth)
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def sparks(self, auth=None) -> float:
        return self.client.get("/api/auth/me", headers=auth or self.auth).json()["sparks"]

    def test_equivalent_request_is_served_without_the_model_nor_sparks(self):
        first = self.generate("Crée-moi un minuteur pomodoro")
        self.assertIsNone(first["cached"])
        self.assertEqual((self.calls, first["cost"]), (1, 1.0))
        again = self.generate("fais un minuteur Pomodoro")
        self.assertEqual(self.calls, 1, "aucun nouvel appel au modèle")
        self.assertEqual(again["cost"], 0.0)
        self.assertEqual(again["html"], first["html"])
        self.assertEqual(again["cached"]["prompt"], "Crée-moi un minuteur pomodoro")
        self.assertGreaterEqual(again["cached"]["similarity"], cache.SIMILARITY)
        self.assertNotEqual(again["widget"]["id"], first["widget"]["id"], "nouvelle carte dans Mon Hub")
        self.assertEqual(self.sparks(), 49.0, "une seule génération payée")
        hub = self.client.get("/api/widgets", headers=self.auth).json()
        self.assertEqual(hub["total"], 2)

    def test_fresh_forces_a_real_generation(self):
        self.generate("Un minuteur pomodoro")
        fresh = self.generate("Un minuteur pomodoro", fresh=True)
        self.assertIsNone(fresh["cached"])
        self.assertEqual((self.calls, fresh["cost"]), (2, 1.0))

    def test_never_shared_between_accounts(self):
        self.generate("Un minuteur pomodoro")
        other = self.register(self.client, "autre@prism.test")
        res = self.generate("Un minuteur pomodoro", auth=other)
        self.assertIsNone(res["cached"])
        self.assertEqual(self.calls, 2)

    def test_context_file_and_different_requests_are_never_reused(self):
        self.generate("Un compteur jusqu'à 10")
        self.assertIsNone(self.generate("Un compteur jusqu'à 100")["cached"], "autre nombre")
        self.assertIsNone(self.generate("Un compteur jusqu'à 10", ghost=["humeur"])["cached"], "autre contexte fantôme")
        canvas = [{"title": "Émetteur", "emits": ["demo.valeur"], "listens": []}]
        self.assertIsNone(self.generate("Un compteur jusqu'à 10", canvas=canvas)["cached"], "autres voisins")
        file = {"name": "x.csv", "kind": "csv", "summary": "colonnes : a, b"}
        self.assertIsNone(self.generate("Un compteur jusqu'à 10", file=file)["cached"], "fichier joint")
        self.assertEqual(self.calls, 5)
        self.assertIsNotNone(self.generate("un compteur jusqu'à 10 !")["cached"], "même demande, même contexte")
        self.assertEqual(self.calls, 5)

    def test_refactor_and_demo_are_never_cached(self):
        first = self.generate("Un minuteur pomodoro")
        refactor = self.generate("Un minuteur pomodoro", widget_id=first["widget"]["id"])
        self.assertIsNone(refactor["cached"])
        self.assertEqual(self.calls, 2)
        prism.GEMINI_API_KEY = ""  # mode démo : rien n'est gardé ni resservi
        demo = self.generate("Une horloge analogique")
        self.assertEqual((demo["mode"], demo["cached"]), ("mock", None))
        prism.GEMINI_API_KEY = "cle-test"
        self.assertIsNone(self.generate("Une horloge analogique")["cached"])

    def test_keeps_the_most_recent_requests_only(self):
        for i in range(5):
            cache.remember(1, f"widget numéro {i} tableau", "ctx", GOOD, "gemini", "m")
        saved, cache.KEEP = cache.KEEP, 3
        try:
            cache.remember(1, "widget numéro 5 tableau", "ctx", GOOD, "gemini", "m")
            self.assertIsNone(cache.lookup(1, "widget numéro 0 tableau", "ctx"), "les plus anciennes sont oubliées")
            self.assertIsNotNone(cache.lookup(1, "widget numéro 5 tableau", "ctx"))
        finally:
            cache.KEEP = saved


if __name__ == "__main__":
    unittest.main()
