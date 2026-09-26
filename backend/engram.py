"""Engramme cognitif (V4) : carte interprétative de l'esprit d'une personnalité publique, en 36 à 44 nœuds.

Gemini reçoit un schéma de réponse (frontend/engine/engram/schema.json, partagé avec le moteur navigateur)
et renvoie un JSON syntaxiquement garanti ; ce module en vérifie le SENS avant de le livrer :
  A. core      exactement 1 nœud « axiome » ;
  E. heart     6 à 8 nœuds : caractère et émotions (trait, émotion, attachement ; chaque type au moins une fois) ;
  B. engine    8 à 10 nœuds, chacun des 4 types au moins une fois ;
  C. shadow    10 à 15 nœuds, chacun des 3 types au moins une fois ;
  D. artifact  exactement 10 évènements datés (triés), avec leur impact ;
  36 nœuds au moins. Les surplus sont écartés (les moins intenses d'abord), les manques font échouer le modèle
  (le suivant de la chaîne prend le relais). Chaque nœud porte sa « directive » : le filtre qui, déposé sur une
  génération, en dicte l'esthétique et la logique ; et, facultative, sa charge émotionnelle (EMOTIONS).
  L'ensemble porte le tempérament (le caractère en une phrase) et le climat émotionnel (2 à 4 émotions pondérées).
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import unicodedata
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
# Conversation avec un Engramme (« Discuter avec … ») : mêmes fichiers pour le moteur navigateur.
CHAT_SYSTEM = (ENGRAM_DIR / "chat-system.txt").read_text(encoding="utf-8").strip()
CHAT_TEMPLATE = (ENGRAM_DIR / "chat-template.txt").read_text(encoding="utf-8").strip()
CHAT_SCHEMA = json.loads((ENGRAM_DIR / "chat-schema.json").read_text(encoding="utf-8"))

TYPES = {
    "core": ("axiome",),
    "heart": ("trait", "emotion", "attachement"),
    "engine": ("algorithme_resolution", "empreinte_syntaxique", "matrice_esthetique", "methode_travail"),
    "shadow": ("paradoxe", "peur_primaire", "biais_cognitif"),
    "artifact": ("succes", "echec", "tournant"),
}
COUNTS = {"core": (1, 1), "heart": (6, 8), "engine": (8, 10), "shadow": (10, 15), "artifact": (10, 10)}
MIN_NODES = 36
# Émotions reconnues (identifiant → nom anglais pour les prompts). L'ordre départage les égalités du climat.
EMOTIONS = {
    "joie": "joy", "emerveillement": "wonder", "passion": "passion", "tendresse": "tenderness",
    "serenite": "serenity", "fierte": "pride", "melancolie": "melancholy", "tristesse": "sadness",
    "colere": "anger", "peur": "fear", "angoisse": "anxiety", "solitude": "loneliness",
}
CLIMATE_MAX = 4
LANGUAGES = {"fr": "French", "en": "English"}
DATE_RE = re.compile(r"^-?\d{1,4}(-\d{2}(-\d{2})?)?$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
LIMITS = {"title": 60, "content": 700, "directive": 400, "evidence": 300, "impact": 400, "summary": 400, "domain": 120,
          "temperament": 300}


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


def _round2(number: float) -> float:
    """Arrondi au centième, « demi vers le haut » : identique en JS (Math.floor)."""
    return math.floor(number * 100 + 0.5) / 100


def _intensity(value) -> float:
    """0..1 arrondi au centième ; 0,5 si illisible."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)) or (isinstance(value, str) and not value.strip()):
        return 0.5
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.5
    if not math.isfinite(number):
        return 0.5
    return _round2(min(1.0, max(0.0, number)))


def _climate(raw, nodes: list[dict]) -> list[dict]:
    """Climat émotionnel : 1 à 4 émotions, poids normalisés (somme ≈ 1). Absent ou illisible : déduit des
    charges émotionnelles des nœuds, pondérées par leur intensité."""
    entries: list[tuple[str, float]] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        emotion = item.get("emotion")
        if not isinstance(emotion, str) or emotion not in EMOTIONS or emotion in seen:
            continue
        weight = _intensity(item.get("weight"))
        if weight > 0:
            seen.add(emotion)
            entries.append((emotion, weight))
    if not entries:
        totals: dict[str, float] = {}
        for node in nodes:
            if "emotion" in node:
                totals[node["emotion"]] = totals.get(node["emotion"], 0) + node["intensity"]
        entries = [(e, w) for e, w in totals.items() if w > 0]
    order = list(EMOTIONS)
    entries.sort(key=lambda e: (-e[1], order.index(e[0])))
    entries = entries[:CLIMATE_MAX]
    total = sum(w for _, w in entries)
    return [{"emotion": e, "weight": _round2(w / total)} for e, w in entries] if total > 0 else []


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
        emotion = node.get("emotion")
        if isinstance(emotion, str) and emotion in EMOTIONS:
            clean["emotion"] = emotion
        elif node["type"] == "emotion":
            continue  # une émotion sans nom reconnu n'a pas sa place
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
        "temperament": _text(raw.get("temperament"), LIMITS["temperament"]),
        "climate": _climate(raw.get("climate"), ordered),
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
# Conversation (« Discuter avec … ») : même algorithme dans engine/engram/engram.js (parité testée)
# --------------------------------------------------------------------------- #
CHAT_NODES_MAX = 50
CHAT_HISTORY_MAX = 12
TRACE_MAX = 4
BASES = ("documente", "declare", "interpretation")
KINDS = ("forge", "nourrit", "contredit")
STOPWORDS = {
    "pour", "dans", "avec", "vous", "votre", "vos", "quoi", "comment", "pourquoi", "quel", "quelle", "quels", "quelles",
    "etre", "avoir", "fait", "faire", "cette", "elle", "lui", "leur", "leurs", "sont", "plus", "moins", "tout", "tous",
    "toute", "toutes", "mais", "donc", "alors", "aussi", "tres", "bien", "etait", "avez", "etes", "est-ce", "what",
    "your", "with", "have", "that", "this", "about", "would", "could", "there", "their", "from", "were",
}


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _reply(value, limit: int) -> str:
    """Texte sur plusieurs lignes : espaces réduits, lignes vides en trop retirées, coupé à limit points de code."""
    text = _scalar(value).replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in text.split("\n")]
    return _clip(re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip(), limit)


def chat_nodes(engram: dict) -> list[dict]:
    """Bulles d'un Engramme reçu du client (données non fiables) : champs utiles, bornés, identifiants nettoyés."""
    nodes, seen = [], set()
    raw = engram.get("nodes") if isinstance(engram, dict) and isinstance(engram.get("nodes"), list) else []
    for index, node in enumerate(raw[:CHAT_NODES_MAX]):
        if not isinstance(node, dict):
            continue
        node_id = _slug(node.get("id"), f"n{index}")
        if node_id in seen:
            continue
        seen.add(node_id)
        keywords = node.get("keywords") if isinstance(node.get("keywords"), list) else []
        nodes.append({
            "id": node_id,
            "category": _text(node.get("category"), 30),
            "type": _text(node.get("type"), 30),
            "title": _text(node.get("title"), LIMITS["title"]),
            "content": _text(node.get("content"), LIMITS["content"]),
            "evidence": _text(node.get("evidence"), LIMITS["evidence"]),
            "basis": node.get("basis") if node.get("basis") in BASES else "interpretation",
            "emotion": node.get("emotion") if isinstance(node.get("emotion"), str) and node.get("emotion") in EMOTIONS else "",
            "date": _text(node.get("date"), 20),
            "impact": _text(node.get("impact"), LIMITS["impact"]),
            "keywords": [_text(k, 40) for k in keywords if isinstance(k, str) and k.strip()][:8],
        })
    return nodes


def chat_dossier(engram: dict) -> str:
    """Toutes les données écrites de l'Engramme, en texte compact pour le modèle."""
    engram = engram if isinstance(engram, dict) else {}
    person, domain = _text(engram.get("person"), 120), _text(engram.get("domain"), LIMITS["domain"])
    lines = [f"PERSON: {person}" + (f" — {domain}" if domain else "")]
    for label, key in (("SUMMARY", "summary"), ("TEMPERAMENT", "temperament")):
        value = _text(engram.get(key), LIMITS[key])
        if value:
            lines.append(f"{label}: {value}")
    climate = []
    for item in engram.get("climate") if isinstance(engram.get("climate"), list) else []:
        if isinstance(item, dict) and isinstance(item.get("emotion"), str) and item["emotion"] in EMOTIONS:
            climate.append(f"{EMOTIONS[item['emotion']]} {math.floor(_intensity(item.get('weight')) * 100 + 0.5)}%")
    if climate:
        lines.append("EMOTIONAL CLIMATE: " + ", ".join(climate[:CLIMATE_MAX]))
    nodes = chat_nodes(engram)
    lines.append("NODES:")
    for n in nodes:
        parts = [f"[{n['id']}] {n['category']}/{n['type']} · {n['title']} — {n['content']}"]
        if n["emotion"]:
            parts.append(f"emotion: {EMOTIONS[n['emotion']]}")
        if n["date"]:
            parts.append(f"{n['date']}: {n['impact']}" if n["impact"] else n["date"])
        if n["keywords"]:
            parts.append("keywords: " + ", ".join(n["keywords"]))
        if n["evidence"]:
            parts.append(f"source ({n['basis']}): {n['evidence']}")
        lines.append(" · ".join(parts))
    ids = {n["id"] for n in nodes}
    links = []
    for link in engram.get("links") if isinstance(engram.get("links"), list) else []:
        if not isinstance(link, dict):
            continue
        a, b, kind = _slug(link.get("from"), ""), _slug(link.get("to"), ""), link.get("kind")
        if a in ids and b in ids and a != b and kind in KINDS:
            links.append(f"{a} {kind} {b}")
    if links:
        lines.append("LINKS: " + "; ".join(links[:40]))
    return "\n".join(lines)


def build_chat_message(engram: dict, history: list, message: str, language: str) -> str:
    person = _text(engram.get("person") if isinstance(engram, dict) else "", 120) or "?"
    turns = []
    for turn in (history if isinstance(history, list) else [])[-CHAT_HISTORY_MAX:]:
        if isinstance(turn, dict) and turn.get("role") in ("user", "persona"):
            text = _text(turn.get("text"), 1200)
            if text:
                turns.append(f"{'User' if turn['role'] == 'user' else person}: {text}")
    values = {"person": person, "dossier": chat_dossier(engram), "history": "\n".join(turns) or "(none)",
              "message": _reply(message, 2000), "language": LANGUAGES.get(language, "French")}
    # Une seule passe : rien de ce qui est inséré n'est réinterprété comme gabarit.
    return re.sub(r"\{\{(person|dossier|history|message|language)\}\}", lambda m: values[m.group(1)], CHAT_TEMPLATE)


def normalize_chat(raw, engram: dict) -> dict:
    """Réponse du modèle → { reply, trace } ; la trace ne cite que des bulles de cet Engramme."""
    if not isinstance(raw, dict):
        raise EngramError("réponse qui n'est pas un objet JSON")
    reply = _reply(raw.get("reply"), 1500)
    if not reply:
        raise EngramError("réponse vide")
    ids = {n["id"] for n in chat_nodes(engram)}
    trace, seen = [], set()
    for step in raw.get("trace") if isinstance(raw.get("trace"), list) else []:
        if not isinstance(step, dict):
            continue
        node_id = _slug(step.get("id"), "")
        if node_id in ids and node_id not in seen:
            seen.add(node_id)
            trace.append({"id": node_id, "why": _text(step.get("why"), 120)})
    return {"reply": reply, "trace": trace[:TRACE_MAX]}


def _words(text: str) -> list[str]:
    decomposed = unicodedata.normalize("NFKD", text.lower())
    plain = "".join(c for c in decomposed if not 0x300 <= ord(c) <= 0x36F)
    return [w for w in re.findall(r"[a-z0-9]+", plain) if len(w) >= 4 and w not in STOPWORDS]


def demo_chat(engram: dict, message: str) -> dict:
    """Sans modèle : les bulles dont les mots rejoignent la question (sinon noyau, cœur, moteur), et une réponse honnête."""
    nodes = chat_nodes(engram)
    person = _text(engram.get("person") if isinstance(engram, dict) else "", 120) or "cette personne"
    question = list(dict.fromkeys(_words(_scalar(message))))
    scored = []
    for index, n in enumerate(nodes):
        words = set(_words(n["title"] + " " + n["content"]))
        common = [w for w in question if w in words]
        if common:
            scored.append((len(common), index, n, common[0]))
    scored.sort(key=lambda s: (-s[0], s[1]))
    trace = [{"id": n["id"], "why": f"mot commun : « {word} »"} for _, _, n, word in scored[:3]]
    if not trace:
        for category, why in (("core", "l'axiome au centre de tout"), ("heart", "son caractère"), ("engine", "sa manière de penser")):
            n = next((m for m in nodes if m["category"] == category), None)
            if n:
                trace.append({"id": n["id"], "why": why})
    titles = ", ".join(f"« {next(n['title'] for n in nodes if n['id'] == s['id'])} »" for s in trace)
    reply = (f"(Mode démo : sans modèle de langage, {person} ne peut pas vraiment vous répondre.) "
             f"Voici les traits de l'Engramme qui guideraient sa réponse : {titles}. "
             "Ajoutez une clé Gemini pour une vraie conversation.")
    return {"reply": reply, "trace": trace}


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


async def run_chat(providers, http_client, engram: dict, history: list, message: str, language: str,
                   timeout: float) -> tuple[dict, str, str]:
    """(réponse, fournisseur, modèle) : réponse JSON imposée à Gemini, JSON simple si le schéma est refusé."""
    user = build_chat_message(engram, history, message, language)
    errors: list[str] = []
    async with http_client() as client:
        for provider in providers:
            for model in provider.models:
                for schema in ((CHAT_SCHEMA, None) if provider.name == "gemini" else (None,)):
                    try:
                        text = await provider.complete(client, model, CHAT_SYSTEM, user, timeout, json_mode=True, schema=schema)
                        return normalize_chat(parse(text), engram), provider.name, model
                    except SchemaRejected as exc:
                        errors.append(str(exc))
                        continue
                    except FatalGenerationError as exc:
                        errors.append(str(exc))
                        break
                    except (GenerationError, EngramError) as exc:
                        log.warning("conversation : %s", exc)
                        errors.append(f"{model}: {exc}" if isinstance(exc, EngramError) else str(exc))
                        break
    raise HTTPException(status_code=502, detail="Réponse impossible : " + " | ".join(errors[-6:]))


class ChatTurn(BaseModel):
    role: Literal["user", "persona"]
    text: str = Field(..., min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    engram: dict
    history: list[ChatTurn] = Field([], max_length=40)
    message: str = Field(..., min_length=1, max_length=2000)
    language: Literal["fr", "en"] = "fr"


class ChatResponse(BaseModel):
    reply: str
    trace: list[dict]
    mode: str
    model: str
    sparks: float
    cost: float


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


@router.post("/engram/chat", response_model=ChatResponse)
async def chat_with_engram(req: ChatRequest, user: User = Depends(current_user)) -> ChatResponse:
    """« Discuter avec … » : réponse à la première personne, fondée sur l'Engramme, et sa trace logique."""
    import app  # noqa: PLC0415

    if len(json.dumps(req.engram, ensure_ascii=False)) > 120_000 or not chat_nodes(req.engram):
        raise HTTPException(status_code=422, detail="Engramme illisible ou trop volumineux.")
    try:
        reservation = await asyncio.to_thread(billing.reserve, user.id, "engram_chat")
    except billing.InsufficientSparks as exc:
        raise app.insufficient(exc) from exc
    history = [turn.model_dump() for turn in req.history]
    try:
        providers = app.active_providers()
        if providers:
            answer, mode, model = await run_chat(providers, app._http_client, req.engram, history, req.message, req.language, app.TIMEOUT_S)
        else:
            answer, mode, model = demo_chat(req.engram, req.message), "mock", "mock:engram-chat"
    except BaseException:
        await asyncio.shield(asyncio.to_thread(billing.refund, reservation))
        raise
    await asyncio.to_thread(billing.confirm, reservation, None)
    return ChatResponse(
        **answer, mode=mode, model=model,
        sparks=billing.as_sparks(await asyncio.to_thread(billing.balance, user.id)),
        cost=billing.as_sparks(reservation.cost_cents),
    )
