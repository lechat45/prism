"""Mode Nexus (V6) : les Engrammes du canvas Nexus pensent pour de vrai.

Deux routes, facturées seulement quand l'utilisateur les déclenche (bouton qui affiche le prix), remboursées si le
modèle échoue :
  POST /api/nexus/think   un esprit pense à partir de ce que ses fils lui apportent (contextes, pensées en amont) ;
  POST /api/nexus/debate  War Room d'un Hub : chaque esprit prend position, répond à un autre, puis synthèse.

L'esprit arrive du navigateur tel que l'utilisateur l'a réglé dans son anatomie : Core (mode de raisonnement), State
(énergie, patience, créativité → humeur), Memories. Tout ce qui vient du modèle est vérifié avant d'être livré (le
modèle suivant prend le relais sinon). Sans modèle (mode démo), une pensée mécanique et honnête.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import billing
import engram
from auth import current_user
from models import User
from providers import FatalGenerationError, GenerationError, SchemaRejected

log = logging.getLogger("prism.nexus")
router = APIRouter(prefix="/api/nexus", tags=["nexus"])

NEXUS_DIR = engram.ENGRAM_DIR.parent / "nexus"
THINK_SYSTEM = (NEXUS_DIR / "think-system.txt").read_text(encoding="utf-8").strip()
THINK_TEMPLATE = (NEXUS_DIR / "think-template.txt").read_text(encoding="utf-8").strip()
THINK_SCHEMA = json.loads((NEXUS_DIR / "think-schema.json").read_text(encoding="utf-8"))
DEBATE_SYSTEM = (NEXUS_DIR / "debate-system.txt").read_text(encoding="utf-8").strip()
DEBATE_TEMPLATE = (NEXUS_DIR / "debate-template.txt").read_text(encoding="utf-8").strip()
DEBATE_SCHEMA = json.loads((NEXUS_DIR / "debate-schema.json").read_text(encoding="utf-8"))

CORES = {
    "science": ("Méthode scientifique stricte", "mesurer avant de conclure, ne retenir que ce qui se vérifie", "Lancer une mesure"),
    "simplicity": ("Simplicité radicale", "retirer jusqu'à l'évidence : une seule action, un seul écran", "Voir l'essentiel"),
    "empathy": ("Empathie utilisateur", "partir des personnes, de leur moment, de leurs mots", "Comprendre en 3 secondes"),
    "poetry": ("Science poétique", "voir les données comme des motifs à composer", "Composer le motif"),
    "systems": ("Pensée systémique", "chercher les boucles, les causes et les effets retard", "Voir les tendances"),
}
MOODS = ("Fatiguée", "Créative", "Patiente", "Concentrée")
LANGUAGES = engram.LANGUAGES
LIMITS = {"line": 280, "key": 40, "title": 90, "action": 40, "debate": 420, "point": 220}


class NexusError(Exception):
    """Réponse du modèle inutilisable : le modèle suivant est essayé."""


# --------------------------------------------------------------------------- requêtes
class Mind(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    role: str = Field("", max_length=120)
    core: Literal["science", "simplicity", "empathy", "poetry", "systems"] = "science"
    mood: str = Field("", max_length=40)
    energy: int = Field(50, ge=0, le=100)
    patience: int = Field(50, ge=0, le=100)
    creativity: int = Field(50, ge=0, le=100)
    memories: list[Annotated[str, Field(max_length=300)]] = Field([], max_length=16)


class Input(BaseModel):
    kind: Literal["context", "thought"]
    author: str = Field("", max_length=120)
    title: str = Field("", max_length=120)
    text: str = Field(..., min_length=1, max_length=3000)


class ThinkRequest(BaseModel):
    mind: Mind
    inputs: list[Input] = Field(..., min_length=1, max_length=8)
    language: Literal["fr", "en"] = "fr"


class DebateRequest(BaseModel):
    minds: list[Mind] = Field(..., min_length=2, max_length=5)
    question: str = Field(..., min_length=2, max_length=400)
    context: str = Field("", max_length=3000)
    language: Literal["fr", "en"] = "fr"


class ThinkResponse(BaseModel):
    thought: dict
    mode: str
    model: str
    sparks: float
    cost: float


class DebateResponse(BaseModel):
    debate: dict
    mode: str
    model: str
    sparks: float
    cost: float


# --------------------------------------------------------------------------- outils
def _clean(value, limit: int) -> str:
    text = re.sub(r"\s+", " ", value if isinstance(value, str) else "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _memories(mind: Mind) -> list[str]:
    return [m for m in (_clean(x, 160) for x in mind.memories) if m][:12]


def mood_of(mind: Mind) -> str:
    """Même règle que le navigateur (nexus.html, moodOf) si l'humeur n'est pas fournie."""
    if mind.mood in MOODS:
        return mind.mood
    if mind.energy < 30:
        return "Fatiguée"
    if mind.creativity >= 70:
        return "Créative"
    if mind.patience >= 70:
        return "Patiente"
    return "Concentrée"


def describe(mind: Mind) -> str:
    label, desc, _ = CORES[mind.core]
    lines = [f"name: {_clean(mind.name, 120)}"]
    if mind.role.strip():
        lines.append(f"role: {_clean(mind.role, 120)}")
    lines += [f"core: {mind.core} ({label} : {desc})", f"mood: {mood_of(mind)}",
              f"state: energy {mind.energy}/100, patience {mind.patience}/100, creativity {mind.creativity}/100"]
    memories = _memories(mind)
    lines.append("memories:" + ("".join(f"\n- {m}" for m in memories) if memories else " (none)"))
    return "\n".join(lines)


def _fill(template: str, values: dict) -> str:
    # Une seule passe : rien de ce qui est inséré n'est réinterprété comme gabarit.
    return re.sub(r"\{\{(\w+)\}\}", lambda m: values.get(m.group(1), m.group(0)), template)


def build_think_message(req: ThinkRequest) -> str:
    inputs = []
    for i, item in enumerate(req.inputs, 1):
        head = f"[{i}] context" + (f" « {_clean(item.title, 120)} »" if item.title.strip() else "") if item.kind == "context" \
            else f"[{i}] thought of {_clean(item.author, 120) or 'another mind'}"
        inputs.append(f"{head}:\n{_clean(item.text, 3000)}")
    return _fill(THINK_TEMPLATE, {"language": LANGUAGES.get(req.language, "French"), "mind": describe(req.mind),
                                  "inputs": "\n\n".join(inputs)})


def build_debate_message(req: DebateRequest) -> str:
    minds = "\n\n".join(describe(m) for m in req.minds)
    return _fill(DEBATE_TEMPLATE, {"language": LANGUAGES.get(req.language, "French"), "minds": minds,
                                   "question": _clean(req.question, 400), "context": _clean(req.context, 3000) or "(none)"})


# --------------------------------------------------------------------------- réponses du modèle
def normalize_thought(raw, mind: Mind) -> dict:
    if not isinstance(raw, dict):
        raise NexusError("réponse qui n'est pas un objet JSON")
    lines = [line for line in (_clean(x, LIMITS["line"]) for x in raw.get("lines") or [] if isinstance(x, str)) if line][:4]
    if len(lines) < 2:
        raise NexusError("pensée trop courte (moins de deux phrases)")
    keys = []
    for key in raw.get("keys") or []:
        key = _clean(key, LIMITS["key"])
        if key and key.lower() not in (k.lower() for k in keys):
            keys.append(key)
    title = _clean(raw.get("title"), LIMITS["title"])
    action = _clean(raw.get("action"), LIMITS["action"]) or CORES[mind.core][2]
    memories = _memories(mind)
    memory = _clean(raw.get("memory"), 160)
    memory = next((m for m in memories if m.lower() == memory.lower()), "")  # jamais un souvenir inventé
    if not title:
        raise NexusError("titre manquant")
    return {"lines": lines, "keys": keys[:5], "title": title, "action": action, "memory": memory}


def _match(name, minds: list[str]) -> str:
    wanted = _clean(name, 120).lower()
    return next((m for m in minds if m.lower() == wanted), "")


def normalize_debate(raw, minds: list[str]) -> dict:
    if not isinstance(raw, dict):
        raise NexusError("réponse qui n'est pas un objet JSON")
    positions, replies = {}, {}
    for item in raw.get("positions") or []:
        author = _match(item.get("author") if isinstance(item, dict) else "", minds)
        text = _clean(item.get("text"), LIMITS["debate"]) if isinstance(item, dict) else ""
        if author and text and author not in positions:
            positions[author] = text
    for item in raw.get("replies") or []:
        if not isinstance(item, dict):
            continue
        author = _match(item.get("author"), minds)
        text = _clean(item.get("text"), LIMITS["debate"])
        if author and text and author not in replies:
            to = _match(item.get("to"), minds)
            if not to or to == author:  # destinataire absent ou soi-même : l'esprit suivant
                to = minds[(minds.index(author) + 1) % len(minds)]
            replies[author] = {"author": author, "to": to, "text": text}
    missing = [m for m in minds if m not in positions or m not in replies]
    if missing:
        raise NexusError("esprits muets : " + ", ".join(missing))
    synthesis = raw.get("synthesis") if isinstance(raw.get("synthesis"), dict) else {}
    summary = _clean(synthesis.get("summary"), LIMITS["debate"])
    if not summary:
        raise NexusError("synthèse manquante")
    points = [p for p in (_clean(x, LIMITS["point"]) for x in synthesis.get("points") or [] if isinstance(x, str)) if p]
    return {
        "positions": [{"author": m, "text": positions[m]} for m in minds],
        "replies": [replies[m] for m in minds],
        "synthesis": {"summary": summary, "points": points[: len(minds) + 1],
                      "first_step": _clean(synthesis.get("first_step"), LIMITS["point"])},
    }


# --------------------------------------------------------------------------- sans modèle
def _title(req: ThinkRequest) -> str:
    context = next((i for i in req.inputs if i.kind == "context"), req.inputs[0])
    first = re.split(r"[.!?\n:;]", context.text, maxsplit=1)[0].strip()
    first = re.sub(r"^(concevoir|créer|imaginer|proposer|réaliser|construire|faire)\s+", "", first, flags=re.I)
    return _clean(first[:1].upper() + first[1:], LIMITS["title"]) or "Ce sujet"


def _keys(text: str) -> list[str]:
    listed = re.search(r":\s*([^.!?\n:]+)", text)
    items = [s.strip(" .") for s in re.split(r",|\bet\b", listed.group(1))] if listed else []
    return [s for s in items if 0 < len(s) <= LIMITS["key"]][:3] if len(items) >= 2 else []


def demo_thought(req: ThinkRequest) -> dict:
    """Sans modèle : l'esprit ne pense pas vraiment ; on le dit, et on montre ce qui guiderait sa pensée."""
    label, desc, action = CORES[req.mind.core]
    name = _clean(req.mind.name, 120)
    memories = _memories(req.mind)
    return {
        "lines": [f"(Mode démo : sans modèle de langage, {name} ne pense pas vraiment.)",
                  f"Son Core « {label} » l'amènerait à {desc}.",
                  f"Humeur : {mood_of(req.mind).lower()}."],
        "keys": _keys(" ".join(i.text for i in req.inputs)),
        "title": _title(req), "action": action, "memory": memories[0] if memories else "",
    }


def demo_debate(req: DebateRequest) -> dict:
    names = [_clean(m.name, 120) for m in req.minds]
    return {
        "positions": [{"author": n, "text": f"(Mode démo) {n} aborderait la question par la voie « {CORES[m.core][0]} » : "
                                             f"{CORES[m.core][1]}."} for n, m in zip(names, req.minds, strict=True)],
        "replies": [{"author": n, "to": names[(i + 1) % len(names)],
                     "text": f"(Mode démo) Sans modèle, pas de vraie réponse à {names[(i + 1) % len(names)]}."}
                    for i, n in enumerate(names)],
        "synthesis": {"summary": "(Mode démo) Synthèse mécanique : chaque esprit apporte son mode de raisonnement.",
                      "points": [f"{n} — {CORES[m.core][1]}" for n, m in zip(names, req.minds, strict=True)],
                      "first_step": CORES[req.minds[0].core][2]},
    }


# --------------------------------------------------------------------------- appel du modèle
async def run(providers, http_client, system: str, user: str, schema: dict, normalize, timeout: float, what: str):
    """(résultat, fournisseur, modèle) : réponse JSON imposée à Gemini (schéma), JSON simple si le schéma est refusé."""
    errors: list[str] = []
    async with http_client() as client:
        for provider in providers:
            for model in provider.models:
                for response_schema in ((schema, None) if provider.name == "gemini" else (None,)):
                    try:
                        text = await provider.complete(client, model, system, user, timeout, json_mode=True, schema=response_schema)
                        return normalize(engram.parse(text)), provider.name, model
                    except SchemaRejected as exc:
                        errors.append(str(exc))
                        continue
                    except FatalGenerationError as exc:
                        errors.append(str(exc))
                        break
                    except (GenerationError, NexusError, engram.EngramError) as exc:
                        log.warning("%s : %s", what, exc)
                        errors.append(f"{model}: {exc}" if not isinstance(exc, GenerationError) else str(exc))
                        break
    raise HTTPException(status_code=502, detail=f"{what} impossible : " + " | ".join(errors[-6:]))


async def _billed(user: User, action: str, work):
    """Réserve le prix, exécute, confirme ; rembourse si rien n'est produit."""
    import app  # noqa: PLC0415

    try:
        reservation = await asyncio.to_thread(billing.reserve, user.id, action)
    except billing.InsufficientSparks as exc:
        raise app.insufficient(exc) from exc
    try:
        result = await work(app)
    except BaseException:
        await asyncio.shield(asyncio.to_thread(billing.refund, reservation))
        raise
    await asyncio.to_thread(billing.confirm, reservation, None)
    sparks = billing.as_sparks(await asyncio.to_thread(billing.balance, user.id))
    return result, sparks, billing.as_sparks(reservation.cost_cents)


@router.post("/think", response_model=ThinkResponse)
async def think(req: ThinkRequest, user: User = Depends(current_user)) -> ThinkResponse:
    """Un esprit du Nexus pense à partir de ses entrées (0,25 Spark, rendus en cas d'échec)."""
    async def work(app):
        providers = app.active_providers()
        if not providers:
            return demo_thought(req), "mock", "mock:nexus-think"
        return await run(providers, app._http_client, THINK_SYSTEM, build_think_message(req), THINK_SCHEMA,
                         lambda raw: normalize_thought(raw, req.mind), app.TIMEOUT_S, "Pensée")

    (thought, mode, model), sparks, cost = await _billed(user, "nexus_think", work)
    return ThinkResponse(thought=thought, mode=mode, model=model, sparks=sparks, cost=cost)


@router.post("/debate", response_model=DebateResponse)
async def debate(req: DebateRequest, user: User = Depends(current_user)) -> DebateResponse:
    """War Room d'un Hub : deux tours de débat et une synthèse (1 Spark, rendu en cas d'échec)."""
    names = [_clean(m.name, 120) for m in req.minds]
    if len({n.lower() for n in names}) != len(names):
        raise HTTPException(status_code=422, detail="Chaque esprit d'un Hub doit avoir un nom distinct.")

    async def work(app):
        providers = app.active_providers()
        if not providers:
            return demo_debate(req), "mock", "mock:nexus-debate"
        return await run(providers, app._http_client, DEBATE_SYSTEM, build_debate_message(req), DEBATE_SCHEMA,
                         lambda raw: normalize_debate(raw, names), app.TIMEOUT_S, "Débat")

    (result, mode, model), sparks, cost = await _billed(user, "nexus_debate", work)
    return DebateResponse(debate=result, mode=mode, model=model, sparks=sparks, cost=cost)
