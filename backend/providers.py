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

from dataclasses import dataclass, field

import httpx

# Raisons de fin Gemini qui signifient « pas de document exploitable ».
_GEMINI_BLOCKED = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE", "OTHER"}


class GenerationError(Exception):
    """Échec d'un modèle : on peut tenter le suivant de la chaîne."""


class FatalGenerationError(Exception):
    """Échec qui ne dépend pas du modèle (clé refusée…) : inutile d'insister."""


@dataclass
class Provider:
    name: str  # "gemini" | "groq"
    api_key: str
    models: list[str]
    url: str
    options: dict = field(default_factory=dict)

    async def complete(self, client: httpx.AsyncClient, model: str, system: str, user: str, timeout: float) -> str:
        call = _gemini if self.name == "gemini" else _groq
        return await call(self, client, model, system, user, timeout)


def _detail(resp: httpx.Response) -> str:
    return resp.text[:300].replace("\n", " ")


async def _post(client: httpx.AsyncClient, model: str, url: str, **kwargs) -> httpx.Response:
    try:
        return await client.post(url, **kwargs)
    except httpx.TimeoutException as exc:
        raise GenerationError(f"{model}: délai dépassé") from exc
    except httpx.HTTPError as exc:
        raise GenerationError(f"{model}: erreur réseau ({exc.__class__.__name__})") from exc


async def _gemini(p: Provider, client: httpx.AsyncClient, model: str, system: str, user: str, timeout: float) -> str:
    payload = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": p.options.get("temperature", 0.6),
            # Les modèles « thinking » décomptent leur réflexion de ce plafond : il doit rester large.
            "maxOutputTokens": p.options.get("max_output_tokens", 32768),
        },
    }
    # Clé dans un en-tête, jamais dans l'URL (qui finit dans les journaux).
    resp = await _post(client, model, p.url.replace("{model}", model), json=payload,
                       headers={"x-goog-api-key": p.api_key}, timeout=timeout)
    if resp.status_code == 400 and "API_KEY_INVALID" in resp.text:
        raise FatalGenerationError("Clé Gemini refusée (API_KEY_INVALID). Vérifiez GEMINI_API_KEY.")
    if resp.status_code in (401, 403):
        raise FatalGenerationError(f"Accès Gemini refusé (HTTP {resp.status_code}) : {_detail(resp)}")
    if resp.status_code == 402:
        raise FatalGenerationError("Crédits Gemini épuisés (HTTP 402).")
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


async def _groq(p: Provider, client: httpx.AsyncClient, model: str, system: str, user: str, timeout: float) -> str:
    payload: dict = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": p.options.get("temperature", 0.5),
        "max_completion_tokens": p.options.get("max_completion_tokens", 6000),
    }
    if model.startswith(p.options.get("reasoning_models_prefix", "openai/gpt-oss")):
        payload["reasoning_effort"] = p.options.get("reasoning_effort", "medium")
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
