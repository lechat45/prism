"""Valide une réponse de /api/generate enregistrée par curl.

Usage :
    curl -s -X POST http://127.0.0.1:8000/api/generate -H "Content-Type: application/json" \
         -d @requete.json -o reponse.json
    python tools/check_generate.py reponse.json

Code de sortie 0 si le document est exploitable, 1 sinon.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from sanitize import inline_scripts, is_blocking, js_syntax_errors, validate_document  # noqa: E402


def check(path: Path) -> bool:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if "html" not in payload:
        print(f"ÉCHEC  réponse sans champ html : {payload}")
        return False

    html = payload["html"]
    issues = validate_document(html)
    js_errors = js_syntax_errors(html)
    checks = [
        ("JSON valide avec champ html", True),
        ("aucune balise Markdown (```)", "```" not in html),
        ("commence par <!DOCTYPE html>", bool(re.match(r"<!doctype html>", html, re.I))),
        ("se termine par </html>", html.rstrip().lower().endswith("</html>")),
        ("aucune prose hors du document", html == html.strip()),
        ("structure HTML sans défaut bloquant", not is_blocking(issues)),
        (f"syntaxe JS valide ({len(inline_scripts(html))} script(s) analysé(s) par Node)", not js_errors),
    ]

    print(f"mode={payload.get('mode')}  modèle={payload.get('model')}  "
          f"durée={payload.get('elapsed_ms')} ms  taille={len(html.encode('utf-8'))} octets")
    for label, ok in checks:
        print(f"  {'OK   ' if ok else 'ÉCHEC'}  {label}")
    for err in js_errors:
        print(f"         {err}")
    if issues:
        print(f"  avertissements : {', '.join(issues)}")
    return all(ok for _, ok in checks)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(0 if check(Path(sys.argv[1])) else 1)
