# Prism

Générateur d'interfaces éphémères (Generative UI) : une demande en langage naturel, ou des données
collées, devient un composant web interactif, rendu instantanément dans une iframe isolée.

**En ligne : <https://lechat45.github.io/prism/>**

![Logo Prism](frontend/assets/prism-logo.png)

## Deux façons de l'utiliser

| | GitHub Pages (statique) | Serveur Python local |
| --- | --- | --- |
| Adresse | <https://lechat45.github.io/prism/> | <http://127.0.0.1:8000> |
| Sans clé Groq | mode démo | mode démo |
| Avec une clé Groq | la vôtre, saisie via le badge du moteur (en haut à droite), appel direct navigateur → api.groq.com | `GROQ_API_KEY` dans `backend/.env` |
| Moteur | `frontend/engine/local.js` | `backend/app.py` |

Le frontend choisit tout seul : il interroge `GET /api/health` et, faute de backend (ou sur `*.github.io`),
passe au moteur navigateur. Les deux moteurs partagent **les mêmes fichiers** (`frontend/engine/`) :
prompt système, gabarits de démo, réglages Groq. Leur parité est vérifiée par les tests.

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

## Architecture

```
index.html            point d'entrée GitHub Pages → redirige vers frontend/
.nojekyll             publication brute (pas de traitement Jekyll)
backend/
  app.py              FastAPI : /api/generate, /api/health, CORS, service du frontend
  sanitize.py         nettoyage de la sortie LLM (```html, prose, <think>) + validation HTML/JS
  mocks.py            mode démo (lit les gabarits partagés)
  tests/              unittest : nettoyage, API avec faux serveur Groq, parité Python ↔ JS
frontend/
  index.html          header (logo pixel art), saisie, rendu, statuts, réglages du moteur
  style.css           design system « Liquid Glass » sombre, CSS pur
  app.js              choix du moteur, injection sandbox, statuts, outils
  engine/             ── partagé par les deux moteurs ──
    system-prompt.txt   prompt système (contrat de sortie HTML)
    user-template.txt   gabarit du message utilisateur
    groq.json           URL, chaîne de modèles, paramètres
    mocks/              gabarits de démo + manifest.json (routage par mots-clés)
    sanitize.js         portage JS de backend/sanitize.py
    local.js            moteur navigateur (démo + Groq direct)
  tests/              fixtures.json (cas partagés), tests Node du moteur navigateur
  assets/             logo pixel art (SVG + PNG)
tools/
  pixel_logo.py       génère le logo (grille 32×32, sans dépendance)
  check_generate.py   valide une réponse enregistrée par curl
  e2e_sandbox.mjs     E2E : Chrome headless via CDP, clics réels dans l'iframe
```

### Contrat de sortie du LLM

Le prompt système (`frontend/engine/system-prompt.txt`) exige un document HTML5 unique, de
`<!DOCTYPE html>` à `</html>`, sans Markdown ni explication, sans ressource externe, compatible
avec `sandbox="allow-scripts"`. Aucun des deux moteurs ne fait confiance au modèle : les blocs de code
et la prose parasites sont retirés, un fragment est complété en document, et tout document tronqué,
sans balise ou dont un `<script>` ne se parse pas fait passer au modèle suivant de la chaîne
(`openai/gpt-oss-120b` puis `llama-3.3-70b-versatile`). Une clé refusée (401) arrête tout de suite.

### Isolation du code généré

| Couche | Effet |
| --- | --- |
| `<iframe sandbox="allow-scripts">` (sans `allow-same-origin`) | origine opaque : aucun accès à la page, à la clé Groq, aux cookies ou au stockage de Prism |
| CSP injectée `default-src 'none'` | aucune requête réseau depuis le composant (pas d'exfiltration) |
| Prélude injecté | erreurs JS remontées au parent (statut « Rendu avec erreur JS »), `localStorage` remplacé par un stockage mémoire |
| Plein écran sur le conteneur | le composant n'est jamais ouvert hors de la sandbox |

## Tests

```bash
.venv/Scripts/python -m unittest discover -s backend/tests -v   # 38 tests, dont parité Python ↔ JS
node --test "frontend/tests/*.test.cjs"                           # 8 tests du moteur navigateur
curl -s -X POST http://127.0.0.1:8000/api/generate -H "Content-Type: application/json" \
     -d '{"prompt":"Crée un bouton interactif qui change de couleur au clic et compte le nombre de clics"}' \
     -o resp.json && .venv/Scripts/python tools/check_generate.py resp.json
node tools/e2e_sandbox.mjs --base http://127.0.0.1:8000           # mode serveur
node tools/e2e_sandbox.mjs --base https://lechat45.github.io/prism/  # mode GitHub Pages
```

Pour simuler GitHub Pages en local : `python -m http.server 8001` à la racine du dépôt, puis
<http://127.0.0.1:8001/>.

## Configuration du serveur

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `GROQ_API_KEY` | vide (mode démo) | clé API Groq |
| `GROQ_MODELS` | `groq.json` | chaîne de modèles, séparés par des virgules |
| `GROQ_REASONING_EFFORT` | `medium` | effort de raisonnement (modèles gpt-oss uniquement) |
| `PRISM_MAX_TOKENS` | `6000` | tokens de sortie max (le palier gratuit Groq plafonne à ~8000 tokens/min) |
| `PRISM_TIMEOUT` | `90` | délai par appel, en secondes |
| `PRISM_HOST` / `PRISM_PORT` | `127.0.0.1` / `8000` | adresse d'écoute |
| `PRISM_CORS_ORIGINS` | `*` | origines autorisées, séparées par des virgules |

Régénérer le logo : `python tools/pixel_logo.py`.
