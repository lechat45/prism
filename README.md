# Prism

Générateur d'interfaces éphémères (Generative UI) sur un **canvas spatial** : chaque demande en
langage naturel, ou chaque fichier CSV/JSON/TXT déposé, devient une micro-application interactive
dans une carte que l'on déplace, redimensionne, refactorise, recolore et exporte.

**En ligne : <https://lechat45.github.io/prism/>**

![Logo Prism](frontend/assets/prism-logo.png)

## Fonctionnalités

| | |
| --- | --- |
| **Canvas infini** | pan (glisser le fond, molette), zoom (Ctrl + molette, pincement, boutons), « Tout voir », « Ranger » ; cartes déplaçables, redimensionnables, fermables (avec « Rétablir »), pilotables au clavier |
| **Générations parallèles** | chaque demande crée sa carte immédiatement ; plusieurs widgets se génèrent en même temps, chacun annulable |
| **Gemini** | modèles `gemini-3.8-flash` puis `gemini-3.6-flash` (secours automatique) ; Groq en secours facultatif côté serveur |
| **Design system Tailwind** | le modèle n'écrit que des classes Tailwind CSS (mode sombre `bg-gray-900`, verre `bg-white/10 backdrop-blur-md`, `rounded-2xl`, ombres douces) ; Prism remplace tout CDN Tailwind par la version épinglée `@tailwindcss/browser@4.3.3` avec empreinte SRI |
| **Import de fichiers** | glisser-déposer (ou trombone, ou collage) d'un CSV, JSON ou TXT jusqu'à 5 Mo, analysé **dans un Web Worker** (séparateur, types de colonnes, formats français) ; seul un résumé de sa structure part au modèle, les données complètes sont remises au widget (`window.PRISM_FILE`) |
| **Persistance** | les cartes (position, taille, code, fichier) sont sauvées en IndexedDB ; chaque widget dispose d'un `localStorage` persistant qui survit au rechargement (cases cochées, compteurs, saisies…) |
| **Inspecteur** | clic sur une carte : refactorisation de cette carte seule (avec annulation), couleur d'accent à chaud, copie du code complet, téléchargement d'un `.html` autonome, code source, relance, effacement des données |
| **Graphiques** | Chart.js 4.5.1 via jsDelivr, épinglé avec empreinte SRI ; toute autre ressource externe reste bloquée |
| **Liquid Glass** | aurore sous le verre dépoli, squelette holographique pendant la génération, fondu enchaîné vers le widget une fois prêt, micro-interactions |

## Deux façons de l'utiliser

| | GitHub Pages (statique) | Serveur Python local |
| --- | --- | --- |
| Adresse | <https://lechat45.github.io/prism/> | <http://127.0.0.1:8000> |
| Sans clé Gemini | widgets de démonstration | widgets de démonstration |
| Avec une clé Gemini | la vôtre, via le badge du moteur (en haut à droite), appel direct navigateur → `generativelanguage.googleapis.com` | `GEMINI_API_KEY` dans `backend/.env` (+ compte Prism, cf. v3) |
| Refactorisation | avec une clé | avec une clé |

Le frontend choisit tout seul : il interroge `GET /api/health` et, faute de backend (ou sur `*.github.io`),
passe au moteur navigateur. Les deux moteurs partagent **les mêmes fichiers** (`frontend/engine/`) :
prompts, gabarits de démo, réglages Gemini, bibliothèques autorisées. Leur parité est vérifiée par les tests.

### Serveur local

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt   # macOS/Linux : .venv/bin/python
cp backend/.env.example backend/.env                               # facultatif : GEMINI_API_KEY=AIza…
.venv/Scripts/python backend/app.py
```

Pas de SDK Google : le backend appelle l'API REST `generateContent` directement, en asynchrone
(`httpx`). Le paquet `google-generativeai` n'est plus maintenu depuis le 30 novembre 2025, et un appel
REST garde le serveur non bloquant sans dépendance de plus.

### Clé Gemini dans le navigateur (GitHub Pages)

Créez une clé gratuite sur <https://aistudio.google.com/apikey>, cliquez sur le badge « Démo · ajouter une clé ».
La clé est gardée dans le navigateur (en `sessionStorage` par défaut, oubliée à la fermeture de l'onglet ;
en `localStorage` si « Mémoriser » est coché) et n'est envoyée qu'à `generativelanguage.googleapis.com`,
dans l'en-tête `x-goog-api-key` (jamais dans l'URL).
Toutes les pages `lechat45.github.io/*` partagent la même origine, donc le même stockage : ne cochez
« Mémoriser » que sur un appareil personnel.

## Sécurité des widgets

Le code généré est non fiable par principe. Chaque widget tourne dans
`<iframe sandbox="allow-scripts">` **sans** `allow-same-origin` : origine opaque, aucun accès à Prism,
à la clé Gemini ni à son stockage. Ce qu'il lui faut est injecté dans son document (`frontend/js/sandbox.js`) :

| Couche | Effet |
| --- | --- |
| CSP `default-src 'none'` + `script-src` limité aux fichiers Tailwind et Chart.js épinglés | aucune requête réseau (pas d'exfiltration) ; bibliothèques vérifiées par SRI |
| `localStorage` fourni par Prism | persistant **et** isolé : chaque écriture est envoyée à la page par `postMessage`, validée (≤ 1 Mo, chaînes uniquement) et rangée avec la carte. Un vrai `localStorage` aurait exigé `allow-same-origin`, qui rend la sandbox contournable |
| `window.PRISM_FILE` | données du fichier joint : un Blob JSON remis par un chargeur minimal (même CSP), lu et parsé dans le processus du widget ; une seule livraison, au seul demandeur |
| Prélude | remonte les erreurs JS (statut de la carte), relaie Ctrl + molette vers le canvas, applique l'accent à chaud |
| Messages entrants | Prism n'accepte que ceux de ses propres iframes, et les valide |

## Performance (v3.5 « Velocity »)

Mesurée avec `tools/perf_probe.mjs` (Chrome headless via CDP, 3 widgets sur le canvas, puis un CSV de 5 Mo) :

| | v3.0 | v3.5 |
| --- | --- | --- |
| Canvas au repos | 31–35 images/s | 60 images/s |
| Dépôt d'un CSV de 5 Mo : blocage du fil principal | 4,5 à 15 s | 0 ms |
| Génération du widget de ce CSV : plus long blocage de la page | 1 à 1,6 s | ~0,12 s |
| Génération du widget de ce CSV : durée totale (mode démo) | 2,3–2,6 s | 1,3–1,4 s |

Machine de mesure : 2 cœurs, souvent saturée ; les chiffres absolus varient, les écarts restent.

- **Web Worker** (`js/worker.js`, `js/tasks.js`) : analyse des fichiers et moteur navigateur (appel Gemini,
  nettoyage et validation du code reçu) tournent hors du fil principal. Repli automatique sur le fil
  principal si le navigateur refuse le worker (page ouverte en `file://`).
- **Données en Blob** : le worker livre les données du fichier sous forme de Blob JSON, qui circule par
  simple poignée jusqu'à IndexedDB et jusqu'au widget ; la page ne clone ni ne sérialise jamais les mégaoctets
  (une affectation `srcdoc` de 7 Mo coûtait ~200 ms, chaque sauvegarde ~100 ms).
- **Injection au bon moment** : documents injectés en début d'image (`requestAnimationFrame`), une carte par
  image (un canvas chargé se restaure sans à-coup) ; le squelette reste jusqu'au signal « prêt » du widget,
  émis une fois ses styles Tailwind compilés (pas de flash sans style), puis fondu enchaîné.
- **Rendu** : plus de `filter: blur()` animé ni de `hue-rotate` plein écran ; l'aurore (dégradés radiaux) ne
  dérive que canvas vide ; les cartes n'utilisent plus `backdrop-filter` (re-flou de chaque carte à chaque image
  d'un déplacement) ; le squelette holographique n'anime que `transform` et `opacity` (compositeur).

## Architecture

```
index.html              point d'entrée GitHub Pages → redirige vers frontend/
backend/
  app.py                FastAPI asynchrone : /api/generate (demande, fichier joint, refactorisation), /api/health, CORS
  providers.py          appels Gemini (REST generateContent) et Groq (secours), erreurs fatales ou « modèle suivant »
  auth.py, billing.py, widgets.py, models.py, db.py, security.py   comptes, Sparks, historique (v3)
  sanitize.py           nettoyage de la sortie LLM, épinglage de Tailwind et Chart.js, validation HTML/JS
  mocks.py              mode démo (lit les gabarits partagés)
  tests/                unittest : nettoyage, API avec faux Gemini, comptes, Sparks, parité Python ↔ JS
frontend/
  index.html            barre du haut, canvas, dock de saisie, inspecteur, réglages
  style.css             « Liquid Glass », CSS pur
  js/main.js            orchestration : dock, cycle de vie des cartes, montage des widgets, messages
  js/canvas.js          vue infinie, cartes (glisser, redimensionner, clavier), placement, cadrage
  js/inspector.js       volet de l'inspecteur
  js/sandbox.js         document de chaque widget (CSP, prélude, stockage, chargeur du Blob), export autonome
  js/offload.js         client du Web Worker (promesses, annulation, repli sur le fil principal)
  js/worker.js, js/tasks.js   Web Worker : analyse des fichiers, moteur navigateur
  js/files.js           lecture et analyse CSV/JSON/TXT, résumé pour le modèle
  js/engine.js          choix du moteur, clé Gemini, génération
  js/store.js           persistance IndexedDB
  engine/               ── partagé par les deux moteurs ──
    system-prompt.txt     contrat de sortie : HTML seul, Tailwind uniquement, persistance, --accent, Chart.js, PRISM_FILE
    user-template.txt, file-template.txt, refactor-template.txt
    gemini.json, groq.json, libs.json  modèles et bibliothèques autorisées (URL + SRI)
    mocks/                gabarits de démo (compteur, calculatrice, dashboard, CSV, JSON, TXT…)
    sanitize.js, local.js portage JS du nettoyage et moteur navigateur
  tests/                fixtures partagées, tests Node (moteur, sandbox, fichiers, worker)
tools/
  e2e_canvas.mjs        E2E : Chrome headless via CDP (deux widgets, vrais clics et glisser-déposer…)
  e2e_server.py         backend branché sur un faux Gemini local (génération « réelle », refactorisation)
  perf_probe.mjs        mesures de fluidité (images/s, blocages du fil principal), profils CPU facultatifs
  serve_static.py       sert le site en statique, comme GitHub Pages
  check_generate.py     valide une réponse enregistrée par curl
  pixel_logo.py         génère le logo pixel art
```

## Tests

```bash
.venv/Scripts/python -m unittest discover -s backend/tests      # backend + parité Python ↔ JS
node --test frontend/tests/engine.test.cjs frontend/tests/files.test.mjs frontend/tests/sandbox.test.mjs frontend/tests/tasks.test.mjs
node tools/e2e_canvas.mjs --base http://127.0.0.1:8000            # serveur (démo)
.venv/Scripts/python tools/serve_static.py &                      # comme GitHub Pages
node tools/e2e_canvas.mjs --base http://127.0.0.1:8001/
node tools/perf_probe.mjs --base http://127.0.0.1:8001/           # fluidité (--profile dossier : profils CPU)
.venv/Scripts/python tools/e2e_server.py &                        # faux Gemini : génération et refactorisation
node tools/e2e_canvas.mjs --base http://127.0.0.1:8003 --refactor
```

> Depuis la v3 (phase 1), `/api/generate` exige un compte : les E2E en mode serveur (8000, 8003)
> seront remis à jour avec l'écran de connexion (phase 2). Le mode statique (8001) n'est pas concerné.

Validation d'une réponse brute (inscription, puis génération avec le jeton) :

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/auth/register -H "Content-Type: application/json" \
     -d '{"email":"moi@exemple.fr","password":"un-mot-de-passe-solide"}' | python -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -s -X POST http://127.0.0.1:8000/api/generate -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
     -d '{"prompt":"Crée un bouton interactif qui change de couleur au clic et compte le nombre de clics"}' \
     -o resp.json && .venv/Scripts/python tools/check_generate.py resp.json
```

## Prism v3 (en cours) — plateforme SaaS

| Phase | Contenu | État |
| --- | --- | --- |
| 1. Backend | comptes (JWT + scrypt), Sparks (réservation atomique, remboursement, grand livre), historique des widgets, API | **fait** (`3.0.0-alpha.1`) |
| 3.5 Velocity & Elegance | Gemini, design system Tailwind, Web Worker, données en Blob, injection au rythme des images, squelette holographique | **fait** (`3.5.0-alpha.1`) |
| 2. Comptes côté interface | fenêtre de connexion/inscription Liquid Glass, jauge de Sparks en anneau, fenêtre « Prism Pro » sur 403 | à faire |
| 3. Mon Hub | panneau d'historique, miniatures générées dans la sandbox, synchronisation du canvas avec le serveur | à faire |
| 4. Bus d'évènements | `prism.emit` / `prism.on` entre widgets, relayés par le canvas ; le prompt connaît les sujets des widgets présents | à faire |
| 5. Spotlight et reflets | invite flottante Ctrl/Cmd + K ; reflets des bords via IntersectionObserver et position du pointeur | à faire |
| 6. Déploiement | hébergement gratuit de l'API, PostgreSQL, secrets, frontend Pages pointé vers l'API | à faire |

API ajoutée en phase 1 (jeton `Authorization: Bearer …` sauf `register`/`login`/`health`) :

| Route | Rôle |
| --- | --- |
| `POST /api/auth/register`, `POST /api/auth/login` | `{ email, password }` → `{ token, user }` (50 Sparks offerts à l'inscription) |
| `GET /api/auth/me` | profil et solde |
| `POST /api/generate` | `{ prompt, file?, widget_id? }` : génère (1 Spark) ou refactorise ce widget (0,5 Spark) ; **403** `insufficient_sparks` si le solde manque |
| `GET /api/sparks` | solde, tarifs, derniers mouvements |
| `GET /api/widgets`, `GET/PATCH/DELETE /api/widgets/{id}`, `POST /api/widgets/{id}/undo` | historique « Mon Hub » |

## Configuration du serveur

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `GEMINI_API_KEY` | vide (mode démo) | clé API Gemini (Google AI Studio) |
| `GEMINI_MODELS` | `gemini.json` | chaîne de modèles, séparés par des virgules (le suivant prend le relais) |
| `GEMINI_MAX_OUTPUT_TOKENS` | `32768` | tokens de sortie max par appel |
| `GROQ_API_KEY` | vide | secours facultatif, essayé seulement si tous les modèles Gemini échouent |
| `GROQ_MODELS` | `groq.json` | chaîne de modèles Groq |
| `GROQ_REASONING_EFFORT` | `medium` | effort de raisonnement (modèles gpt-oss uniquement) |
| `PRISM_MAX_TOKENS` | `6000` | tokens de sortie max côté Groq |
| `PRISM_TIMEOUT` | `90` | délai par appel, en secondes |
| `PRISM_HOST` / `PRISM_PORT` | `127.0.0.1` / `8000` | adresse d'écoute |
| `PRISM_CORS_ORIGINS` | `*` | origines autorisées, séparées par des virgules |
| `PRISM_JWT_SECRET` | secret de développement dans `data/` | signature des sessions : **obligatoire en production** |
| `PRISM_DATABASE_URL` | `sqlite:///data/prism.db` | base de données (PostgreSQL en production) |
| `PRISM_SIGNUP_SPARKS` | `50` | Sparks offerts à l'inscription |
| `PRISM_TOKEN_TTL_HOURS` | `168` | durée d'une session |

Régénérer le logo : `python tools/pixel_logo.py`.
