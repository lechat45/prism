"""Prism Sparks : crédits de génération.

Principe « réserver puis confirmer » : le coût est débité AVANT l'appel au modèle, par une mise
à jour conditionnelle atomique (… WHERE sparks >= coût), puis remboursé si la génération échoue.
Des générations parallèles ne peuvent donc jamais rendre un solde négatif (contrainte CHECK
en dernier rempart). Chaque mouvement est inscrit au grand livre (spark_ledger).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.orm import Session

import db
from models import SparkLedger, User

CENTS = 100  # un Spark = 100 centièmes
SIGNUP_BONUS = round(float(os.getenv("PRISM_SIGNUP_SPARKS", "50")) * CENTS)
PRICES = {"generate": 1 * CENTS, "refactor": CENTS // 2, "engram": 2 * CENTS}  # engramme : 30 à 36 nœuds


def as_sparks(cents: int) -> float:
    return cents / CENTS


class InsufficientSparks(Exception):
    def __init__(self, balance_cents: int, required_cents: int):
        super().__init__(f"solde {as_sparks(balance_cents)} < {as_sparks(required_cents)}")
        self.balance_cents = balance_cents
        self.required_cents = required_cents


@dataclass(frozen=True)
class Reservation:
    ledger_id: int
    user_id: int
    action: str
    cost_cents: int


def credit(s: Session, user_id: int, cents: int, reason: str, widget_id: str | None = None) -> None:
    """Crédite un compte dans la transaction courante (bonus, remboursement, achat futur)."""
    s.execute(update(User).where(User.id == user_id).values(sparks_cents=User.sparks_cents + cents))
    s.add(SparkLedger(user_id=user_id, delta_cents=cents, reason=reason, widget_id=widget_id))


def reserve(user_id: int, action: str) -> Reservation:
    """Débite le coût de l'action, ou lève InsufficientSparks sans rien débiter."""
    cost = PRICES[action]
    with db.session() as s, s.begin():
        result = s.execute(
            update(User)
            .where(User.id == user_id, User.sparks_cents >= cost)
            .values(sparks_cents=User.sparks_cents - cost)
        )
        if result.rowcount != 1:
            balance = s.scalar(select(User.sparks_cents).where(User.id == user_id)) or 0
            raise InsufficientSparks(balance, cost)
        entry = SparkLedger(user_id=user_id, delta_cents=-cost, reason=action)
        s.add(entry)
        s.flush()
        return Reservation(ledger_id=entry.id, user_id=user_id, action=action, cost_cents=cost)


def refund(reservation: Reservation) -> None:
    """Rend les Sparks d'une génération qui n'a rien produit."""
    with db.session() as s, s.begin():
        credit(s, reservation.user_id, reservation.cost_cents, "refund")


def confirm(reservation: Reservation, widget_id: str) -> None:
    """Rattache la dépense au widget produit (traçabilité dans le grand livre)."""
    with db.session() as s, s.begin():
        s.execute(update(SparkLedger).where(SparkLedger.id == reservation.ledger_id).values(widget_id=widget_id))


def balance(user_id: int) -> int:
    with db.session() as s:
        return s.scalar(select(User.sparks_cents).where(User.id == user_id)) or 0


def ledger(user_id: int, limit: int = 20) -> list[SparkLedger]:
    with db.session() as s:
        return list(
            s.scalars(
                select(SparkLedger).where(SparkLedger.user_id == user_id).order_by(SparkLedger.id.desc()).limit(limit)
            )
        )
