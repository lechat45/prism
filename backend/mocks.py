"""Composants de démonstration servis quand GROQ_API_KEY n'est pas renseignée.

Les gabarits HTML et les règles de routage vivent dans frontend/engine/mocks/ :
ils sont partagés avec le moteur navigateur (frontend/engine/local.js) utilisé
sur GitHub Pages, où aucun backend ne tourne. Toute modification de la démo se
fait donc à un seul endroit.
"""
from __future__ import annotations

import html
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

MOCKS_DIR = Path(__file__).resolve().parent.parent / "frontend" / "engine" / "mocks"


@lru_cache(maxsize=1)
def manifest() -> dict:
    return json.loads((MOCKS_DIR / "manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=None)
def template(name: str) -> str:
    return (MOCKS_DIR / f"{name}.html").read_text(encoding="utf-8").rstrip("\n")


def _js_value(value: object) -> str:
    """JSON sûr à injecter dans un <script> (aucun « < » ne peut fermer la balise)."""
    # Compact, comme JSON.stringify : sortie identique au moteur navigateur.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def extract_series(prompt: str) -> list[dict[str, float | str]]:
    """Récupère des paires « libellé : valeur » dans le texte collé par l'utilisateur."""
    spec = manifest()
    series = []
    for label, value in re.findall(spec["series_pattern"], prompt):
        label = label.strip(" '’-")
        if label and len(series) < spec["series_max"]:
            number = float(value.replace(",", "."))
            # 12400 et non 12400.0 : même JSON que parseFloat côté navigateur.
            series.append({"label": label[: spec["label_max"]], "value": int(number) if number.is_integer() else number})
    return series


def _route(prompt: str) -> str:
    spec = manifest()
    text = _normalize(prompt)
    for route in spec["routes"]:
        if any(keyword in text for keyword in route["keywords"]):
            return route["template"]
    if len(extract_series(prompt)) >= spec["series_min"]:
        return "dashboard"
    return spec["fallback"]


def render(name: str, prompt: str) -> str:
    spec = manifest()
    marks = spec["placeholders"]
    document = template(name)
    if name == "dashboard":
        series = extract_series(prompt)
        own_data = len(series) >= spec["series_min"]
        source = spec["sources"]["user" if own_data else "sample"]
        document = document.replace(marks["data"], _js_value(series if own_data else spec["sample_series"]))
        document = document.replace(marks["source"], html.escape(source))
    return document.replace(marks["prompt"], html.escape(prompt))


def mock_component(prompt: str) -> tuple[str, str]:
    """Retourne (html, nom_du_gabarit) pour une demande donnée."""
    name = _route(prompt)
    return render(name, prompt), name
