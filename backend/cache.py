"""Bouclier API (V5, phase 1 · point 3) : une demande presque identique à une demande passée du même compte reçoit
le widget déjà généré, sans appel au modèle — et sans Sparks.

Similarité volontairement légère (pur Python, aucune dépendance) : chaque demande devient un vecteur creux de
trigrammes de caractères de ses mots normalisés (minuscules, sans accents), hachés de façon stable (crc32) ; deux
demandes se ressemblent si leur cosinus atteint SIMILARITY (0,90). Le cosinus seul confondrait « compteur jusqu'à
10 » et « compteur jusqu'à 100 » : il faut aussi les mêmes nombres, les mêmes mots porteurs (à une faute de frappe
près) et le même contexte (filtre ADN, contexte fantôme, sujets des widgets voisins).

Jamais de partage entre comptes (un widget est une création personnelle), jamais avec un fichier joint (les données
comptent), jamais pour une refactorisation ni une réponse de démonstration ; « Générer à nouveau » (fresh) passe outre.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, select

import db
from models import PromptCache

SIMILARITY = 0.90
DIMENSIONS = 4096  # vecteur haché : collisions rares pour des demandes de quelques phrases
KEEP = 200  # demandes gardées par compte (les plus récentes)

STOP = frozenset("""
a à au aux avec ce ces cet cette d de des du elle en et est il ils je l la le les leur lui ma mais me mes moi mon
ne nos notre nous on ou où par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous y
c s t m n j plus tres tout tous toute toutes bien comme dans entre sans chaque
cree creer crees fais faire fait genere generer genere-moi cree-moi fais-moi donne donne-moi montre montrer
affiche afficher permet permettre veux voudrais aimerais peux pourrais stp svp merci please
widget widgets application app appli petit petite simple nouveau nouvelle
the and for with from that this into your you are was were can will make create show build give me my our
i want would like could please new a an of to in on at by is it as or be some
""".split())

_WORD = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _plain(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


@dataclass(frozen=True)
class Features:
    vector: dict[int, float]  # indice → poids (norme 1)
    words: frozenset[str]  # mots porteurs (sans mots vides ni nombres)
    numbers: tuple[str, ...]  # nombres, dans l'ordre


def features(prompt: str) -> Features:
    tokens = _WORD.findall(_plain(prompt))
    numbers = tuple(t for t in tokens if t.isdigit())
    words = [t for t in tokens if not t.isdigit() and t not in STOP and len(t) > 1]
    counts: dict[int, float] = {}
    for word in words:
        padded = f" {word} "
        grams = [padded[i:i + 3] for i in range(len(padded) - 2)] or [padded]
        for gram in grams:
            key = zlib.crc32(gram.encode()) % DIMENSIONS
            counts[key] = counts.get(key, 0.0) + 1.0 / len(grams)  # chaque mot pèse autant, quelle que soit sa longueur
    for n in numbers:  # les nombres comptent aussi dans la forme (en plus d'être exigés à l'identique)
        key = zlib.crc32(f"#{n}".encode()) % DIMENSIONS
        counts[key] = counts.get(key, 0.0) + 1.0
    norm = math.sqrt(sum(v * v for v in counts.values())) or 1.0
    return Features({k: v / norm for k, v in counts.items()}, frozenset(words), numbers)


def cosine(a: dict[int, float], b: dict[int, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(k, 0.0) for k, v in a.items())


def _close(a: str, b: str) -> bool:
    """Même mot, à une faute de frappe près (distance d'édition ≤ 1, ou 2 pour un mot long)."""
    if a == b:
        return True
    limit = 2 if min(len(a), len(b)) > 6 else 1
    if abs(len(a) - len(b)) > limit:
        return False
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1] <= limit


def same_meaning(a: Features, b: Features) -> tuple[bool, float]:
    """(même demande ?, similarité) : cosinus ≥ SIMILARITY, mêmes nombres, mots porteurs appariés."""
    score = cosine(a.vector, b.vector)
    if score < SIMILARITY or a.numbers != b.numbers:
        return False, score
    for x, y in ((a.words, b.words), (b.words, a.words)):
        if any(not any(_close(w, v) for v in y) for w in x):
            return False, score
    return True, score


def context_key(dna: dict | None = None, ghost: list[str] | None = None, canvas: list[dict] | None = None) -> str:
    """Empreinte de ce qui, en plus de la demande, façonne le widget (même contexte exigé)."""
    blob = json.dumps({"dna": dna or None, "ghost": sorted(ghost or []), "canvas": canvas or []}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


@dataclass(frozen=True)
class Hit:
    id: int
    html: str
    mode: str
    model: str
    prompt: str
    similarity: float
    created_at: datetime


def lookup(user_id: int, prompt: str, context: str) -> Hit | None:
    """Widget déjà généré pour une demande équivalente de ce compte, dans le même contexte (le plus proche)."""
    wanted = features(prompt)
    if not wanted.words and not wanted.numbers:
        return None
    best: Hit | None = None
    with db.session() as s:
        rows = s.scalars(select(PromptCache).where(PromptCache.user_id == user_id, PromptCache.context == context)
                         .order_by(PromptCache.created_at.desc()).limit(KEEP)).all()
        for row in rows:
            stored = Features({int(k): v for k, v in json.loads(row.vector_json).items()}, frozenset(json.loads(row.words_json)),
                              tuple(json.loads(row.numbers_json)))
            ok, score = same_meaning(wanted, stored)
            if ok and (best is None or score > best.similarity):
                best = Hit(row.id, row.html, row.mode, row.model, row.prompt, score, row.created_at)
    return best


def remember(user_id: int, prompt: str, context: str, html: str, mode: str, model: str) -> None:
    """Garde un widget réellement généré (jamais une démo) ; KEEP demandes au plus par compte."""
    if mode == "mock":
        return
    f = features(prompt)
    if not f.words and not f.numbers:
        return
    with db.session() as s, s.begin():
        s.add(PromptCache(user_id=user_id, context=context, prompt=prompt[:2000], html=html, mode=mode, model=model,
                          vector_json=json.dumps({str(k): round(v, 5) for k, v in f.vector.items()}),
                          words_json=json.dumps(sorted(f.words)), numbers_json=json.dumps(list(f.numbers))))
        s.flush()
        old = s.scalars(select(PromptCache.id).where(PromptCache.user_id == user_id)
                        .order_by(PromptCache.created_at.desc(), PromptCache.id.desc()).offset(KEEP)).all()
        if old:
            s.execute(delete(PromptCache).where(PromptCache.id.in_(old)))


def served(entry_id: int) -> None:
    """Compteur d'usages (statistique : appels au modèle évités)."""
    with db.session() as s, s.begin():
        row = s.get(PromptCache, entry_id)
        if row:
            row.hits += 1
            row.last_hit_at = datetime.now(UTC)
