"""Tests de bout en bout de l'API, avec un faux serveur Groq (httpx.MockTransport).

Couvre le chemin « clé présente » sans consommer de quota : nettoyage du Markdown,
bascule vers le modèle suivant (429, troncature, JS invalide), clé refusée.
Depuis la v3, /api/generate exige un compte : chaque test s'inscrit sur une base temporaire.
"""
from __future__ import annotations

import json
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from helpers import DbTestCase  # noqa: E402

import app as prism  # noqa: E402

GOOD = (
    "<!DOCTYPE html>\n<html><head><style>b{}</style></head><body>"
    '<button id="b">0</button><script>let n = 0;'
    'document.getElementById("b").onclick = () => { n++; };</script></body></html>'
)
PRIMARY, SECONDARY = "openai/gpt-oss-120b", "llama-3.3-70b-versatile"


def completion(content: str, finish: str = "stop") -> httpx.Response:
    return httpx.Response(
        200, json={"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": finish}]}
    )


class FakeGroq:
    """Répond selon le modèle demandé et mémorise chaque requête reçue."""

    def __init__(self, responses: dict[str, httpx.Response]):
        self.responses = responses
        self.calls: list[tuple[dict, httpx.Headers]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.calls.append((body, request.headers))
        return self.responses[body["model"]]


class ApiTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self._saved = (prism.GROQ_API_KEY, prism.GROQ_MODELS, prism._http_client)
        prism.GROQ_API_KEY = "test-key"
        prism.GROQ_MODELS = [PRIMARY, SECONDARY]
        self.client = TestClient(prism.app)
        self.auth = self.register(self.client)

    def tearDown(self):
        prism.GROQ_API_KEY, prism.GROQ_MODELS, prism._http_client = self._saved
        super().tearDown()

    def post(self, body: dict):
        return self.client.post("/api/generate", json=body, headers=self.auth)

    def fake(self, **responses: httpx.Response) -> FakeGroq:
        groq = FakeGroq({PRIMARY: responses.get("primary"), SECONDARY: responses.get("secondary")})
        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(groq.handler))
        return groq

    def generate(self, prompt: str = "Crée un bouton qui compte les clics"):
        return self.post({"prompt": prompt})

    def test_markdown_wrapped_output_is_cleaned(self):
        groq = self.fake(primary=completion(f"Voici votre composant :\n```html\n{GOOD}\n```\nBonne utilisation !"))
        res = self.generate()
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["html"], GOOD)
        self.assertEqual((data["mode"], data["model"]), ("groq", PRIMARY))

        body, headers = groq.calls[0]
        self.assertEqual(headers["authorization"], "Bearer test-key")
        self.assertEqual(body["messages"][0], {"role": "system", "content": prism.SYSTEM_PROMPT})
        self.assertIn("Crée un bouton qui compte les clics", body["messages"][1]["content"])
        self.assertEqual(body["reasoning_effort"], prism.GROQ_REASONING_EFFORT)

    def test_rate_limit_falls_back_to_next_model(self):
        groq = self.fake(primary=httpx.Response(429, json={"error": "rate"}), secondary=completion(GOOD))
        data = self.generate().json()
        self.assertEqual(data["model"], SECONDARY)
        self.assertNotIn("reasoning_effort", groq.calls[1][0])  # paramètre réservé à gpt-oss

    def test_truncated_answer_falls_back(self):
        self.fake(primary=completion(GOOD[:90], finish="length"), secondary=completion(GOOD))
        self.assertEqual(self.generate().json()["model"], SECONDARY)

    @unittest.skipUnless(shutil.which("node"), "Node.js requis")
    def test_js_syntax_error_falls_back(self):
        broken = GOOD.replace("let n = 0;", "let n = ;")
        self.fake(primary=completion(broken), secondary=completion(GOOD))
        self.assertEqual(self.generate().json()["model"], SECONDARY)

    def test_rejected_key_stops_immediately(self):
        groq = self.fake(primary=httpx.Response(401, json={"error": "bad key"}), secondary=completion(GOOD))
        res = self.generate()
        self.assertEqual(res.status_code, 502)
        self.assertIn("401", res.json()["detail"])
        self.assertEqual(len(groq.calls), 1)

    def test_prose_only_answer_is_not_a_component(self):
        self.fake(primary=completion("Désolé, je ne peux pas faire cela."), secondary=completion(GOOD))
        self.assertEqual(self.generate().json()["model"], SECONDARY)

    def test_all_models_failing_returns_502(self):
        self.fake(primary=httpx.Response(500, text="boom"), secondary=completion("Désolé, je ne peux pas."))
        res = self.generate()
        self.assertEqual(res.status_code, 502)
        detail = res.json()["detail"]
        self.assertIn("Tous les modèles ont échoué", detail)
        self.assertIn("aucune balise HTML", detail)

    def test_mock_mode_without_key(self):
        prism.GROQ_API_KEY = ""
        data = self.generate().json()
        self.assertEqual((data["mode"], data["model"]), ("mock", "mock:counter"))
        self.assertEqual(self.client.get("/api/health").json()["mode"], "mock")

    def test_blank_prompt_is_rejected(self):
        self.assertEqual(self.generate("   ").status_code, 422)
        self.assertEqual(self.post({}).status_code, 422)
        bad = self.client.post("/api/generate", content=b"{pas du json", headers={"Content-Type": "application/json", **self.auth})
        self.assertEqual(bad.status_code, 422)

    def test_windows_cp1252_body_is_accepted(self):
        prism.GROQ_API_KEY = ""  # mode démo : le gabarit générique réaffiche la demande
        body = '{"prompt":"Crée un minuteur à café"}'
        for encoding in ("utf-8", "cp1252"):
            with self.subTest(encoding=encoding):
                res = self.client.post(
                    "/api/generate", content=body.encode(encoding), headers={"Content-Type": "application/json", **self.auth}
                )
                self.assertEqual(res.status_code, 200)
                self.assertIn("Crée un minuteur à café", res.json()["html"])

    def test_attached_file_summary_reaches_the_model(self):
        groq = self.fake(primary=completion(GOOD))
        file = {"name": "ventes.csv", "kind": "csv", "summary": "Colonnes : mois (text), total (number)"}
        res = self.post({"prompt": "un graphique", "file": file})
        self.assertEqual(res.status_code, 200)
        message = groq.calls[0][0]["messages"][1]["content"]
        self.assertIn("ATTACHED FILE", message)
        self.assertIn("Colonnes : mois (text), total (number)", message)
        self.assertIn(prism.LIBS["chartjs"]["url"], groq.calls[0][0]["messages"][0]["content"])

    def test_refactor_sends_current_code_and_repins_chartjs(self):
        answer = GOOD.replace("<head>", '<head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>').replace(
            "let n = 0;", "let n = 0; new Chart(document.body, {});"
        )
        groq = self.fake(primary=completion(GOOD))
        widget_id = self.generate().json()["widget"]["id"]
        groq.responses[PRIMARY] = completion(answer)
        res = self.post({"prompt": "ajoute un graphique", "widget_id": widget_id})
        self.assertEqual(res.status_code, 200)
        message = groq.calls[1][0]["messages"][1]["content"]
        self.assertIn("current source of an existing widget", message)
        self.assertIn(GOOD, message)
        html = res.json()["html"]
        self.assertEqual(html.count(prism.LIBS["chartjs"]["url"]), 1)
        self.assertIn(prism.LIBS["chartjs"]["integrity"], html)
        self.assertNotIn("external_resource", res.json()["warnings"])

    def test_demo_mode_routes_files_and_refuses_refactor(self):
        prism.GROQ_API_KEY = ""
        file = {"name": "arbre.json", "kind": "json", "summary": "objet, 3 clés"}
        res = self.post({"prompt": "explore", "file": file})
        self.assertEqual(res.json()["model"], "mock:json-tree")
        before = res.json()["sparks"]
        refused = self.post({"prompt": "change", "widget_id": res.json()["widget"]["id"]})
        self.assertEqual(refused.status_code, 409)
        self.assertIn("GROQ_API_KEY", refused.json()["detail"])
        me = self.client.get("/api/auth/me", headers=self.auth).json()
        self.assertEqual(me["sparks"], before, "refus sans débit")

    def test_invalid_file_kind_is_rejected(self):
        res = self.post({"prompt": "x", "file": {"name": "a.exe", "kind": "exe", "summary": ""}})
        self.assertEqual(res.status_code, 422)

    def test_openapi_documents_request_body(self):
        schema = self.client.get("/openapi.json").json()
        body = schema["paths"]["/api/generate"]["post"]["requestBody"]["content"]["application/json"]["schema"]
        self.assertIn("prompt", body["properties"])

    def test_cors_preflight(self):
        res = self.client.options(
            "/api/generate",
            headers={"Origin": "http://localhost:5500", "Access-Control-Request-Method": "POST",
                     "Access-Control-Request-Headers": "authorization, content-type"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["access-control-allow-origin"], "*")
        self.assertIn("authorization", res.headers["access-control-allow-headers"].lower())

    def test_frontend_is_served(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn('<script type="module" src="js/main.js">', res.text)
        # v2 : les iframes sont créées par le canvas, avec la sandbox définie dans js/sandbox.js.
        sandbox = self.client.get("/js/sandbox.js")
        self.assertEqual(sandbox.status_code, 200)
        self.assertIn('FRAME_SANDBOX = "allow-scripts"', sandbox.text)
        for path in ("/assets/prism-logo.svg", "/engine/libs.json", "/engine/mocks/csv-chart.html"):
            self.assertEqual(self.client.get(path).status_code, 200, path)


if __name__ == "__main__":
    unittest.main()
