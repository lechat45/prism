"""Fournisseurs de modèles, appelés en HTTP asynchrone (httpx) : la boucle d'évènements n'est jamais bloquée.

- Gemini (principal) : API REST officielle `generateContent` — celle qu'enveloppent les SDK Google.
  Le paquet `google-generativeai` est abandonné depuis le 30/11/2025 ; l'appeler directement évite une
  dépendance et garde le même code côté navigateur (moteur de GitHub Pages).
- Groq (secours facultatif) : API compatible OpenAI, utilisée seulement si GROQ_API_KEY est définie.

Chaque fonction renvoie le texte brut du modèle, ou lève :
  GenerationError       → essayer le modèle ou le fournisseur suivant ;
  FatalGenerationError  → clé refusée, crédits épuisés… : inutile d'insister.
"""
from __future__ import annotations

import asyncio
import contextlib
import re
import time
from dataclasses import dataclass, field

import httpx

# Raisons de fin Gemini qui signifient « pas de document exploitable ».
_GEMINI_BLOCKED = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE", "OTHER"}
# Surcharge passagère du modèle (« high demand ») : une autre clé prend le relais, puis une nouvelle tentative.
_GEMINI_RETRY = {500, 503}
# Quota nul (modèle non ouvert à cette clé) ou quota du jour épuisé : inutile de réessayer avant longtemps.
_LONG_QUOTA = re.compile(r"limit: 0\b|PerDay")


class KeyPool:
    """Répartition des appels entre les clés Gemini, pour tout le serveur : aucune clé ne porte seule la charge.

    Ordre d'essai d'un appel : les clés disponibles avant celles en pause, puis la moins occupée (appels en
    cours : un Engramme garde sa clé près d'une minute, l'Engramme suivant part donc sur une autre), puis
    celle qui a servi le moins récemment (tourniquet). Une clé au quota (429) se met en pause une minute, une
    clé surchargée (500/503) vingt secondes : les appels suivants passent par les autres. État en mémoire
    seulement ; les clés n'apparaissent jamais dans les messages ni dans /api/health (seulement leur nombre).

    V6.3 : les quotas de Google sont comptés par modèle ; une pause vise donc le couple (clé, modèle), et chaque
    clé garde ses autres modèles (3 clés × 11 modèles = 33 quotas indépendants). Un quota nul (« limit: 0 » :
    modèle non ouvert à cette clé, comme les modèles Pro sur l'offre gratuite) ou journalier épuisé met ce
    couple en pause une heure. Une pause sans modèle vise toute la clé."""

    # Quota : une minute ; surcharge (« high demand ») ou lenteur (délai dépassé, 408) : quarante-cinq secondes, le temps
    # que les autres modèles de la chaîne servent à sa place.
    PAUSE = {429: 60.0, 500: 45.0, 503: 45.0, 408: 45.0}
    LONG_PAUSE = 3600.0

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.clear()

    def clear(self) -> None:
        self.busy: dict[str, int] = {}
        self.last: dict[str, int] = {}  # rang du dernier départ (compteur : l'horloge est trop grossière sous Windows)
        self.seq = 0
        self.paused: dict[tuple[str, str | None], float] = {}  # (clé, modèle) ; modèle None : toute la clé
        self.served: dict[str, int] = {}

    def paused_until(self, key: str, model: str | None = None) -> float:
        return max(self.paused.get((key, None), 0.0), self.paused.get((key, model), 0.0) if model else 0.0)

    def order(self, keys: list[str], model: str | None = None) -> list[str]:
        now = self.clock()
        return sorted(keys, key=lambda k: (self.paused_until(k, model) > now, self.busy.get(k, 0), self.last.get(k, float("-inf"))))

    @contextlib.contextmanager
    def using(self, key: str):
        self.busy[key] = self.busy.get(key, 0) + 1
        self.seq += 1
        self.last[key] = self.seq
        self.served[key] = self.served.get(key, 0) + 1
        try:
            yield
        finally:
            self.busy[key] -= 1

    def pause(self, key: str, status: int, model: str | None = None, long: bool = False) -> None:
        self.paused[(key, model)] = self.clock() + (self.LONG_PAUSE if long else self.PAUSE.get(status, 20.0))

    def stats(self, keys: list[str], models: list[str]) -> dict:
        """Capacité : couples (clé, modèle) disponibles ou en pause (jamais les clés elles-mêmes)."""
        now = self.clock()
        pairs = [(k, m) for k in keys for m in models]
        return {"pairs": len(pairs), "paused": sum(1 for k, m in pairs if self.paused_until(k, m) > now)}


KEYS = KeyPool()


class GenerationError(Exception):
    """Échec d'un modèle : on peut tenter le suivant de la chaîne."""


class ModelTimeout(GenerationError):
    """Le modèle n'a pas répondu dans le délai : il se repose sur cette clé, le suivant prend le relais."""


class FatalGenerationError(Exception):
    """Échec qui ne dépend pas du modèle (clé refusée…) : inutile d'insister."""


class SchemaRejected(GenerationError):
    """Le modèle refuse le schéma de réponse (HTTP 400) : réessayer en JSON simple."""


@dataclass
class Provider:
    name: str  # "gemini" | "groq"
    api_key: str  # une clé, ou plusieurs séparées par des virgules (Gemini : relais sur quota ou refus)
    models: list[str]
    url: str
    options: dict = field(default_factory=dict)

    @property
    def keys(self) -> list[str]:
        return [k.strip() for k in self.api_key.split(",") if k.strip()]

    def key_order(self, model: str | None = None) -> list[str]:
        """Toutes les clés, dans l'ordre d'essai de la répartition pour ce modèle (cf. KeyPool)."""
        return KEYS.order(self.keys, model)

    def only(self, models: list[str]) -> "Provider":
        """Le même fournisseur, restreint à une chaîne de modèles (rôle d'une tâche, voix d'un Conseil)."""
        return Provider(self.name, self.api_key, list(models), self.url, self.options)

    async def complete(self, client: httpx.AsyncClient, model: str, system: str, user: str, timeout: float,
                       *, json_mode: bool = False, schema: dict | None = None, thinking: str | None = None) -> str:
        """json_mode : réponse JSON (Gemini : responseMimeType, Groq : response_format) ;
        schema : schéma de réponse imposé à Gemini (sous-ensemble OpenAPI de responseSchema) ;
        thinking : niveau de réflexion Gemini (« high » : mode profond), ignoré par Groq et par les modèles qui le refusent."""
        if self.name == "gemini":
            return await _gemini(self, client, model, system, user, timeout, json_mode, schema, thinking)
        return await _groq(self, client, model, system, user, timeout, json_mode, schema)


def _detail(resp: httpx.Response) -> str:
    """Message d'erreur du fournisseur (champ error.message du JSON s'il existe), sur une ligne."""
    try:
        message = resp.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        message = resp.text
    return " ".join(str(message).split())[:300]


async def _post(client: httpx.AsyncClient, model: str, url: str, **kwargs) -> httpx.Response:
    try:
        return await client.post(url, **kwargs)
    except httpx.TimeoutException as exc:
        raise ModelTimeout(f"{model}: délai dépassé") from exc
    except httpx.HTTPError as exc:
        raise GenerationError(f"{model}: erreur réseau ({exc.__class__.__name__})") from exc


async def _gemini_post(p: Provider, client: httpx.AsyncClient, model: str, payload: dict, timeout: float) -> httpx.Response:
    """Envoie la requête avec les clés, dans l'ordre de la répartition (KeyPool). Clé refusée, quota atteint
    (429) ou surcharge passagère (500/503) : la clé suivante prend le relais aussitôt ; si toutes sont
    surchargées, une nouvelle tentative après un court délai. Renvoie la première réponse exploitable (ou
    l'erreur d'un autre type, traitée par l'appelant)."""
    url = p.url.replace("{model}", model)
    keys = p.keys
    refused, exhausted, overloaded = [], [], []

    async def send(key: str) -> httpx.Response:
        with KEYS.using(key):
            # Clé dans un en-tête, jamais dans l'URL (qui finit dans les journaux).
            return await _post(client, model, url, json=payload, headers={"x-goog-api-key": key}, timeout=timeout)

    order = p.key_order(model)
    now = KEYS.clock()
    if order and all(KEYS.paused_until(k, model) > now for k in order):
        # Ce modèle se repose sur toutes les clés (quota, surcharge récente) : le suivant de la chaîne, sans attendre.
        raise GenerationError(f"{model}: en pause sur toutes les clés (quota ou surcharge récents)")
    for key in order:
        index = keys.index(key) + 1
        try:
            resp = await send(key)
        except ModelTimeout:
            # Trop lent en ce moment (la demande est mondiale, pas propre à une clé) : ce modèle se repose sur toutes les
            # clés, les appels suivants passent aussitôt par d'autres modèles.
            for other in keys:
                KEYS.pause(other, 408, model)
            raise
        if resp.status_code == 400 and "API_KEY_INVALID" in resp.text:
            refused.append(f"clé n°{index} refusée (API_KEY_INVALID)")
        elif resp.status_code in (401, 403):
            refused.append(f"clé n°{index} : accès refusé (HTTP {resp.status_code}) {_detail(resp)}")
        elif resp.status_code == 429:
            # Quota nul (modèle non ouvert à cette clé) ou journalier : ce couple (clé, modèle) se repose une heure.
            KEYS.pause(key, 429, model, long=bool(_LONG_QUOTA.search(resp.text)))
            exhausted.append(f"clé n°{index}")
        elif resp.status_code in _GEMINI_RETRY:
            KEYS.pause(key, resp.status_code, model)
            overloaded.append(key)
        else:
            return resp
    if overloaded:  # surcharge sur chaque clé encore valable : une dernière tentative, sur la moins occupée
        await asyncio.sleep(p.options.get("retry_delay", 2.0))
        return await send(KEYS.order(overloaded, model)[0])
    if exhausted:  # quota d'un modèle atteint sur toutes les clés : un autre modèle a peut-être le sien
        raise GenerationError(f"{model}: quota atteint (HTTP 429) — {', '.join(exhausted)}" + (f" ; {'; '.join(refused)}" if refused else ""))
    raise FatalGenerationError("Clé Gemini refusée : " + " ; ".join(refused) + ". Vérifiez GEMINI_API_KEY.")


async def _gemini(p: Provider, client: httpx.AsyncClient, model: str, system: str, user: str, timeout: float,
                  json_mode: bool = False, schema: dict | None = None, thinking: str | None = None) -> str:
    payload = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": p.options.get("temperature", 0.6),
            # Les modèles « thinking » décomptent leur réflexion de ce plafond : il doit rester large.
            "maxOutputTokens": p.options.get("max_output_tokens", 32768),
        },
    }
    if json_mode or schema:
        payload["generationConfig"]["responseMimeType"] = "application/json"
    if schema:
        payload["generationConfig"]["responseSchema"] = schema
    if thinking:
        payload["generationConfig"]["thinkingConfig"] = {"thinkingLevel": thinking}
    resp = await _gemini_post(p, client, model, payload, timeout)
    if thinking and resp.status_code == 400 and "hinking" in resp.text:
        # Niveau de réflexion refusé par ce modèle : la même demande, à sa réflexion par défaut.
        del payload["generationConfig"]["thinkingConfig"]
        resp = await _gemini_post(p, client, model, payload, timeout)
    if resp.status_code == 402:
        raise FatalGenerationError("Crédits Gemini épuisés (HTTP 402).")
    if resp.status_code == 400 and schema:
        raise SchemaRejected(f"{model}: schéma de réponse refusé — {_detail(resp)}")
    if resp.status_code >= 400:  # 404 modèle inconnu, 429 quota, 5xx : modèle suivant
        raise GenerationError(f"{model}: HTTP {resp.status_code} — {_detail(resp)}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise GenerationError(f"{model}: réponse illisible") from exc
    blocked = (data.get("promptFeedback") or {}).get("blockReason")
    if blocked:
        raise GenerationError(f"{model}: demande bloquée ({blocked})")
    candidates = data.get("candidates") or []
    if not candidates:
        raise GenerationError(f"{model}: aucune réponse")
    candidate = candidates[0]
    finish = candidate.get("finishReason")
    if finish == "MAX_TOKENS":
        raise GenerationError(f"{model}: réponse tronquée (maxOutputTokens={p.options.get('max_output_tokens')})")
    if finish in _GEMINI_BLOCKED:
        raise GenerationError(f"{model}: réponse interrompue ({finish})")
    parts = (candidate.get("content") or {}).get("parts") or []
    # Les parties « thought » sont la réflexion du modèle, pas le document.
    return "".join(part.get("text", "") for part in parts if not part.get("thought"))


async def _groq(p: Provider, client: httpx.AsyncClient, model: str, system: str, user: str, timeout: float,
                json_mode: bool = False, schema: dict | None = None) -> str:
    payload: dict = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": p.options.get("temperature", 0.5),
        "max_completion_tokens": p.options.get("max_completion_tokens", 6000),
    }
    if model.startswith(p.options.get("reasoning_models_prefix", "openai/gpt-oss")):
        payload["reasoning_effort"] = p.options.get("reasoning_effort", "medium")
    if json_mode or schema:  # schéma décrit dans le prompt ; Groq garantit seulement un objet JSON
        payload["response_format"] = {"type": "json_object"}
    resp = await _post(client, model, p.url, json=payload,
                       headers={"Authorization": f"Bearer {p.api_key}"}, timeout=timeout)
    if resp.status_code == 401:
        raise FatalGenerationError("Clé Groq refusée (401). Vérifiez GROQ_API_KEY.")
    if resp.status_code >= 400:
        raise GenerationError(f"{model}: HTTP {resp.status_code} — {_detail(resp)}")
    try:
        choice = resp.json()["choices"][0]
        raw = choice.get("message", {}).get("content") or ""
    except (ValueError, KeyError, IndexError, AttributeError) as exc:
        raise GenerationError(f"{model}: réponse Groq illisible") from exc
    if choice.get("finish_reason") == "length":
        raise GenerationError(f"{model}: réponse tronquée (max_completion_tokens={payload['max_completion_tokens']})")
    return raw
