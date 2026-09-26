# Changelog

## 4.0.0-alpha.1 — 2026-09-26 (V4 « Singularité » : l'Engramme cognitif)

- **Engramme cognitif** : « Engramme : Marie Curie » (dock, Spotlight, voix) cartographie l'esprit d'une
  personnalité publique en 30 à 36 bulles : 1 noyau (axiome), 8 à 10 moteurs opérationnels (algorithme de
  résolution, empreinte syntaxique, matrice esthétique, méthode de travail), 10 à 15 ombres et biais
  (paradoxes, peurs primaires, biais cognitifs), 10 artefacts chronologiques datés. 2 Sparks en mode serveur.
- **Définition JSON stricte** pour Gemini (`responseSchema`, `engine/engram/schema.json`) et validation du sens
  (`backend/engram.py`, jumeau JS `engine/engram/engram.js` à parité exacte, 17 cas partagés) : comptes, types,
  dates, liens ; modèle suivant si la réponse est incomplète, JSON simple si le schéma est refusé partout.
  Route `POST /api/engram` ; refus motivé (422 `engram_refused`, Sparks rendus) pour une personne non publique.
- **Éthique** dans le prompt : faits publics uniquement, rien d'inventé (évènement, date, citation), ombres
  données comme interprétations et jamais comme diagnostics ; mention « portrait interprétatif » sur la carte.
- **Moteur physique ressort-masse natif** (sans D3, déterministe, pas fixe de 1/120 s) et **rendu Canvas** :
  noyau blanc immobile, moteurs cyan sages aux liens épais, ombres violettes/cramoisies erratiques qui fuient
  le pointeur, pulsent et glitchent, artefacts dorés rapides à traînées ; anneaux elliptiques, libellés sans
  chevauchement. Survol : la bulle s'arrête et grossit, fiche **Liquid Glass** (Tailwind épinglé).
- **Injection d'ADN** : clic sur une bulle → filtre ADN dans le dock (la prochaine demande passe par ce trait) ;
  fichier ou texte déposé sur une bulle → génération filtrée immédiate, à côté de l'Engramme. `dna` dans
  `POST /api/generate` (validé : type cohérent avec la catégorie, palette hexadécimale…), section « COGNITIVE
  DNA FILTER » du message, identique dans les deux moteurs.
- **Zoom fractal** : double-clic sur une partie d'un widget → proposition ; le sous-composant devient un widget
  complet (mêmes données) qui émerge du point cliqué.
- **Incantation** : Espace maintenu → reconnaissance vocale (Web Speech API), transcription sous le pointeur,
  carte créée à cet endroit ; aussi depuis Spotlight. **Verre organique** : pendant l'écoute, le volume du micro
  (AudioContext) module flou et saturation du verre. `Permissions-Policy: microphone=(self)` (page seulement).
- Moteur navigateur (GitHub Pages) : Engramme avec la clé Gemini de l'utilisateur (même schéma, même
  validation, dans le Web Worker), sinon l'Engramme de démonstration.
- Dépôt : `.gitattributes` (fins de ligne LF partout : un clone Windows avec `core.autocrlf` cassait la parité
  des gabarits Python ↔ JS).
- Tests : 114 Python, 64 Node ; E2E V4 30/30 (serveur) et 24/24 (statique) ; E2E existants inchangés
  (38, 47, 55, 5) ; CI : deux étapes E2E V4.

## 3.5.0-rc.1 — 2026-09-26 (phase 6 : prêt pour la mise en ligne)

Candidate à la version 3.5.0 : tout le nécessaire au déploiement gratuit est là ; la 3.5.0 finale suivra
la première mise en ligne vérifiée (`tools/check_deploy.py`) et le premier passage de la CI GitHub.

- **Image Docker** de production (Python 3.13, Node pour la vérification du JS généré, utilisateur non root)
  et **blueprint Render** (`render.yaml` : service gratuit, contrôle de santé, secret de session généré,
  base et clé Gemini saisies dans le tableau de bord). Guide pas à pas : `DEPLOY.md`.
- **PostgreSQL** : pilote psycopg 3, adresses `postgres://` / `postgresql://` des hébergeurs acceptées,
  connexions vérifiées avant usage (bases qui s'endorment), requêtes préparées côté serveur désactivées
  (poolers de type PgBouncer) ; la suite Python peut tourner sur PostgreSQL (`PRISM_TEST_DATABASE_URL`).
- **Garde-fous de production** (`PRISM_ENV=production`) : refus de démarrer sans secret de session de
  32 caractères au moins ni base PostgreSQL (sauf `PRISM_ALLOW_SQLITE=1`) ; jamais de secret de
  développement généré en production.
- **En-têtes** : `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`,
  HSTS en production ; IP réelle derrière le proxy (`FORWARDED_ALLOW_IPS`) pour les limites anti-abus ;
  port fourni par l'hébergeur (`PORT`). CORS : `PUT` autorisé (oubli de la phase 3, requis depuis GitHub Pages).
- **GitHub Pages → API** : balise `<meta name="prism-api">` (utilisée seulement sur `*.github.io`, HTTPS
  ou machine locale) ; serveur endormi : démarrage en moteur navigateur, « Réveil du serveur… », bascule
  en mode serveur au réveil et synchronisation du canvas.
- **CI GitHub** : Python sur SQLite et PostgreSQL (conteneur de service), Node, 4 E2E Chrome, construction
  et contrôle de l'image Docker (refus sans secret, puis `check_deploy.py`).
- Outils : `check_deploy.py` (contrôles en lecture seule d'un déploiement), `prod_local.py` (production en
  local), `e2e_pages_api.mjs` (page servie comme github.io via le CDP, API endormie puis réveillée).
- Tests : 94 Python (+ 9 de déploiement), 50 Node ; E2E contre la configuration de production locale 47/47 ;
  GitHub Pages → API 5/5 ; `check_deploy.py` 10/10 en local.

## 3.5.0-alpha.5 — 2026-09-26 (phase 5 : Spotlight et reflets)

- **Spotlight (Ctrl/Cmd + K)** : invite flottante pour générer, refactoriser la carte sélectionnée, sauter à une
  carte, lancer une commande ou rouvrir un widget de « Mon Hub », au clavier (flèches, Entrée, Échap). Classement
  sans accents ni casse (exact, début, début de mot, mots, sous-séquence) ; une commande bien nommée passe devant
  « Générer ». Le raccourci fonctionne aussi le focus dans un widget (relais du prélude). Bouton « Commandes » dans
  la barre du haut.
- **Reflets des bords** qui suivent le pointeur (relayé depuis les iframes ~30 fois/s), calculés depuis les
  coordonnées du monde, une fois par image, pour les seules cartes visibles ; peints dans le fond de la carte,
  sans couche au-dessus de l'iframe, et plus repeints tant que le pointeur est sur la carte ou qu'un bouton est
  enfoncé (une première version faisait perdre un clic sur trois dans les rafales vers une iframe isolée).
- **IntersectionObserver** : cartes visibles suivies ; une carte hors champ jamais démarrée attend d'approcher de
  l'écran pour charger son iframe (restauration d'un grand canvas, appareil neuf) ; restauration depuis le Hub
  sur un appareil neuf : cadrage automatique.
- Synchronisation : envois vers « Mon Hub » en `keepalive` et vidés au départ de la page — une carte fermée juste
  avant un rechargement ne revient plus.
- Tests : 85 Python, 50 Node (classement du Spotlight, reflets) ; E2E : Ctrl + K (page et widget), commande,
  saut vers une carte, reflets, cartes hors écran non démarrées puis démarrées, génération depuis Spotlight
  (statique 38, démo 47, faux Gemini 55 contrôles) ; attente de la fin réelle de l'animation du volet avant de
  viser une pastille.

## 3.5.0-alpha.4 — 2026-09-26 (phase 4 : bus d'évènements)

- **Widgets connectés** : `window.prism.emit(sujet, données)` et `prism.on(sujet | "*", fn)` dans chaque widget
  (prélude de la sandbox). La page relaie aux seuls abonnés, jamais à l'émetteur, après validation (sujet,
  JSON ≤ 64 Ko) et sous débit plafonné par carte ; la dernière valeur de chaque sujet est remise aux nouveaux
  abonnés. Export `.html` : bus inerte.
- **Liaisons sur le canvas** (SVG sous les cartes, coordonnées du monde) avec lueur à chaque évènement ;
  inspecteur : sujets émis/écoutés, compte, dernière valeur, « Isoler cette carte du bus ».
- **Contexte du canvas pour le modèle** : `canvas` dans `POST /api/generate` (et le moteur navigateur), section
  `CANVAS` générée à l'identique en Python et en JS (parité testée) ; message construit en une seule passe, sans
  réinterprétation des textes insérés. Prompt système : section EVENT BUS.
- Gabarit de démo « compteur » : publie `compteur.change`. Sujets relus dans le code des widgets et observés à
  l'exécution, conservés avec la carte.
- Tests : 85 Python, 45 Node (bus : relais, écho, rejeu, isolement, plafonds, liaisons, contexte) ; E2E faux
  Gemini 47 contrôles (émetteur + récepteur : contexte transmis, rejeu, relais, liaison, isolement), démo 39,
  statique 30.

## 3.5.0-alpha.3 — 2026-09-26 (phase 3 : Mon Hub)

- **Mon Hub** : bibliothèque des widgets du compte (bouton dans la barre du haut) avec miniatures, recherche,
  réouverture sur le canvas (« Afficher » si la carte y est déjà), suppression définitive à double
  confirmation, pagination. Fermer une carte la retire du canvas, pas du Hub.
- **Miniatures fabriquées dans la sandbox** : sur demande de la page, le prélude du widget clone son document
  (`<canvas>` figés en images, saisies reportées), le rend en image SVG sans réseau et renvoie un
  `data:image/webp` ; la page le valide (image matricielle base64, 300 000 caractères au plus) puis l'envoie.
- **Synchronisation du canvas** : disposition, état du widget, couleur et titre des cartes liées envoyés par
  lots (champs changés seulement) ; données du fichier joint téléversées une fois, en Blob, via le nouveau
  `PUT /api/widgets/{id}/file` (JSON brut, 16 Mo au plus, lu par morceaux) ; carte fermée → `clear_layout`.
  À la connexion (ou au démarrage), les cartes posées sur le canvas depuis un autre appareil sont restaurées.
- **Import** d'une carte créée hors compte (`POST /api/widgets`, gratuit, 1 000 widgets par compte) à sa
  première refactorisation ; l'annulation utilise les versions du serveur, même après réouverture.
- Backend : données du fichier dans une colonne à part (`file_data_json`) pour une liste du Hub légère
  (code, état et données non chargés) ; `on_canvas` et `has_file_data` dans chaque entrée, filtre
  `?on_canvas=` ; mini-migration SQLite qui ajoute les colonnes nouvelles à une base existante.
- Tests : 83 Python (import, JSON brut, plafonds, présence sur le canvas, migration), 36 Node ; E2E serveur :
  Hub avec miniatures réelles, réouverture avec état conservé, **second appareil** (contexte de navigateur
  vierge) restauré à la connexion avec données et état, suppression depuis le Hub (41 contrôles avec faux
  Gemini, 38 en démo) ; E2E statique 29/29.

## 3.5.0-alpha.2 — 2026-09-26 (phase 2 : comptes côté interface)

Le frontend en mode serveur retrouve la génération, désormais liée à un compte.

- **Connexion / inscription** : fenêtre Liquid Glass (onglets Connexion / Créer un compte, rappel des
  Sparks offerts, « Rester connecté »). Une génération lancée sans compte ouvre la fenêtre, garde la demande
  dans le dock et la relance après l'inscription. Jeton Bearer en `sessionStorage` (ou `localStorage` si
  « Rester connecté »), vérifié au démarrage (`/api/auth/me`) ; session expirée : retour à la connexion.
- **Anneau de Sparks** dans la barre du haut : solde, jauge irisée (orange quand il baisse, rouge à sec),
  « −1 » animé à chaque débit ; menu du compte (e-mail, tarifs, Prism Pro, déconnexion).
- **Prism Pro** : fenêtre ouverte sur solde insuffisant (vérifié avant de créer la carte, et sur réponse
  403 `insufficient_sparks`, la demande revenant dans le dock) ou depuis le menu. Le paiement n'est pas
  encore ouvert : le bouton l'indique.
- **Refactorisation par `widget_id`** : la carte retient l'identifiant du widget enregistré côté serveur ;
  l'annulation passe par `POST /api/widgets/{id}/undo` pour que la prochaine refactorisation parte de la
  version restaurée.
- Tests : E2E serveur démo (34 contrôles) et faux Gemini (37 contrôles : inscription par la fenêtre,
  reprise de la demande, débit, session conservée, Prism Pro sur solde épuisé), sur une base SQLite
  jetable (`tools/e2e_server.py [--demo]`) ; E2E statique inchangé (29/29).

## 3.5.0-alpha.1 — 2026-09-25 (Velocity & Elegance)

- **Gemini** remplace Groq comme fournisseur principal, côté serveur (`GEMINI_API_KEY`) comme dans le
  navigateur (clé Google AI Studio). Appel REST `generateContent` asynchrone (`httpx`), sans SDK : le paquet
  `google-generativeai` n'est plus maintenu. Chaîne `gemini-3.8-flash` → `gemini-3.6-flash` ; la réflexion
  du modèle (`thought`) est écartée ; quota, modèle retiré, troncature (`MAX_TOKENS`), blocage de sécurité :
  modèle suivant ; clé refusée : arrêt immédiat, Sparks remboursés. Groq reste un secours facultatif.
- **Design system Tailwind** : le prompt système impose les classes Tailwind (mode sombre élégant, verre,
  `rounded-2xl`, ombres subtiles), sans `<style>`. Tout CDN Tailwind écrit par le modèle est remplacé par
  `@tailwindcss/browser@4.3.3` épinglé avec SRI (et autorisé par la CSP) ; ajouté aussi quand le document
  utilise des classes Tailwind sans balise. Règles d'épinglage génériques (`libs.json`), partagées Python/JS.
- **Web Worker** : analyse des fichiers joints et moteur navigateur (appel, nettoyage, validation) hors du
  fil principal ; repli automatique si le worker est indisponible. Dépôt d'un CSV de 5 Mo : 0 ms de blocage
  (contre 4,5 à 15 s).
- **Données en Blob** : les données du fichier joint circulent en Blob (worker → IndexedDB → widget) ; un
  chargeur minimal les remet au widget, qui les parse dans son propre processus. Plus de `srcdoc` de 7 Mo ni
  de re-sérialisation à chaque sauvegarde. Cartes v2 migrées au chargement.
- **Injection au rythme des images** : documents injectés via `requestAnimationFrame`, une carte par image ;
  signal « prêt » émis par le widget une fois ses styles Tailwind compilés, puis fondu enchaîné.
- **Squelette holographique** à la place du faisceau de chargement : silhouette de carte irisée, barres
  animées et reflet balayant, en `transform`/`opacity` uniquement.
- **Rendu allégé** : aurore en dégradés radiaux (plus de flou ni de `hue-rotate` plein écran animés), animée
  seulement canvas vide ; cartes sans `backdrop-filter`. Canvas au repos : 60 images/s (contre 31–35).
- Pièce jointe : état « Analyse en cours… » pendant le travail du worker ; retirer le fichier annule l'analyse.
- Copie du code : `ClipboardItem` avec promesse (compatible Safari) ; export `.html` avec les données du Blob.
- Outils : `tools/perf_probe.mjs` (images/s, blocages attribués page/widget, profils CPU) ; E2E : faux Gemini,
  contrôle du fondu squelette → widget. Tests : 77 Python, 34 Node, E2E statique 29/29.

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
