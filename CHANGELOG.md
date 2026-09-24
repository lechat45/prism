# Changelog

## 0.2.0 — 2026-09-24

Compatibilité GitHub Pages.

- `index.html` à la racine (redirection vers `frontend/`) et `.nojekyll` : le site s'affiche
  sur <https://lechat45.github.io/prism/> au lieu du README.
- Moteur navigateur (`frontend/engine/local.js`) utilisé quand aucun backend ne répond :
  mode démo, ou génération réelle avec la clé Groq de l'utilisateur (appel direct à api.groq.com,
  même chaîne de modèles et même validation que le backend).
- Réglages du moteur (badge en haut à droite) : clé en `sessionStorage` par défaut,
  `localStorage` sur option, chaîne de modèles personnalisable.
- Sources uniques partagées par les deux moteurs dans `frontend/engine/` : prompt système,
  gabarit utilisateur, réglages Groq, gabarits de démo et leur routage.
- `frontend/engine/sanitize.js` : portage JS du nettoyage/validation ; parité exacte avec Python
  vérifiée par `backend/tests/test_parity.py` sur `frontend/tests/fixtures.json`.
- Tests : 38 tests Python, 8 tests Node, E2E en mode serveur et en mode statique.

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
