"""Engramme cognitif (V4) : carte interprétative de l'esprit d'une personnalité publique, en 30 à 36 nœuds.

Gemini reçoit un schéma de réponse (frontend/engine/engram/schema.json, partagé avec le moteur navigateur)
et renvoie un JSON syntaxiquement garanti ; ce module en vérifie le SENS avant de le livrer :
  A. core      exactement 1 nœud « axiome » ;
  B. engine    8 à 10 nœuds, chacun des 4 types au moins une fois ;
  C. shadow    10 à 15 nœuds, chacun des 3 types au moins une fois ;
  D. artifact  exactement 10 évènements datés (triés), avec leur impact ;
  30 nœuds au moins. Les surplus sont écartés (les moins intenses d'abord), les manques font échouer le modèle
  (le suivant de la chaîne prend le relais). Chaque nœud porte sa « directive » : le filtre qui, déposé sur une
  génération, en dicte l'esthétique et la logique.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import billing
from auth import current_user
from models import User
from providers import FatalGenerationError, GenerationError, SchemaRejected

log = logging.getLogger("prism.engram")
router = APIRouter(prefix="/api", tags=["engram"])

ENGRAM_DIR = Path(__file__).resolve().parent.parent / "frontend" / "engine" / "engram"
SCHEMA = json.loads((ENGRAM_DIR / "schema.json").read_text(encoding="utf-8"))
SYSTEM_PROMPT = (ENGRAM_DIR / "system-prompt.txt").read_text(encoding="utf-8").strip()
USER_TEMPLATE = (ENGRAM_DIR / "user-template.txt").read_text(encoding="utf-8").strip()
DEMO = json.loads((ENGRAM_DIR / "demo-marie-curie.json").read_text(encoding="utf-8"))

TYPES = {
    "core": ("axiome",),
    "engine": ("algorithme_resolution", "empreinte_syntaxique", "matrice_esthetique", "methode_travail"),
    "shadow": ("paradoxe", "peur_primaire", "biais_cognitif"),
    "artifact": ("succes", "echec", "tournant"),
}
COUNTS = {"core": (1, 1), "engine": (8, 10), "shadow": (10, 15), "artifact": (10, 10)}
MIN_NODES = 30
LANGUAGES = {"fr": "French", "en": "English"}
DATE_RE = re.compile(r"^-?\d{1,4}(-\d{2}(-\d{2})?)?$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
LIMITS = {"title": 60, "content": 700, "directive": 400, "evidence": 300, "impact": 400, "summary": 400, "domain": 120}


class EngramError(Exception):
    """Réponse inutilisable : le modèle suivant est essayé."""


class EngramRefused(Exception):
    """Le modèle refuse (personne privée, mineure, inconnue) : on s'arrête et on explique."""


# --------------------------------------------------------------------------- #
# Validation et normalisation (données du modèle : non fiables)
# --------------------------------------------------------------------------- #
def _scalar(value) -> str:
    """Chaîne, ou entier écrit en chiffres ; tout le reste compte pour vide (comme en JS)."""
    if isinstance(value, str):
        return value
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else ""


def _text(value, limit: int) -> str:
    text = re.sub(r"\s+", " ", _scalar(value)).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _intensity(value) -> float:
    """0..1 arrondi au centième (arrondi « demi vers le haut », identique en JS) ; 0,5 si illisible."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)) or (isinstance(value, str) and not value.strip()):
        return 0.5
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.5
    if not math.isfinite(number):
        return 0.5
    return math.floor(min(1.0, max(0.0, number)) * 100 + 0.5) / 100


def _date_key(date: str) -> tuple[int, int, int]:
    """« 1898-12-26 », « 1903 », « -44-03 » (avant notre ère) → clé de tri chronologique."""
    negative = date.startswith("-")
    parts = [int(p) for p in date.lstrip("-").split("-")] + [0, 0]
    return (-parts[0] if negative else parts[0], parts[1], parts[2])


def _slug(value: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", _scalar(value).lower()).strip("-")[:24]
    return slug or fallback


def normalize(raw: dict) -> dict:
    """JSON du modèle → Engramme conforme, ou EngramError / EngramRefused."""
    if not isinstance(raw, dict):
        raise EngramError("réponse qui n'est pas un objet JSON")
    refusal = raw.get("refusal").strip() if isinstance(raw.get("refusal"), str) else ""
    if refusal or raw.get("public_figure") is False:
        raise EngramRefused(_text(refusal or "Personnalité publique non reconnue.", 300))
    nodes, seen = [], set()
    for index, node in enumerate(raw.get("nodes") if isinstance(raw.get("nodes"), list) else []):
        if not isinstance(node, dict):
            continue
        category = node.get("category")
        if not isinstance(category, str) or category not in TYPES or node.get("type") not in TYPES[category]:
            continue  # type incohérent avec sa catégorie : nœud écarté (les comptes trancheront)
        node_id = _slug(node.get("id"), f"n{index}")
        while node_id in seen:
            node_id = f"{node_id[:20]}-{index}"
        seen.add(node_id)
        intensity = _intensity(node.get("intensity"))
        clean = {
            "id": node_id,
            "category": category,
            "type": node["type"],
            "title": _text(node.get("title"), LIMITS["title"]),
            "content": _text(node.get("content"), LIMITS["content"]),
            "directive": _text(node.get("directive"), LIMITS["directive"]),
            "basis": node.get("basis") if node.get("basis") in ("documente", "declare", "interpretation") else "interpretation",
            "evidence": _text(node.get("evidence"), LIMITS["evidence"]),
            "intensity": intensity,
        }
        if not (clean["title"] and clean["content"] and clean["directive"]):
            continue
        if category == "artifact":
            date = _scalar(node.get("date")).strip()
            impact = _text(node.get("impact"), LIMITS["impact"])
            if not DATE_RE.fullmatch(date) or not impact:
                continue  # un artefact sans date vérifiable n'a pas sa place
            clean["date"] = date
            clean["impact"] = impact
        if node["type"] == "matrice_esthetique":
            palette = node.get("palette") if isinstance(node.get("palette"), list) else []
            clean["palette"] = [c.lower() for c in palette if isinstance(c, str) and HEX_RE.fullmatch(c)][:5]
        if node["type"] == "empreinte_syntaxique":
            keywords = node.get("keywords") if isinstance(node.get("keywords"), list) else []
            clean["keywords"] = [_text(k, 40) for k in keywords if isinstance(k, str) and k.strip()][:8]
        nodes.append({**clean, "_order": index})

    by_category: dict[str, list[dict]] = {c: [n for n in nodes if n["category"] == c] for c in TYPES}
    for category, (low, high) in COUNTS.items():
        group = by_category[category]
        if len(group) < low:
            raise EngramError(f"catégorie {category} : {len(group)} nœud(s) valides, {low} attendus au moins")
        if len(group) > high:  # surplus : on garde les plus intenses, dans l'ordre du modèle
            keep = {id(n) for n in sorted(group, key=lambda n: -n["intensity"])[:high]}
            by_category[category] = [n for n in group if id(n) in keep]
        missing = set(TYPES[category]) - {n["type"] for n in by_category[category]}
        if missing:
            raise EngramError(f"catégorie {category} : types manquants {sorted(missing)}")
    by_category["artifact"].sort(key=lambda n: _date_key(n["date"]))
    ordered = [n for c in TYPES for n in by_category[c]]
    if len(ordered) < MIN_NODES:
        raise EngramError(f"{len(ordered)} nœuds, {MIN_NODES} attendus au moins")
    for node in ordered:
        node.pop("_order", None)

    ids = {n["id"] for n in ordered}
    links, pairs = [], set()
    for link in raw.get("links") if isinstance(raw.get("links"), list) else []:
        if not isinstance(link, dict):
            continue
        a, b, kind = _slug(link.get("from"), ""), _slug(link.get("to"), ""), link.get("kind")
        if a in ids and b in ids and a != b and kind in ("forge", "nourrit", "contredit") and (a, b) not in pairs:
            pairs.add((a, b))
            links.append({"from": a, "to": b, "kind": kind})
    return {
        "person": _text(raw.get("person"), 120),
        "domain": _text(raw.get("domain"), LIMITS["domain"]),
        "summary": _text(raw.get("summary"), LIMITS["summary"]),
        "nodes": ordered,
        "links": links[:40],
    }


def parse(text: str) -> dict:
    """Texte du modèle → objet JSON (tolère un bloc ```json, en mode JSON simple)."""
    body = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", body, re.S)
    if fence:
        body = fence.group(1)
    elif not body.startswith("{"):
        start, end = body.find("{"), body.rfind("}")
        body = body[start : end + 1] if start != -1 and end > start else body
    try:
        return json.loads(body)
    except ValueError as exc:
        raise EngramError(f"JSON illisible ({exc})") from exc


def build_user_message(person: str, language: str) -> str:
    values = {"person": person, "language": LANGUAGES.get(language, "French")}
    return re.sub(r"\{\{(person|language)\}\}", lambda m: values[m.group(1)], USER_TEMPLATE)


def demo_engram() -> dict:
    return normalize(DEMO)


# --------------------------------------------------------------------------- #
# Génération
# --------------------------------------------------------------------------- #
async def run_models(providers, http_client, person: str, language: str, timeout: float) -> tuple[dict, str, str]:
    """(engramme, fournisseur, modèle). Schéma imposé d'abord ; si chaque modèle le refuse, JSON simple."""
    user = build_user_message(person, language)
    errors: list[str] = []
    for with_schema in (True, False):
        rejected_all = True
        async with http_client() as client:
            for provider in providers:
                for model in provider.models:
                    try:
                        text = await provider.complete(client, model, SYSTEM_PROMPT, user, timeout,
                                                       json_mode=True, schema=SCHEMA if with_schema and provider.name == "gemini" else None)
                        return normalize(parse(text)), provider.name, model
                    except EngramRefused:
                        raise
                    except SchemaRejected as exc:
                        errors.append(str(exc))
                        continue
                    except FatalGenerationError as exc:
                        errors.append(str(exc))
                        rejected_all = False
                        break
                    except (GenerationError, EngramError) as exc:
                        log.warning("engramme : %s", exc)
                        errors.append(f"{model}: {exc}" if isinstance(exc, EngramError) else str(exc))
                        rejected_all = False
        if not rejected_all:
            break
    raise HTTPException(status_code=502, detail="Engramme impossible : " + " | ".join(errors[-6:]))


class EngramRequest(BaseModel):
    person: str = Field(..., min_length=2, max_length=120)
    language: Literal["fr", "en"] = "fr"


class EngramResponse(BaseModel):
    engram: dict
    mode: str  # "gemini" | "groq" | "mock"
    model: str
    sparks: float
    cost: float


@router.post("/engram", response_model=EngramResponse)
async def create_engram(req: EngramRequest, user: User = Depends(current_user)) -> EngramResponse:
    import app  # fournisseurs actifs et client HTTP (substituables par les tests)  # noqa: PLC0415

    person = re.sub(r"\s+", " ", req.person).strip()
    try:
        reservation = await asyncio.to_thread(billing.reserve, user.id, "engram")
    except billing.InsufficientSparks as exc:
        raise app.insufficient(exc) from exc
    try:
        providers = app.active_providers()
        if providers:
            engram, mode, model = await run_models(providers, app._http_client, person, req.language, app.TIMEOUT_S)
        else:
            engram, mode, model = demo_engram(), "mock", "mock:engram-marie-curie"
    except EngramRefused as exc:
        await asyncio.shield(asyncio.to_thread(billing.refund, reservation))
        raise HTTPException(status_code=422, detail={"code": "engram_refused", "message": str(exc)}) from exc
    except BaseException:
        await asyncio.shield(asyncio.to_thread(billing.refund, reservation))
        raise
    await asyncio.to_thread(billing.confirm, reservation, None)
    return EngramResponse(
        engram=engram, mode=mode, model=model,
        sparks=billing.as_sparks(await asyncio.to_thread(billing.balance, user.id)),
        cost=billing.as_sparks(reservation.cost_cents),
    )
