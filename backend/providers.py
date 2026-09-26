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
import itertools
from dataclasses import dataclass, field

import httpx

# Raisons de fin Gemini qui signifient « pas de document exploitable ».
_GEMINI_BLOCKED = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE", "OTHER"}
# Surcharge passagère du modèle (« high demand ») : une nouvelle tentative après un court délai.
_GEMINI_RETRY = {500, 503}
# Tourniquet des clés : chaque appel commence par la clé suivante (quota réparti entre les clés).
_rotation = itertools.count()


class GenerationError(Exception):
    """Échec d'un modèle : on peut tenter le suivant de la chaîne."""


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

    def key_order(self) -> list[str]:
        """Toutes les clés, en commençant par la suivante du tourniquet."""
        keys = self.keys
        start = next(_rotation) % len(keys) if keys else 0
        return keys[start:] + keys[:start]

    async def complete(self, client: httpx.AsyncClient, model: str, system: str, user: str, timeout: float,
                       *, json_mode: bool = False, schema: dict | None = None) -> str:
        """json_mode : réponse JSON (Gemini : responseMimeType, Groq : response_format) ;
        schema : schéma de réponse imposé à Gemini (sous-ensemble OpenAPI de responseSchema)."""
        call = _gemini if self.name == "gemini" else _groq
        return await call(self, client, model, system, user, timeout, json_mode, schema)


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
        raise GenerationError(f"{model}: délai dépassé") from exc
    except httpx.HTTPError as exc:
        raise GenerationError(f"{model}: erreur réseau ({exc.__class__.__name__})") from exc


async def _gemini_post(p: Provider, client: httpx.AsyncClient, model: str, payload: dict, timeout: float) -> httpx.Response:
    """Envoie la requête avec les clés à tour de rôle. Clé refusée ou quota atteint (429) : clé suivante ;
    surcharge passagère (500/503) : une nouvelle tentative après un court délai. Renvoie la première
    réponse exploitable (ou l'erreur d'un autre type, traitée par l'appelant)."""
    url = p.url.replace("{model}", model)
    refused, exhausted = [], []
    for index, key in enumerate(p.key_order(), 1):
        for attempt in range(2):
            # Clé dans un en-tête, jamais dans l'URL (qui finit dans les journaux).
            resp = await _post(client, model, url, json=payload, headers={"x-goog-api-key": key}, timeout=timeout)
            if resp.status_code not in _GEMINI_RETRY or attempt:
                break
            await asyncio.sleep(p.options.get("retry_delay", 2.0))
        if resp.status_code == 400 and "API_KEY_INVALID" in resp.text:
            refused.append(f"clé n°{index} refusée (API_KEY_INVALID)")
        elif resp.status_code in (401, 403):
            refused.append(f"clé n°{index} : accès refusé (HTTP {resp.status_code}) {_detail(resp)}")
        elif resp.status_code == 429:
            exhausted.append(f"clé n°{index}")
        else:
            return resp
    if exhausted:  # quota d'un modèle atteint sur toutes les clés : un autre modèle a peut-être le sien
        raise GenerationError(f"{model}: quota atteint (HTTP 429) — {', '.join(exhausted)}" + (f" ; {'; '.join(refused)}" if refused else ""))
    raise FatalGenerationError("Clé Gemini refusée : " + " ; ".join(refused) + ". Vérifiez GEMINI_API_KEY.")


async def _gemini(p: Provider, client: httpx.AsyncClient, model: str, system: str, user: str, timeout: float,
                  json_mode: bool = False, schema: dict | None = None) -> str:
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
