"""Widgets de l'utilisateur : historique (« Mon Hub »), mise à jour de la carte, annulation.

Chaque génération réussie crée un widget côté serveur ; le canvas y synchronise ensuite sa
disposition, son état (localStorage du widget), sa couleur et sa miniature.
Un widget d'un autre compte répond 404 : on ne révèle pas son existence.
"""
from __future__ import annotations

import json
import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth import current_user
from db import get_session
from models import User, Widget

router = APIRouter(prefix="/api/widgets", tags=["widgets"])

ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
THUMBNAIL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
MAX_THUMBNAIL = 300_000  # caractères (~220 Ko d'image)
MAX_STORAGE = 1_000_000  # même plafond que la sandbox côté navigateur
MAX_FILE_DATA = 7_000_000  # données d'un fichier joint (5 Mo à l'origine, en JSON)


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
    versions: int
    created_at: str
    updated_at: str

    @classmethod
    def of(cls, w: Widget) -> WidgetSummary:
        file = w.file
        return cls(
            id=w.id, title=w.title, prompt=w.prompt, mode=w.mode, model=w.model, accent=w.accent,
            thumbnail=w.thumbnail, file_name=file.get("name") if file else None, versions=len(w.history),
            created_at=iso(w.created_at), updated_at=iso(w.updated_at),
        )


class WidgetDetail(WidgetSummary):
    html: str
    storage: dict[str, str]
    layout: Layout | None
    file: dict | None

    @classmethod
    def of(cls, w: Widget) -> WidgetDetail:
        return cls(**WidgetSummary.of(w).model_dump(), html=w.html, storage=w.storage, layout=w.layout, file=w.file)


class WidgetPage(BaseModel):
    items: list[WidgetSummary]
    total: int


class WidgetPatch(BaseModel):
    title: str | None = Field(None, max_length=120)
    accent: str | None = None
    layout: Layout | None = None
    storage: dict[str, str] | None = None
    thumbnail: str | None = Field(None, max_length=MAX_THUMBNAIL)
    file_data: dict | None = None  # window.PRISM_FILE complet, pour recharger le widget sur un autre appareil
    clear_accent: bool = False

    @field_validator("accent")
    @classmethod
    def check_accent(cls, v: str | None) -> str | None:
        if v is not None and not ACCENT_RE.match(v):
            raise ValueError("couleur attendue au format #rrggbb")
        return v

    @field_validator("thumbnail")
    @classmethod
    def check_thumbnail(cls, v: str | None) -> str | None:
        if v is not None and not THUMBNAIL_RE.match(v):
            raise ValueError("miniature attendue en data:image/png|jpeg|webp;base64")
        return v

    @field_validator("storage")
    @classmethod
    def check_storage(cls, v: dict[str, str] | None) -> dict[str, str] | None:
        if v is not None and sum(len(k) + len(val) for k, val in v.items()) > MAX_STORAGE:
            raise ValueError("données du widget au-delà de 1 Mo")
        return v


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
    user: User = Depends(current_user),
    s: Session = Depends(get_session),
) -> WidgetPage:
    total = s.scalar(select(func.count()).select_from(Widget).where(Widget.user_id == user.id)) or 0
    rows = s.scalars(
        select(Widget).where(Widget.user_id == user.id).order_by(Widget.updated_at.desc()).limit(limit).offset(offset)
    )
    return WidgetPage(items=[WidgetSummary.of(w) for w in rows], total=total)


@router.get("/{widget_id}", response_model=WidgetDetail)
def get_widget(widget_id: str, user: User = Depends(current_user), s: Session = Depends(get_session)) -> WidgetDetail:
    return WidgetDetail.of(owned(s, user, widget_id))


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
    if body.layout is not None:
        widget.layout = body.layout.model_dump()
    if body.storage is not None:
        widget.storage = body.storage
    if body.thumbnail is not None:
        widget.thumbnail = body.thumbnail
    if "file_data" in fields:
        file = widget.file
        if file is None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "no_file", "message": "Ce widget n'a pas de fichier joint."})
        encoded = json.dumps(body.file_data)
        if len(encoded) > MAX_FILE_DATA:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail={"code": "file_too_large", "message": "Données du fichier trop volumineuses."})
        widget.file = {**file, "data": body.file_data}
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
