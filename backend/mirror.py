"""Mode Miroir (V5, phase 2 · point 4) : après MIRROR_SPARKS Sparks dépensés, l'utilisateur peut faire dresser SON
Engramme — un portrait de créateur tiré de ses propres usages dans Prism (demandes, couleurs choisies, retouches,
Engrammes explorés, fusions) — et s'en servir comme filtre ADN pour ses créations.

Jamais d'office : à sa demande et avec son accord explicite (consent), gratuit (récompense), une fois par période de
COOLDOWN au plus. Seules les données de son compte servent ; le portrait décrit un style de création, jamais une
personne jugée (aucune inférence sensible : cf. mirror-system.txt). Ses dix évènements (artefacts) sont des jalons
réels et datés de son activité (premier widget, première refactorisation, première fusion…) : rien n'est inventé.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select

import billing
import cache
import db
import engram
from auth import current_user
from models import SparkLedger, User, Widget
from providers import FatalGenerationError, GenerationError, SchemaRejected

log = logging.getLogger("prism.mirror")
router = APIRouter(prefix="/api", tags=["engram"])

MIRROR_SPARKS = float(os.getenv("PRISM_MIRROR_SPARKS", "50"))  # Sparks dépensés pour débloquer le miroir
COOLDOWN = timedelta(hours=float(os.getenv("PRISM_MIRROR_COOLDOWN_HOURS", "24")))
EVENTS = 10  # artefacts d'un Engramme (compte exact)
LABEL = {"fr": "Vous", "en": "You"}
SYSTEM = (engram.ENGRAM_DIR / "mirror-system.txt").read_text(encoding="utf-8").strip()
TEMPLATE = (engram.ENGRAM_DIR / "mirror-template.txt").read_text(encoding="utf-8").strip()


def _schema() -> dict:
    """Schéma de réponse : celui de la fusion (pas d'artefact : les jalons sont fournis), sans provenance A/B."""
    schema = copy.deepcopy(engram.FUSION_SCHEMA)
    node = schema["properties"]["nodes"]["items"]
    node["properties"].pop("sources", None)
    node["required"] = [k for k in node["required"] if k != "sources"]
    if "propertyOrdering" in node:
        node["propertyOrdering"] = [k for k in node["propertyOrdering"] if k != "sources"]
    node["properties"]["evidence"]["description"] = "The usage facts this node rests on (counts, colours, words, dates)."
    schema["properties"]["person"]["description"] = "The given person label."
    schema["properties"]["domain"]["description"] = "Creation in Prism, in the requested language."
    return schema


SCHEMA = _schema()


class MirrorError(Exception):
    """Pas encore assez de matière pour un Engramme (jalons) : rien n'est enregistré."""


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _is_engram_title(title: str) -> bool:
    return bool(re.match(r"^(?:Hyper-)?Engramme\s*·|^Miroir\s*·", title or ""))


# --------------------------------------------------------------------------- état
def status(user_id: int, now: datetime | None = None) -> dict:
    """Sparks dépensés (nets des remboursements), déblocage, disponibilité (délai entre deux miroirs)."""
    now = now or datetime.now(UTC)
    with db.session() as s:
        rows = s.execute(select(SparkLedger.delta_cents, SparkLedger.reason).where(SparkLedger.user_id == user_id)).all()
        last = s.scalar(select(func.max(SparkLedger.created_at)).where(SparkLedger.user_id == user_id, SparkLedger.reason == "mirror"))
    debits = -sum(d for d, _ in rows if d < 0)
    refunds = sum(d for d, r in rows if r == "refund" and d > 0)
    spent = billing.as_sparks(max(0, debits - refunds))
    next_at = _aware(last) + COOLDOWN if last else None
    return {
        "spent": spent, "threshold": MIRROR_SPARKS, "unlocked": spent >= MIRROR_SPARKS,
        "available": spent >= MIRROR_SPARKS and (next_at is None or now >= next_at),
        "next_at": next_at.isoformat() if next_at and now < next_at else None,
        "last_at": _aware(last).isoformat() if last else None,
    }


# --------------------------------------------------------------------------- données d'usage et jalons
def _activity(user_id: int) -> tuple[list, list]:
    with db.session() as s:
        widgets = s.execute(select(Widget.title, Widget.prompt, Widget.accent, Widget.created_at, Widget.updated_at,
                                   Widget.history_json, Widget.file_json, Widget.layout_json)
                            .where(Widget.user_id == user_id).order_by(Widget.created_at)).all()
        ledger = s.execute(select(SparkLedger.reason, SparkLedger.delta_cents, SparkLedger.created_at)
                           .where(SparkLedger.user_id == user_id).order_by(SparkLedger.created_at, SparkLedger.id)).all()
    return widgets, ledger


def usage(widgets: list, ledger: list) -> dict:
    """Résumé de l'activité (ce que voit le modèle) : ni adresse, ni données de fichiers, demandes abrégées."""
    creations = [w for w in widgets if not _is_engram_title(w.title)]
    words: Counter = Counter()
    for w in creations:
        words.update(cache.features(w.prompt or w.title).words)
    accents = Counter(w.accent for w in widgets if w.accent)
    files = Counter((json.loads(w.file_json) or {}).get("kind", "?") for w in widgets if w.file_json)
    actions = Counter(r for r, d, _ in ledger if d < 0)
    persons = [re.sub(r"^(?:Hyper-)?Engramme\s*·\s*", "", w.title) for w in widgets if re.match(r"^(?:Hyper-)?Engramme\s*·", w.title or "")]
    return {
        "widgets_created": len(creations),
        "recent_requests": [re.sub(r"\s+", " ", w.prompt or w.title)[:90] for w in creations[-30:]],
        "frequent_words": [w for w, _ in words.most_common(14)],
        "accents": [{"color": c, "times": n} for c, n in accents.most_common(5)],
        "refactorings": sum(len(json.loads(w.history_json or "[]")) for w in widgets),
        "files_attached": dict(files),
        "engrams_explored": persons[:12],
        "fusions": actions.get("engram_fusion", 0),
        "conversations": actions.get("engram_chat", 0),
        "set_aside": sum(1 for w in creations if not w.layout_json),
        "actions": dict(actions),
    }


TEXTS = {
    "fr": {
        "first": ("Premier widget", "Votre premier widget, « {t} », ouvre votre atelier.", "Le canvas cesse d'être vide."),
        "refactor": ("Première refactorisation", "Pour la première fois, vous reprenez un widget au lieu d'en créer un autre.", "L'itération entre dans votre manière."),
        "engram": ("Premier Engramme", "Vous cartographiez un premier esprit{p}.", "Les grands esprits deviennent des filtres."),
        "chat": ("Première conversation", "Vous dialoguez pour la première fois avec un Engramme.", "Les idées se discutent avant de se construire."),
        "fusion": ("Première fusion d'esprits", "Vous fusionnez deux Engrammes en un Hyper-Engramme.", "Vous cherchez l'hybride plutôt que le modèle."),
        "refund": ("Première demande avortée", "Une génération n'aboutit pas ; les Sparks vous sont rendus.", "Vous reformulez plutôt que d'abandonner."),
        "reworked": ("Version remise sur l'établi", "« {t} » ne vous convient pas tel quel : vous le retravaillez.", "La première version n'est qu'un brouillon."),
        "aside": ("Carte écartée", "Vous retirez « {t} » du canvas.", "Choisir, c'est aussi écarter."),
        "file": ("Premier fichier confié", "Vous confiez vos propres données à un widget ({k}).", "Vos widgets travaillent sur votre réel."),
        "count": ("{n}e création", "Votre {n}e widget voit le jour : « {t} ».", "Une pratique s'installe."),
        "busiest": ("Journée la plus féconde", "{n} créations en une journée.", "Un élan créatif soutenu."),
        "last": ("Dernière création", "Votre création la plus récente : « {t} ».", "Le style d'aujourd'hui."),
        "creation": ("Création : {t}", "Vous créez « {t} ».", "Une pierre de plus à l'atelier."),
        "domain": "Création dans Prism",
    },
    "en": {
        "first": ("First widget", "Your first widget, “{t}”, opens your workshop.", "The canvas is no longer empty."),
        "refactor": ("First refactoring", "For the first time you rework a widget instead of making another one.", "Iteration enters your way of working."),
        "engram": ("First Engram", "You map a first mind{p}.", "Great minds become filters."),
        "chat": ("First conversation", "You talk with an Engram for the first time.", "Ideas get discussed before being built."),
        "fusion": ("First fusion of minds", "You fuse two Engrams into a Hyper-Engram.", "You look for the hybrid rather than the model."),
        "refund": ("First aborted request", "A generation fails; your Sparks are refunded.", "You rephrase rather than give up."),
        "reworked": ("Back on the workbench", "“{t}” does not suit you as it is: you rework it.", "A first version is only a draft."),
        "aside": ("Card set aside", "You take “{t}” off the canvas.", "Choosing also means setting aside."),
        "file": ("First file entrusted", "You hand your own data to a widget ({k}).", "Your widgets work on your reality."),
        "count": ("Creation no. {n}", "Your widget no. {n} is born: “{t}”.", "A practice settles in."),
        "busiest": ("Most prolific day", "{n} creations in a single day.", "A sustained creative drive."),
        "last": ("Latest creation", "Your latest creation: “{t}”.", "Today's style."),
        "creation": ("Creation: {t}", "You create “{t}”.", "One more stone in the workshop."),
        "domain": "Creation in Prism",
    },
}


def milestones(widgets: list, ledger: list, language: str = "fr") -> list[dict]:
    """Dix jalons réels et datés (succès, échec, tournant chacun présent au moins une fois), du plus ancien au plus
    récent. MirrorError s'il n'y a pas encore assez de matière."""
    t = TEXTS["en" if language == "en" else "fr"]
    creations = [w for w in widgets if not _is_engram_title(w.title)]
    engrams = [w for w in widgets if re.match(r"^Engramme\s*·", w.title or "")]
    candidates: list[tuple[int, datetime, str, str, str, str, float]] = []  # priorité, date, type, titre, contenu, impact, intensité

    def add(priority: int, moment: datetime, kind: str, key: str, intensity: float, **values) -> None:
        title, content, impact = (text.format(**values) for text in t[key])
        candidates.append((priority, _aware(moment), kind, title, content, impact, intensity))

    short = lambda w: engram._text(w.title or w.prompt, 40)  # noqa: E731
    if creations:
        add(0, creations[0].created_at, "succes", "first", 0.9, t=short(creations[0]))
    firsts: dict[str, datetime] = {}
    for reason, delta, moment in ledger:
        if (delta < 0 or reason == "refund") and reason not in firsts:
            firsts[reason] = moment
    if "refactor" in firsts:
        add(1, firsts["refactor"], "tournant", "refactor", 0.75)
    if "engram" in firsts:
        person = engrams[0].title.split("·", 1)[1].strip() if engrams else ""
        add(1, firsts["engram"], "succes", "engram", 0.8, p=f" ({person})" if person else "")
    if "engram_chat" in firsts:
        add(2, firsts["engram_chat"], "tournant", "chat", 0.6)
    if "engram_fusion" in firsts:
        add(1, firsts["engram_fusion"], "succes", "fusion", 0.85)
    if "refund" in firsts:
        add(2, firsts["refund"], "echec", "refund", 0.5)
    reworked = next((w for w in creations if json.loads(w.history_json or "[]")), None)
    if reworked:
        add(2, reworked.created_at, "echec", "reworked", 0.55, t=short(reworked))
    aside = min((w for w in creations if not w.layout_json), key=lambda w: _aware(w.updated_at), default=None)
    if aside:
        add(3, aside.updated_at, "echec", "aside", 0.45, t=short(aside))
    with_file = next((w for w in creations if w.file_json), None)
    if with_file:
        add(2, with_file.created_at, "tournant", "file", 0.6, k=(json.loads(with_file.file_json) or {}).get("kind", "?"))
    for n in (5, 10, 25, 50, 100):
        if len(creations) >= n:
            add(3, creations[n - 1].created_at, "succes", "count", 0.5 + min(0.4, n / 250), n=n, t=short(creations[n - 1]))
    days = Counter(_aware(w.created_at).date() for w in creations)
    if days and days.most_common(1)[0][1] >= 3:
        day, count = days.most_common(1)[0]
        add(3, datetime(day.year, day.month, day.day, tzinfo=UTC), "succes", "busiest", 0.6, n=count)
    if len(creations) > 1:
        add(3, creations[-1].created_at, "tournant", "last", 0.5, t=short(creations[-1]))
    for index, w in enumerate(creations[1:-1], 2):  # créations ordinaires : en dernier recours
        add(9, w.created_at, "tournant" if index % 2 else "succes", "creation", 0.35, t=short(w))

    chosen: list[tuple] = []
    for kind in engram.TYPES["artifact"]:  # chaque type représenté (le plus prioritaire)
        best = min((c for c in candidates if c[2] == kind and c not in chosen), key=lambda c: (c[0], c[1]), default=None)
        if best is None:
            raise MirrorError("Votre Engramme demande au moins une version retravaillée ou écartée : continuez à créer." if kind == "echec"
                              else "Pas encore assez de créations pour dresser votre Engramme.")
        chosen.append(best)
    for c in sorted(candidates, key=lambda c: (c[0], c[1])):
        if len(chosen) >= EVENTS:
            break
        if c not in chosen:
            chosen.append(c)
    if len(chosen) < EVENTS:
        raise MirrorError("Pas encore assez de créations pour dresser votre Engramme.")
    chosen.sort(key=lambda c: c[1])
    return [{"id": f"ev{i}", "category": "artifact", "type": kind, "title": engram._text(title, engram.LIMITS["title"]),
             "content": content, "directive": impact, "basis": "documente", "evidence": moment.date().isoformat(),
             "intensity": intensity, "date": moment.date().isoformat(), "impact": impact}
            for i, (_, moment, kind, title, content, impact, intensity) in enumerate(chosen, 1)]


# --------------------------------------------------------------------------- portrait
def finish_mirror(raw, events: list[dict], label: str, language: str) -> dict:
    if not isinstance(raw, dict):
        raise engram.EngramError("réponse qui n'est pas un objet JSON")
    created = [n for n in (raw.get("nodes") if isinstance(raw.get("nodes"), list) else [])
               if isinstance(n, dict) and n.get("category") != "artifact"]  # un jalon inventé n'entre jamais
    domain = TEXTS["en" if language == "en" else "fr"]["domain"]
    mirror = engram.normalize({**raw, "person": label, "public_figure": True, "refusal": None,
                               "domain": raw.get("domain") or domain, "nodes": created + events})
    for node in mirror["nodes"]:
        if node["category"] != "artifact":
            node["basis"] = "interpretation"
    mirror["mirror"] = True
    return mirror


def demo_mirror(data: dict, events: list[dict], label: str) -> dict:
    """Sans modèle : portrait mécanique mais valide, tiré des mêmes données (mode démo)."""
    words = data["frequent_words"] or ["widget"]
    top = ", ".join(words[:3])
    palette = [a["color"] for a in data["accents"]][:5] or ["#7cc4ff", "#a78bfa", "#f472b6"]
    if len(palette) < 2:
        palette.append("#0b0d12")
    n, refactors = data["widgets_created"], data["refactorings"]
    minds = ", ".join(data["engrams_explored"][:3]) or "aucun encore"
    evidence = f"{n} créations ; mots fréquents : {top} ; {refactors} retouches ; Engrammes : {minds}."

    def node(i, category, kind, title, content, directive, intensity=0.6, **extra):
        return {"id": i, "category": category, "type": kind, "title": title, "content": content, "directive": directive,
                "basis": "interpretation", "evidence": evidence, "intensity": intensity, **extra}

    nodes = [
        node("core", "core", "axiome", f"Faire exister {words[0]}", f"Vos créations tournent autour de {top} : vous cherchez des outils qui rendent une idée tangible tout de suite.",
             "Aller droit à l'objet : un widget utile dès la première seconde, centré sur l'action principale.", 1),
        node("h1", "heart", "trait", "Curiosité pratique", "Vous testez beaucoup d'idées, vite.", "Proposer d'emblée une version utilisable.", 0.7),
        node("h2", "heart", "trait", "Exigence tranquille", "Vous revenez sur vos widgets quand ils ne vous satisfont pas.", "Soigner les détails sans alourdir.", 0.55),
        node("h3", "heart", "trait", "Goût de l'essai", "Chaque demande est une expérience.", "Laisser de la place à l'exploration.", 0.5),
        node("h4", "heart", "emotion", "Plaisir de voir naître", "Vos widgets cherchent une satisfaction immédiate.", "Des retours visuels francs et joyeux.", 0.65, emotion="joie"),
        node("h5", "heart", "emotion", "Calme de l'outil bien fait", "Vous aimez ce qui fonctionne sans bruit.", "Des interfaces posées, sans agitation.", 0.5, emotion="serenite"),
        node("h6", "heart", "attachement", f"Attachement à {words[0]}", f"Vous revenez souvent vers {words[0]}.", f"Faire de {words[0]} un point d'entrée.", 0.6),
        node("h7", "heart", "attachement", "Vos couleurs", "Vous gardez vos accents d'un widget à l'autre.", "Reprendre votre palette.", 0.5),
        node("e1", "engine", "algorithme_resolution", "Du besoin à l'outil", "Vous formulez un besoin concret et attendez un outil complet.", "Découper en une action principale et des réglages secondaires repliés.", 0.7),
        node("e2", "engine", "algorithme_resolution", "Essayer puis corriger", "Vous préférez une version rapide à une spécification longue.", "Livrer vite une base claire, facile à retoucher.", 0.6),
        node("e3", "engine", "empreinte_syntaxique", "Vos mots", f"Votre vocabulaire revient : {top}.", "Employer vos mots dans les libellés.", 0.6, keywords=words[:8]),
        node("e4", "engine", "empreinte_syntaxique", "Demandes brèves", "Vos demandes vont à l'essentiel.", "Des libellés courts et directs.", 0.5, keywords=words[3:8] or words[:3]),
        node("e5", "engine", "matrice_esthetique", "Votre palette", "Les accents que vous choisissez composent une signature.", "Utiliser cette palette avec retenue.", 0.65, palette=palette),
        node("e6", "engine", "matrice_esthetique", "Verre et sobriété", "Vous restez dans l'esthétique sombre et vitrée de Prism.", "Fond sombre, verre dépoli, un seul accent.", 0.5, palette=palette[:2]),
        node("e7", "engine", "methode_travail", "Itérer", f"{refactors} retouches : vous travaillez par versions successives.", "Prévoir l'évolution : une structure simple à étendre.", 0.55),
        node("e8", "engine", "methode_travail", "S'inspirer des esprits", f"Vous explorez des Engrammes ({minds}).", "Laisser un trait d'inspiration visible.", 0.45),
        node("e9", "engine", "methode_travail", "Composer le canvas", "Vous pensez en ensembles de widgets.", "Prévoir les échanges avec les widgets voisins.", 0.45),
        node("s1", "shadow", "paradoxe", "Vite et parfait", "Vous voulez l'immédiat et la finition à la fois.", "Montrer l'essentiel d'abord, le raffinement ensuite.", 0.55),
        node("s2", "shadow", "paradoxe", "Simple mais complet", "Vos demandes sont brèves, vos attentes riches.", "Replier les options avancées.", 0.5),
        node("s3", "shadow", "paradoxe", "Constance et nouveauté", "Vous gardez vos couleurs mais changez souvent de sujet.", "Varier la forme, garder l'identité.", 0.4),
        node("s4", "shadow", "peur_primaire", "La page blanche", "Un canvas vide vous invite moins qu'une ébauche.", "Toujours proposer un point de départ.", 0.45),
        node("s5", "shadow", "peur_primaire", "La complexité", "Trop de réglages vous fait reculer.", "Cacher la complexité derrière des réglages par défaut.", 0.5),
        node("s6", "shadow", "peur_primaire", "Perdre son travail", "Vous tenez à ce que vos données restent.", "Sauvegarder visiblement.", 0.4),
        node("s7", "shadow", "biais_cognitif", f"Tout ramener à {words[0]}", f"{words[0]} revient au risque de masquer d'autres pistes.", "Suggérer une variante inattendue.", 0.45),
        node("s8", "shadow", "biais_cognitif", "Même palette", "Vos accents se répètent.", "Oser un contraste ponctuel.", 0.4),
        node("s9", "shadow", "biais_cognitif", "Premier jet gardé", "Une première version réussie est rarement remise en cause.", "Prévoir une variante à comparer.", 0.35),
        node("s10", "shadow", "biais_cognitif", "Outil avant récit", "Vous privilégiez la fonction à l'histoire.", "Ajouter une phrase qui dit à quoi sert l'outil.", 0.35),
    ]
    raw = {"summary": f"Portrait mécanique (mode démo, sans modèle de langage) tiré de {n} créations dans Prism.",
           "temperament": "Curieux et pratique, vous créez vite et retouchez ce qui compte.",
           "climate": [{"emotion": "joie", "weight": 0.5}, {"emotion": "serenite", "weight": 0.3}, {"emotion": "passion", "weight": 0.2}],
           "nodes": nodes, "links": [{"from": events[0]["id"], "to": "h1", "kind": "forge"}, {"from": "e2", "to": "e7", "kind": "nourrit"},
                                     {"from": "s1", "to": "e2", "kind": "contredit"}]}
    return finish_mirror(raw, events, label, "fr")


async def run_mirror(providers, http_client, data: dict, events: list[dict], label: str, language: str, timeout: float):
    compact = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    values = {"person": label, "usage": compact(data), "language": engram.LANGUAGES.get(language, "French"),
              "events": compact([{k: e[k] for k in ("id", "type", "title", "date", "impact")} for e in events])}
    user = re.sub(r"\{\{(person|usage|events|language)\}\}", lambda m: values[m.group(1)], TEMPLATE)
    errors: list[str] = []
    async with http_client() as client:
        for provider in providers:
            for model in provider.models:
                for schema in ((SCHEMA, None) if provider.name == "gemini" else (None,)):
                    try:
                        text = await provider.complete(client, model, SYSTEM, user, timeout, json_mode=True, schema=schema)
                        return finish_mirror(engram.parse(text), events, label, language), provider.name, model
                    except SchemaRejected as exc:
                        errors.append(str(exc))
                        continue
                    except FatalGenerationError as exc:
                        errors.append(str(exc))
                        break
                    except (GenerationError, engram.EngramError) as exc:
                        log.warning("miroir : %s", exc)
                        errors.append(f"{model}: {exc}" if isinstance(exc, engram.EngramError) else str(exc))
                        break
    raise HTTPException(status_code=502, detail="Engramme miroir impossible : " + " | ".join(errors[-6:]))


# --------------------------------------------------------------------------- routes
class MirrorRequest(BaseModel):
    consent: bool = False  # l'utilisateur a lu ce qui est utilisé et le demande
    language: Literal["fr", "en"] = "fr"


@router.get("/engram/mirror")
def mirror_status(user: User = Depends(current_user)) -> dict:
    return status(user.id)


@router.post("/engram/mirror", response_model=engram.EngramResponse)
async def create_mirror(req: MirrorRequest, user: User = Depends(current_user)) -> engram.EngramResponse:
    import app  # fournisseurs actifs et client HTTP (substituables par les tests)  # noqa: PLC0415

    if not req.consent:
        raise HTTPException(status_code=422, detail={"code": "consent_required", "message": "Le Mode Miroir demande votre accord explicite."})
    state = await asyncio.to_thread(status, user.id)
    if not state["unlocked"]:
        raise HTTPException(status_code=403, detail={"code": "mirror_locked", "message":
                            f"Le Mode Miroir s'ouvre après {state['threshold']:g} Sparks dépensés ({state['spent']:g} pour l'instant)."})
    if not state["available"]:
        raise HTTPException(status_code=429, detail={"code": "mirror_cooldown", "next_at": state["next_at"], "message":
                            "Votre Engramme a déjà été dressé récemment : réessayez plus tard."})
    widgets, ledger = await asyncio.to_thread(_activity, user.id)
    try:
        events = milestones(widgets, ledger, req.language)
    except MirrorError as exc:
        raise HTTPException(status_code=422, detail={"code": "mirror_insufficient", "message": str(exc)}) from exc
    data = usage(widgets, ledger)
    label = LABEL[req.language]
    providers = app.active_providers()
    if providers:
        mirror, mode, model = await run_mirror(providers, app._http_client, data, events, label, req.language, app.TIMEOUT_S)
    else:
        mirror, mode, model = demo_mirror(data, events, label), "mock", "mock:engram-mirror"

    def record() -> None:
        with db.session() as s, s.begin():
            s.add(SparkLedger(user_id=user.id, delta_cents=0, reason="mirror"))

    await asyncio.to_thread(record)
    return engram.EngramResponse(engram=mirror, mode=mode, model=model,
                                 sparks=billing.as_sparks(await asyncio.to_thread(billing.balance, user.id)), cost=0.0)
