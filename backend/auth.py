"""Comptes : inscription, connexion, profil, et dépendance `current_user` pour les routes protégées."""
from __future__ import annotations

import re
import threading
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import billing
import security
from db import get_session
from models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer = HTTPBearer(auto_error=False)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# --------------------------------------------------------------------------- #
# Limitation de débit (mémoire du processus : suffisant pour un seul serveur ;
# à remplacer par Redis ou équivalent en multi-instances).
# --------------------------------------------------------------------------- #
class RateLimiter:
    def __init__(self, limit: int, window_s: float):
        self.limit = limit
        self.window = window_s
        self.hits: dict[str, deque[float]] = defaultdict(deque)
        self.lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float]:
        hits = self.hits[key]
        while hits and now - hits[0] > self.window:
            hits.popleft()
        return hits

    def blocked(self, key: str) -> bool:
        with self.lock:
            return len(self._prune(key, time.monotonic())) >= self.limit

    def hit(self, key: str) -> None:
        with self.lock:
            now = time.monotonic()
            self._prune(key, now).append(now)

    def reset(self, key: str | None = None) -> None:
        with self.lock:
            if key is None:
                self.hits.clear()
            else:
                self.hits.pop(key, None)


login_failures = RateLimiter(limit=10, window_s=15 * 60)  # par adresse IP + e-mail
registrations = RateLimiter(limit=10, window_s=60 * 60)  # par adresse IP


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "inconnue"


def too_many(message: str) -> HTTPException:
    return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail={"code": "rate_limited", "message": message})


# --------------------------------------------------------------------------- #
# Schémas
# --------------------------------------------------------------------------- #
class Credentials(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not EMAIL_RE.match(value):
            raise ValueError("adresse e-mail invalide")
        return value


class UserOut(BaseModel):
    id: int
    email: str
    sparks: float
    plan: str

    @classmethod
    def of(cls, user: User) -> UserOut:
        return cls(id=user.id, email=user.email, sparks=user.sparks, plan=user.plan)


class Session_(BaseModel):
    token: str
    token_type: str = "bearer"
    user: UserOut


# --------------------------------------------------------------------------- #
# Dépendance d'authentification
# --------------------------------------------------------------------------- #
def unauthorized(message: str) -> HTTPException:
    return HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        detail={"code": "auth_required", "message": message},
        headers={"WWW-Authenticate": "Bearer"},
    )


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    s: Session = Depends(get_session),
) -> User:
    if creds is None:
        raise unauthorized("Connexion requise.")
    try:
        claims = security.decode_token(creds.credentials)
    except security.InvalidToken as exc:
        raise unauthorized("Session invalide ou expirée : reconnectez-vous.") from exc
    user = s.get(User, claims["sub"])
    if user is None or claims["ver"] != user.token_version:
        raise unauthorized("Session révoquée : reconnectez-vous.")
    return user


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.post("/register", response_model=Session_, status_code=status.HTTP_201_CREATED)
def register(body: Credentials, request: Request, s: Session = Depends(get_session)) -> Session_:
    ip = client_ip(request)
    if registrations.blocked(ip):
        raise too_many("Trop d'inscriptions depuis cette adresse : réessayez plus tard.")
    registrations.hit(ip)
    user = User(email=body.email, password_hash=security.hash_password(body.password), sparks_cents=0)
    s.add(user)
    try:
        s.flush()
    except IntegrityError as exc:
        s.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail={"code": "email_taken", "message": "Un compte existe déjà avec cet e-mail."}
        ) from exc
    billing.credit(s, user.id, billing.SIGNUP_BONUS, "signup_bonus")
    s.commit()
    s.refresh(user)
    return Session_(token=security.create_token(user.id, user.token_version), user=UserOut.of(user))


@router.post("/login", response_model=Session_)
def login(body: Credentials, request: Request, s: Session = Depends(get_session)) -> Session_:
    key = f"{client_ip(request)}|{body.email}"
    if login_failures.blocked(key):
        raise too_many("Trop de tentatives : réessayez dans quelques minutes.")
    user = s.scalar(select(User).where(User.email == body.email))
    ok = security.verify_password(body.password, user.password_hash if user else security.DUMMY_HASH)
    if not (user and ok):
        login_failures.hit(key)
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail={"code": "bad_credentials", "message": "E-mail ou mot de passe incorrect."},
        )
    login_failures.reset(key)
    return Session_(token=security.create_token(user.id, user.token_version), user=UserOut.of(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)) -> UserOut:
    return UserOut.of(user)
