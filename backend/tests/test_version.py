"""La version affichée à côté de « Prism » suit celle du serveur et du CHANGELOG (règle : une version par livraison)."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

import app

ROOT = Path(__file__).resolve().parents[2]
LABELS = {"a": "alpha", "b": "beta", "rc": "rc"}


def semver(pep440: str) -> str:
    """« 4.0.0a5 » → « 4.0.0-alpha.5 », « 3.5.0rc1 » → « 3.5.0-rc.1 », « 4.0.0 » → « 4.0.0 »."""
    m = re.fullmatch(r"(\d+\.\d+\.\d+)(?:(a|b|rc)(\d+))?", pep440)
    assert m, pep440
    return m.group(1) + (f"-{LABELS[m.group(2)]}.{m.group(3)}" if m.group(2) else "")


class VersionTests(unittest.TestCase):
    def test_interface_changelog_and_server_agree(self):
        version = semver(app.__version__)
        html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        shown = re.search(r'id="app-version"[^>]*>v([^<]+)<', html)
        self.assertIsNotNone(shown, "badge de version à côté de « Prism »")
        self.assertEqual(shown.group(1), version, "index.html")
        first = re.search(r"^## (\S+)", (ROOT / "CHANGELOG.md").read_text(encoding="utf-8"), re.M)
        self.assertEqual(first.group(1), version, "première entrée du CHANGELOG")

    def test_semver(self):
        self.assertEqual(semver("4.0.0a5"), "4.0.0-alpha.5")
        self.assertEqual(semver("3.5.0rc1"), "3.5.0-rc.1")
        self.assertEqual(semver("4.0.0"), "4.0.0")


if __name__ == "__main__":
    unittest.main()
