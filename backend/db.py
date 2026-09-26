"""Base de données : SQLAlchemy 2, SQLite par défaut.

Pour un déploiement, il suffit de pointer PRISM_DATABASE_URL vers PostgreSQL
(ex. postgresql+psycopg://…) : le code n'utilise que des types et requêtes portables.
Configuration paresseuse : rien n'est créé à l'import (les tests choisissent leur base).
"""
from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DEFAULT_URL = f"sqlite:///{(Path(__file__).resolve().parent.parent / 'data' / 'prism.db').as_posix()}"


class Base(DeclarativeBase):
    pass


SessionLocal = sessionmaker(autoflush=False, expire_on_commit=False)
_engine: Engine | None = None


def configure(url: str | None = None) -> Engine:
    """(Re)crée le moteur et les tables. Idempotent pour une même URL."""
    global _engine
    url = url or os.getenv("PRISM_DATABASE_URL") or DEFAULT_URL
    kwargs: dict = {}
    if url.startswith("sqlite"):
        path = url.removeprefix("sqlite:///")
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # Les routes synchrones de FastAPI tournent dans un pool de threads.
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")  # suppression en cascade des widgets
            cur.execute("PRAGMA journal_mode=WAL")  # lectures concurrentes pendant les écritures
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()

    import models  # noqa: F401 — enregistre les tables sur Base.metadata

    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    if _engine is not None:
        _engine.dispose()
    _engine = engine
    SessionLocal.configure(bind=engine)
    return engine


def _add_missing_columns(engine: Engine) -> None:
    """Mini-migration : create_all ne modifie pas une table existante ; on y ajoute les colonnes
    nullables apparues depuis (ex. widgets.file_data_json en v3 phase 3). Rien n'est jamais supprimé."""
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name not in existing and column.nullable:
                    kind = column.type.compile(engine.dialect)
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {kind}'))


def engine() -> Engine:
    return _engine or configure()


def session() -> Session:
    engine()
    return SessionLocal()


def get_session() -> Iterator[Session]:
    """Dépendance FastAPI : une session par requête."""
    with session() as s:
        yield s
