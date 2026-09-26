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
| **Bus d'évènements** | les widgets se parlent : `prism.emit(sujet, données)` / `prism.on(sujet, fn)` ; liaisons tracées sur le canvas ; une nouvelle génération connaît les sujets des widgets présents et peut s'y brancher |
| **Spotlight** | Ctrl/Cmd + K (même dans un widget) : générer, refactoriser la carte sélectionnée, sauter à une carte, commandes, widgets de « Mon Hub », au clavier |
| **Liquid Glass** | aurore sous le verre dépoli, reflets des bords qui suivent le pointeur, squelette holographique pendant la génération, fondu enchaîné vers le widget une fois prêt |
| **Engramme cognitif** (V4) | « Engramme : Marie Curie » : carte interprétative de l'esprit d'une personnalité publique en 36 à 44 bulles vivantes (noyau, caractère et émotions, moteurs, ombres, artefacts datés), moteur physique ressort-masse natif ; chaque bulle devient un **filtre ADN** pour vos générations |
| **Zoom fractal** (V4) | double-clic sur une partie d'un widget : Prism propose d'en faire un widget complet, qui émerge du point cliqué |
| **Paramètres** | roue dentée : compte et solde, « Mes écrits » (conversations, demandes, export JSON), moteur et clés, version |
| **Incantation** (V4) | maintenir Espace et parler : la demande dictée devient une carte sous le pointeur ; pendant l'écoute, le **verre organique** respire avec la voix |

## Deux façons de l'utiliser

| | GitHub Pages (statique) | Serveur Python local |
| --- | --- | --- |
| Adresse | <https://lechat45.github.io/prism/> | <http://127.0.0.1:8000> |
| Sans clé Gemini | widgets de démonstration | widgets de démonstration |
| Avec une clé Gemini | la vôtre, via le badge du moteur (en haut à droite), appel direct navigateur → `generativelanguage.googleapis.com` | `GEMINI_API_KEY` dans `backend/.env` (+ compte Prism, cf. v3) |
| Compte | aucun (votre clé, votre quota) | inscription par e-mail, 50 Sparks offerts ; génération 1 Spark, refactorisation 0,5 |
| Mon Hub | — | bibliothèque des widgets, canvas retrouvé sur tout appareil connecté |
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
| Prélude | remonte les erreurs JS (statut de la carte), relaie Ctrl + molette vers le canvas, applique l'accent à chaud, fabrique la miniature du Hub à la demande de la page (image matricielle seulement, vérifiée avant envoi), fournit `window.prism` (bus d'évènements : tout passe par la page, qui filtre) |
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

## Mon Hub (mode serveur, compte connecté)

- **Bibliothèque** (bouton « Mon Hub ») : tous vos widgets, du plus récent au plus ancien, avec miniature,
  recherche, « Ouvrir » (ou « Afficher » s'il est déjà sur le canvas) et suppression définitive (double clic
  de confirmation). Fermer une carte la retire du canvas, pas du Hub.
- **Miniatures** fabriquées par le widget lui-même, dans sa sandbox : la page ne peut pas lire l'iframe,
  alors le prélude clone le document (graphiques `<canvas>` figés en images, saisies reportées), le rend dans
  une image SVG sans réseau et renvoie un `data:image/webp` de quelques Ko. Refaite après une génération, une
  refactorisation, un changement de couleur ou quelques secondes après la dernière modification de l'état.
- **Synchronisation** : chaque carte liée envoie ses changements (disposition, état du widget, couleur, titre),
  regroupés toutes les 1,2 s ; les données du fichier joint partent une fois, en Blob, sans passer par le
  fil principal. À la connexion sur un autre appareil, les cartes posées sur le canvas y sont restaurées,
  données du fichier et état compris ; l'annulation d'une refactorisation passe par les versions du serveur.
- **Import** : une carte créée hors compte (GitHub Pages, avant connexion) rejoint le Hub au moment de sa
  première refactorisation, sans coût en Sparks.
- Limites actuelles : fusion additive (une carte fermée sur un appareil reste ouverte sur un autre jusqu'à
  sa fermeture là-bas) ; données de fichier au-delà de 16 Mo gardées sur l'appareil d'origine.

## Bus d'évènements (widgets connectés)

Chaque widget dispose de `window.prism` (fourni par le prélude de sa sandbox) :

```js
prism.emit("sales.region.selected", { region: "Nord", value: 12400 }); // publie aux autres widgets
const stop = prism.on("sales.region.selected", (data, meta) => { … });  // reçoit (et la dernière valeur connue)
prism.on("*", (data, { topic, from }) => { … });                       // tout le trafic
```

- **La page relaie**, jamais d'un widget à l'autre directement : seulement aux abonnés, jamais à l'émetteur,
  après validation (sujet `[A-Za-z0-9._:-]`, 64 caractères, données JSON de 64 Ko au plus) et sous un débit
  plafonné par carte (rafales tolérées, boucles infinies coupées et signalées).
- **Dernière valeur** gardée par sujet : un widget ouvert après coup la reçoit à l'abonnement (`meta.replay`).
- **Liaisons** émetteur → auditeur tracées sur le canvas ; une lueur les parcourt à chaque évènement.
  L'inspecteur liste les sujets émis et écoutés (compte, dernière valeur) et permet d'**isoler** une carte.
- **Contexte du modèle** : chaque génération ou refactorisation envoie les autres widgets du canvas avec leurs
  sujets et un exemple de données (section `CANVAS` du message, même texte côté serveur et navigateur) ; le prompt
  système apprend au modèle à publier ses sorties et à se brancher sur l'existant quand la demande s'y prête.
- Export `.html` : `window.prism` inerte, le widget fonctionne seul.

## Spotlight et reflets (phase 5)

- **Ctrl/Cmd + K**, partout, y compris le focus dans un widget (le prélude de la sandbox relaie le raccourci) :
  une invite flottante. Taper une demande puis Entrée génère le widget ; si une carte est sélectionnée,
  « Refactoriser » est proposé juste après. La même invite trouve les cartes du canvas (titre, demande, sujets du
  bus), les commandes (Tout voir, Ranger, Zoom 100 %, joindre un fichier, Mon Hub, Prism Pro, réglages, exporter,
  isoler du bus, fermer…) et les widgets de « Mon Hub » à rouvrir. Recherche sans accents ni casse, flèches et
  Entrée ; une commande bien nommée passe devant « Générer ».
- **Reflets** : le bord et la barre d'une carte captent la lumière du côté du pointeur, y compris quand il survole
  une autre iframe (position relayée ~30 fois/s). Calcul depuis les coordonnées du monde, sans lecture de mise en
  page, une fois par image, et seulement pour les cartes visibles. La lumière est peinte dans le fond de la carte :
  aucune couche ne recouvre l'iframe (une superposition ralentit l'aiguillage des clics vers une iframe isolée).
- **IntersectionObserver** : il sait quelles cartes sont à l'écran (marge de 300 px). Une carte jamais démarrée et
  hors champ (canvas restauré, appareil neuf) garde son squelette et ne charge son iframe qu'à son approche ; un
  grand canvas se restaure donc sans lancer des dizaines de widgets invisibles.

## Prism V4 « Singularité » : l'Engramme cognitif

Tapez **« Engramme : Marie Curie »** (dock, Spotlight ou voix) : Prism cartographie l'esprit d'une
personnalité publique, vivante ou historique, en une constellation de 36 à 44 bulles : sa façon de penser, mais aussi
son caractère et ses émotions.

| Catégorie | Bulles | Rendu et physique |
| --- | --- | --- |
| **A. Noyau** | 1 axiome | orbe blanc massif, rappelé au centre par un ressort très raide : immobile |
| **E. Caractère et émotions** | 6 à 8 : traits de caractère, émotions (source, manifestation), attachements (ce qui l'émeut) | orbes chauds teintés par leur émotion, anneau intérieur au plus près du noyau, **battement de cœur** (« lub-dub ») au rythme de l'émotion : colère rapide, sérénité lente |
| **B. Moteurs opérationnels** | 8 à 10 : algorithme de résolution, empreinte syntaxique (mots-clés), matrice esthétique (palette), méthode de travail | cyan, orbite proche, liens épais vers le noyau, dérive lente et amortie |
| **C. Ombres et biais** | 10 à 15 : paradoxes, peurs primaires, biais cognitifs | violet / cramoisi, orbite médiane, bruit lissé et sursauts, se repoussent entre elles, **fuient le pointeur**, pulsation asynchrone, glitch (aberration chromatique, tranches décalées) |
| **D. Artefacts chronologiques** | exactement 10 évènements datés, avec leur impact | or, minuscules, orbite lointaine, rapides, traînées |

- **Caractère et émotions** : 12 émotions reconnues (joie, émerveillement, passion, tendresse, sérénité, fierté,
  mélancolie, tristesse, colère, peur, angoisse, solitude), chacune avec sa couleur. Toute bulle peut porter une
  **charge émotionnelle** (fin halo coloré, ligne dans sa fiche) ; l'Engramme porte le **tempérament** de la personne
  (son caractère en une phrase) et son **climat émotionnel** (2 à 4 émotions pondérées) : puces dans l'en-tête et
  **aura** qui teinte toute la carte. Émotions lues dans les sources publiques (écrits, journaux et lettres publiés,
  témoignages), décrites comme des expériences vécues, jamais comme des troubles.
- **Discuter avec la personne** : le bouton « Discuter avec Marie Curie » de la carte (ou Spotlight, ou « Mon Hub »)
  ouvre une conversation avec une simulation fondée sur toutes les données écrites de l'Engramme (tempérament, climat,
  bulles, sources, liens), à la première personne, clairement présentée comme une simulation (jamais la personne, aucune
  citation inventée). Chaque réponse arrive avec sa **logique** : 1 à 4 bulles, dans l'ordre du raisonnement, que des
  **ronds numérotés** écrivent un à un sur la carte (fil lumineux de bulle en bulle, explication tapée lettre à lettre).
  ¼ de Spark par message ; sans clé, une réponse de démonstration honnête. Historique gardé avec la carte.
- **Mon Hub** : les personnes (Engrammes) en tête, avec « Discuter » et « Ouvrir ».
- **Mouvement logique et organique** : chaque bulle a une place calculée. Les artefacts forment une horloge (ordre
  chronologique, sens horaire depuis midi) ; chaque bulle intérieure se tourne vers ce qui l'a forgée ou qu'elle nourrit
  (lecture radiale : évènement → émotion → trait → noyau), les types restent groupés, les places sont équidistantes
  (aucun chevauchement) et tout l'Engramme tourne d'un bloc : les alignements restent vrais. Organique par-dessus :
  respiration, battement du cœur, ombres erratiques qui reviennent à leur place, épicycles vifs des artefacts.
- **Moteur physique natif** (`frontend/engine/engram/physics.js`, sans D3) : ressort-masse, Euler semi-implicite
  à pas fixe (1/120 s), déterministe (graine), anneaux elliptiques épousant la carte, répulsion à courte portée.
  La bulle survolée s'arrête et grossit ; une fiche **Liquid Glass** (`bg-white/10 backdrop-blur-xl
  border-white/20 shadow-2xl`) montre titre, contenu, directive ADN, source (documenté / déclaré /
  interprétation), date et impact, palette, vocabulaire.
- **Définition JSON stricte** : Gemini reçoit un schéma de réponse (`responseSchema`, `engine/engram/schema.json`)
  et renvoie un JSON garanti ; `backend/engram.py` (et son jumeau `engine/engram/engram.js`, parité testée)
  en vérifie le sens : comptes par catégorie, types présents, dates vérifiables, liens valides. Un modèle qui
  échoue passe la main au suivant ; si le schéma est refusé partout, nouvel essai en JSON simple.
- **Éthique** : personnalités publiques uniquement (refus motivé sinon, Sparks rendus), faits publics
  seulement, aucune citation ni date inventée, ombres présentées comme des interprétations et jamais comme des
  diagnostics ; chaque carte porte la mention « portrait interprétatif généré par IA d'après des sources
  publiques ».
- **Injection d'ADN** : un clic sur une bulle en fait le **filtre ADN** du dock (la prochaine demande passe par ce
  trait : esthétique, logique, ton) ; un fichier CSV/JSON/TXT ou un texte **déposé sur une bulle** lance
  aussitôt la génération filtrée, à côté de l'Engramme. Le trait part avec la demande (`dna`), avec le tempérament,
  l'émotion de la bulle et le climat émotionnel : le widget en reprend le caractère et le registre émotionnel
  (couleurs, mouvement, textes), sans jamais faire parler la personne.
- **Zoom fractal** : double-clic sur une partie d'un widget (tableau, graphique, formulaire…) → proposition
  « Zoom fractal » ; le sous-composant devient un widget complet, avec les mêmes données, qui émerge du point cliqué.
- **Incantation** : Espace maintenu (hors d'un champ) ouvre l'écoute (Web Speech API) ; la transcription
  s'affiche sous le pointeur ; au relâchement, la carte naît à cet endroit (« engramme de … » crée un Engramme).
  Aussi depuis Spotlight (« Incantation vocale »).
- **Verre organique** : pendant l'écoute, le volume du micro (AudioContext + AnalyserNode) module le flou et la
  saturation du verre et la taille de l'orbe. Uniquement pendant l'incantation : aucun repeint continu au-dessus
  des widgets. Le micro est réservé à la page (`Permissions-Policy: microphone=(self)`), jamais aux widgets.
- Coût en mode serveur : **2 Sparks** par Engramme ; sans clé (démo), l'Engramme d'exemple de Marie Curie.

## Architecture

```
index.html              point d'entrée GitHub Pages → redirige vers frontend/
backend/
  app.py                FastAPI asynchrone : /api/generate (demande, fichier joint, refactorisation), /api/health, CORS
  providers.py          appels Gemini (REST generateContent) et Groq (secours), erreurs fatales ou « modèle suivant »
  auth.py, billing.py, widgets.py, models.py, db.py, security.py   comptes, Sparks, historique (v3)
  sanitize.py           nettoyage de la sortie LLM, épinglage de Tailwind et Chart.js, validation HTML/JS
  mocks.py              mode démo (lit les gabarits partagés)
  engram.py             V4 : /api/engram, validation de l'Engramme, repli JSON simple
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
  js/account.js         compte (mode serveur) : session Bearer, appels authentifiés, solde de Sparks
  js/account-ui.js      anneau de Sparks, menu du compte, fenêtres connexion/inscription et « Prism Pro »
  js/hub.js             « Mon Hub » : bibliothèque des widgets (miniatures, recherche, réouverture, suppression)
  js/sync.js            copie des cartes vers le serveur, import des cartes locales, restauration
  js/bus.js             bus d'évènements entre widgets : relais filtré, dernière valeur, liaisons, contexte du modèle
  js/links.js           liaisons du bus dessinées sur le canvas (SVG), lueur à chaque évènement
  js/spotlight.js       barre de commande Ctrl/Cmd + K : classement, liste, exécution
  js/reflections.js     IntersectionObserver (cartes visibles, démarrage différé) et reflets des bords
  js/engram.js          V4 : document des cartes Engramme, données relues, trait ADN d'une bulle
  js/voice.js           V4 : incantation (Espace maintenu, reconnaissance vocale) et verre organique (micro)
  js/store.js           persistance IndexedDB
  engine/               ── partagé par les deux moteurs ──
    system-prompt.txt     contrat de sortie : HTML seul, Tailwind uniquement, persistance, --accent, Chart.js, PRISM_FILE
    user-template.txt, file-template.txt, refactor-template.txt, canvas-template.txt
    gemini.json, groq.json, libs.json  modèles et bibliothèques autorisées (URL + SRI)
    mocks/                gabarits de démo (compteur, calculatrice, dashboard, CSV, JSON, TXT…)
    sanitize.js, local.js portage JS du nettoyage et moteur navigateur
    dna-template.txt      section « filtre ADN » du message (trait d'Engramme)
    engram/               V4 : schema.json (réponse imposée à Gemini), system-prompt.txt, user-template.txt,
                          engram.js (validation, document de carte), physics.js (moteur ressort-masse),
                          viewer.html (rendu Canvas, fiche Liquid Glass), demo-marie-curie.json
  tests/                fixtures partagées, tests Node (moteur, sandbox, fichiers, worker)
tools/
  e2e_canvas.mjs        E2E : Chrome headless via CDP (deux widgets, vrais clics et glisser-déposer…)
  e2e_server.py         backend branché sur un faux Gemini local (génération « réelle », refactorisation)
  perf_probe.mjs        mesures de fluidité (images/s, blocages du fil principal), profils CPU facultatifs
  e2e_pages_api.mjs     E2E : frontend servi comme GitHub Pages, API distante endormie puis réveillée
  e2e_engram.mjs        E2E V4 : Engramme, survol et fiche, filtre ADN, dépôt sur une bulle, zoom fractal,
                        incantation (micro factice, reconnaissance simulée), verre organique, rechargement
  prod_local.py         Prism en configuration de production, en local (port 8005)
  check_deploy.py       contrôles d'un déploiement (santé, en-têtes, CORS, frontend, authentification)
  serve_static.py       sert le site en statique, comme GitHub Pages
  check_generate.py     valide une réponse enregistrée par curl
  pixel_logo.py         génère le logo pixel art
Dockerfile, render.yaml  image de production et blueprint Render (cf. DEPLOY.md)
.github/workflows/ci.yml tests Python (SQLite + PostgreSQL), Node, E2E Chrome, image Docker
```

## Mise en ligne

Tout est prêt pour un déploiement gratuit : **API + frontend sur Render** (image Docker), **base PostgreSQL
sur Neon**, **GitHub Pages** branché sur l'API par une balise `<meta name="prism-api">`. Pas à pas, limites
des offres gratuites, sécurité et dépannage : **[DEPLOY.md](DEPLOY.md)**.

- En production (`PRISM_ENV=production`, déjà dans l'image), le serveur **refuse de démarrer** sans secret de
  session d'au moins 32 caractères ni base PostgreSQL ; il envoie des en-têtes de sécurité et lit l'IP réelle
  derrière le proxy de l'hébergeur.
- Hébergement gratuit endormi : le frontend démarre en moteur navigateur (« Réveil du serveur… ») et bascule
  en mode serveur au réveil, sans rechargement.
- `python tools/check_deploy.py https://…` contrôle un déploiement en lecture seule.

## Tests

```bash
.venv/Scripts/python -m unittest discover -s backend/tests      # backend + parité Python ↔ JS
node --test frontend/tests/*.test.*                              # (bash) moteur, sandbox, bus, Engramme, physique…
.venv/Scripts/python tools/e2e_server.py --demo &                 # serveur démo, base jetable
node tools/e2e_canvas.mjs --base http://127.0.0.1:8004
.venv/Scripts/python tools/serve_static.py &                      # comme GitHub Pages
node tools/e2e_canvas.mjs --base http://127.0.0.1:8001/
node tools/perf_probe.mjs --base http://127.0.0.1:8001/           # fluidité (--profile dossier : profils CPU)
.venv/Scripts/python tools/e2e_server.py &                        # faux Gemini : génération et refactorisation
node tools/e2e_canvas.mjs --base http://127.0.0.1:8003 --refactor
node tools/e2e_pages_api.mjs --api http://127.0.0.1:8004          # GitHub Pages → API (serveur démo lancé)
node tools/e2e_engram.mjs --base http://127.0.0.1:8004             # V4 : Engramme, ADN, zoom fractal, incantation
node tools/e2e_engram.mjs --base http://127.0.0.1:8001/frontend/   # V4 : idem, moteur navigateur
.venv/Scripts/python tools/prod_local.py &                       # configuration de production, port 8005
.venv/Scripts/python tools/check_deploy.py http://127.0.0.1:8005 --allow-demo
```

La CI GitHub (`.github/workflows/ci.yml`) rejoue tout cela à chaque envoi, la suite Python aussi sur
PostgreSQL (`PRISM_TEST_DATABASE_URL`), et construit l'image Docker de production.

> Face à un serveur, l'E2E crée un compte jetable par la vraie fenêtre d'inscription (saisie clavier),
> vérifie la reprise de la demande, l'anneau de Sparks, la session après rechargement et « Prism Pro »
> (le faux Gemini n'offre que 5 Sparks pour atteindre le solde épuisé). `tools/e2e_server.py` utilise
> une base SQLite temporaire : `data/prism.db` n'est jamais touchée.

Validation d'une réponse brute (inscription, puis génération avec le jeton) :

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/auth/register -H "Content-Type: application/json" \
     -d '{"email":"moi@exemple.fr","password":"un-mot-de-passe-solide"}' | python -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -s -X POST http://127.0.0.1:8000/api/generate -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
     -d '{"prompt":"Crée un bouton interactif qui change de couleur au clic et compte le nombre de clics"}' \
     -o resp.json && .venv/Scripts/python tools/check_generate.py resp.json
```

## Prism v3 — plateforme SaaS

| Phase | Contenu | État |
| --- | --- | --- |
| 1. Backend | comptes (JWT + scrypt), Sparks (réservation atomique, remboursement, grand livre), historique des widgets, API | **fait** (`3.0.0-alpha.1`) |
| 3.5 Velocity & Elegance | Gemini, design system Tailwind, Web Worker, données en Blob, injection au rythme des images, squelette holographique | **fait** (`3.5.0-alpha.1`) |
| 2. Comptes côté interface | fenêtre de connexion/inscription Liquid Glass, jauge de Sparks en anneau, fenêtre « Prism Pro » sur 403 | **fait** (`3.5.0-alpha.2`) |
| 3. Mon Hub | panneau d'historique, miniatures générées dans la sandbox, synchronisation du canvas avec le serveur | **fait** (`3.5.0-alpha.3`) |
| 4. Bus d'évènements | `prism.emit` / `prism.on` entre widgets, relayés par le canvas ; le prompt connaît les sujets des widgets présents | **fait** (`3.5.0-alpha.4`) |
| 5. Spotlight et reflets | invite flottante Ctrl/Cmd + K ; reflets des bords via IntersectionObserver et position du pointeur | **fait** (`3.5.0-alpha.5`) |
| 6. Déploiement | image Docker, blueprint Render, PostgreSQL (Neon), garde-fous de production, en-têtes, CI, frontend Pages pointé vers l'API | **prêt** (`3.5.0-rc.1`) — mise en ligne : [DEPLOY.md](DEPLOY.md) |
| V4 « Singularité » | Engramme cognitif, injection d'ADN, zoom fractal, incantation vocale, verre organique | **fait** (`4.0.0-alpha.1`, branche `v4`) |

API ajoutée en phase 1 (jeton `Authorization: Bearer …` sauf `register`/`login`/`health`) :

| Route | Rôle |
| --- | --- |
| `POST /api/auth/register`, `POST /api/auth/login` | `{ email, password }` → `{ token, user }` (50 Sparks offerts à l'inscription) |
| `GET /api/auth/me` | profil et solde |
| `POST /api/generate` | `{ prompt, file?, widget_id?, canvas?, dna? }` : génère (1 Spark) ou refactorise ce widget (0,5 Spark) ; `canvas` = autres widgets et sujets du bus (20 au plus) ; `dna` = trait d'Engramme qui filtre la génération (V4) ; **403** `insufficient_sparks` si le solde manque |
| `POST /api/engram` | `{ person, language? }` : Engramme cognitif (2 Sparks, V4) ; **422** `engram_refused` (personne non publique, Sparks rendus) |
| `POST /api/engram/chat` | `{ engram, history?, message, language? }` : « Discuter avec … » → `{ reply, trace: [{ id, why }] }` (¼ de Spark, V4) |
| `GET /api/sparks` | solde, tarifs, derniers mouvements |
| `GET /api/widgets[?on_canvas=true]`, `GET/PATCH/DELETE /api/widgets/{id}`, `POST /api/widgets/{id}/undo` | « Mon Hub » : liste légère, détail, état de la carte (`layout`, `clear_layout`, `storage`, `accent`, `title`, `thumbnail`), annulation, suppression |
| `POST /api/widgets` | importe une carte créée hors compte (gratuit, 1 000 widgets par compte au plus) |
| `GET/PUT /api/widgets/{id}/file` | données du fichier joint (`window.PRISM_FILE`) en JSON brut, 16 Mo au plus (`PRISM_MAX_FILE_DATA_MB`) |

## Configuration du serveur

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `GEMINI_API_KEY` | vide (mode démo) | clé API Gemini (Google AI Studio) ; plusieurs clés séparées par des virgules : servies à tour de rôle, une clé au quota (429) ou refusée passe la main |
| `GEMINI_RETRY_DELAY` | `2` | surcharge passagère (503 « high demand ») : nouvelle tentative après ce délai, puis modèle suivant |
| `GEMINI_MODELS` | `gemini.json` (3.8-flash, 3.6-flash, 3.5-flash-lite) | chaîne de modèles, séparés par des virgules (le suivant prend le relais) ; le modèle « lite » final, peu demandé, répond quand Google est saturé |
| `GEMINI_MAX_OUTPUT_TOKENS` | `32768` | tokens de sortie max par appel |
| `GROQ_API_KEY` | vide | secours facultatif, essayé seulement si tous les modèles Gemini échouent |
| `GROQ_MODELS` | `groq.json` | chaîne de modèles Groq |
| `GROQ_REASONING_EFFORT` | `medium` | effort de raisonnement (modèles gpt-oss uniquement) |
| `PRISM_MAX_TOKENS` | `6000` | tokens de sortie max côté Groq |
| `PRISM_TIMEOUT` | `90` | délai par appel, en secondes |
| `PRISM_ENV` | `development` | `production` : refus de démarrer sans secret ni PostgreSQL, HSTS |
| `PRISM_HOST` / `PRISM_PORT` (ou `PORT`) | `127.0.0.1` / `8000` | adresse d'écoute (`PORT` : fourni par l'hébergeur) |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | proxys de confiance (`X-Forwarded-For`) : `*` derrière le proxy d'un hébergeur |
| `PRISM_CORS_ORIGINS` | `*` | origines autorisées, séparées par des virgules |
| `PRISM_JWT_SECRET` | secret de développement dans `data/` | signature des sessions : **obligatoire en production** |
| `PRISM_DATABASE_URL` | `sqlite:///data/prism.db` | base de données ; `postgres://…` / `postgresql://…` acceptés (pilote psycopg 3) |
| `PRISM_ALLOW_SQLITE` | vide | `1` : SQLite tolérée en production (disque persistant seulement) |
| `PRISM_MAX_FILE_DATA_MB` | `16` | données de fichier joint par widget |
| `PRISM_SIGNUP_SPARKS` | `50` | Sparks offerts à l'inscription |
| `PRISM_TOKEN_TTL_HOURS` | `168` | durée d'une session |

Régénérer le logo : `python tools/pixel_logo.py`.
