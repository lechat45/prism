"""Modèles : utilisateurs, widgets (historique « Mon Hub ») et grand livre des Sparks."""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class User(Base):
    """Compte. Le solde est stocké en centièmes de Spark (entier exact : 0,5 Spark = 50)."""

    __tablename__ = "users"
    __table_args__ = (CheckConstraint("sparks_cents >= 0", name="sparks_non_negatifs"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    sparks_cents: Mapped[int] = mapped_column(Integer, default=0)
    plan: Mapped[str] = mapped_column(String(20), default="free")
    # Incrémenté pour invalider tous les jetons émis (changement de mot de passe…).
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    widgets: Mapped[list[Widget]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)

    @property
    def sparks(self) -> float:
        return self.sparks_cents / 100


class Widget(Base):
    """Micro-application générée : code, état persistant, disposition sur le canvas, miniature."""

    __tablename__ = "widgets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(120), default="")
    prompt: Mapped[str] = mapped_column(Text, default="")
    html: Mapped[str] = mapped_column(Text)
    # Versions précédentes (refactorisations), la plus récente en tête, 5 au plus.
    history_json: Mapped[str] = mapped_column(Text, default="[]")
    # Fichier joint : { name, kind, summary } à la génération, { …, data } une fois téléversé.
    file_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    storage_json: Mapped[str] = mapped_column(Text, default="{}")  # localStorage du widget
    layout_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # { x, y, w, h, z }
    accent: Mapped[str | None] = mapped_column(String(7), nullable=True)
    thumbnail: Mapped[str | None] = mapped_column(Text, nullable=True)  # data:image/… (miniature du Hub)
    mode: Mapped[str] = mapped_column(String(20), default="mock")
    model: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    user: Mapped[User] = relationship(back_populates="widgets")

    # Accès JSON typés
    @property
    def history(self) -> list[str]:
        return json.loads(self.history_json or "[]")

    @history.setter
    def history(self, value: list[str]) -> None:
        self.history_json = json.dumps(value[:5])

    @property
    def file(self) -> dict | None:
        return json.loads(self.file_json) if self.file_json else None

    @file.setter
    def file(self, value: dict | None) -> None:
        self.file_json = json.dumps(value) if value is not None else None

    @property
    def storage(self) -> dict[str, str]:
        return json.loads(self.storage_json or "{}")

    @storage.setter
    def storage(self, value: dict[str, str]) -> None:
        self.storage_json = json.dumps(value)

    @property
    def layout(self) -> dict | None:
        return json.loads(self.layout_json) if self.layout_json else None

    @layout.setter
    def layout(self, value: dict | None) -> None:
        self.layout_json = json.dumps(value) if value is not None else None


class SparkLedger(Base):
    """Chaque mouvement de Sparks (bonus, génération, refactorisation, remboursement) : solde auditable."""

    __tablename__ = "spark_ledger"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    delta_cents: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(20))  # signup_bonus | generate | refactor | refund
    widget_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
