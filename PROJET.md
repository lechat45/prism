# Prism — description complète du projet

> Version décrite : **4.0.0-alpha.7** (26 septembre 2026). En ligne : <https://lechat45.github.io/prism/>,
> API : <https://prism-api-0x4z.onrender.com>. Code : <https://github.com/lechat45/prism> (branches `v3` = site public,
> `v4` = développement, identiques à chaque publication).

## 1. L'idée

Prism transforme une phrase en **application**. On écrit « un minuteur de concentration », on dépose un fichier CSV,
on parle à voix haute : une **carte** apparaît sur un **canvas infini**, avec une micro-application interactive générée
par un modèle de langage (Gemini). Les cartes se déplacent, se redimensionnent, se parlent entre elles, se
refactorisent et s'exportent.

La V4, « Singularité », ajoute la **recréation de personnes** : l'**Engramme cognitif**, une carte vivante de l'esprit
d'une personnalité publique (sa façon de penser, son caractère, ses émotions, ses failles et les évènements qui l'ont
forgée), avec laquelle on peut **discuter**, et dont chaque trait peut **filtrer** la génération d'autres interfaces.

## 2. Utiliser Prism

| Geste | Effet |
| --- | --- |
| Écrire dans la barre du bas, Entrée | une carte se génère (plusieurs en parallèle, chacune annulable) |
| Glisser un fichier CSV, JSON ou TXT (5 Mo max) | analysé dans le navigateur ; le widget reçoit toutes les données |
| `Engramme : Marie Curie` | carte Engramme de la personne |
| Ctrl/Cmd + K | Spotlight : générer, retrouver une carte, commandes, « Discuter avec … », Mon Hub, Paramètres |
| Maintenir **Espace** et parler | **incantation** : la demande dictée devient une carte sous le pointeur ; le verre de l'interface respire avec la voix |
| Double-clic dans un widget | **zoom fractal** : la partie visée devient un widget complet |
| Glisser le fond, Ctrl + molette | se déplacer, zoomer ; « Tout voir », « Ranger » |
| Clic sur la barre d'une carte | inspecteur : refactoriser, couleur d'accent, export `.html`, code, relance |
| Roue dentée | **Paramètres** : compte, « Mes écrits », moteur, version |

**Comptes.** Sur le site public, le serveur Prism fournit comptes, **Sparks** (crédit d'utilisation), **Mon Hub**
(bibliothèque synchronisée entre appareils) et la génération avec les clés Gemini du serveur : les visiteurs n'ont besoin
d'aucune clé. Deux façons d'entrer :

- **Se connecter / créer un compte** : e-mail + mot de passe, 50 Sparks offerts ;
- **Tester** : un **compte d'essai** immédiat, sans e-mail, avec 10 Sparks ; il fonctionne comme un vrai compte et
  disparaît à la déconnexion.

Tarifs : un widget 1 Spark, une refactorisation 0,5, un Engramme 2, un message à un Engramme 0,25. Sans serveur (ou
pendant son réveil, l'hébergement gratuit s'endort après 15 minutes), Prism bascule sur le **moteur du navigateur** :
démonstration, ou vraie génération avec la clé Gemini de l'utilisateur (Paramètres → Moteur).

## 3. Les widgets

- **Génération** : un prompt système impose un document HTML complet, stylé avec Tailwind (version épinglée, empreinte
  SRI), Chart.js pour les graphiques ; la sortie est nettoyée, validée (structure, ressources autorisées, syntaxe JS)
  et, si un modèle échoue, le suivant prend le relais (Gemini 3.8 Flash → 3.6 Flash → 3.5 Flash Lite).
- **Sécurité** : chaque widget vit dans une iframe `sandbox="allow-scripts"` sans `allow-same-origin`, avec une
  politique de contenu qui bloque tout réseau (sauf les bibliothèques épinglées). Un widget ne peut lire ni Prism, ni les
  autres widgets, ni les clés, ni les sessions. Tout ce dont il a besoin lui est remis par la page.
- **Persistance** : cartes en IndexedDB ; chaque widget dispose d'un `localStorage` persistant (pont `postMessage`) ;
  en mode serveur, copie dans **Mon Hub** (disposition, état, miniature, données du fichier).
- **Bus d'évènements** : `prism.emit(sujet, données)` / `prism.on(sujet, …)` ; les liaisons se dessinent sur le canvas
  et une nouvelle génération connaît les sujets des widgets présents pour s'y brancher.
- **Performance** : analyse des fichiers et moteur navigateur dans un Web Worker, données en Blob, montage des cartes au
  rythme des images, démarrage différé des cartes hors écran, squelette holographique pendant la génération.

## 4. La recréation de personne : l'Engramme cognitif

### 4.1 Ce que c'est — et ce que ce n'est pas

Un Engramme est un **portrait interprétatif**, construit par un modèle de langage **à partir des sources publiques**
(œuvres, décisions, évènements documentés, déclarations, lettres et journaux publiés, biographies, témoignages). Ce
n'est **pas** la personne, ni un diagnostic, ni une biographie exhaustive. Chaque carte le dit : « Portrait interprétatif
généré par IA d'après des sources publiques : ni citation, ni diagnostic ».

Règles imposées au modèle (prompt système, `frontend/engine/engram/system-prompt.txt`) :

- **seulement des personnalités publiques** (adultes, vivants ou historiques) au dossier public étendu ; sinon refus
  motivé, et les Sparks sont rendus ;
- **rien d'inventé** : ni évènement, ni date, ni détail privé, ni sentiment, ni citation ;
- ombres et émotions décrites avec nuance (« tend à… », « écrit que… »), **jamais** comme des troubles ou des
  diagnostics ; rien sur la santé, la sexualité ou la vie privée qui ne soit déjà documenté et central ;
- chaque bulle déclare sa **base** : `documente` (fait établi), `declare` (propos de la personne),
  `interpretation` (synthèse), et sa **source** (`evidence`).

### 4.2 Structure : 36 à 44 bulles en cinq catégories

| Catégorie | Nombre | Types | Rôle |
| --- | --- | --- | --- |
| **A. Noyau** | 1 | `axiome` | le centre de gravité : la conviction fondamentale |
| **E. Caractère et émotions** | 6 à 8 | `trait`, `emotion`, `attachement` | tempérament, émotions marquantes (source, manifestation), ce qui l'émeut (personnes, lieux, causes) |
| **B. Moteurs opérationnels** | 8 à 10 | `algorithme_resolution`, `empreinte_syntaxique` (+ mots-clés), `matrice_esthetique` (+ palette), `methode_travail` | comment la personne pense, parle, voit, travaille |
| **C. Ombres et biais** | 10 à 15 | `paradoxe`, `peur_primaire`, `biais_cognitif` | ce qui rend l'esprit humain : contradictions, peurs, angles morts |
| **D. Artefacts chronologiques** | exactement 10 | `succes`, `echec`, `tournant` | évènements datés (AAAA, AAAA-MM ou AAAA-MM-JJ) avec leur impact |

Chaque bulle porte : titre, contenu (2 à 3 phrases propres à la personne), **directive ADN** (comment une interface
générée « à travers » ce trait doit se présenter), base, source, intensité (0 à 1) et, si elle en a une, sa **charge
émotionnelle** parmi 12 émotions (joie, émerveillement, passion, tendresse, sérénité, fierté, mélancolie, tristesse,
colère, peur, angoisse, solitude). L'ensemble porte le **tempérament** (le caractère en une phrase), le **climat
émotionnel** (2 à 4 émotions pondérées) et jusqu'à 40 **liens** : `forge` (un évènement qui a forgé un trait),
`nourrit`, `contredit`.

### 4.3 Génération et vérification

1. La demande (`POST /api/engram`, ou le moteur du navigateur) part avec un **schéma de réponse imposé** à Gemini
   (`schema.json`) : le JSON reçu est syntaxiquement garanti. Si un modèle refuse le schéma, nouvel essai en JSON simple.
2. `backend/engram.py` (et son jumeau `engine/engram/engram.js`, à **parité exacte** vérifiée par des cas partagés)
   vérifie le **sens** : types cohérents avec leur catégorie, comptes respectés, chaque type présent, dates valides
   (artefacts triés), émotions reconnues, palette hexadécimale, liens entre bulles existantes. Les surplus sont écartés
   (les moins intenses d'abord) ; un Engramme incomplet fait passer au modèle suivant ; le climat absent est déduit des
   émotions des bulles.
3. Clés et quotas : plusieurs clés servies à tour de rôle (quota ou refus → clé suivante), surcharge (503) → nouvelle
   tentative puis modèle suivant ; un modèle « lite » en dernier recours quand Google est saturé.

### 4.4 Rendu et mouvement : logique d'abord, organique ensuite

Le moteur physique (`physics.js`, ressort-masse natif, pas fixe de 1/120 s, déterministe) donne à chaque bulle une
**place calculée** :

- **anneaux concentriques** qui épousent la carte : cœur (le plus proche du noyau), moteurs, ombres, artefacts ;
- **artefacts en horloge** : ordre chronologique, dans le sens des aiguilles d'une montre depuis midi ;
- **alignements** : chaque bulle intérieure se tourne vers ce qui l'a forgée ou qu'elle nourrit, d'où une lecture
  radiale (évènement → émotion → trait → noyau) ; sans lien, les bulles d'un même type restent groupées ;
- **places équidistantes** dans chaque anneau (aucun chevauchement), et **rotation d'un bloc** de tout l'Engramme : les
  alignements ne se défont jamais.

Par-dessus cette logique, la vie : le noyau respire à peine ; les bulles du **cœur battent** (« lub-dub ») au rythme de
leur émotion (colère rapide, sérénité lente) ; les moteurs ondulent ; les **ombres** sont erratiques, se repoussent,
**fuient le pointeur** puis regagnent leur place, et scintillent (glitch) ; les **artefacts**, satellites dorés,
décrivent de petits épicycles avec une traînée. Le **climat émotionnel** teinte l'aura autour du noyau.

Au survol, la bulle s'arrête, grossit et affiche une **fiche en verre** (catégorie, type, émotion, contenu, directive
ADN, base et source, date et impact, palette, mots-clés).

### 4.5 Utiliser un Engramme

- **Filtre ADN** : un clic sur une bulle en fait le filtre de la prochaine demande ; déposer un fichier ou un texte sur
  une bulle lance aussitôt une génération « à travers » ce trait. Le widget reprend la directive, la palette, le
  vocabulaire, le tempérament, l'émotion et le climat de la personne, sans jamais la faire parler.
- **Discuter avec la personne** : le bouton « Discuter avec … » (sur la carte, dans Spotlight, dans Mon Hub) ouvre une
  conversation. Le modèle reçoit **toutes les données écrites** de l'Engramme (tempérament, climat, chaque bulle avec sa
  source, les liens) et l'historique ; il répond à la première personne, dans la voix de la personne (ton, mots,
  raisonnement), en restant dans le dossier public, sans citation inventée, et se présente comme une **simulation** si
  on le lui demande ; pour une personne vivante, rien sur sa vie privée actuelle ni aucun engagement en son nom.
- **Les ronds qui écrivent sa logique** : chaque réponse arrive avec sa **trace** (1 à 4 bulles, dans l'ordre du
  raisonnement, uniquement des bulles de l'Engramme). Sur la carte, un fil lumineux relie ces bulles, des ronds numérotés
  apparaissent un à un et écrivent lettre à lettre ce que chaque bulle apporte ; le reste s'estompe. Dans la
  conversation, les mêmes ronds, cliquables pour rejouer la logique. Sans modèle, une réponse de démonstration honnête
  désigne les bulles qui guideraient la réponse.

## 5. Architecture technique

```
frontend/  (site statique : GitHub Pages, ou servi par l'API)
  index.html, style.css            interface « Liquid Glass » (CSS pur)
  js/                               modules : canvas, cartes, sandbox, bus, Hub, Spotlight, compte, Engramme,
                                    conversation (chat.js), voix (voice.js), paramètres (prefs.js), Web Worker
  engine/                           partagé par les deux moteurs : prompts, gabarits, schémas, validation JS,
                                    moteur navigateur (local.js) ; engram/ : Engramme (schéma, prompts, validation,
                                    physique, document de carte, démo Marie Curie)
backend/   (FastAPI, Python 3.13)
  app.py        génération, santé, CORS, en-têtes de sécurité, garde-fous de production
  engram.py     Engramme et conversation      auth.py   comptes, sessions JWT, compte d'essai
  billing.py    Sparks (réservation, confirmation, remboursement, grand livre)
  widgets.py    Mon Hub      providers.py   Gemini (clés en tourniquet, relais) et Groq en secours
  db.py, models.py   SQLAlchemy : SQLite en local, PostgreSQL (Neon) en production
tools/     E2E Chrome (CDP), serveurs de test, contrôles de déploiement, mesures de performance
```

- **Déploiement** : API + frontend sur **Render** (image Docker, offre gratuite, déploiement seulement après une CI
  verte), base **PostgreSQL sur Neon**, site public sur **GitHub Pages** (branche `v3`) branché sur l'API par la balise
  `<meta name="prism-api">`. Secrets (clés Gemini, base, secret de session) uniquement dans le tableau de bord de Render.
- **Qualité** : 128 tests Python (sur SQLite et PostgreSQL), 72 tests Node, parité Python ↔ navigateur sur des cas
  partagés, six scénarios E2E dans Chrome (site statique, serveur de démo, faux Gemini, GitHub Pages → API, Engramme en
  mode serveur et statique), contrôle de l'image Docker ; tout est rejoué par la CI GitHub à chaque envoi. Aucun test ne
  touche la production.

## 6. Historique

| Version | Apport |
| --- | --- |
| 2.0 | canvas multi-widgets, fichiers, persistance, inspecteur |
| 3.0 – 3.5 | comptes et Sparks, Gemini, design system Tailwind, Web Worker, Mon Hub, bus d'évènements, Spotlight et reflets, déploiement |
| 4.0.0-alpha.1 | V4 « Singularité » : Engramme cognitif, injection d'ADN, zoom fractal, incantation, verre organique |
| alpha.2 | Engramme sur le vrai Gemini, plusieurs clés, relais sur surcharge |
| alpha.3 | caractère et émotions (catégorie E, climat, battement de cœur, ADN émotionnel) |
| alpha.4 | « Discuter avec … », ronds de la logique, mouvement logique, personnes dans Mon Hub |
| alpha.5 – alpha.6 | version affichée, Paramètres |
| alpha.7 | mise en ligne réelle (Render + Neon), bouton « Tester » (compte d'essai), ce document |

## 7. Limites connues

- Quand Google est saturé, les longues générations (Engramme) passent par le modèle « lite », moins riche ; un
  Engramme prend de 25 s à 1 min 30.
- L'hébergement gratuit s'endort : première visite après 15 minutes d'inactivité, environ une minute de réveil (Prism
  répond en moteur navigateur pendant ce temps).
- La reconnaissance vocale dépend du navigateur (Chrome, Edge, Safari) ; l'incantation demande que le focus ne soit pas
  dans un widget.
- Les Engrammes restent des interprétations : leur qualité dépend du dossier public de la personne et du modèle.
