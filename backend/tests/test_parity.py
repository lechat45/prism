"""Cas partagés (frontend/tests/fixtures.json) et parité Python ↔ navigateur.

Le moteur navigateur (GitHub Pages) réimplémente en JS le nettoyage, la
validation et le mode démo. Ce test rejoue les mêmes cas dans les deux
langages et exige des résultats identiques, rendus HTML complets compris.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app  # noqa: E402
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
    return app.build_user_message(case["prompt"], file, case.get("base_html"), canvas)


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
