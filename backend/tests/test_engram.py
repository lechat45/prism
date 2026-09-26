"""Engramme cognitif (V4) : définition JSON stricte, validation du sens, route /api/engram avec un faux Gemini."""
from __future__ import annotations

import copy
import json
import unittest

import httpx
from fastapi.testclient import TestClient
from helpers import DbTestCase

import app as prism
import engram

M1, M2 = "gemini-3.8-flash", "gemini-3.6-flash"


def demo() -> dict:
    return copy.deepcopy(engram.DEMO)


def gemini_json(obj) -> httpx.Response:
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}]})


class DefinitionTests(unittest.TestCase):
    def test_schema_and_validator_agree(self):
        node = engram.SCHEMA["properties"]["nodes"]["items"]["properties"]
        self.assertEqual(set(node["category"]["enum"]), set(engram.TYPES))
        self.assertEqual(set(node["type"]["enum"]), {t for types in engram.TYPES.values() for t in types})
        self.assertEqual(set(node["basis"]["enum"]), {"documente", "declare", "interpretation"})
        self.assertIn("directive", engram.SCHEMA["properties"]["nodes"]["items"]["required"], "chaque nœud est un filtre de génération")
        link = engram.SCHEMA["properties"]["links"]["items"]["properties"]["kind"]["enum"]
        self.assertEqual(set(link), {"forge", "nourrit", "contredit"})
        # Gemini refuse maxItems dans responseSchema (HTTP 400 « invalid argument », constaté le 2026-09-26) :
        # les limites sont dans le prompt et appliquées par normalize().
        self.assertNotIn("maxItems", json.dumps(engram.SCHEMA))

    def test_prompt_states_the_taxonomy_and_the_ethics(self):
        p = engram.SYSTEM_PROMPT
        for needle in ("exactly 1 node", "8 to 10 nodes", "10 to 15 nodes", "exactly 10 nodes", "never medical or psychiatric",
                       "Never invent an event", "public_figure to false"):
            self.assertIn(needle, p)
        message = engram.build_user_message("Ada {{language}} Lovelace", "en")
        self.assertIn("<<<\nAda {{language}} Lovelace\n>>>", message, "le nom n'est jamais réinterprété")
        self.assertIn("English", message)


class NormalizeTests(unittest.TestCase):
    def test_demo_is_a_valid_engram(self):
        e = engram.demo_engram()
        counts = {c: sum(n["category"] == c for n in e["nodes"]) for c in engram.TYPES}
        self.assertEqual(counts, {"core": 1, "engine": 9, "shadow": 10, "artifact": 10})
        dates = [n["date"] for n in e["nodes"] if n["category"] == "artifact"]
        self.assertEqual(dates, sorted(dates, key=engram._date_key))
        self.assertEqual(len(e["links"]), 15)
        self.assertTrue(all(n["directive"] for n in e["nodes"]))

    def test_refusal_for_non_public_people(self):
        for raw in ({"public_figure": False, "refusal": "Personne privée.", "nodes": [], "links": []},
                    {**demo(), "refusal": "Mineur."}):
            with self.assertRaises(engram.EngramRefused):
                engram.normalize(raw)

    def test_counts_and_types_are_enforced(self):
        cases = {
            "artefact manquant": lambda d: d["nodes"].remove(next(n for n in d["nodes"] if n["category"] == "artifact")),
            "type d'ombre absent": lambda d: [n.update(type="paradoxe") for n in d["nodes"] if n["type"] == "peur_primaire"],
            "deux noyaux": lambda d: d["nodes"].append({**d["nodes"][0], "id": "core2"}),
            "artefact sans date": lambda d: next(n for n in d["nodes"] if n["category"] == "artifact").update(date="vers 1900"),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                data = demo()
                mutate(data)
                if label == "deux noyaux":
                    self.assertEqual(sum(n["category"] == "core" for n in engram.normalize(data)["nodes"]), 1, "surplus écarté")
                else:
                    with self.assertRaises(engram.EngramError):
                        engram.normalize(data)

    def test_surplus_trimmed_by_intensity_and_fields_cleaned(self):
        data = demo()
        extra = [{**n, "id": f"x{i}", "intensity": 0.01} for i, n in enumerate(n for n in data["nodes"] if n["category"] == "engine")]
        data["nodes"] += extra[:3]  # 12 moteurs → 10 gardés, les moins intenses écartés
        data["nodes"][0]["title"] = "T" * 200
        data["nodes"][0]["type"] = "axiome"
        palette = next(n for n in data["nodes"] if n["type"] == "matrice_esthetique")
        palette["palette"] = ["#AABBCC", "rouge", "#123", "#00ff00"]
        data["nodes"].append({**data["nodes"][1], "category": "shadow"})  # type incohérent : écarté
        data["links"] += [{"from": "a1", "to": "inconnu", "kind": "forge"}, {"from": "a1", "to": "s6", "kind": "forge"},
                          {"from": "core", "to": "e1", "kind": "aime"}]
        e = engram.normalize(data)
        engines = [n for n in e["nodes"] if n["category"] == "engine"]
        self.assertEqual(len(engines), 10)
        self.assertEqual(sum(n["id"].startswith("x") for n in engines), 1, "on garde les plus intenses")
        self.assertEqual(len(e["nodes"][0]["title"]), engram.LIMITS["title"])
        self.assertEqual(next(n for n in e["nodes"] if n["type"] == "matrice_esthetique")["palette"], ["#aabbcc", "#00ff00"])
        self.assertEqual(len(e["links"]), 15, "liens inconnus, doublons et types invalides écartés")

    def test_duplicate_ids_are_made_unique(self):
        data = demo()
        for n in data["nodes"][1:4]:
            n["id"] = "e1"
        ids = [n["id"] for n in engram.normalize(data)["nodes"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_parse_tolerates_fences_and_prose(self):
        obj = {"a": 1}
        for text in ('{"a": 1}', '```json\n{"a": 1}\n```', 'Voici :\n{"a": 1}\nFin.'):
            self.assertEqual(engram.parse(text), obj)
        with self.assertRaises(engram.EngramError):
            engram.parse("pas de JSON")


class EngramApiTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self._saved = (prism.GEMINI_MODELS, prism._http_client)
        prism.GEMINI_API_KEY = "cle-test"
        prism.GEMINI_MODELS = [M1, M2]
        self.answers: dict[str, list[httpx.Response]] = {}
        self.calls: list[tuple[str, dict]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            model = request.url.path.split("/models/")[1].split(":")[0]
            self.calls.append((model, json.loads(request.content)))
            queue = self.answers.get(model) or []
            return queue.pop(0) if queue else gemini_json(demo())

        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(prism.app)
        self.auth = self.register(self.client)

    def tearDown(self):
        prism.GEMINI_MODELS, prism._http_client = self._saved
        super().tearDown()

    def post(self, person="Marie Curie", **extra):
        return self.client.post("/api/engram", json={"person": person, **extra}, headers=self.auth)

    def sparks(self):
        return self.client.get("/api/auth/me", headers=self.auth).json()["sparks"]

    def test_structured_output_request_and_billing(self):
        res = self.post()
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()
        self.assertEqual((data["mode"], data["model"], data["cost"], data["sparks"]), ("gemini", M1, 2.0, 48.0))
        self.assertEqual(len(data["engram"]["nodes"]), 30)
        _, body = self.calls[0]
        config = body["generationConfig"]
        self.assertEqual(config["responseMimeType"], "application/json")
        self.assertEqual(config["responseSchema"], engram.SCHEMA)
        self.assertTrue(body["systemInstruction"]["parts"][0]["text"].startswith("You are the Engram architect"))
        self.assertIn("<<<\nMarie Curie\n>>>", body["contents"][0]["parts"][0]["text"])

    def test_invalid_engram_falls_back_to_the_next_model(self):
        thin = demo()
        thin["nodes"] = thin["nodes"][:12]
        self.answers[M1] = [gemini_json(thin)]
        res = self.post()
        self.assertEqual(res.json()["model"], M2)
        self.assertEqual([m for m, _ in self.calls], [M1, M2])

    def test_schema_rejected_everywhere_retries_in_plain_json_mode(self):
        refused = httpx.Response(400, json={"error": {"code": 400, "message": "Invalid JSON payload: responseSchema"}})
        self.answers = {M1: [refused, gemini_json("```json\n" + json.dumps(demo()) + "\n```")], M2: [refused]}
        res = self.post()
        self.assertEqual(res.status_code, 200, res.text)
        schemas = [("responseSchema" in b["generationConfig"], b["generationConfig"].get("responseMimeType")) for _, b in self.calls]
        self.assertEqual(schemas, [(True, "application/json"), (True, "application/json"), (False, "application/json")])

    def test_refusal_is_explained_and_refunded(self):
        self.answers[M1] = [gemini_json({"person": "?", "public_figure": False, "refusal": "Personne privée : pas d'engramme.",
                                         "summary": "", "nodes": [], "links": []})]
        res = self.post("Mon voisin")
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json()["detail"]["code"], "engram_refused")
        self.assertEqual(len(self.calls), 1, "un refus ne passe pas au modèle suivant")
        self.assertEqual(self.sparks(), 50.0)

    def test_all_models_fail_refund(self):
        self.answers = {M1: [httpx.Response(500)] * 2, M2: [gemini_json("pas du json")]}
        res = self.post()
        self.assertEqual(res.status_code, 502)
        self.assertIn("Engramme impossible", res.json()["detail"])
        self.assertEqual(self.sparks(), 50.0)

    def test_demo_mode_without_model(self):
        prism.GEMINI_API_KEY = ""
        res = self.post("Quelqu'un")
        self.assertEqual((res.json()["mode"], res.json()["model"]), ("mock", "mock:engram-marie-curie"))
        self.assertEqual(res.json()["engram"]["person"], "Marie Curie")
        self.assertEqual(self.calls, [])

    def test_validation_auth_and_sparks(self):
        self.assertEqual(self.client.post("/api/engram", json={"person": "Marie Curie"}).status_code, 401)
        for bad in ({"person": "x"}, {"person": "y" * 121}, {"person": "Marie Curie", "language": "de"}):
            self.assertEqual(self.client.post("/api/engram", json=bad, headers=self.auth).status_code, 422)
        for _ in range(25):  # 50 Sparks → 25 engrammes
            self.assertEqual(self.post().status_code, 200)
        res = self.post()
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["detail"]["code"], "insufficient_sparks")


class DnaGenerateTests(DbTestCase):
    """« Injection d'ADN » : le trait choisi part avec la demande et filtre la génération."""

    DOC = "<!DOCTYPE html><html><head><title>Minuteur</title></head><body><p>ok</p></body></html>"

    def setUp(self):
        super().setUp()
        self._saved = (prism.GEMINI_MODELS, prism._http_client)
        prism.GEMINI_API_KEY = "cle-test"
        prism.GEMINI_MODELS = [M1]
        self.bodies: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.bodies.append(json.loads(request.content))
            return gemini_json(self.DOC)

        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(prism.app)
        self.auth = self.register(self.client)
        self.trait = engram.DEMO["nodes"][6]  # matrice esthétique, avec palette

    def tearDown(self):
        prism.GEMINI_MODELS, prism._http_client = self._saved
        super().tearDown()

    def dna(self, **changes):
        n = self.trait
        return {"person": "Marie Curie", "category": n["category"], "type": n["type"], "title": n["title"],
                "content": n["content"], "directive": n["directive"], "palette": n.get("palette", []), **changes}

    def test_trait_reaches_the_model(self):
        res = self.client.post("/api/generate", json={"prompt": "Un minuteur", "dna": self.dna()}, headers=self.auth)
        self.assertEqual(res.status_code, 200, res.text)
        message = self.bodies[0]["contents"][0]["parts"][0]["text"]
        self.assertIn("COGNITIVE DNA FILTER", message)
        self.assertIn(self.trait["directive"], message)
        self.assertIn("Palette to use: " + ", ".join(self.trait["palette"]), message)
        self.assertLess(message.index("<<<\nUn minuteur\n>>>"), message.index("COGNITIVE DNA FILTER"), "la demande d'abord")

    def test_invalid_trait_is_rejected_before_billing(self):
        cases = {
            "type d'une autre catégorie": self.dna(category="shadow"),
            "couleur invalide": self.dna(palette=["rouge"]),
            "directive vide": self.dna(directive=""),
            "titre trop long": self.dna(title="T" * (engram.LIMITS["title"] + 1)),
        }
        for label, dna in cases.items():
            with self.subTest(label):
                res = self.client.post("/api/generate", json={"prompt": "Un minuteur", "dna": dna}, headers=self.auth)
                self.assertEqual(res.status_code, 422)
        self.assertEqual(self.bodies, [])
        self.assertEqual(self.client.get("/api/auth/me", headers=self.auth).json()["sparks"], 50.0)

    def test_refactor_ignores_the_trait(self):
        created = self.client.post("/api/generate", json={"prompt": "Un minuteur"}, headers=self.auth).json()
        res = self.client.post("/api/generate", json={"prompt": "ajoute un titre", "widget_id": created["widget"]["id"], "dna": self.dna()},
                               headers=self.auth)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertNotIn("COGNITIVE DNA FILTER", self.bodies[-1]["contents"][0]["parts"][0]["text"])

    def test_page_may_use_the_microphone_widgets_never(self):
        policy = self.client.get("/api/health").headers["Permissions-Policy"]
        self.assertIn("microphone=(self)", policy, "incantation vocale et verre organique (page)")
        self.assertIn("camera=()", policy)


if __name__ == "__main__":
    unittest.main()
