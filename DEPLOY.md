# Déployer Prism (gratuitement)

Cible : **l'API et le frontend sur Render** (image Docker, offre gratuite), **la base sur Neon**
(PostgreSQL gratuit et permanent), et, en option, **GitHub Pages branché sur l'API**.

```
Navigateur ──► https://prism-api-xxxx.onrender.com  (frontend + /api, Docker)
    │                         │
    │                         └──► Neon (PostgreSQL)  ·  Gemini (clé du serveur)
    └── ou https://lechat45.github.io/prism/  ──CORS + jeton──►  même API
```

## Offres gratuites (vérifiées le 26 septembre 2026)

| Service | Ce qu'il faut savoir |
| --- | --- |
| Render, service web gratuit | mise en veille après **15 min** sans trafic, réveil en **~1 min** ; 750 h/mois ; **disque éphémère** (une base SQLite y serait perdue) |
| Render PostgreSQL gratuit | **expire 30 jours** après sa création : à éviter |
| Neon, offre gratuite | 0,5 Go par projet, 100 heures de calcul par mois, mise en veille après 5 min, **sans expiration** |

Pendant le réveil du serveur, le frontend affiche « Réveil du serveur… » et fonctionne en moteur
navigateur ; il bascule en mode serveur dès que l'API répond.

## 1. Base de données : Neon

1. Créez un compte sur <https://neon.com>, puis un projet (région européenne, par ex. Frankfurt).
2. Dans **Connect**, copiez la chaîne de connexion (`postgresql://…@…neon.tech/…?sslmode=require`).
   L'adresse directe comme l'adresse « pooled » conviennent (Prism désactive les requêtes préparées côté
   serveur, incompatibles avec certains poolers).

Les tables sont créées au premier démarrage ; les colonnes ajoutées par une version ultérieure le sont
aussi, automatiquement (rien n'est jamais supprimé).

## 2. API : Render

1. Créez un compte sur <https://render.com> et reliez-le à GitHub.
2. **New → Blueprint**, choisissez le dépôt `lechat45/prism` et la branche **`v3`** (celle que publie aussi
   GitHub Pages). Render lit `render.yaml`.
3. Renseignez les deux secrets demandés :
   - `PRISM_DATABASE_URL` : la chaîne Neon de l'étape 1 ;
   - `GEMINI_API_KEY` : votre clé Google AI Studio (<https://aistudio.google.com/apikey>) ; plusieurs clés
     possibles, séparées par des virgules (servies à tour de rôle, relais sur quota) : copiez la valeur de
     `backend/.env`.

   `PRISM_JWT_SECRET` est généré par Render ; les autres réglages sont dans `render.yaml`.
4. **Apply**. Premier déploiement : quelques minutes (construction de l'image). Adresse du service :
   `https://prism-api-xxxx.onrender.com`.

Le serveur **refuse de démarrer** si la configuration de production est incomplète (secret absent ou
de moins de 32 caractères, base SQLite) : le motif figure dans le journal de Render.

## 3. Vérifier

```bash
python tools/check_deploy.py https://prism-api-xxxx.onrender.com
```

Lecture seule (aucun compte créé, aucun Spark dépensé) : santé, moteur Gemini actif, en-têtes de
sécurité, CORS pour GitHub Pages (dont `PUT` et `Authorization`), frontend servi, génération refusée
sans compte. Attendu : `10/10 contrôles réussis`. Le premier appel peut prendre une minute (réveil).

L'application est alors utilisable directement à l'adresse Render.

## 4. GitHub Pages branché sur l'API (facultatif)

1. Dans `frontend/index.html`, renseignez l'adresse de l'API :
   ```html
   <meta name="prism-api" content="https://prism-api-xxxx.onrender.com">
   ```
   Elle n'est utilisée que sur `*.github.io` : en local, Prism parle toujours à votre serveur local.
2. Publiez-la sur la branche `v3` (GitHub Pages publie `v3`). Le site <https://lechat45.github.io/prism/>
   propose alors comptes, Sparks, Mon Hub, Engrammes et conversations, sans clé côté visiteur.
3. `PRISM_CORS_ORIGINS` doit contenir `https://lechat45.github.io` (c'est le cas dans `render.yaml`).

Sans cette balise, GitHub Pages reste en moteur navigateur (démo, ou clé Gemini de l'utilisateur).

## 5. Sécurité et coûts

- **Secrets** uniquement dans le tableau de bord de Render, jamais dans le dépôt. Changer
  `PRISM_JWT_SECRET` déconnecte tout le monde.
- **La clé Gemini est celle du serveur** : chaque génération la consomme. Garde-fous en place : 50 Sparks
  à l'inscription (`PRISM_SIGNUP_SPARKS`), inscriptions limitées par IP (IP réelle derrière le proxy de
  Render grâce à `FORWARDED_ALLOW_IPS`), anti-force brute sur la connexion. Réduisez les Sparks offerts
  si besoin, et surveillez les quotas dans Google AI Studio.
- **Base gratuite de 0,5 Go** : les données de fichier joint sont plafonnées à 4 Mo par widget
  (`PRISM_MAX_FILE_DATA_MB`) ; au-delà, elles restent sur l'appareil d'origine.
- En-têtes envoyés par Prism : `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` et, en production, `Strict-Transport-Security`.

## 6. Mises à jour

Render redéploie à chaque commit sur la branche choisie, **une fois la CI GitHub verte**
(`autoDeployTrigger: checksPass`) : Python sur SQLite et PostgreSQL, Node, E2E Chrome (statique, serveur,
faux Gemini, GitHub Pages → API, Engramme) et image Docker. Un commit qui casse les tests n'est jamais déployé.

## 7. Dépannage

| Symptôme | Piste |
| --- | --- |
| « Configuration de production incomplète » au démarrage | `PRISM_JWT_SECRET` ou `PRISM_DATABASE_URL` manquant (journal Render) |
| Erreur de connexion à la base | chaîne Neon complète, avec `?sslmode=require` |
| GitHub Pages reste en « Démo · ajouter une clé » | balise `prism-api` vide ou en `http://`, ou serveur injoignable pendant plus de 2 min |
| Erreurs CORS dans la console | `PRISM_CORS_ORIGINS` doit contenir l'origine exacte du site |
| Widgets de démonstration seulement | `GEMINI_API_KEY` absente (le contrôle « moteur réel » de `check_deploy.py` échoue) |

## Autres hébergeurs

L'image Docker fonctionne partout (Google Cloud Run, Koyeb, Fly.io, un VPS…) avec les mêmes variables :

| Variable | Rôle |
| --- | --- |
| `PRISM_ENV=production` | active les garde-fous et HSTS (déjà dans l'image) |
| `PRISM_JWT_SECRET` | secret des sessions, 32 caractères au moins (`python -c "import secrets; print(secrets.token_urlsafe(48))"`) |
| `PRISM_DATABASE_URL` | PostgreSQL (`postgres://`, `postgresql://` acceptés) |
| `GEMINI_API_KEY` | clé du modèle (Groq en secours : `GROQ_API_KEY`) |
| `PRISM_CORS_ORIGINS` | origines autorisées, ex. `https://lechat45.github.io` |
| `FORWARDED_ALLOW_IPS` | proxys de confiance pour l'IP réelle (`*` derrière le proxy d'un hébergeur) |
| `PORT` / `PRISM_PORT` | port d'écoute (fourni par l'hébergeur) |
| `PRISM_MAX_FILE_DATA_MB`, `PRISM_SIGNUP_SPARKS` | plafonds (défauts : 16 Mo, 50 Sparks) |

Pour éprouver la configuration de production sans hébergeur : `python tools/prod_local.py` (port 8005,
SQLite temporaire autorisée) puis `python tools/check_deploy.py http://127.0.0.1:8005 --allow-demo`.
