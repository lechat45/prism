"""Widgets de l'utilisateur : bibliothèque « Mon Hub », synchronisation du canvas, annulation.

Chaque génération réussie crée un widget côté serveur ; le canvas y synchronise ensuite sa
disposition (présence sur le canvas comprise), son état (localStorage du widget), sa couleur,
sa miniature et les données de son fichier joint. Une carte créée hors compte peut être importée.
Un widget d'un autre compte répond 404 : on ne révèle pas son existence.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session, defer

import db
from auth import current_user
from db import get_session
from models import User, Widget

router = APIRouter(prefix="/api/widgets", tags=["widgets"])

ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
THUMBNAIL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
MAX_THUMBNAIL = 300_000  # caractères (~220 Ko d'image)
MAX_STORAGE = 1_000_000  # même plafond que la sandbox côté navigateur
# window.PRISM_FILE en JSON : un CSV de 5 Mo (plafond du navigateur) grossit une fois en objets,
# les noms de colonnes étant répétés à chaque ligne.
MAX_FILE_DATA = int(float(os.getenv("PRISM_MAX_FILE_DATA_MB", "16")) * 1_000_000)  # octets (base gratuite : réduire)
MAX_HTML = 1_000_000  # code d'un widget importé (un widget généré pèse quelques dizaines de Ko)
MAX_WIDGETS = 1000  # par compte, pour les imports (la génération, elle, coûte des Sparks)


def iso(dt: datetime) -> str:
    # SQLite ne conserve pas le fuseau : les dates y sont écrites en UTC.
    return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).isoformat()


# --------------------------------------------------------------------------- #
# Schémas
# --------------------------------------------------------------------------- #
class Layout(BaseModel):
    x: float = Field(..., ge=-1e6, le=1e6)
    y: float = Field(..., ge=-1e6, le=1e6)
    w: float = Field(..., ge=120, le=10_000)
    h: float = Field(..., ge=120, le=10_000)
    z: int = Field(1, ge=0, le=1_000_000)


class WidgetSummary(BaseModel):
    """Entrée du Hub : sans le code, pour rester léger."""

    id: str
    title: str
    prompt: str
    mode: str
    model: str
    accent: str | None
    thumbnail: str | None
    file_name: str | None
    has_file_data: bool  # données du fichier téléversées (réouverture possible sur un autre appareil)
    on_canvas: bool  # la carte est posée sur le canvas (disposition connue)
    versions: int
    created_at: str
    updated_at: str

    @classmethod
    def of(cls, w: Widget, has_file_data: bool | None = None) -> WidgetSummary:
        file = w.file
        return cls(
            id=w.id, title=w.title, prompt=w.prompt, mode=w.mode, model=w.model, accent=w.accent,
            thumbnail=w.thumbnail, file_name=file.get("name") if file else None,
            has_file_data=w.file_data_json is not None if has_file_data is None else has_file_data,
            on_canvas=w.layout_json is not None, versions=len(w.history),
            created_at=iso(w.created_at), updated_at=iso(w.updated_at),
        )


class WidgetDetail(WidgetSummary):
    html: str
    storage: dict[str, str]
    layout: Layout | None
    file: dict | None  # { name, kind, summary } ; les données : GET /api/widgets/{id}/file

    @classmethod
    def of(cls, w: Widget) -> WidgetDetail:
        file = {k: v for k, v in w.file.items() if k != "data"} if w.file else None
        return cls(**WidgetSummary.of(w).model_dump(), html=w.html, storage=w.storage, layout=w.layout, file=file)


class WidgetPage(BaseModel):
    items: list[WidgetSummary]
    total: int


def _check_accent(v: str | None) -> str | None:
    if v is not None and not ACCENT_RE.match(v):
        raise ValueError("couleur attendue au format #rrggbb")
    return v


def _check_storage(v: dict[str, str] | None) -> dict[str, str] | None:
    if v is not None and sum(len(k) + len(val) for k, val in v.items()) > MAX_STORAGE:
        raise ValueError("données du widget au-delà de 1 Mo")
    return v


class WidgetPatch(BaseModel):
    title: str | None = Field(None, max_length=120)
    accent: str | None = None
    layout: Layout | None = None
    storage: dict[str, str] | None = None
    thumbnail: str | None = Field(None, max_length=MAX_THUMBNAIL)
    file_data: dict | None = None  # préférer PUT /{id}/file (JSON brut, sans double analyse)
    clear_accent: bool = False
    clear_layout: bool = False  # carte retirée du canvas (elle reste dans le Hub)

    @field_validator("accent")
    @classmethod
    def check_accent(cls, v: str | None) -> str | None:
        return _check_accent(v)

    @field_validator("thumbnail")
    @classmethod
    def check_thumbnail(cls, v: str | None) -> str | None:
        if v is not None and not THUMBNAIL_RE.match(v):
            raise ValueError("miniature attendue en data:image/png|jpeg|webp;base64")
        return v

    @field_validator("storage")
    @classmethod
    def check_storage(cls, v: dict[str, str] | None) -> dict[str, str] | None:
        return _check_storage(v)


class FileMeta(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    kind: Literal["csv", "json", "txt"]
    summary: str = Field(..., max_length=8_000)


class WidgetImport(BaseModel):
    """Carte créée hors compte (moteur navigateur, avant connexion) : ajoutée au Hub, sans Sparks."""

    html: str = Field(..., min_length=1, max_length=MAX_HTML)
    prompt: str = Field("", max_length=12_000)
    title: str = Field("", max_length=120)
    mode: str = Field("import", max_length=20)
    model: str = Field("", max_length=100)
    accent: str | None = None
    layout: Layout | None = None
    storage: dict[str, str] = {}
    file: FileMeta | None = None

    @field_validator("accent")
    @classmethod
    def check_accent(cls, v: str | None) -> str | None:
        return _check_accent(v)

    @field_validator("storage")
    @classmethod
    def check_storage(cls, v: dict[str, str]) -> dict[str, str]:
        return _check_storage(v)


# --------------------------------------------------------------------------- #
# Service (utilisé aussi par /api/generate)
# --------------------------------------------------------------------------- #
def owned(s: Session, user: User, widget_id: str) -> Widget:
    widget = s.get(Widget, widget_id)
    if widget is None or widget.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "widget_not_found", "message": "Widget introuvable."})
    return widget


def title_of(html: str, fallback: str) -> str:
    m = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I)
    title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    return (title or fallback)[:120]


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.get("", response_model=WidgetPage)
def list_widgets(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    on_canvas: bool | None = Query(None, description="true : seulement les cartes posées sur le canvas"),
    user: User = Depends(current_user),
    s: Session = Depends(get_session),
) -> WidgetPage:
    where = [Widget.user_id == user.id]
    if on_canvas is not None:
        where.append(Widget.layout_json.is_not(None) if on_canvas else Widget.layout_json.is_(None))
    total = s.scalar(select(func.count()).select_from(Widget).where(*where)) or 0
    # Ni le code, ni l'état, ni les données du fichier : la liste reste légère.
    rows = list(s.scalars(
        select(Widget).where(*where).options(defer(Widget.html), defer(Widget.storage_json), defer(Widget.file_data_json))
        .order_by(Widget.updated_at.desc()).limit(limit).offset(offset)
    ))
    with_data = set(s.scalars(
        select(Widget.id).where(Widget.id.in_([w.id for w in rows]), Widget.file_data_json.is_not(None))
    ))
    return WidgetPage(items=[WidgetSummary.of(w, has_file_data=w.id in with_data) for w in rows], total=total)


@router.post("", response_model=WidgetDetail, status_code=status.HTTP_201_CREATED)
def import_widget(body: WidgetImport, user: User = Depends(current_user), s: Session = Depends(get_session)) -> WidgetDetail:
    count = s.scalar(select(func.count()).select_from(Widget).where(Widget.user_id == user.id)) or 0
    if count >= MAX_WIDGETS:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "hub_full", "message": f"Mon Hub est plein ({MAX_WIDGETS} widgets)."})
    widget = Widget(
        user_id=user.id, html=body.html, prompt=body.prompt.strip(), mode=body.mode, model=body.model,
        title=(body.title.strip() or title_of(body.html, body.prompt.strip()[:60] or "Widget"))[:120],
        accent=body.accent, storage=body.storage,
        layout=body.layout.model_dump() if body.layout else None,
        file=body.file.model_dump() if body.file else None,
    )
    s.add(widget)
    s.commit()
    return WidgetDetail.of(widget)


@router.get("/{widget_id}", response_model=WidgetDetail)
def get_widget(widget_id: str, user: User = Depends(current_user), s: Session = Depends(get_session)) -> WidgetDetail:
    return WidgetDetail.of(owned(s, user, widget_id))


@router.get("/{widget_id}/file")
def get_file_data(widget_id: str, user: User = Depends(current_user), s: Session = Depends(get_session)) -> Response:
    """window.PRISM_FILE tel que téléversé (JSON brut : le navigateur en fait un Blob sans l'analyser)."""
    widget = owned(s, user, widget_id)
    if widget.file_data_json is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "no_file_data", "message": "Données du fichier absentes."})
    return Response(content=widget.file_data_json, media_type="application/json")


def _store_file_data(user: User, widget_id: str, raw: str) -> WidgetSummary:
    with db.session() as s:
        widget = owned(s, user, widget_id)
        if widget.file is None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "no_file", "message": "Ce widget n'a pas de fichier joint."})
        widget.file_data_json = raw
        widget.updated_at = datetime.now(UTC)
        s.commit()
        return WidgetSummary.of(widget)


def _too_large() -> HTTPException:
    return HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                         detail={"code": "file_too_large", "message": "Données du fichier trop volumineuses."})


@router.put("/{widget_id}/file", response_model=WidgetSummary)
async def put_file_data(widget_id: str, request: Request, user: User = Depends(current_user)) -> WidgetSummary:
    """Corps = window.PRISM_FILE en JSON brut (objet), lu par morceaux sous un plafond."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_FILE_DATA:
        raise _too_large()
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_FILE_DATA:
            raise _too_large()
        chunks.append(chunk)
    try:
        raw = b"".join(chunks).decode("utf-8")
        data = await asyncio.to_thread(json.loads, raw)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "invalid_json", "message": "JSON invalide."}) from exc
    if not isinstance(data, dict):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "invalid_json", "message": "Objet JSON attendu."})
    return await asyncio.to_thread(_store_file_data, user, widget_id, raw)


@router.patch("/{widget_id}", response_model=WidgetSummary)
def patch_widget(
    widget_id: str, body: WidgetPatch, user: User = Depends(current_user), s: Session = Depends(get_session)
) -> WidgetSummary:
    widget = owned(s, user, widget_id)
    fields = body.model_fields_set
    if "title" in fields and body.title is not None:
        widget.title = body.title.strip()[:120] or widget.title
    if body.clear_accent:
        widget.accent = None
    elif "accent" in fields and body.accent is not None:
        widget.accent = body.accent
    if body.clear_layout:
        widget.layout = None
    elif body.layout is not None:
        widget.layout = body.layout.model_dump()
    if body.storage is not None:
        widget.storage = body.storage
    if body.thumbnail is not None:
        widget.thumbnail = body.thumbnail
    if "file_data" in fields:
        file = widget.file
        if file is None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "no_file", "message": "Ce widget n'a pas de fichier joint."})
        encoded = json.dumps(body.file_data, ensure_ascii=False)
        if len(encoded.encode()) > MAX_FILE_DATA:
            raise _too_large()
        widget.file_data_json = encoded
    widget.updated_at = datetime.now(UTC)
    s.commit()
    return WidgetSummary.of(widget)


@router.post("/{widget_id}/undo", response_model=WidgetDetail)
def undo_refactor(widget_id: str, user: User = Depends(current_user), s: Session = Depends(get_session)) -> WidgetDetail:
    """Restaure la version précédente (gratuit : les Sparks paient la génération, pas l'annulation)."""
    widget = owned(s, user, widget_id)
    history = widget.history
    if not history:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "no_history", "message": "Aucune version précédente."})
    widget.html, widget.history = history[0], history[1:]
    widget.title = title_of(widget.html, widget.title)
    widget.updated_at = datetime.now(UTC)
    s.commit()
    return WidgetDetail.of(widget)


@router.delete("/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_widget(widget_id: str, user: User = Depends(current_user), s: Session = Depends(get_session)) -> Response:
    s.delete(owned(s, user, widget_id))
    s.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
