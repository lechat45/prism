"""Fournisseur Gemini (principal) avec un faux serveur : format d'appel, erreurs, bascules, Tailwind épinglé."""
from __future__ import annotations

import json
import unittest

import httpx
from fastapi.testclient import TestClient
from helpers import DbTestCase

import app as prism

GOOD = (
    '<!DOCTYPE html><html lang="fr" class="h-full" style="--accent:#7cc4ff"><head><title>Compteur</title>'
    '<script src="https://cdn.tailwindcss.com"></script></head>'
    '<body class="h-full bg-gray-900"><main class="rounded-2xl bg-white/10 backdrop-blur-md p-6">'
    '<button id="b" class="px-3 py-2 rounded-xl bg-[var(--accent)]">0</button></main>'
    '<script>let n = 0; document.getElementById("b").onclick = () => { n++; };</script></body></html>'
)
M1, M2 = "gemini-3.8-flash", "gemini-3.6-flash"


def gemini_ok(text: str, finish: str = "STOP", thought: str | None = None) -> httpx.Response:
    parts = ([{"text": thought, "thought": True}] if thought else []) + [{"text": text}]
    return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": finish}]})


def groq_ok(text: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": text}, "finish_reason": "stop"}]})


INVALID_KEY = httpx.Response(400, json={"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.",
                                                  "status": "INVALID_ARGUMENT", "details": [{"reason": "API_KEY_INVALID"}]}})


class GeminiTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self._saved = (prism.GEMINI_MODELS, prism._http_client)
        prism.GEMINI_API_KEY = "cle-gemini-test"
        prism.GEMINI_MODELS = [M1, M2]
        self.answers: dict[str, list[httpx.Response]] = {}
        self.calls: list[tuple[str, dict, httpx.Headers]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            if ":generateContent" in request.url.path:
                target = request.url.path.split("/models/")[1].split(":")[0]
            else:
                target = "groq:" + body["model"]
            self.calls.append((target, body, request.headers))
            queue = self.answers.get(target) or []
            return queue.pop(0) if queue else gemini_ok(GOOD)

        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(prism.app)
        self.auth = self.register(self.client)

    def tearDown(self):
        prism.GEMINI_MODELS, prism._http_client = self._saved
        super().tearDown()

    def generate(self, prompt: str = "un compteur"):
        return self.client.post("/api/generate", json={"prompt": prompt}, headers=self.auth)

    def test_canvas_context_reaches_the_model(self):
        canvas = [{"title": "Filtre des régions", "emits": ["sales.region.selected"], "listens": ["filters.reset"],
                   "samples": {"sales.region.selected": '{"region":"Nord"}'}}]
        res = self.client.post("/api/generate", json={"prompt": "un graphique relié au filtre", "canvas": canvas}, headers=self.auth)
        self.assertEqual(res.status_code, 200, res.text)
        _, body, _ = self.calls[0]
        message = body["contents"][0]["parts"][0]["text"]
        self.assertIn('- "Filtre des régions": emits sales.region.selected (e.g. {"region":"Nord"}); listens to filters.reset', message)
        self.assertIn("EVENT BUS", body["systemInstruction"]["parts"][0]["text"])

    def test_canvas_context_is_validated(self):
        ok = {"title": "A", "emits": ["a.b"], "listens": ["*"]}
        for bad in ([{**ok, "emits": ["pas un sujet !"]}], [{**ok, "listens": ["**"]}], [{**ok, "emits": ["x"] * 21}],
                    [{**ok, "samples": {"a.b": "x" * 301}}], [ok] * 21, [{**ok, "title": "t" * 121}]):
            with self.subTest(bad=str(bad)[:60]):
                res = self.client.post("/api/generate", json={"prompt": "x", "canvas": bad}, headers=self.auth)
                self.assertEqual(res.status_code, 422, res.text)
        self.assertEqual(self.calls, [], "rien n'est parti au modèle")

    def test_request_format_and_tailwind_design_system(self):
        self.answers[M1] = [gemini_ok(f"Voici :\n```html\n{GOOD}\n```", thought="je réfléchis au design")]
        res = self.generate()
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()
        self.assertEqual((data["mode"], data["model"]), ("gemini", M1))

        target, body, headers = self.calls[0]
        self.assertEqual(target, M1)
        self.assertEqual(headers["x-goog-api-key"], "cle-gemini-test")
        system = body["systemInstruction"]["parts"][0]["text"]
        self.assertIn("Tu es un designer Apple/Vercel de classe mondiale", system)
        self.assertIn(prism.LIBS["tailwind"]["url"], system)
        self.assertNotIn("{{", system)
        self.assertIn("<<<\nun compteur\n>>>", body["contents"][0]["parts"][0]["text"])
        self.assertEqual(body["generationConfig"]["maxOutputTokens"], prism.GEMINI_MAX_OUTPUT_TOKENS)

        html = data["html"]
        self.assertNotIn("je réfléchis", html, "la réflexion du modèle n'est pas le document")
        self.assertNotIn("cdn.tailwindcss.com", html)
        self.assertEqual(html.count(prism.LIBS["tailwind"]["url"]), 1)
        self.assertIn(prism.LIBS["tailwind"]["integrity"], html)
        self.assertNotIn("external_resource", data["warnings"])

    def test_invalid_key_is_fatal_for_gemini(self):
        self.answers[M1] = [INVALID_KEY]
        res = self.generate()
        self.assertEqual(res.status_code, 502)
        self.assertIn("Clé Gemini refusée", res.json()["detail"])
        self.assertEqual([c[0] for c in self.calls], [M1], "pas d'essai du second modèle avec une clé refusée")
        self.assertEqual(self.client.get("/api/auth/me", headers=self.auth).json()["sparks"], 50, "remboursé")

    def test_next_model_on_quota_missing_model_truncation_or_block(self):
        cases = {
            "quota 429": httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED"}}),
            "modèle retiré 404": httpx.Response(404, json={"error": {"status": "NOT_FOUND"}}),
            "réponse tronquée": gemini_ok(GOOD[:80], finish="MAX_TOKENS"),
            "sécurité": gemini_ok("", finish="SAFETY"),
            "demande bloquée": httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}),
            "surcharge 503": httpx.Response(503, text="overloaded"),
        }
        for label, failure in cases.items():
            with self.subTest(label):
                self.calls.clear()
                self.answers = {M1: [failure]}
                res = self.generate()
                self.assertEqual(res.status_code, 200, res.text)
                self.assertEqual(res.json()["model"], M2)
                self.assertEqual([c[0] for c in self.calls], [M1, M2])

    def test_groq_is_the_fallback_provider(self):
        prism.GROQ_API_KEY = "cle-groq-test"
        self.answers = {M1: [INVALID_KEY], "groq:" + prism.GROQ_MODELS[0]: [groq_ok(GOOD)]}
        res = self.generate()
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((res.json()["mode"], res.json()["model"]), ("groq", prism.GROQ_MODELS[0]))
        health = self.client.get("/api/health").json()
        self.assertEqual((health["mode"], health["providers"]), ("gemini", ["gemini", "groq"]))
        self.assertEqual(health["models"][:2], [M1, M2])

    def test_all_failures_are_refunded_with_details(self):
        self.answers = {M1: [httpx.Response(500, text="panne")], M2: [gemini_ok("Désolé, impossible.")]}
        res = self.generate()
        self.assertEqual(res.status_code, 502)
        detail = res.json()["detail"]
        self.assertIn("Tous les modèles ont échoué", detail)
        self.assertIn("aucune balise HTML", detail)
        self.assertEqual(self.client.get("/api/auth/me", headers=self.auth).json()["sparks"], 50)


if __name__ == "__main__":
    unittest.main()
