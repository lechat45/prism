"""Tests du nettoyage de sortie LLM et des composants de démo.

Lancement :  python -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mocks import extract_series, mock_component  # noqa: E402
from sanitize import (  # noqa: E402
    clean_llm_output,
    ensure_document,
    inline_scripts,
    is_blocking,
    js_syntax_errors,
    validate_document,
)

DOC = '<!DOCTYPE html>\n<html lang="fr"><head><style>b{}</style></head><body><b>ok</b><script>let a = 1;</script></body></html>'
HAS_NODE = shutil.which("node") is not None


class CleanOutputTests(unittest.TestCase):
    def test_clean_document_is_untouched(self):
        self.assertEqual(clean_llm_output(DOC), DOC)

    def test_strips_markdown_fence_and_prose(self):
        raw = f"Voici votre composant :\n\n```html\n{DOC}\n```\n\nBonne utilisation !"
        self.assertEqual(clean_llm_output(raw), DOC)

    def test_strips_unterminated_fence(self):
        self.assertEqual(clean_llm_output(f"```html\n{DOC}"), DOC)

    def test_strips_think_block(self):
        self.assertEqual(clean_llm_output(f"<think>je réfléchis</think>\n{DOC}"), DOC)

    def test_picks_largest_fenced_block(self):
        raw = f"```css\nb{{}}\n```\n```html\n{DOC}\n```"
        self.assertEqual(clean_llm_output(raw), DOC)

    def test_fragment_is_wrapped(self):
        wrapped = ensure_document(clean_llm_output("Bien sûr !\n<div>salut</div>\nVoilà."))
        self.assertTrue(wrapped.startswith("<!DOCTYPE html>"))
        self.assertIn("<div>salut</div>", wrapped)
        self.assertEqual(validate_document(wrapped), [])

    def test_missing_doctype_is_added(self):
        self.assertTrue(ensure_document("<html><body></body></html>").startswith("<!DOCTYPE html>"))


class ValidateTests(unittest.TestCase):
    def test_clean_document_has_no_issue(self):
        self.assertEqual(validate_document(DOC), [])

    def test_truncated_document_is_blocking(self):
        truncated = ensure_document(clean_llm_output(DOC[: DOC.index("let a")]))
        self.assertTrue(is_blocking(validate_document(truncated)))

    def test_leftover_fence_is_blocking(self):
        self.assertTrue(is_blocking(validate_document(DOC.replace("ok", "```"))))

    def test_sandbox_warnings_are_not_blocking(self):
        issues = validate_document(DOC.replace("let a = 1;", "sessionStorage.x = 1; fetch('https://x.y');"))
        self.assertIn("sandbox_api:sessionStorage", issues)
        self.assertIn("sandbox_api:fetch()", issues)
        self.assertFalse(is_blocking(issues))

    def test_local_storage_is_expected(self):
        # v2 : la sandbox fournit un localStorage persistant par widget, que le prompt impose.
        self.assertEqual(validate_document(DOC.replace("let a = 1;", 'localStorage.setItem("state", "{}");')), [])

    def test_external_resource_detected(self):
        self.assertIn("external_resource", validate_document(DOC.replace("<b>", '<img src="https://cdn.x/y.png"><b>')))

    def test_inline_scripts_skip_data_and_src(self):
        doc = DOC.replace(
            "<script>",
            '<script type="application/json">{"a":1}</script><script src="x.js"></script><script>',
        )
        self.assertEqual(inline_scripts(doc), ["let a = 1;"])

    @unittest.skipUnless(HAS_NODE, "Node.js requis")
    def test_js_syntax_error_detected(self):
        self.assertEqual(js_syntax_errors(DOC), [])
        errors = js_syntax_errors(DOC.replace("let a = 1;", "const x = ;\nlet é = 'accent';"))
        self.assertEqual(len(errors), 1)
        self.assertIn("script #1", errors[0])


class MockTests(unittest.TestCase):
    PROMPTS = {
        "counter": "Crée un bouton interactif qui change de couleur au clic et compte le nombre de clics",
        "calculator": "Une calculatrice élégante",
        "dashboard": "Tableau de bord des ventes : Janvier 12400, Février 15100, Mars 13850",
        "generic": "Un minuteur Pomodoro",
    }

    def test_routing(self):
        for expected, prompt in self.PROMPTS.items():
            with self.subTest(prompt=prompt):
                self.assertEqual(mock_component(prompt)[1], expected)

    def test_mocks_are_clean_and_valid_js(self):
        for prompt in self.PROMPTS.values():
            document, name = mock_component(prompt)
            with self.subTest(template=name):
                self.assertEqual(validate_document(document), [])
                self.assertEqual(js_syntax_errors(document), [])

    def test_prompt_cannot_break_out_of_script(self):
        document, _ = mock_component("dashboard </script><script>alert(1)</script> a: 1, b: 2")
        self.assertEqual(document.lower().count("<script>"), 1)

    def test_extract_series(self):
        series = extract_series("Janvier 12400, Février: 15100 ; Mars=13,5")
        self.assertEqual([s["label"] for s in series], ["Janvier", "Février", "Mars"])
        self.assertEqual(series[2]["value"], 13.5)


if __name__ == "__main__":
    unittest.main()
