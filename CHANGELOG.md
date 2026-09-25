# Changelog

## 3.0.0-alpha.1 — 2026-09-25 (phase 1 : backend)

Socle SaaS côté serveur. **Le frontend n'est pas encore adapté** (phase 2) : en mode serveur,
la génération répond désormais 401 tant qu'on n'est pas connecté. Le site GitHub Pages
(moteur navigateur, sans compte) n'est pas concerné.

- **Base de données** : SQLAlchemy 2 + SQLite (`data/prism.db`), PostgreSQL possible via
  `PRISM_DATABASE_URL`. Tables `users`, `widgets`, `spark_ledger`.
- **Comptes** (`/api/auth/register`, `/login`, `/me`) : mots de passe en scrypt (bibliothèque
  standard, sel aléatoire), jetons JWT HS256 (Bearer, 7 jours, révocables par `token_version`),
  e-mails normalisés, anti-force brute (10 échecs / 15 min par IP + e-mail), inscriptions limitées
  par IP, temps de réponse identique pour un compte inexistant.
- **Prism Sparks** : 50 à l'inscription ; génération 1 Spark, refactorisation 0,5 Spark. Coût
  réservé atomiquement avant l'appel au modèle, remboursé en cas d'échec : des générations
  parallèles ne peuvent pas dépasser le solde (contrainte CHECK en dernier rempart). Grand livre
  de tous les mouvements ; `GET /api/sparks`. Solde insuffisant : **403** `insufficient_sparks`,
  sans appel au modèle.
- **Mon Hub (API)** : chaque génération est enregistrée ; `GET/PATCH/DELETE /api/widgets[/id]`,
  `POST /api/widgets/{id}/undo`. Disposition, état du widget, couleur, miniature et données du
  fichier joint synchronisables. Les widgets d'un autre compte répondent 404.
- **Refactorisation** : la requête désigne un `widget_id` ; le serveur part de sa copie du code
  (plus de `base_html` envoyé par le client) et garde les 5 versions précédentes.
- CORS : en-tête `Authorization` et méthodes `PATCH`/`DELETE` autorisés.
- Tests : 71 tests Python (comptes, jetons falsifiés/expirés/`alg: none`, Sparks, concurrence,
  cloisonnement des widgets).

## 2.0.0 — 2026-09-24

Prism devient un canvas spatial multi-widgets.

- **Canvas infini** : chaque demande crée une carte ; pan, zoom (Ctrl + molette, pincement, boutons),
  « Tout voir », « Ranger » ; cartes déplaçables, redimensionnables, fermables avec « Rétablir »,
  pilotables au clavier ; générations en parallèle, annulables.
- **Import de fichiers** CSV/JSON/TXT par glisser-déposer, trombone ou collage (5 Mo max) : analyse dans
  le navigateur (séparateur, types, formats français), résumé de structure envoyé au modèle, données
  complètes injectées dans le widget (`window.PRISM_FILE`). Nouveaux gabarits de démo : graphique CSV,
  explorateur JSON, analyse de texte.
- **Persistance** : cartes en IndexedDB ; `localStorage` persistant par widget, fourni par la sandbox
  (sans `allow-same-origin`). Le prompt système impose de l'utiliser pour tout état modifiable.
- **Inspecteur** : refactorisation d'une carte seule (données conservées, annulation), couleur d'accent
  à chaud (`--accent` imposé par le prompt), copie du code complet, téléchargement d'un `.html` autonome.
- **Chart.js** 4.5.1 via jsDelivr, épinglé (SRI) : toute balise Chart.js écrite par le modèle est remplacée
  par la version épinglée ; la CSP n'autorise que ce fichier.
- **Liquid Glass v2** : dégradés fluides animés, grain de verre dépoli, grille du canvas, animations
  d'apparition, micro-interactions, barres de défilement des cartes masquées.
- API : `POST /api/generate` accepte `file` (résumé) et `base_html` (refactorisation) ; 409 en mode démo
  pour une refactorisation. `GROQ_URL` surchargeable pour les tests.
- Frontend réécrit en modules ES (`frontend/js/`).
- Serveur sous Windows : boucle d'évènements « selector » au lieu de Proactor (avec Python 3.14, des
  réponses complètes côté serveur n'arrivaient parfois jamais au navigateur).
- Tests : 45 tests Python (parité Python ↔ JS étendue), 29 tests Node, E2E Chrome headless en trois modes
  (serveur, statique, faux Groq avec refactorisation).

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
