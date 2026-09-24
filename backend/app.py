"""Prism — backend FastAPI.

Route principale : POST /api/generate
    Transforme une demande en langage naturel (ou des données collées) en un
    document HTML/CSS/JS autonome, destiné à être rendu dans une iframe sandbox.

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
import time
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from mocks import mock_component
from sanitize import (
    clean_llm_output,
    ensure_document,
    has_markup,
    is_blocking,
    js_syntax_errors,
    validate_document,
)

__version__ = "0.2.0"

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

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_URL = GROQ_DEFAULTS["url"]
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
SYSTEM_PROMPT = (ENGINE_DIR / "system-prompt.txt").read_text(encoding="utf-8").strip()
USER_TEMPLATE = (ENGINE_DIR / "user-template.txt").read_text(encoding="utf-8").strip()


def build_user_message(prompt: str) -> str:
    return USER_TEMPLATE.replace("{{prompt}}", prompt)


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=12_000)


class GenerateResponse(BaseModel):
    html: str
    mode: str  # "groq" | "mock"
    model: str
    elapsed_ms: int
    warnings: list[str] = []


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
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


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


async def _call_groq(client: httpx.AsyncClient, model: str, prompt: str) -> tuple[str, list[str]]:
    payload: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_message(prompt)},
        ],
        "temperature": GROQ_DEFAULTS["temperature"],
        "max_completion_tokens": MAX_TOKENS,
    }
    if model.startswith(GROQ_DEFAULTS["reasoning_models_prefix"]):
        payload["reasoning_effort"] = GROQ_REASONING_EFFORT

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

    cleaned = clean_llm_output(raw)
    if not has_markup(cleaned):
        raise GenerationError(f"{model}: aucune balise HTML dans la réponse ({cleaned[:80]!r})")
    document = ensure_document(cleaned)
    issues = validate_document(document)
    js_errors = await asyncio.to_thread(js_syntax_errors, document)
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
    }


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
async def generate(req: GenerateRequest = Depends(read_generate_request)) -> GenerateResponse:
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="La demande est vide.")
    started = time.perf_counter()

    if not GROQ_API_KEY:
        document, template = mock_component(prompt)
        return GenerateResponse(
            html=document,
            mode="mock",
            model=f"mock:{template}",
            elapsed_ms=round((time.perf_counter() - started) * 1000),
            warnings=validate_document(document),
        )

    errors: list[str] = []
    async with _http_client() as client:
        for model in GROQ_MODELS:
            try:
                document, issues = await _call_groq(client, model, prompt)
            except FatalGenerationError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            except GenerationError as exc:
                log.warning("échec génération: %s", exc)
                errors.append(str(exc))
                continue
            return GenerateResponse(
                html=document,
                mode="groq",
                model=model,
                elapsed_ms=round((time.perf_counter() - started) * 1000),
                warnings=issues,
            )
    raise HTTPException(status_code=502, detail="Tous les modèles ont échoué : " + " | ".join(errors))


# Le frontend est servi par le même processus (monté en dernier pour ne pas masquer /api).
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    log.info("Prism %s — mode %s — http://%s:%d", __version__, "groq" if GROQ_API_KEY else "mock", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT)
