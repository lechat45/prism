# Prism

Générateur d'interfaces éphémères (Generative UI) : une demande en langage naturel, ou des données
collées, devient un composant web interactif, rendu instantanément dans une iframe isolée.

![Logo Prism](frontend/assets/prism-logo.png)

## Démarrage

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt   # macOS/Linux : .venv/bin/python
.venv/Scripts/python backend/app.py
```

Puis ouvrir <http://127.0.0.1:8000>. Le backend sert aussi le frontend (une seule commande).
`frontend/index.html` peut aussi être ouvert directement (`file://`) : il appelle alors `http://127.0.0.1:8000`.

### Clé Groq (gratuite)

Sans clé, Prism tourne en **mode démo** : des composants pré-écrits (compteur, calculatrice,
tableau de bord qui lit vos paires « libellé valeur », carte générique). Pour la vraie génération :

```bash
cp backend/.env.example backend/.env    # puis renseigner GROQ_API_KEY=gsk_…
```

Modèles essayés dans l'ordre (`GROQ_MODELS`) : `openai/gpt-oss-120b`, puis `llama-3.3-70b-versatile`.
Le suivant prend le relais en cas de quota (429), d'erreur, de réponse tronquée, de réponse sans HTML
ou de JavaScript syntaxiquement invalide. Une clé refusée (401) arrête tout de suite.

## Architecture

```
backend/
  app.py            FastAPI : /api/generate, /api/health, CORS, prompt système, service du frontend
  sanitize.py       nettoyage de la sortie LLM (```html, prose, <think>) + validation HTML/JS
  mocks.py          composants du mode démo
  tests/            unittest : nettoyage, mocks, API avec faux serveur Groq
frontend/
  index.html        header (logo pixel art), zone de saisie, zone de rendu, indicateurs d'état
  style.css         design system « Liquid Glass » sombre, CSS pur
  app.js            Vanilla JS : appel API, injection sandbox, statuts, outils (code, copier, plein écran)
  assets/           logo pixel art (SVG + PNG)
tools/
  pixel_logo.py     génère le logo (grille 32×32 rastérisée, sans dépendance)
  check_generate.py valide une réponse enregistrée par curl
  e2e_sandbox.mjs   test E2E : Chrome headless via CDP, clics réels dans l'iframe
```

### Contrat de sortie du LLM

Le prompt système (`SYSTEM_PROMPT` dans `backend/app.py`) exige un document HTML5 unique, de
`<!DOCTYPE html>` à `</html>`, sans Markdown ni explication, sans ressource externe, et compatible
avec `sandbox="allow-scripts"`. Le backend ne fait pas confiance au modèle pour autant :
`sanitize.py` retire les blocs de code et la prose parasites, complète un fragment en document,
puis rejette tout document tronqué, sans balise ou dont un `<script>` ne se parse pas
(vérification par Node.js `vm.Script` si Node est installé).

### Isolation du code généré

| Couche | Effet |
| --- | --- |
| `<iframe sandbox="allow-scripts">` (sans `allow-same-origin`) | origine opaque : aucun accès à la page, aux cookies ou au stockage de Prism |
| CSP injectée `default-src 'none'` | aucune requête réseau depuis le composant (pas d'exfiltration) |
| Prélude injecté | erreurs JS remontées au parent (statut « Rendu avec erreur JS »), `localStorage` remplacé par un stockage mémoire |
| Plein écran sur le conteneur | le composant n'est jamais ouvert hors de la sandbox |

## Tests

```bash
.venv/Scripts/python -m unittest discover -s backend/tests -v          # 31 tests
curl -s -X POST http://127.0.0.1:8000/api/generate -H "Content-Type: application/json" \
     -d '{"prompt":"Crée un bouton interactif qui change de couleur au clic et compte le nombre de clics"}' \
     -o resp.json && .venv/Scripts/python tools/check_generate.py resp.json
node tools/e2e_sandbox.mjs --screenshot e2e.png                         # serveur lancé, Chrome/Edge requis
```

## Configuration

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `GROQ_API_KEY` | vide (mode démo) | clé API Groq |
| `GROQ_MODELS` | `openai/gpt-oss-120b,llama-3.3-70b-versatile` | chaîne de modèles |
| `GROQ_REASONING_EFFORT` | `medium` | effort de raisonnement (modèles gpt-oss uniquement) |
| `PRISM_MAX_TOKENS` | `6000` | tokens de sortie max (le palier gratuit Groq plafonne à ~8000 tokens/min) |
| `PRISM_TIMEOUT` | `90` | délai par appel, en secondes |
| `PRISM_HOST` / `PRISM_PORT` | `127.0.0.1` / `8000` | adresse d'écoute |
| `PRISM_CORS_ORIGINS` | `*` | origines autorisées, séparées par des virgules |

Régénérer le logo : `python tools/pixel_logo.py`.
