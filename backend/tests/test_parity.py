"""Cas partagés (frontend/tests/fixtures.json) et parité Python ↔ navigateur.

Le moteur navigateur (GitHub Pages) réimplémente en JS le nettoyage, la
validation et le mode démo. Ce test rejoue les mêmes cas dans les deux
langages et exige des résultats identiques, rendus HTML complets compris.
"""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app  # noqa: E402
import engram  # noqa: E402
import mocks  # noqa: E402
from sanitize import (  # noqa: E402
    clean_llm_output,
    has_markup,
    is_blocking,
    js_syntax_errors,
    normalize_libraries,
    validate_document,
)

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
FIXTURES = json.loads((FRONTEND / "tests" / "fixtures.json").read_text(encoding="utf-8"))
NODE = shutil.which("node")


def _message(case: dict) -> str:
    file = app.AttachedFile(**case["file"]) if case.get("file") else None
    canvas = [app.CanvasWidget(**w) for w in case.get("canvas", [])]
    dna = app.DnaTrait(**case["dna"]) if case.get("dna") else None
    return app.build_user_message(case["prompt"], file, case.get("base_html"), canvas, dna)


def patched(case: dict):
    """Démo de l'Engramme modifiée par les opérations du cas (même algorithme dans run_fixtures.cjs)."""
    if "raw" in case:
        return copy.deepcopy(case["raw"])
    data = copy.deepcopy(engram.DEMO)
    for op, path, *value in case["patch"]:
        parent = data
        for key in path[:-1]:
            parent = parent[key]
        if op == "set":
            parent[path[-1]] = copy.deepcopy(value[0])
        elif op == "append":
            parent[path[-1]].append(copy.deepcopy(value[0]))
        else:
            del parent[path[-1]]
    return data


def engram_result(case: dict) -> dict:
    try:
        return {"ok": engram.normalize(patched(case))}
    except engram.EngramRefused:
        return {"error": "EngramRefused"}
    except engram.EngramError:
        return {"error": "EngramError"}


def chat_results(case: dict) -> dict:
    source = copy.deepcopy(engram.DEMO) if case["engram"] == "demo" else case["engram"]
    try:
        normalized = {"ok": engram.normalize_chat(case["raw"], source)}
    except engram.EngramError:
        normalized = {"error": "EngramError"}
    return {"message": engram.build_chat_message(source, case["history"], case["message"], "fr"),
            "demo": engram.demo_chat(source, case["message"]), "normalized": normalized}


def parse_result(text: str) -> dict:
    try:
        return {"ok": engram.parse(text)}
    except engram.EngramError:
        return {"error": "EngramError"}


def python_results() -> dict:
    return {
        "clean": [clean_llm_output(c["raw"]) for c in FIXTURES["clean"]],
        "markup": [has_markup(c["text"]) for c in FIXTURES["markup"]],
        "validate": [validate_document(c["doc"], app.ALLOWED_URLS) for c in FIXTURES["validate"]],
        "js_syntax": [len(js_syntax_errors(c["doc"])) for c in FIXTURES["js_syntax"]],
        "libraries": [normalize_libraries(c["doc"], app.LIBS) for c in FIXTURES["libraries"]],
        "routing": [mocks.mock_component(c["prompt"], c.get("file_kind"))[1] for c in FIXTURES["routing"]],
        "series": [mocks.extract_series(c["prompt"]) for c in FIXTURES["series"]],
        "renders": [mocks.mock_component(c["prompt"], c.get("file_kind"))[0] for c in FIXTURES["render"]],
        "mock_renders": [mocks.mock_component(c["prompt"], c.get("file_kind"))[0] for c in FIXTURES["routing"]],
        "messages": [_message(c) for c in FIXTURES["messages"]],
        "engram": [engram_result(c) for c in FIXTURES["engram"]],
        "engram_parse": [parse_result(t) for t in FIXTURES["engram_parse"]],
        "engram_messages": [engram.build_user_message(c["person"], c["language"]) for c in FIXTURES["engram_messages"]],
        "engram_chat": [chat_results(c) for c in FIXTURES["engram_chat"]],
    }


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = python_results()

    def test_clean(self):
        for case, got in zip(FIXTURES["clean"], self.r["clean"]):
            self.assertEqual(got, case["expected"], case["name"])

    def test_markup(self):
        for case, got in zip(FIXTURES["markup"], self.r["markup"]):
            self.assertEqual(got, case["expected"], case["text"])

    def test_validate(self):
        for case, got in zip(FIXTURES["validate"], self.r["validate"]):
            with self.subTest(case["name"]):
                self.assertEqual(is_blocking(got), case["blocking"])
                if "exact" in case:
                    self.assertEqual(got, case["exact"])
                for issue in case.get("includes", []):
                    self.assertIn(issue, got)

    @unittest.skipUnless(NODE, "Node.js requis")
    def test_js_syntax(self):
        for case, got in zip(FIXTURES["js_syntax"], self.r["js_syntax"]):
            self.assertEqual(got, case["errors"], case["name"])

    def test_routing_and_series(self):
        for case, got in zip(FIXTURES["routing"], self.r["routing"]):
            self.assertEqual(got, case["template"], case["prompt"])
        for case, got in zip(FIXTURES["series"], self.r["series"]):
            self.assertEqual([s["label"] for s in got], case["labels"])
            self.assertEqual([s["value"] for s in got], case["values"])

    def test_libraries(self):
        pinned = app.LIBS["chartjs"]["url"]
        for case, got in zip(FIXTURES["libraries"], self.r["libraries"]):
            with self.subTest(case["name"]):
                self.assertEqual(got.count(pinned), case["pinned"])
                self.assertEqual(got.count(app.LIBS["tailwind"]["url"]), case.get("tailwind", 0))
                if case["pinned"]:
                    self.assertIn(f'integrity="{app.LIBS["chartjs"]["integrity"]}"', got)
                for needle in case.get("absent", []):
                    self.assertNotIn(needle, got)
                for needle in case.get("contains", []):
                    self.assertIn(needle, got)
                self.assertEqual(normalize_libraries(got, app.LIBS), got, "idempotent")

    def test_demo_templates_keep_their_own_css(self):
        # Les gabarits de démo ont leur CSS : le reset de Tailwind (preflight) les casserait.
        for html in self.r["mock_renders"] + self.r["renders"]:
            self.assertNotIn(app.LIBS["tailwind"]["url"], html)

    def test_messages(self):
        for case, got in zip(FIXTURES["messages"], self.r["messages"]):
            with self.subTest(case["name"]):
                for needle in case.get("contains", []):
                    self.assertIn(needle, got)
                for needle in case.get("absent", []):
                    self.assertNotIn(needle, got)

    def test_engram_cases_cover_both_outcomes(self):
        outcomes = [next(iter(r)) for r in self.r["engram"]]
        self.assertGreaterEqual(outcomes.count("ok"), 8)
        self.assertIn({"error": "EngramRefused"}, self.r["engram"])
        self.assertIn({"error": "EngramError"}, self.r["engram"])
        by_name = {c["name"]: r for c, r in zip(FIXTURES["engram"], self.r["engram"])}
        surplus = by_name["surplus d'ombres : les plus intenses, ordre conservé"]["ok"]
        shadows = [n["id"] for n in surplus["nodes"] if n["category"] == "shadow"]
        self.assertEqual(len(shadows), 15)
        self.assertIn("x3", shadows)
        self.assertNotIn("x6", shadows)
        title = by_name["textes : espaces, coupe au point de code, scalaires"]["ok"]["nodes"][0]["title"]
        self.assertEqual(len(title), engram.LIMITS["title"])
        self.assertTrue(title.startswith("Comprendre, jamais craindre \U0001f30d") and title.endswith("…"))

    def test_render(self):
        for case, got in zip(FIXTURES["render"], self.r["renders"]):
            with self.subTest(case["name"]):
                for needle in case.get("contains", []):
                    self.assertIn(needle, got)
                for needle in case.get("absent", []):
                    self.assertNotIn(needle, got)
                if "script_tags" in case:
                    self.assertEqual(got.lower().count("<script>"), case["script_tags"])


@unittest.skipUnless(NODE, "Node.js requis")
class ParityTests(unittest.TestCase):
    """Le moteur navigateur doit produire exactement les mêmes résultats."""

    @classmethod
    def setUpClass(cls):
        proc = subprocess.run(
            [NODE, str(FRONTEND / "tests" / "run_fixtures.cjs")],
            capture_output=True, text=True, encoding="utf-8", check=True,
        )
        cls.js = json.loads(proc.stdout)
        cls.py = python_results()

    def test_same_results(self):
        for section in self.py:
            with self.subTest(section=section):
                self.assertEqual(self.js[section], self.py[section])


if __name__ == "__main__":
    unittest.main()
