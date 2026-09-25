"""Prism — backend FastAPI.

Transforme une demande en langage naturel (ou un fichier joint) en un document HTML/CSS/JS
autonome, rendu dans une iframe sandbox, pour des utilisateurs authentifiés qui paient en Sparks.

Routes :
    /api/auth     inscription, connexion, profil (auth.py)
    /api/generate génération (1 Spark) ou refactorisation d'un widget (0,5 Spark)
    /api/widgets  historique « Mon Hub » : lecture, mise à jour, annulation, suppression (widgets.py)
    /api/sparks   solde, tarifs et grand livre (billing.py)
    /api/health   état du serveur

Moteurs :
    - Groq (API OpenAI-compatible) si GROQ_API_KEY est définie ;
    - sinon mode démo (mock) avec des composants pré-écrits.

Lancement :  python backend/app.py   (puis http://127.0.0.1:8000)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

import auth
import billing
import db
import widgets
from mocks import mock_component
from models import User, Widget
from widgets import WidgetSummary
from sanitize import (
    clean_llm_output,
    ensure_document,
    has_markup,
    is_blocking,
    js_syntax_errors,
    normalize_libraries,
    validate_document,
)

__version__ = "3.0.0a1"

BACKEND_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BACKEND_DIR.parent / "frontend"


def _load_dotenv(*paths: Path) -> None:
    """Charge des fichiers .env simples (CLE=valeur) sans dépendance externe."""
    for path in paths:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_load_dotenv(BACKEND_DIR / ".env", BACKEND_DIR.parent / ".env")

ENGINE_DIR = FRONTEND_DIR / "engine"  # fichiers partagés avec le moteur navigateur (GitHub Pages)
GROQ_DEFAULTS = json.loads((ENGINE_DIR / "groq.json").read_text(encoding="utf-8"))
LIBS = json.loads((ENGINE_DIR / "libs.json").read_text(encoding="utf-8"))
ALLOWED_URLS = tuple(lib["url"] for key, lib in LIBS.items() if not key.startswith("_"))

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
# Surcharge réservée aux tests locaux (faux serveur Groq, cf. tools/e2e_server.py).
GROQ_URL = os.getenv("GROQ_URL", GROQ_DEFAULTS["url"])
# Chaîne de modèles essayés dans l'ordre (le suivant prend le relais en cas d'échec).
GROQ_MODELS = [
    m.strip() for m in os.getenv("GROQ_MODELS", ",".join(GROQ_DEFAULTS["models"])).split(",") if m.strip()
]
GROQ_REASONING_EFFORT = os.getenv("GROQ_REASONING_EFFORT", GROQ_DEFAULTS["reasoning_effort"])
MAX_TOKENS = int(os.getenv("PRISM_MAX_TOKENS", str(GROQ_DEFAULTS["max_completion_tokens"])))
TIMEOUT_S = float(os.getenv("PRISM_TIMEOUT", "90"))
HOST = os.getenv("PRISM_HOST", "127.0.0.1")
PORT = int(os.getenv("PRISM_PORT", "8000"))
CORS_ORIGINS = [o.strip() for o in os.getenv("PRISM_CORS_ORIGINS", "*").split(",") if o.strip()]

log = logging.getLogger("prism")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# --------------------------------------------------------------------------- #
# Prompts : impose une sortie 100 % HTML, sans Markdown ni explication.
# Source unique dans frontend/engine/ (aussi utilisée par le moteur navigateur).
# --------------------------------------------------------------------------- #
def _engine_text(name: str) -> str:
    return (ENGINE_DIR / name).read_text(encoding="utf-8").strip()


SYSTEM_PROMPT = _engine_text("system-prompt.txt").replace("{{chartjs_url}}", LIBS["chartjs"]["url"])
USER_TEMPLATE = _engine_text("user-template.txt")
FILE_TEMPLATE = _engine_text("file-template.txt")
REFACTOR_TEMPLATE = _engine_text("refactor-template.txt")


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
class AttachedFile(BaseModel):
    """Structure d'un fichier joint : les données complètes restent dans le navigateur
    (injectées dans le widget sous window.PRISM_FILE), seul ce résumé part au LLM."""

    name: str = Field(..., min_length=1, max_length=200)
    kind: Literal["csv", "json", "txt"]
    summary: str = Field(..., max_length=8_000)


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=12_000)
    file: AttachedFile | None = None
    # Présent = refactorisation de ce widget (seule cette carte change) : le serveur part du code
    # qu'il a enregistré, jamais d'un code envoyé par le client.
    widget_id: str | None = Field(None, max_length=36)


def build_user_message(prompt: str, file: AttachedFile | None = None, base_html: str | None = None) -> str:
    file_block = ""
    if file:
        file_block = FILE_TEMPLATE.replace("{{kind}}", file.kind).replace("{{summary}}", file.summary) + "\n"
    template = REFACTOR_TEMPLATE if base_html else USER_TEMPLATE
    # {{html}} en dernier : le code existant ne doit pas être réinterprété comme gabarit.
    message = template.replace("{{file}}", file_block).replace("{{prompt}}", prompt)
    return message.replace("{{html}}", base_html or "")


class GenerateResponse(BaseModel):
    html: str
    mode: str  # "groq" | "mock"
    model: str
    elapsed_ms: int
    warnings: list[str] = []
    widget: WidgetSummary  # enregistré dans « Mon Hub »
    sparks: float  # solde après débit
    cost: float


async def read_generate_request(request: Request) -> GenerateRequest:
    """Corps JSON en UTF-8, avec repli cp1252 : curl en ligne de commande sous Windows
    transmet les accents (« Crée ») dans l'encodage ANSI, ce qui n'est pas du JSON valide."""
    raw = await request.body()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    try:
        return GenerateRequest.model_validate_json(text)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors(include_url=False)) from exc


class GenerationError(Exception):
    """Échec d'un modèle : on peut tenter le suivant de la chaîne."""


class FatalGenerationError(Exception):
    """Échec qui ne dépend pas du modèle (clé refusée…) : inutile d'insister."""


app = FastAPI(title="Prism", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    # Jeton Bearer, pas de cookie : le frontend peut être servi ailleurs que l'API.
    allow_headers=["Content-Type", "Authorization"],
)
app.include_router(auth.router)
app.include_router(widgets.router)


@app.middleware("http")
async def revalidate_frontend(request, call_next):
    """Le navigateur revalide les fichiers du frontend (ETag) : jamais de CSS/JS périmé."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


def _http_client() -> httpx.AsyncClient:
    """Point d'injection : les tests y substituent un transport Groq simulé."""
    return httpx.AsyncClient()


async def _call_groq(client: httpx.AsyncClient, model: str, user_message: str) -> tuple[str, list[str]]:
    payload: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        "temperature": GROQ_DEFAULTS["temperature"],
        "max_completion_tokens": MAX_TOKENS,
    }
    if model.startswith(GROQ_DEFAULTS["reasoning_models_prefix"]):
        payload["reasoning_effort"] = GROQ_REASONING_EFFORT

    t0 = time.perf_counter()
    try:
        resp = await client.post(
            GROQ_URL,
            json=payload,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            timeout=TIMEOUT_S,
        )
    except httpx.TimeoutException as exc:
        raise GenerationError(f"{model}: délai dépassé ({TIMEOUT_S:.0f}s)") from exc
    except httpx.HTTPError as exc:
        raise GenerationError(f"{model}: erreur réseau ({exc.__class__.__name__})") from exc

    if resp.status_code == 401:
        raise FatalGenerationError("Clé Groq refusée (401). Vérifiez GROQ_API_KEY.")
    if resp.status_code >= 400:
        detail = resp.text[:300].replace("\n", " ")
        raise GenerationError(f"{model}: HTTP {resp.status_code} — {detail}")

    try:
        choice = resp.json()["choices"][0]
        raw = choice.get("message", {}).get("content") or ""
    except (ValueError, KeyError, IndexError, AttributeError) as exc:
        raise GenerationError(f"{model}: réponse Groq illisible") from exc
    if choice.get("finish_reason") == "length":
        raise GenerationError(f"{model}: réponse tronquée (max_completion_tokens={MAX_TOKENS})")

    t1 = time.perf_counter()
    cleaned = clean_llm_output(raw)
    if not has_markup(cleaned):
        raise GenerationError(f"{model}: aucune balise HTML dans la réponse ({cleaned[:80]!r})")
    document = normalize_libraries(ensure_document(cleaned), LIBS)
    issues = validate_document(document, ALLOWED_URLS)
    t2 = time.perf_counter()
    js_errors = await asyncio.to_thread(js_syntax_errors, document)
    log.info(
        "%s : modèle %d ms, nettoyage %d ms, vérification JS %d ms",
        model, (t1 - t0) * 1000, (t2 - t1) * 1000, (time.perf_counter() - t2) * 1000,
    )
    if js_errors:
        issues.append("js_syntax")
    if is_blocking(issues):
        raise GenerationError(f"{model}: document invalide ({', '.join(issues + js_errors)})")
    return document, issues


@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "mode": "groq" if GROQ_API_KEY else "mock",
        "models": GROQ_MODELS if GROQ_API_KEY else ["mock"],
        "auth": True,
        "pricing": {action: billing.as_sparks(cents) for action, cents in billing.PRICES.items()},
        "signup_sparks": billing.as_sparks(billing.SIGNUP_BONUS),
    }


@app.get("/api/sparks")
def sparks(user: User = Depends(auth.current_user)) -> dict:
    """Solde, tarifs et derniers mouvements (bonus, dépenses, remboursements)."""
    return {
        "sparks": user.sparks,
        "pricing": {action: billing.as_sparks(cents) for action, cents in billing.PRICES.items()},
        "ledger": [
            {"delta": billing.as_sparks(e.delta_cents), "reason": e.reason, "widget_id": e.widget_id,
             "at": widgets.iso(e.created_at)}
            for e in billing.ledger(user.id)
        ],
    }


async def run_model(user_message: str, prompt: str, file_kind: str | None) -> tuple[str, str, str, list[str]]:
    """Produit un document : (html, mode, modèle, avertissements). Lève HTTPException 502 si tout échoue."""
    if not GROQ_API_KEY:
        document, template = mock_component(prompt, file_kind)
        return document, "mock", f"mock:{template}", validate_document(document, ALLOWED_URLS)
    errors: list[str] = []
    async with _http_client() as client:
        for model in GROQ_MODELS:
            try:
                document, issues = await _call_groq(client, model, user_message)
            except FatalGenerationError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            except GenerationError as exc:
                log.warning("échec génération: %s", exc)
                errors.append(str(exc))
                continue
            return document, "groq", model, issues
    raise HTTPException(status_code=502, detail="Tous les modèles ont échoué : " + " | ".join(errors))


def insufficient(exc: billing.InsufficientSparks) -> HTTPException:
    """403 attendu par le frontend pour ouvrir la fenêtre « Prism Pro »."""
    return HTTPException(
        status_code=403,
        detail={
            "code": "insufficient_sparks",
            "message": "Plus assez de Sparks pour cette action.",
            "sparks": billing.as_sparks(exc.balance_cents),
            "required": billing.as_sparks(exc.required_cents),
        },
    )


def _load_for_refactor(user: User, widget_id: str) -> str:
    with db.session() as s:
        return widgets.owned(s, user, widget_id).html


def _save_widget(user: User, req: GenerateRequest, html: str, mode: str, model: str) -> WidgetSummary:
    """Crée le widget (génération) ou le met à jour en gardant l'ancienne version (refactorisation)."""
    with db.session() as s, s.begin():
        if req.widget_id:
            widget = widgets.owned(s, user, req.widget_id)
            widget.history = [widget.html, *widget.history]
            widget.html = html
            widget.updated_at = datetime.now(UTC)
        else:
            file = req.file.model_dump() if req.file else None
            widget = Widget(user_id=user.id, prompt=req.prompt.strip(), html=html, file=file,
                            title=widgets.title_of(html, req.prompt.strip()[:60]))
            s.add(widget)
        widget.mode, widget.model = mode, model
        widget.title = widgets.title_of(html, widget.title)
        s.flush()
        return WidgetSummary.of(widget)


@app.post(
    "/api/generate",
    response_model=GenerateResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": GenerateRequest.model_json_schema()}},
        }
    },
)
async def generate(
    req: GenerateRequest = Depends(read_generate_request),
    user: User = Depends(auth.current_user),
) -> GenerateResponse:
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="La demande est vide.")
    started = time.perf_counter()
    action = "refactor" if req.widget_id else "generate"

    base_html = None
    if action == "refactor":
        base_html = await asyncio.to_thread(_load_for_refactor, user, req.widget_id)  # 404 si pas à lui
        if not GROQ_API_KEY:
            raise HTTPException(
                status_code=409,
                detail="La refactorisation a besoin d'un modèle : ajoutez GROQ_API_KEY (mode démo actif).",
            )

    # Réserver avant d'appeler le modèle : aucune génération parallèle ne peut dépasser le solde.
    try:
        reservation = await asyncio.to_thread(billing.reserve, user.id, action)
    except billing.InsufficientSparks as exc:
        raise insufficient(exc) from exc

    try:
        user_message = build_user_message(prompt, req.file, base_html)
        document, mode, model, issues = await run_model(user_message, prompt, req.file.kind if req.file else None)
        widget = await asyncio.to_thread(_save_widget, user, req, document, mode, model)
    except BaseException:
        # Échec (modèle, validation, base) ou requête annulée : rien n'a été livré, on rembourse.
        # shield : même une annulation ne doit pas interrompre le remboursement.
        await asyncio.shield(asyncio.to_thread(billing.refund, reservation))
        raise
    await asyncio.to_thread(billing.confirm, reservation, widget.id)
    return GenerateResponse(
        html=document,
        mode=mode,
        model=model,
        elapsed_ms=round((time.perf_counter() - started) * 1000),
        warnings=issues,
        widget=widget,
        sparks=billing.as_sparks(await asyncio.to_thread(billing.balance, user.id)),
        cost=billing.as_sparks(reservation.cost_cents),
    )


# Le frontend est servi par le même processus (monté en dernier pour ne pas masquer /api).
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


# Sous Windows, uvicorn prend par défaut la boucle Proactor : avec Python 3.14, des réponses
# complètes côté serveur n'arrivaient parfois jamais au navigateur (vu en E2E). La boucle
# « selector » n'a pas ce défaut ; Prism n'utilise pas les sous-processus asyncio (vérification
# JS lancée dans un thread), seule chose qu'elle ne sait pas faire sous Windows.
UVICORN_LOOP = "asyncio:SelectorEventLoop" if sys.platform == "win32" else "auto"


if __name__ == "__main__":
    import uvicorn

    log.info("Prism %s — mode %s — http://%s:%d", __version__, "groq" if GROQ_API_KEY else "mock", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT, loop=UVICORN_LOOP)
