"""« Mon Hub » : historique des widgets, cloisonnement entre comptes, mises à jour validées."""
from __future__ import annotations

import unittest

import httpx
from fastapi.testclient import TestClient
from helpers import DbTestCase

import app as prism

V1 = "<!DOCTYPE html><html><head><title>Version 1</title></head><body>1</body></html>"
V2 = "<!DOCTYPE html><html><head><title>Version 2</title></head><body>2</body></html>"
PNG = "data:image/png;base64,iVBORw0KGgo="


class WidgetTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self._saved = (prism.GROQ_API_KEY, prism._http_client)
        prism.GROQ_API_KEY = ""  # mode démo : génération sans modèle
        self.client = TestClient(prism.app)
        self.alice = self.register(self.client)
        self.bob = self.register(self.client, email="bob@exemple.fr")

    def tearDown(self):
        prism.GROQ_API_KEY, prism._http_client = self._saved
        super().tearDown()

    def generate(self, headers, prompt="un compteur", **extra):
        res = self.client.post("/api/generate", json={"prompt": prompt, **extra}, headers=headers)
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def test_generation_is_saved_in_the_hub(self):
        out = self.generate(self.alice, file={"name": "v.csv", "kind": "csv", "summary": "2 colonnes"})
        page = self.client.get("/api/widgets", headers=self.alice).json()
        self.assertEqual(page["total"], 1)
        item = page["items"][0]
        self.assertEqual(item["id"], out["widget"]["id"])
        self.assertEqual((item["file_name"], item["mode"], item["versions"]), ("v.csv", "mock", 0))
        self.assertNotIn("html", item, "la liste reste légère")
        detail = self.client.get(f"/api/widgets/{item['id']}", headers=self.alice).json()
        self.assertEqual(detail["html"], out["html"])
        self.assertEqual(detail["file"], {"name": "v.csv", "kind": "csv", "summary": "2 colonnes"})

    def test_widgets_are_private(self):
        widget_id = self.generate(self.alice)["widget"]["id"]
        self.assertEqual(self.client.get("/api/widgets", headers=self.bob).json()["total"], 0)
        for method, path, body in (("get", f"/api/widgets/{widget_id}", None),
                                   ("patch", f"/api/widgets/{widget_id}", {"title": "à moi"}),
                                   ("post", f"/api/widgets/{widget_id}/undo", None),
                                   ("delete", f"/api/widgets/{widget_id}", None)):
            with self.subTest(route=f"{method} {path}"):
                kwargs = {"headers": self.bob}
                if body is not None:
                    kwargs["json"] = body
                self.assertEqual(getattr(self.client, method)(path, **kwargs).status_code, 404)
        self.assertEqual(self.client.get(f"/api/widgets/{widget_id}", headers=self.alice).status_code, 200)

    def test_patch_updates_canvas_state(self):
        widget_id = self.generate(self.alice)["widget"]["id"]
        patch = {"title": "Mon compteur", "accent": "#ff5e8a", "layout": {"x": 10, "y": -20, "w": 460, "h": 420, "z": 3},
                 "storage": {"state": '{"clicks":3}'}, "thumbnail": PNG}
        res = self.client.patch(f"/api/widgets/{widget_id}", json=patch, headers=self.alice)
        self.assertEqual(res.status_code, 200, res.text)
        detail = self.client.get(f"/api/widgets/{widget_id}", headers=self.alice).json()
        self.assertEqual(detail["title"], "Mon compteur")
        self.assertEqual(detail["accent"], "#ff5e8a")
        self.assertEqual(detail["layout"], patch["layout"])
        self.assertEqual(detail["storage"], {"state": '{"clicks":3}'})
        self.assertEqual(detail["thumbnail"], PNG)
        self.client.patch(f"/api/widgets/{widget_id}", json={"clear_accent": True}, headers=self.alice)
        self.assertIsNone(self.client.get(f"/api/widgets/{widget_id}", headers=self.alice).json()["accent"])

    def test_patch_rejects_invalid_values(self):
        widget_id = self.generate(self.alice)["widget"]["id"]
        for bad in ({"accent": "red"}, {"accent": "#000000;}"}, {"thumbnail": "javascript:alert(1)"},
                    {"thumbnail": "data:image/svg+xml;base64,PHN2Zz4="}, {"layout": {"x": 0, "y": 0, "w": 10, "h": 10}},
                    {"storage": {"k": "x" * 1_000_001}}, {"storage": {"k": 1}}):
            with self.subTest(patch=bad):
                self.assertEqual(self.client.patch(f"/api/widgets/{widget_id}", json=bad, headers=self.alice).status_code, 422)

    def test_file_data_upload(self):
        plain = self.generate(self.alice)["widget"]["id"]
        res = self.client.patch(f"/api/widgets/{plain}", json={"file_data": {"a": 1}}, headers=self.alice)
        self.assertEqual(res.status_code, 409)
        with_file = self.generate(self.alice, file={"name": "d.json", "kind": "json", "summary": "objet"})["widget"]["id"]
        data = {"name": "d.json", "kind": "json", "data": {"a": [1, 2]}}
        self.assertEqual(self.client.patch(f"/api/widgets/{with_file}", json={"file_data": data}, headers=self.alice).status_code, 200)
        detail = self.client.get(f"/api/widgets/{with_file}", headers=self.alice).json()
        self.assertEqual(detail["file"]["data"], data)
        self.assertEqual(detail["file"]["summary"], "objet")

    def test_refactor_keeps_history_and_undo_restores(self):
        answers = [V1, V2]
        prism.GROQ_API_KEY = "test-key"
        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json={"choices": [{"message": {"content": answers.pop(0)}, "finish_reason": "stop"}]})))
        widget_id = self.generate(self.alice)["widget"]["id"]
        out = self.generate(self.alice, prompt="version 2", widget_id=widget_id)
        self.assertEqual(out["widget"]["id"], widget_id, "une refactorisation modifie la même carte")
        self.assertEqual((out["widget"]["title"], out["widget"]["versions"]), ("Version 2", 1))
        undone = self.client.post(f"/api/widgets/{widget_id}/undo", headers=self.alice).json()
        self.assertEqual((undone["html"], undone["title"], undone["versions"]), (V1, "Version 1", 0))
        self.assertEqual(self.client.post(f"/api/widgets/{widget_id}/undo", headers=self.alice).status_code, 409)

    def test_delete(self):
        widget_id = self.generate(self.alice)["widget"]["id"]
        self.assertEqual(self.client.delete(f"/api/widgets/{widget_id}", headers=self.alice).status_code, 204)
        self.assertEqual(self.client.get(f"/api/widgets/{widget_id}", headers=self.alice).status_code, 404)
        self.assertEqual(self.client.get("/api/widgets", headers=self.alice).json()["total"], 0)

    def test_pagination_newest_first(self):
        for i in range(3):
            self.generate(self.alice, prompt=f"widget {i}")
        page = self.client.get("/api/widgets?limit=2", headers=self.alice).json()
        self.assertEqual((page["total"], len(page["items"])), (3, 2))
        self.assertEqual(page["items"][0]["prompt"], "widget 2")
        self.assertEqual(self.client.get("/api/widgets?limit=500", headers=self.alice).status_code, 422)


if __name__ == "__main__":
    unittest.main()
