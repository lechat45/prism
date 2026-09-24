# Changelog

## 0.1.0 — 2026-09-24

Premier MVP.

- Backend FastAPI : `POST /api/generate` (Groq, chaîne `openai/gpt-oss-120b` → `llama-3.3-70b-versatile`),
  `GET /api/health`, CORS, service du frontend, mode démo sans clé.
- Prompt système imposant un document HTML autonome, sans Markdown ni explication.
- Nettoyage et validation de la sortie LLM : blocs de code, prose, `<think>`, documents tronqués,
  réponses sans HTML, syntaxe JS vérifiée par Node ; corps de requête cp1252 (curl sous Windows) accepté.
- Frontend Vanilla JS « Liquid Glass » : saisie, exemples, rendu en iframe `sandbox="allow-scripts"`
  avec CSP sans réseau, statuts (attente, chargement, succès, erreur JS, échec), annulation,
  vue du code, copie, relance, plein écran.
- Logo pixel art généré par `tools/pixel_logo.py`.
- Tests : 31 tests unitaires/API, validation curl (`tools/check_generate.py`), E2E Chrome headless
  (`tools/e2e_sandbox.mjs`).
