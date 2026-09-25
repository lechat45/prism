"""Mots de passe (scrypt, bibliothèque standard) et jetons d'accès (JWT HS256).

Jeton Bearer plutôt que cookie : le frontend peut être servi ailleurs que l'API
(GitHub Pages → API hébergée), cas où les cookies tiers sont bloqués par les navigateurs.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt

log = logging.getLogger("prism.security")

# scrypt : ~16 Mo de mémoire par calcul, coûteux pour une attaque par force brute.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1
TOKEN_TTL = timedelta(hours=float(os.getenv("PRISM_TOKEN_TTL_HOURS", "168")))  # 7 jours
ISSUER = "prism"
SECRET_FILE = Path(__file__).resolve().parent.parent / "data" / "jwt_secret"


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# Empreinte factice : un e-mail inconnu coûte autant qu'un vrai compte (pas d'énumération au chronomètre).
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def _load_secret() -> str:
    env = os.getenv("PRISM_JWT_SECRET", "").strip()
    if env:
        return env
    # Développement : secret aléatoire persistant (les sessions survivent aux redémarrages).
    # En production, définir PRISM_JWT_SECRET.
    try:
        if SECRET_FILE.is_file():
            return SECRET_FILE.read_text(encoding="utf-8").strip()
        SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
        value = secrets.token_urlsafe(64)
        SECRET_FILE.write_text(value, encoding="utf-8")
        log.warning("PRISM_JWT_SECRET absent : secret de développement créé dans %s", SECRET_FILE)
        return value
    except OSError:
        log.warning("PRISM_JWT_SECRET absent et secret non persistable : sessions perdues au redémarrage")
        return secrets.token_urlsafe(64)


_SECRET: str | None = None


def secret() -> str:
    global _SECRET
    if _SECRET is None:
        _SECRET = _load_secret()
    return _SECRET


def create_token(user_id: int, token_version: int, now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    claims = {"sub": str(user_id), "ver": token_version, "iss": ISSUER, "iat": now, "exp": now + TOKEN_TTL}
    return jwt.encode(claims, secret(), algorithm="HS256")


class InvalidToken(Exception):
    pass


def decode_token(token: str) -> dict:
    try:
        # algorithms explicite : refuse « none » et toute confusion d'algorithme.
        claims = jwt.decode(
            token, secret(), algorithms=["HS256"], issuer=ISSUER, options={"require": ["sub", "exp", "iat", "ver"]}
        )
        claims["sub"] = int(claims["sub"])
        return claims
    except (jwt.PyJWTError, ValueError) as exc:
        raise InvalidToken(str(exc)) from exc
