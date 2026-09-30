"""Mode Nexus (V6) : les Engrammes du canvas Nexus pensent pour de vrai.

Deux routes, facturées seulement quand l'utilisateur les déclenche (bouton qui affiche le prix), remboursées si le
modèle échoue :
  POST /api/nexus/think   un esprit pense à partir de ce que ses fils lui apportent (contextes, pensées en amont) ;
  POST /api/nexus/debate  War Room d'un Hub : chaque esprit prend position, répond à un autre, puis synthèse.

V6.3, trois profondeurs (champ « depth ») :
  fast     la chaîne rapide de l'orchestre (Gemini Flash, puis Lite, puis Gemma) ;
  deep     les modèles les plus capables d'abord (Pro quand la clé y a droit), réflexion poussée (thinkingLevel high) ;
  council  Conseil de modèles : plusieurs modèles pensent en parallèle (chacun part sur la clé la moins occupée, donc
           sur des clés différentes), puis un arbitre tranche ; en War Room, chaque esprit a sa propre voix (son
           modèle), les deux tours se jouent en parallèle et un arbitre écrit la synthèse.

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
COUNCIL_SYSTEM = (NEXUS_DIR / "council-system.txt").read_text(encoding="utf-8").strip()
COUNCIL_TEMPLATE = (NEXUS_DIR / "council-template.txt").read_text(encoding="utf-8").strip()
VOICE_SYSTEM = (NEXUS_DIR / "voice-system.txt").read_text(encoding="utf-8").strip()
VOICE_TEMPLATE = (NEXUS_DIR / "voice-template.txt").read_text(encoding="utf-8").strip()
VOICE_SCHEMA = json.loads((NEXUS_DIR / "voice-schema.json").read_text(encoding="utf-8"))
SYNTHESIS_SYSTEM = (NEXUS_DIR / "synthesis-system.txt").read_text(encoding="utf-8").strip()
SYNTHESIS_TEMPLATE = (NEXUS_DIR / "synthesis-template.txt").read_text(encoding="utf-8").strip()
SYNTHESIS_SCHEMA = json.loads((NEXUS_DIR / "synthesis-schema.json").read_text(encoding="utf-8"))

Depth = Literal["fast", "deep", "council"]
# Action facturée selon la profondeur (billing.PRICES).
THINK_ACTIONS = {"fast": "nexus_think", "deep": "nexus_think_deep", "council": "nexus_think_council"}
DEBATE_ACTIONS = {"fast": "nexus_debate", "deep": "nexus_debate_deep", "council": "nexus_debate_council"}

CORES = {
    "science": ("Méthode scientifique stricte", "mesurer avant de conclure, ne retenir que ce qui se vérifie", "Lancer une mesure"),
    "simplicity": ("Simplicité radicale", "retirer jusqu'à l'évidence : une seule action, un seul écran", "Voir l'essentiel"),
    "empathy": ("Empathie utilisateur", "partir des personnes, de leur moment, de leurs mots", "Comprendre en 3 secondes"),
    "poetry": ("Science poétique", "voir les données comme des motifs à composer", "Composer le motif"),
    "systems": ("Pensée systémique", "chercher les boucles, les causes et les effets retard", "Voir les tendances"),
}
MOODS = ("Fatiguée", "Créative", "Patiente", "Concentrée")
LANGUAGES = engram.LANGUAGES
LIMITS = {"line": 280, "key": 40, "title": 90, "action": 40, "debate": 420, "point": 220, "why": 60}
ENGRAM_MAX_JSON = 150_000  # un Engramme reçu (données du client) au plus
TRACE_MAX = 4


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
    # V6.1 : l'Engramme cognitif complet (bulles, climat, liens) ; le modèle pense à partir de lui.
    engram: dict | None = None


class Input(BaseModel):
    kind: Literal["context", "thought"]
    author: str = Field("", max_length=120)
    title: str = Field("", max_length=120)
    text: str = Field(..., min_length=1, max_length=3000)


class ThinkRequest(BaseModel):
    mind: Mind
    inputs: list[Input] = Field(..., min_length=1, max_length=8)
    language: Literal["fr", "en"] = "fr"
    depth: Depth = "fast"


class DebateRequest(BaseModel):
    minds: list[Mind] = Field(..., min_length=2, max_length=5)
    question: str = Field(..., min_length=2, max_length=400)
    context: str = Field("", max_length=3000)
    language: Literal["fr", "en"] = "fr"
    depth: Depth = "fast"


class ThinkResponse(BaseModel):
    thought: dict
    mode: str
    model: str
    sparks: float
    cost: float
    depth: str = "fast"
    # Conseil : chaque voix entendue ({"model", "line"}), l'arbitre étant « model ».
    council: list[dict] | None = None


class DebateResponse(BaseModel):
    debate: dict
    mode: str
    model: str
    sparks: float
    cost: float
    depth: str = "fast"
    # Conseil : la voix (le modèle) de chaque esprit ({"author", "model"}), l'arbitre de la synthèse étant « model ».
    council: list[dict] | None = None


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
    if mind.engram:
        # L'Engramme complet (dossier compact, identifiants des bulles compris) : le modèle pense à partir de lui.
        lines = [f"name: {_clean(mind.engram.get('person') or mind.name, 120)}",
                 "ENGRAM (interpretive map of this mind: think from it; node ids in brackets):", engram.chat_dossier(mind.engram)]
        if mind.mood:
            lines.append(f"mood: {_clean(mind.mood, 40)}")
        memories = _memories(mind)
        lines.append("memories:" + ("".join(f"\n- {m}" for m in memories) if memories else " (none)"))
        return "\n".join(lines)
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


def think_inputs(req: ThinkRequest) -> str:
    inputs = []
    for i, item in enumerate(req.inputs, 1):
        head = f"[{i}] context" + (f" « {_clean(item.title, 120)} »" if item.title.strip() else "") if item.kind == "context" \
            else f"[{i}] thought of {_clean(item.author, 120) or 'another mind'}"
        inputs.append(f"{head}:\n{_clean(item.text, 3000)}")
    return "\n\n".join(inputs)


def build_think_message(req: ThinkRequest) -> str:
    return _fill(THINK_TEMPLATE, {"language": LANGUAGES.get(req.language, "French"), "mind": describe(req.mind),
                                  "inputs": think_inputs(req)})


def build_council_message(req: ThinkRequest, heard: list[tuple[str, dict]]) -> str:
    candidates = []
    for i, (model, t) in enumerate(heard, 1):
        extra = [f"keys: {', '.join(t['keys'])}" if t["keys"] else "", f"title: {t['title']}", f"action: {t['action']}",
                 f"memory: {t['memory']}" if t["memory"] else "",
                 "trace: " + ", ".join(f"{s['id']} ({s['why']})" for s in t["trace"]) if t["trace"] else ""]
        candidates.append(f"[{i}] by {model}:\n" + " ".join(t["lines"]) + "\n" + "\n".join(e for e in extra if e))
    return _fill(COUNCIL_TEMPLATE, {"language": LANGUAGES.get(req.language, "French"), "mind": describe(req.mind),
                                    "inputs": think_inputs(req),
                                    "candidates": "\n\n".join(candidates)})


def build_voice_message(req: DebateRequest, index: int, positions: dict[str, str], to: str = "") -> str:
    names = [_clean(m.name, 120) for m in req.minds]
    task = (f"reply — answer {to}'s position (agree, qualify or disagree concretely)." if to
            else "position — give your position on the question.")
    shown = "\n".join(f"- {name}: {text}" for name, text in positions.items()) or "(none yet)"
    return _fill(VOICE_TEMPLATE, {"language": LANGUAGES.get(req.language, "French"), "mind": describe(req.minds[index]),
                                  "others": ", ".join(n for i, n in enumerate(names) if i != index),
                                  "question": _clean(req.question, 400), "context": _clean(req.context, 3000) or "(none)",
                                  "positions": shown, "task": task})


def build_synthesis_message(req: DebateRequest, positions: list[dict], replies: list[dict]) -> str:
    debate = "\n".join([f"Round 1 — {p['author']}: {p['text']}" for p in positions] +
                       [f"Round 2 — {r['author']} to {r['to']}: {r['text']}" for r in replies])
    return _fill(SYNTHESIS_TEMPLATE, {"language": LANGUAGES.get(req.language, "French"),
                                      "minds": "\n\n".join(describe(m) for m in req.minds),
                                      "question": _clean(req.question, 400), "context": _clean(req.context, 3000) or "(none)",
                                      "debate": debate})


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
    # Bulles de l'Engramme mobilisées (ronds de la logique dans l'Engramme vivant) : seulement des bulles qui existent.
    ids = {n["id"] for n in engram.chat_nodes(mind.engram)} if mind.engram else set()
    trace, seen = [], set()
    for step in raw.get("trace") if isinstance(raw.get("trace"), list) else []:
        node_id = _clean(step.get("id") if isinstance(step, dict) else "", 60)
        if node_id in ids and node_id not in seen:
            seen.add(node_id)
            trace.append({"id": node_id, "why": _clean(step.get("why"), LIMITS["why"])})
    return {"lines": lines, "keys": keys[:5], "title": title, "action": action, "memory": memory, "trace": trace[:TRACE_MAX]}


def normalize_voice(raw) -> str:
    text = _clean(raw.get("text"), LIMITS["debate"]) if isinstance(raw, dict) else ""
    if not text:
        raise NexusError("voix muette")
    return text


def normalize_synthesis(raw, minds: list[str]) -> dict:
    if not isinstance(raw, dict):
        raise NexusError("réponse qui n'est pas un objet JSON")
    summary = _clean(raw.get("summary"), LIMITS["debate"])
    if not summary:
        raise NexusError("synthèse manquante")
    points = [p for p in (_clean(x, LIMITS["point"]) for x in raw.get("points") or [] if isinstance(x, str)) if p]
    return {"summary": summary, "points": points[: len(minds) + 1], "first_step": _clean(raw.get("first_step"), LIMITS["point"])}


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
    if req.mind.engram:
        nodes = engram.chat_nodes(req.mind.engram)
        core = next((n for n in nodes if n["category"] == "core"), None)
        engine = next((n for n in nodes if n["category"] == "engine"), None)
        memories = _memories(req.mind)
        return {
            "lines": [f"(Mode démo : sans modèle de langage, {name} ne pense pas vraiment.)",
                      f"Son axiome : « {core['title']} »." if core else "Son axiome guiderait sa pensée.",
                      f"Sa méthode : {engine['title']}." if engine else "Sa méthode guiderait la suite."],
            "keys": _keys(" ".join(i.text for i in req.inputs)), "title": _title(req),
            "action": _clean(engine["title"], LIMITS["action"]) if engine else "Explorer", "memory": memories[0] if memories else "",
            "trace": [{"id": n["id"], "why": why} for n, why in ((core, "axiome"), (engine, "méthode")) if n],
        }
    return {
        "lines": [f"(Mode démo : sans modèle de langage, {name} ne pense pas vraiment.)",
                  f"Son Core « {label} » l'amènerait à {desc}.",
                  f"Humeur : {mood_of(req.mind).lower()}."],
        "keys": _keys(" ".join(i.text for i in req.inputs)),
        "title": _title(req), "action": action, "memory": memories[0] if memories else "", "trace": [],
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
async def run(providers, http_client, system: str, user: str, schema: dict, normalize, timeout: float, what: str,
              thinking: str | None = None, hedge: float | None = None):
    """(résultat, fournisseur, modèle) : réponse JSON imposée à Gemini (schéma), JSON simple si le schéma est refusé ;
    thinking : niveau de réflexion du mode Profond.

    V6.3, course des modèles : la chaîne est parcourue dans l'ordre, et un modèle qui échoue passe aussitôt la main ;
    avec « hedge » (secondes), un modèle qui tarde à répondre voit le suivant entrer dans la course en parallèle (il
    part sur une autre clé, la moins occupée) : la première réponse valable gagne, les autres appels sont annulés.
    Quand Google sature, on n'attend plus le délai complet d'un modèle muet avant d'essayer le suivant."""
    attempts = [(provider, model) for provider in providers for model in provider.models]
    errors: list[str] = []
    refused: set[str] = set()  # fournisseurs aux clés refusées : leurs autres modèles ne sont plus essayés
    pending: set[asyncio.Task] = set()

    async def attempt(client, provider, model):
        for response_schema in ((schema, None) if provider.name == "gemini" else (None,)):
            try:
                text = await provider.complete(client, model, system, user, timeout, json_mode=True, schema=response_schema,
                                               thinking=thinking)
            except SchemaRejected as exc:
                errors.append(str(exc))
                continue
            return normalize(engram.parse(text)), provider.name, model
        raise NexusError("schéma refusé, même en JSON simple")

    async with http_client() as client:
        def launch() -> bool:
            while attempts:
                provider, model = attempts.pop(0)
                if provider.name in refused:
                    continue
                task = asyncio.ensure_future(attempt(client, provider, model))
                task.prism = (provider.name, model)
                pending.add(task)
                return True
            return False

        try:
            launch()
            while pending:
                done, _ = await asyncio.wait(pending, timeout=hedge if attempts else None, return_when=asyncio.FIRST_COMPLETED)
                if not done:  # personne n'a encore répondu : un modèle de plus entre dans la course
                    if hedge is not None:
                        log.info("%s : %s tarde, %d modèle(s) en course", what, ", ".join(t.prism[1] for t in pending), len(pending) + 1)
                    launch()
                    continue
                failed = 0
                for task in done:
                    pending.discard(task)
                    name, model = task.prism
                    try:
                        return task.result()
                    except FatalGenerationError as exc:
                        refused.add(name)
                        errors.append(str(exc))
                    except (GenerationError, NexusError, engram.EngramError) as exc:
                        log.warning("%s : %s", what, exc)
                        errors.append(f"{model}: {exc}" if not isinstance(exc, GenerationError) else str(exc))
                    failed += 1
                for _ in range(failed):  # chaque échec libère sa place : le suivant de la chaîne, sans attendre
                    launch()
        finally:
            for task in pending:  # une réponse a gagné (ou tout a échoué) : les appels encore en course s'arrêtent
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
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


def _check_engrams(minds: list[Mind]) -> None:
    """Engrammes reçus du client : bornés, et lisibles (sinon rien n'est facturé)."""
    for mind in minds:
        if mind.engram is None:
            continue
        if len(json.dumps(mind.engram, ensure_ascii=False)) > ENGRAM_MAX_JSON or not engram.chat_nodes(mind.engram):
            raise HTTPException(status_code=422, detail="Engramme illisible ou trop volumineux.")


def _voices(app) -> list[list]:
    """Chaînes de fournisseurs des voix du Conseil : Gemini restreint à chaque voix, puis les autres fournisseurs."""
    base = app.active_providers("nexus")
    gemini = next((p for p in base if p.name == "gemini"), None)
    others = [p for p in base if p.name != "gemini"]
    return [[gemini.only(chain)] + others if gemini else others for chain in app.council_voices()] if base else []


async def council_think(app, req: ThinkRequest):
    """Conseil : chaque voix pense en parallèle (clés différentes), puis un arbitre écrit la pensée finale."""
    message = build_think_message(req)

    def normalize(raw):
        return normalize_thought(raw, req.mind)

    results = await asyncio.gather(*(run(chain, app._http_client, THINK_SYSTEM, message, THINK_SCHEMA, normalize, app.NEXUS_TIMEOUT_S,
                                         "Voix du Conseil", hedge=app.NEXUS_HEDGE_S) for chain in _voices(app)), return_exceptions=True)
    heard = [(model, thought) for r in results if not isinstance(r, BaseException) for thought, _mode, model in [r]]
    for r in results:
        if isinstance(r, BaseException) and not isinstance(r, HTTPException):
            raise r
    if not heard:
        raise HTTPException(status_code=502, detail="Conseil impossible : aucune voix n'a répondu.")
    council = [{"model": model, "line": thought["lines"][0]} for model, thought in heard]
    mode = app.active_providers("nexus")[0].name
    if len(heard) == 1:
        return heard[0][1], mode, heard[0][0], council
    try:
        thought, mode, judge = await run(app.active_providers("judge"), app._http_client, COUNCIL_SYSTEM,
                                         build_council_message(req, heard), THINK_SCHEMA, normalize, app.NEXUS_LONG_TIMEOUT_S,
                                         "Arbitrage du Conseil", thinking=app.GEMINI_THINKING, hedge=app.NEXUS_LONG_HEDGE_S)
    except HTTPException:  # arbitre indisponible : la première voix entendue fait foi
        thought, judge = heard[0][1], heard[0][0]
    return thought, mode, judge, council


async def council_debate(app, req: DebateRequest, names: list[str]):
    """War Room en Conseil : chaque esprit parle avec sa propre voix (son modèle), les deux tours en parallèle ;
    une voix qui échoue passe la parole au modèle de la voix suivante ; un arbitre écrit la synthèse."""
    voices = _voices(app)

    async def speak(index: int, positions: dict[str, str], to: str = ""):
        message = build_voice_message(req, index, positions, to)
        errors = []
        for k in range(len(voices)):
            chain = voices[(index + k) % len(voices)]
            try:
                text, _mode, model = await run(chain, app._http_client, VOICE_SYSTEM, message, VOICE_SCHEMA, normalize_voice,
                                               app.NEXUS_TIMEOUT_S, f"Voix de {names[index]}", hedge=app.NEXUS_HEDGE_S)
                return text, model
            except HTTPException as exc:
                errors.append(str(exc.detail))
        raise HTTPException(status_code=502, detail=f"{names[index]} n'a pas pu parler : " + " | ".join(errors[-3:]))

    first = await asyncio.gather(*(speak(i, {}) for i in range(len(names))))
    positions = {names[i]: text for i, (text, _model) in enumerate(first)}
    targets = [names[(i + 1) % len(names)] for i in range(len(names))]
    second = await asyncio.gather(*(speak(i, positions, targets[i]) for i in range(len(names))))
    debate = {"positions": [{"author": n, "text": positions[n]} for n in names],
              "replies": [{"author": names[i], "to": targets[i], "text": text} for i, (text, _model) in enumerate(second)]}
    try:
        synthesis, mode, judge = await run(app.active_providers("judge"), app._http_client, SYNTHESIS_SYSTEM,
                                           build_synthesis_message(req, debate["positions"], debate["replies"]), SYNTHESIS_SCHEMA,
                                           lambda raw: normalize_synthesis(raw, names), app.NEXUS_LONG_TIMEOUT_S, "Synthèse du Conseil",
                                           thinking=app.GEMINI_THINKING, hedge=app.NEXUS_LONG_HEDGE_S)
    except HTTPException:
        raise HTTPException(status_code=502, detail="Synthèse du Conseil impossible : aucun modèle n'a répondu.") from None
    debate["synthesis"] = synthesis
    council = [{"author": names[i], "model": model} for i, (_text, model) in enumerate(first)]
    return debate, mode, judge, council


@router.post("/think", response_model=ThinkResponse)
async def think(req: ThinkRequest, user: User = Depends(current_user)) -> ThinkResponse:
    """Un esprit du Nexus pense à partir de ses entrées (0,25 Spark ; Profond 0,5 ; Conseil 1 ; rendus en cas d'échec)."""
    _check_engrams([req.mind])

    async def work(app):
        providers = app.active_providers("deep" if req.depth == "deep" else "nexus")
        if not providers:
            return demo_thought(req), "mock", "mock:nexus-think", None
        if req.depth == "council":
            return await council_think(app, req)
        result = await run(providers, app._http_client, THINK_SYSTEM, build_think_message(req), THINK_SCHEMA,
                           lambda raw: normalize_thought(raw, req.mind),
                           app.NEXUS_LONG_TIMEOUT_S if req.depth == "deep" else app.NEXUS_TIMEOUT_S, "Pensée",
                           thinking=app.GEMINI_THINKING if req.depth == "deep" else None,
                           hedge=app.NEXUS_LONG_HEDGE_S if req.depth == "deep" else app.NEXUS_HEDGE_S)
        return (*result, None)

    (thought, mode, model, council), sparks, cost = await _billed(user, THINK_ACTIONS[req.depth], work)
    return ThinkResponse(thought=thought, mode=mode, model=model, sparks=sparks, cost=cost, depth=req.depth, council=council)


@router.post("/debate", response_model=DebateResponse)
async def debate(req: DebateRequest, user: User = Depends(current_user)) -> DebateResponse:
    """War Room d'un Hub : deux tours de débat et une synthèse (1 Spark ; Profond 2 ; Conseil 3 ; rendus en cas d'échec)."""
    _check_engrams(req.minds)
    names = [_clean(m.name, 120) for m in req.minds]
    if len({n.lower() for n in names}) != len(names):
        raise HTTPException(status_code=422, detail="Chaque esprit d'un Hub doit avoir un nom distinct.")

    async def work(app):
        providers = app.active_providers("deep" if req.depth == "deep" else "nexus")
        if not providers:
            return demo_debate(req), "mock", "mock:nexus-debate", None
        if req.depth == "council":
            return await council_debate(app, req, names)
        result = await run(providers, app._http_client, DEBATE_SYSTEM, build_debate_message(req), DEBATE_SCHEMA,
                           lambda raw: normalize_debate(raw, names), app.NEXUS_LONG_TIMEOUT_S, "Débat",
                           thinking=app.GEMINI_THINKING if req.depth == "deep" else None, hedge=app.NEXUS_LONG_HEDGE_S)
        return (*result, None)

    (result, mode, model, council), sparks, cost = await _billed(user, DEBATE_ACTIONS[req.depth], work)
    return DebateResponse(debate=result, mode=mode, model=model, sparks=sparks, cost=cost, depth=req.depth, council=council)
