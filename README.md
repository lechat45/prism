# Prism

Générateur d'interfaces éphémères (Generative UI) sur un **canvas spatial** : chaque demande en
langage naturel, ou chaque fichier CSV/JSON/TXT déposé, devient une micro-application interactive
dans une carte que l'on déplace, redimensionne, refactorise, recolore et exporte.

**En ligne : <https://lechat45.github.io/prism/>**

![Logo Prism](frontend/assets/prism-logo.png)

## Fonctionnalités (v2)

| | |
| --- | --- |
| **Canvas infini** | pan (glisser le fond, molette), zoom (Ctrl + molette, pincement, boutons), « Tout voir », « Ranger » ; cartes déplaçables, redimensionnables, fermables (avec « Rétablir »), pilotables au clavier |
| **Générations parallèles** | chaque demande crée sa carte immédiatement ; plusieurs widgets se génèrent en même temps, chacun annulable |
| **Import de fichiers** | glisser-déposer (ou trombone, ou collage) d'un CSV, JSON ou TXT jusqu'à 5 Mo. Le navigateur analyse le fichier (séparateur, types de colonnes, formats français) ; seul un résumé de sa structure part au modèle, les données complètes sont injectées dans le widget (`window.PRISM_FILE`) |
| **Persistance** | les cartes (position, taille, code, fichier) sont sauvées en IndexedDB ; chaque widget dispose d'un `localStorage` persistant qui survit au rechargement (cases cochées, compteurs, saisies…) |
| **Inspecteur** | clic sur une carte : refactorisation de cette carte seule (avec annulation), couleur d'accent à chaud, copie du code complet, téléchargement d'un `.html` autonome, code source, relance, effacement des données |
| **Graphiques** | Chart.js 4.5.1 autorisé via jsDelivr, épinglé avec empreinte SRI ; toute autre ressource externe reste bloquée |
| **Liquid Glass v2** | dégradés fluides animés sous le verre dépoli, apparition des cartes, micro-interactions, barres de défilement des cartes masquées |

## Deux façons de l'utiliser

| | GitHub Pages (statique) | Serveur Python local |
| --- | --- | --- |
| Adresse | <https://lechat45.github.io/prism/> | <http://127.0.0.1:8000> |
| Sans clé Groq | widgets de démonstration | widgets de démonstration |
| Avec une clé Groq | la vôtre, via le badge du moteur (en haut à droite), appel direct navigateur → api.groq.com | `GROQ_API_KEY` dans `backend/.env` |
| Refactorisation | avec une clé | avec une clé |

Le frontend choisit tout seul : il interroge `GET /api/health` et, faute de backend (ou sur `*.github.io`),
passe au moteur navigateur. Les deux moteurs partagent **les mêmes fichiers** (`frontend/engine/`) :
prompts, gabarits de démo, réglages Groq, bibliothèques autorisées. Leur parité est vérifiée par les tests.

### Serveur local

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt   # macOS/Linux : .venv/bin/python
cp backend/.env.example backend/.env                               # facultatif : GROQ_API_KEY=gsk_…
.venv/Scripts/python backend/app.py
```

### Clé Groq dans le navigateur (GitHub Pages)

Créez une clé gratuite sur <https://console.groq.com/keys>, cliquez sur le badge « Démo · ajouter une clé ».
La clé est gardée dans le navigateur (en `sessionStorage` par défaut, oubliée à la fermeture de l'onglet ;
en `localStorage` si « Mémoriser » est coché) et n'est envoyée qu'à `api.groq.com`.
Toutes les pages `lechat45.github.io/*` partagent la même origine, donc le même stockage : ne cochez
« Mémoriser » que sur un appareil personnel.

## Sécurité des widgets

Le code généré est non fiable par principe. Chaque widget tourne dans
`<iframe sandbox="allow-scripts">` **sans** `allow-same-origin` : origine opaque, aucun accès à Prism,
à la clé Groq ni à son stockage. Ce qu'il lui faut est injecté dans son document (`frontend/js/sandbox.js`) :

| Couche | Effet |
| --- | --- |
| CSP `default-src 'none'` + `script-src` limité au fichier Chart.js épinglé | aucune requête réseau (pas d'exfiltration) ; bibliothèque vérifiée par SRI |
| `localStorage` fourni par Prism | persistant **et** isolé : chaque écriture est envoyée à la page par `postMessage`, validée (≤ 1 Mo, chaînes uniquement) et rangée avec la carte. Un vrai `localStorage` aurait exigé `allow-same-origin`, qui rend la sandbox contournable |
| `window.PRISM_FILE` | données du fichier joint, JSON échappé (`<`, U+2028/2029) |
| Prélude | remonte les erreurs JS (statut de la carte), relaie Ctrl + molette vers le canvas, applique l'accent à chaud |
| Messages entrants | Prism n'accepte que ceux de ses propres iframes, et les valide |

## Architecture

```
index.html              point d'entrée GitHub Pages → redirige vers frontend/
backend/
  app.py                FastAPI : /api/generate (demande, fichier joint, refactorisation), /api/health, CORS
  sanitize.py           nettoyage de la sortie LLM, épinglage de Chart.js, validation HTML/JS
  mocks.py              mode démo (lit les gabarits partagés)
  tests/                unittest : nettoyage, API avec faux Groq, parité Python ↔ JS
frontend/
  index.html            barre du haut, canvas, dock de saisie, inspecteur, réglages
  style.css             « Liquid Glass v2 », CSS pur
  js/main.js            orchestration : dock, cycle de vie des cartes, messages des widgets
  js/canvas.js          vue infinie, cartes (glisser, redimensionner, clavier), placement, cadrage
  js/inspector.js       volet de l'inspecteur
  js/sandbox.js         document de chaque widget (CSP, prélude, stockage), export autonome
  js/files.js           lecture et analyse CSV/JSON/TXT, résumé pour le modèle
  js/engine.js          choix du moteur, clé Groq, génération
  js/store.js           persistance IndexedDB
  engine/               ── partagé par les deux moteurs ──
    system-prompt.txt     contrat de sortie : HTML seul, persistance, --accent, Chart.js, PRISM_FILE
    user-template.txt, file-template.txt, refactor-template.txt
    groq.json, libs.json  modèles et bibliothèques autorisées (URL + SRI)
    mocks/                gabarits de démo (compteur, calculatrice, dashboard, CSV, JSON, TXT…)
    sanitize.js, local.js portage JS du nettoyage et moteur navigateur
  tests/                fixtures partagées, tests Node (moteur, sandbox, fichiers)
tools/
  e2e_canvas.mjs        E2E : Chrome headless via CDP (deux widgets, vrais clics et glisser-déposer…)
  e2e_server.py         backend branché sur un faux Groq local (génération « réelle », refactorisation)
  serve_static.py       sert le site en statique, comme GitHub Pages
  check_generate.py     valide une réponse enregistrée par curl
  pixel_logo.py         génère le logo pixel art
```

## Tests

```bash
.venv/Scripts/python -m unittest discover -s backend/tests      # backend + parité Python ↔ JS
node --test "frontend/tests/*.test.*"                             # moteur navigateur, sandbox, fichiers
node tools/e2e_canvas.mjs --base http://127.0.0.1:8000            # serveur (démo)
.venv/Scripts/python tools/serve_static.py &                      # comme GitHub Pages
node tools/e2e_canvas.mjs --base http://127.0.0.1:8001/
.venv/Scripts/python tools/e2e_server.py &                        # faux Groq : génération et refactorisation
node tools/e2e_canvas.mjs --base http://127.0.0.1:8003 --refactor
```

Validation d'une réponse brute :

```bash
curl -s -X POST http://127.0.0.1:8000/api/generate -H "Content-Type: application/json" \
     -d '{"prompt":"Crée un bouton interactif qui change de couleur au clic et compte le nombre de clics"}' \
     -o resp.json && .venv/Scripts/python tools/check_generate.py resp.json
```

## Configuration du serveur

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `GROQ_API_KEY` | vide (mode démo) | clé API Groq |
| `GROQ_MODELS` | `groq.json` | chaîne de modèles, séparés par des virgules |
| `GROQ_REASONING_EFFORT` | `medium` | effort de raisonnement (modèles gpt-oss uniquement) |
| `PRISM_MAX_TOKENS` | `6000` | tokens de sortie max (le palier gratuit Groq plafonne à ~8000 tokens/min : une refactorisation d'un gros widget peut le dépasser) |
| `PRISM_TIMEOUT` | `90` | délai par appel, en secondes |
| `PRISM_HOST` / `PRISM_PORT` | `127.0.0.1` / `8000` | adresse d'écoute |
| `PRISM_CORS_ORIGINS` | `*` | origines autorisées, séparées par des virgules |

Régénérer le logo : `python tools/pixel_logo.py`.
