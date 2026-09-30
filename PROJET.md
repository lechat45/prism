# Prism — description complète du projet

> Version décrite : **6.3.0-alpha.1** (30 septembre 2026). En ligne : <https://lechat45.github.io/prism/>,
> API : <https://prism-api-0x4z.onrender.com>. Code : <https://github.com/lechat45/prism> (branches `v3` = site public
> sur GitHub Pages, `v4` = branche déployée par Render pour l'API, `v5` et `v6` = développement ; identiques à chaque publication).
> Ce document est mis à jour à chaque livraison ; le détail technique de chaque version est dans `CHANGELOG.md`.

## Nouveautés

Les dernières mises à jour, de la plus récente à la plus ancienne.

- **6.3.0-alpha.1 — 30 septembre 2026 · un orchestre de modèles.** Prism utilise désormais 13 modèles Google au lieu
  de 3 (Pro, Flash, Lite et Gemma), et ses 3 clés travaillent avec chacun d'eux : 39 quotas au lieu de 3. Chaque tâche
  a sa chaîne de modèles, un modèle saturé ou trop lent passe aussitôt la main, et quand un modèle tarde, le suivant
  part en parallèle. Dans le Nexus, trois profondeurs de pensée : **Rapide**, **Profond** (les modèles les plus
  capables, réflexion poussée) et **Conseil** (trois modèles pensent ensemble, un arbitre tranche ; en War Room, chaque
  esprit parle avec son propre modèle). Le prix de chaque profondeur est affiché avant de penser.
- **6.2.0-alpha.1 — 30 septembre 2026 · le Nexus prend de l'atmosphère.** Une brume en volutes flotte sous le canvas,
  éclairée par les bulles, avec sa météo (clair, brume, aurore, orage). Un **Inventaire** apporte de nouveaux blocs :
  prisme holographique, horloge chrono-quantique (un contexte qui change avec le temps), fusion bionique, émetteur et
  récepteur sans fil. Les esprits parlent dans l'espace (bulles au-dessus d'eux), un clic droit ouvre une roue de
  réactions, et la War Room a un canal par Hub et des réponses en fil. Les Engrammes hors de l'écran s'endorment et se
  réveillent avant d'y revenir (moins de lag). Nouveaux **Paramètres** (⚙ ou Ctrl + K) avec recherche et aperçu en
  direct avant d'appliquer.
- **6.1.0-alpha.2 — 30 septembre 2026 · correctif.** Couper un fil dans le Nexus fonctionne à coup sûr, même avec
  plusieurs Engrammes vivants à l'écran.
- **6.1.0-alpha.1 — 30 septembre 2026 · les vrais Engrammes dans le Nexus.** Dans le Nexus, chaque Engramme est de
  nouveau le vrai Engramme cognitif, avec toutes ses bulles qui bougent seules, dans une carte de verre. Il pense à
  partir de ce qu'il est (son axiome, sa méthode, son caractère, les évènements de sa vie) et allume les bulles qu'il
  mobilise ; un double-clic plonge dedans, en grand. Les Engrammes (Nexus et Mode Focus) prennent un air de carte
  stellaire : étoiles qui scintillent, constellations, fils de verre parcourus de lumière, particules au survol.
- **6.0.0-alpha.4 — 27 septembre 2026 · solde exact.** Après « Penser » dans le Nexus, le solde de Sparks affiché est
  relu auprès du serveur (plusieurs esprits pensent en même temps et leurs réponses pouvaient arriver dans le désordre).
- **6.0.0-alpha.3 — 27 septembre 2026 · le serveur suit.** Correctif de mise en ligne : un test automatique bloquait
  depuis la V5 le déploiement de l'API ; il est réparé, et le serveur reçoit enfin les routes qui font penser le Nexus
  avec Gemini. Au passage : un widget très utilisé puis fermé garde désormais sa miniature dans Mon Hub.
- **6.0.0-alpha.2 — 27 septembre 2026 · le Nexus pense pour de vrai.** Le site s'ouvre désormais sur la porte
  d'entrée (Focus ou Nexus). Dans le Nexus, le menu « Intelligence » fait penser les Engrammes avec Gemini, avec votre
  compte Prism : le bouton « Penser » affiche son prix (0,25 Spark par esprit) avant toute dépense, et la War Room
  débat pour 1 Spark. On peut créer un esprit à partir de n'importe quel nom, et la scène est gardée sur l'appareil :
  on la retrouve en revenant, pensées déjà payées comprises.
- **6.0.0-alpha.1 — 27 septembre 2026 · le Mode Nexus (prototype de la V6).** Prism a son logo, la Lentille Continua
  (trois rubans sans fin entrelacés autour d'une lentille vide), et une porte d'entrée à deux portes : **Focus**, Prism
  tel que vous le connaissez, et **Nexus**, un laboratoire où l'on relie à la main des contextes, des esprits
  (Engrammes) et des écrans par des fils de lumière. Couper un fil fait oublier aussitôt ce qui en dépendait ; un
  double-clic plonge dans un Engramme pour changer sa logique, son humeur et ses souvenirs ; entourer plusieurs
  Engrammes les réunit dans une War Room où ils débattent. Prototype autonome : `frontend/nexus.html`, entièrement dans
  le navigateur (section 6).
- **5.0.0-alpha.5 — 27 septembre 2026 · l'écosystème devient sensitif.** Votre propre Engramme de créateur (Mode
  Miroir, après 50 Sparks, avec votre accord), une aura sonore et haptique facultative, un mode spatial (cartes en arc,
  réalité mixte si l'appareil le permet). En coulisses : une demande déjà servie revient sans appel au modèle ni Sparks
  (bouclier API), et fermer une carte libère désormais tout ce qu'elle occupait en mémoire (vérifié à chaque envoi).
- **5.0.0-alpha.4 — 27 septembre 2026 · les Engrammes calculent et dessinent à part.** Chaque Engramme fait tourner sa
  physique et son dessin sur un fil séparé (Web Worker) : la carte reste réactive même quand plusieurs Engrammes
  vivent en même temps (avec cinq Engrammes, le pointeur répond en ~10 ms au lieu de 100 à 300 ms). La physique ne
  s'emballe plus quand la machine ralentit, et les Engrammes au repos se partagent un budget de calcul pour ne jamais
  priver le reste de Prism. Première étape de la phase 1 de la V5 « Écosystème sensitif ».
- **5.0.0-alpha.3 — 27 septembre 2026 · les clés Gemini travaillent ensemble.** Les trois clés du serveur se partagent
  les demandes : chacune part sur la clé la moins occupée, si bien qu'un Engramme en cours (près d'une minute) ne
  retient pas les suivants, qui partent sur les autres clés. Une clé surchargée ou au quota passe aussitôt la main et se
  repose un moment. Le nombre de clés s'affiche dans Paramètres → Moteur.
- **5.0.0-alpha.2 — 27 septembre 2026 · l'écosystème vivant.** Glisser un Engramme sur un autre les fusionne en un
  Hyper-Engramme (animation de fusion, provenance de chaque bulle) ; un pointeur qui tourne en rond sur un widget fait
  proposer « Simplifier » (jamais de dépense sans votre clic) ; « Dissoudre » brise une carte en particules dont les
  mots-clés nourrissent, visiblement, les widgets créés ensuite au même endroit. Nouvel onglet Paramètres → Écosystème.
- **5.0.0-alpha.1 — 26 septembre 2026 · fusion côté serveur.** Route `POST /api/engram/fusion` (3 Sparks).
- **4.0.0-alpha.7 — 26 septembre 2026 · mise en ligne réelle.** API sur Render avec base Neon et clés Gemini du
  serveur, bouton « Tester » (compte d'essai), ce document.

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

Tarifs : un widget 1 Spark, une refactorisation 0,5, un Engramme 2, un message à un Engramme 0,25, une fusion 3 ;
dans le Nexus, la pensée d'un esprit 0,25 et un débat de War Room 1. Sans serveur (ou
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
3. Clés et quotas : les clés se **partagent le travail** — chaque appel part sur la clé la moins occupée (un Engramme
   garde sa clé près d'une minute ; le suivant en prend une autre), à égalité sur celle restée au repos le plus
   longtemps ; une clé surchargée (503) ou au quota (429) passe aussitôt la main et se repose (20 s, 1 min) ; toutes
   surchargées → une dernière tentative, puis modèle suivant ; un modèle « lite » en dernier recours quand Google est
   saturé.

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

**Sur un fil à part.** Depuis la 5.0.0-alpha.4, la physique et le dessin tournent dans un **Web Worker** avec une toile
`OffscreenCanvas` : la carte crée ce fil depuis son propre code (sa CSP n'autorise que ces Workers, sans réseau), puis
lui confie sa toile. Elle ne garde que ce qui touche au document (fiche, légende, dépôts, pointeur) et une réplique de
la simulation, mise à jour par des instantanés compacts (positions et tailles des bulles, transférés sans copie). Les
cartes au repos se partagent un budget de calcul (environ 60 % d'un cœur au total, 30 images/s au plus chacune) ; celle
que l'on manipule tourne à pleine vitesse ; une carte hors de l'écran s'arrête. Si le navigateur ne sait pas faire,
tout se passe comme avant, sur le fil de la carte.


**Néo-Constellation (6.1).** L'Engramme se lit comme une carte stellaire : des étoiles scintillent, chaque catégorie
est tracée en constellation, les « arbres » (caractère, moteurs, ombres, évènements) sont reliés au noyau et entre eux
par des fils de verre que parcourt une lueur ; la bulle survolée laisse échapper des particules, entourée d'un arc de
verre qui tourne. Tout se fige si l'on réduit les animations.

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

## 5. L'écosystème vivant (V5)

### 5.1 Fusionner deux esprits : l'Hyper-Engramme

On glisse un Engramme, par sa barre de titre, sur un autre : la cible s'illumine ; au lâcher, la carte revient à sa place
et Prism propose la fusion, avec son prix (3 Sparks) — rien n'est dépensé sans ce clic. Le serveur (ou le moteur du
navigateur, même code) envoie à Gemini **le JSON complet des deux Engrammes** et un schéma de réponse imposé. Le modèle
synthétise un noyau, un caractère, des émotions, des moteurs et des ombres hybrides (qui s'amplifient, s'annulent ou
créent un paradoxe) ; il ne peut rien inventer de factuel : les évènements sont ceux des deux vies (les cinq plus
marquants de chacune, signés du nom de leur personne) et toute bulle nouvelle est marquée comme interprétation. Chaque
bulle porte sa **provenance** (`sources` : A, B ou les deux), visible dans sa fiche.

La carte « Hyper-Engramme · A × B » joue la fusion à sa première ouverture : deux noyaux fantômes, à gauche et à droite,
sont précipités l'un vers l'autre par une gravité qui croît comme le cube du temps ; les bulles de chaque vie partent de
leur côté ; les ombres, qui d'ordinaire s'évitent, se heurtent et glitchent (toile secouée, couleurs décalées) ; un
éclair, puis tout se range en 3,2 s. Ensuite, c'est un Engramme comme les autres.

### 5.2 Darwinisme d'interface

Chaque widget signale déjà la position du pointeur (pour les reflets) ; elle est maintenant horodatée. La page en garde
quelques secondes par carte et le **Web Worker** calcule vitesse, hésitation, zone parcourue et tours autour d'un point.
Plus de 5 secondes de mouvement continu sans clic, à tourner en rond (deux tours, ou 1 500 px dans une zone de 260 px) :
Prism émet `prism.ux.confusion` sur le bus (les autres widgets peuvent y réagir), puis pose sur la carte « Vous cherchez
quelque chose ? Simplifier (0,5 Spark) ». Un clic refactorise le widget avec une consigne « simplifier l'UX » (action
principale évidente, moins de contrôles visibles, une phrase d'aide), annulable. Aucune position ne quitte l'appareil,
aucune dépense sans accord : le mode automatique est un choix explicite (Paramètres → Écosystème), limité à trois
simplifications par 24 heures, chacune annulable.

### 5.3 Sédimentation

« Dissoudre », dans l'inspecteur, brise la carte en particules qui s'enfoncent dans le fond du canvas ; un sédiment reste
incrusté à cet endroit, avec les mots-clés de la carte. Le canvas est découpé en cases de 480 px : un widget créé plus
tard dans la même case reçoit ces mots comme **contexte fantôme**, qu'il peut glisser subtilement (un ton, un exemple,
un libellé) sans changer ce qu'on lui demande. Ce contexte n'est jamais caché : il s'affiche pendant la génération et
dans l'inspecteur de la carte produite, et se désactive ou s'efface dans les Paramètres. Chaque case sert trois fois,
puis ses sédiments s'effacent.

### 5.4 Mode Miroir : votre propre Engramme

Après 50 Sparks dépensés, Paramètres → Écosystème propose « Créer mon Engramme ». Ce clic vaut accord : Prism dresse un
portrait de **votre style de création**, à partir de vos usages seulement — vos demandes, les couleurs que vous
choisissez, vos refactorisations, les Engrammes que vous explorez, vos fusions. Jamais votre adresse, jamais les
données de vos fichiers, aucune déduction sur votre personne (santé, opinions, vie privée…), aucun diagnostic : les
ombres décrivent des habitudes de création, avec bienveillance. Ses dix évènements sont vos propres jalons, réels et
datés (premier widget, première refactorisation, premier Engramme, première fusion, journée la plus féconde…). La carte
« Miroir · Vous » s'utilise comme filtre ADN : vos prochains widgets vous ressemblent. Gratuit, une fois par jour.

### 5.5 Aura sonore et haptique

Facultative (désactivée par défaut) : des sons discrets, synthétisés sur place — un tintement quand deux idées se lient
(une liaison apparaît entre deux widgets, un ADN est injecté), un son grave quand une ombre d'Engramme fuit le pointeur,
une montée quand deux esprits fusionnent, un souffle quand une carte se dissout — et, sur mobile, de brèves vibrations.

### 5.6 Mode spatial

Le bouton de la barre du haut dispose les cartes en arc : inclinées vers vous selon leur place, en profondeur, comme
un mur de verre qui vous entoure. Si l'appareil sait faire de la réalité mixte (WebXR, par exemple un téléphone Android
récent), Prism propose d'y entrer : l'interface Liquid Glass s'affiche par-dessus la pièce filmée.

## 6. Le Mode Nexus (V6)

La V6 fait de Prism un **système d'exploitation cognitif spatial**. `frontend/nexus.html` est à la fois la page
d'accueil du site et le Mode Nexus. Sans serveur, il fonctionne seul (simulation locale) ; avec le serveur Prism, ses
Engrammes pensent avec Gemini.

### 6.1 La porte d'entrée

Fond d'obsidienne, logo animé (la Lentille Continua tourne lentement, son foyer respire) et deux portes de verre :
**Mode Focus**, l'expérience directe (une intention, une interface : l'application Prism actuelle), et **Mode Nexus**,
le laboratoire. Franchir la porte Nexus fait plonger la vue dans le canvas.

### 6.2 Bulles et synapses

| Bulle | Rôle |
| --- | --- |
| **Contexte** (verre cyan) | une donnée brute : un brief, une consigne, un texte ; titre et texte modifiables |
| **Engramme** (carte de verre) | un vrai Engramme cognitif, vivant : il reçoit, pense à partir de ses bulles, transmet sa pensée |
| **Rendu** (écran) | la sortie : titre, données clés, voix de chaque esprit, action principale |
| **Blocs avancés** (Inventaire) | prisme holographique, horloge chrono-quantique, fusion bionique, émetteur et récepteur sans fil (section 6.8) |

On tire une **synapse** depuis le port lumineux de droite d'une bulle jusqu'à une autre bulle ; le fil prend les
couleurs des deux bulles, et une impulsion le parcourt quand l'information passe. Le flux va toujours
**Contexte → Engramme → Rendu** (un Engramme peut aussi nourrir un autre Engramme) ; les fils impossibles (vers un
Contexte, depuis un Rendu, en boucle) sont refusés.

| Geste | Effet |
| --- | --- |
| Glisser une bulle (un Engramme : par son en-tête), le fond | déplacer ; molette ou pincement : zoom ; « Tout voir » ou F |
| Glisser depuis un port | tirer une synapse |
| Clic sur un fil | le **couper** |
| Double-clic sur l'en-tête d'un Engramme (ou ⤢) | **plonger** dedans, en grand |
| Double-clic dans le vide | un nouveau Contexte |
| Alt + glisser (ou l'outil Hub) | entourer des Engrammes : un **Hub** |
| Clic droit, appui long, ou R sur la bulle choisie | la **roue de réactions** (section 6.10) |
| Ctrl + K (ou ⚙) | les **Paramètres**, recherche d'un réglage (section 6.11) |

### 6.3 Le flux, et le fil coupé

Chaque bulle calcule sa **mémoire** à partir de ce qu'elle reçoit, dans l'ordre du graphe. Les données du brief (par
exemple « CO₂, température, bruit ») voyagent le long des fils jusqu'à l'écran. **Couper un fil efface instantanément
la mémoire du nœud suivant** et de tout ce qui en dépendait : l'Engramme privé d'entrée se tait, et l'écran perd sa
voix sur-le-champ.

### 6.4 Les Engrammes du Nexus, et la plongée

Chaque bulle Engramme contient **le vrai Engramme cognitif** de la personne (section 4) : ses 36 à 44 bulles vivantes,
rendues par le même moteur que le Mode Focus ; on survole une bulle pour lire sa fiche de verre. Pour penser, il part
de ce qu'il est : son **axiome**, le **moteur** le plus proche du sujet (et sa directive), un **trait de caractère**,
une **ombre** si le sujet la réveille, et l'**évènement de sa vie** qui s'en rapproche. Les bulles mobilisées
s'allument dans l'Engramme, numérotées.

Un double-clic sur son en-tête (ou le bouton ⤢) fait **plonger** la caméra dedans : l'Engramme s'ouvre en grand, avec
son climat émotionnel, sa pensée dans le Nexus, ce qu'il reçoit et les évènements de sa vie.

### 6.5 Hubs : les War Rooms

Entourer plusieurs Engrammes crée un **Hub** (un anneau qui les suit). Sa **War Room** les réunit : on pose une
question, chacun prend position, puis répond à un autre, et le Hub livre une **synthèse** commune. Chaque Hub a son
**canal** (onglets en haut de la War Room, messages non lus) : un débat continue dans le sien pendant qu'on en lit un
autre. Sous le message d'un esprit, **« Répondre en fil »** lui pose une question à lui seul ; il répond dans le fil
(avec Gemini : le prix d'une pensée, 0,25 Spark, affiché sur « Répondre »). Le panneau s'efface pendant un geste sur
le canvas.

### 6.6 Intelligence : simulation locale ou Gemini

Le menu **Intelligence** (en haut à droite) choisit comment les esprits pensent :

- **Simulation locale** : gratuite et instantanée ; chaque esprit raisonne par règles à partir de son anatomie. C'est
  le mode par défaut, et le seul sans serveur ;
- **Gemini** : de vraies pensées, avec votre compte Prism (le même que dans le Mode Focus ; un compte d'essai s'ouvre
  depuis le menu). Un esprit dont les entrées ou l'anatomie changent passe en attente (« Prêt à penser ») ; le bouton
  **« Penser · 0,5 Spark »** (0,25 par esprit) affiche le prix avant toute dépense, et rien n'est débité sans ce clic.
  Dans la War Room, **« Débattre · 1 Spark »** fait débattre les esprits en deux tours avec une synthèse.

Le serveur vérifie tout ce que le modèle renvoie (un souvenir cité doit exister, chaque esprit parle à chaque tour) et
rend les Sparks si rien n'aboutit. Une pensée payée est gardée pour exactement ces entrées : refaire un fil coupé ne
coûte rien.

Avec Gemini, trois **profondeurs** (menu Intelligence ; prix par esprit / par débat, affichés sur les boutons) :

| Profondeur | Pensée | Débat | Ce qui se passe |
| --- | --- | --- | --- |
| **Rapide** | 0,25 | 1 | Gemini Flash, relayé par Lite puis Gemma si Google sature |
| **Profond** | 0,5 | 2 | les modèles les plus capables d'abord (Pro quand l'offre y donne droit), réflexion poussée |
| **Conseil** | 1 | 3 | trois modèles différents pensent en parallèle, chacun sur sa clé ; un arbitre écrit la pensée finale. En War Room, chaque esprit parle avec son propre modèle, les deux tours en parallèle, et l'arbitre écrit la synthèse |

L'écran de Rendu, la plongée et la War Room disent d'où vient chaque pensée (le modèle, ou les voix du Conseil et
leur arbitre). Changer de profondeur remet les esprits concernés en attente : une pensée payée vaut pour une
profondeur.

### 6.7 D'où viennent les Engrammes, scène gardée

Le menu Engramme propose des **démonstrations** (Marie Curie, Ada Lovelace), **vos Engrammes** déjà créés dans Prism
(cartes de cet appareil, Mon Hub), ou d'en **créer un** pour n'importe quelle personnalité publique : le serveur le
dresse en 25 s à 1 min 30, pour 2 Sparks débités seulement à la réussite. La scène (bulles, Engrammes, fils, Hubs,
vue, pensées payées) est **gardée sur l'appareil** et retrouvée en revenant ; le menu « ⋯ » repart d'une scène vide ou
de la démonstration (un second clic confirme).

### 6.8 Inventaire : les blocs avancés

Le menu **Inventaire** réunit les essentiels (Contexte, Engramme, Rendu) et cinq blocs qui enrichissent le flux :

| Bloc | Rôle |
| --- | --- |
| **Prisme holographique** | relais de verre : laisse passer le flux et le projette (transparence réglable) |
| **Horloge chrono-quantique** | une source dont l'état change avec le temps : un état par ligne, période de 3 à 60 s ; un clic sur son anneau la fige (l'état observé) ; un Engramme qui la reçoit pense « avec ce moment » |
| **Fusion bionique** | fond tous les flux reçus en une seule pensée, qui garde la voix de chacun |
| **Émetteur / Récepteur sans fil** | tout ce qui entre dans un émetteur ressort des récepteurs du même canal, sans fil (liaison en pointillés) ; « Paire sans fil » crée les deux sur un canal libre |

Les règles du flux valent pour eux : une horloge ou un récepteur ne reçoivent pas de fil, un écran ou un émetteur n'en
émettent pas, et aucune boucle n'est permise, liaisons sans fil comprises (une boucle créée en changeant de canal est
signalée et le flux s'y arrête).

### 6.9 Atmosphère et anti-lag

Sous le canvas flotte une **brume volumétrique** (WebGL) éclairée par les bulles : chacune est une source de lumière
qui se diffuse dans la brume et transparaît à travers le verre, plus vive quand l'esprit pense. La météo change d'elle-
même (clair, brume, aurore, orage aux éclairs brefs) ou se fixe dans les Paramètres ; l'**illumination globale** teinte
la surface sous chaque bulle. Sans carte graphique (rendu logiciel), la brume devient de simples lueurs, bien moins
coûteuses ; elle se met en pause quand la page est cachée ou pendant une plongée.

**Streaming prédictif** : la caméra est suivie ; un Engramme hors de l'écran (et de là où la caméra va dans 0,65 s)
s'endort après 2,5 s, et ceux vers lesquels elle se dirige se réveillent avant d'entrer à l'écran. Au-delà d'un
plafond d'Engrammes vivants (4 ou 8 selon la machine), les plus proches du centre passent devant ; une bulle épinglée
reste toujours vivante. Les bulles hors champ ne sont plus peintes. Un compteur facultatif affiche les performances.

### 6.10 Social : bulles de dialogue et roue de réactions

Ce que pense ou dit un esprit (dans le flux ou dans la War Room) apparaît dans une **bulle de dialogue** au-dessus de
lui, dans le canvas, lisible à tout zoom. La **roue de réactions** (clic droit, appui long sur écran tactile, ou R sur
la bulle choisie) propose : approuver, une idée, une question, attention, **ping** (la bulle pulse) et **épingler**.

### 6.11 Paramètres « Liquid Glass »

Le bouton ⚙ (ou **Ctrl + K**, qui place directement dans la recherche) ouvre les Paramètres du Nexus : Rendu
(atmosphère, météo, densité, éclairage, illumination globale, grille, opacité du verre), Performance (images par
seconde, streaming, plafond, occlusion, compteur), Social (bulles, War Room, roue) et Accessibilité (animations). La
recherche filtre en direct (sans accents, mots-clés : « brume », « fps », « emoji »…). Chaque changement s'essaie dans
l'**aperçu en direct** à droite ; rien ne change dans le Nexus avant « Appliquer » ; « Annuler » et « Réglages par
défaut ». Les réglages sont gardés sur l'appareil.

### 6.12 Prochaines étapes

Générer de vrais widgets dans les bulles de Rendu (moteur du Mode Focus), converser avec un Engramme depuis la
plongée, et synchroniser les scènes dans Mon Hub.

## 7. Architecture technique

```
frontend/  (site statique : GitHub Pages, ou servi par l'API)
  index.html, style.css            interface « Liquid Glass » (CSS pur) : le Mode Focus
  nexus.html                        V6 : porte d'entrée (accueil du site) et Mode Nexus, un seul fichier ; pont vers
                                    le compte (js/account.js) pour penser avec Gemini
  assets/logo_prism.svg             le logo, la Lentille Continua
  js/                               modules : canvas, cartes, sandbox, bus, Hub, Spotlight, compte, Engramme,
                                    conversation (chat.js), voix (voice.js), paramètres (prefs.js), Web Worker ;
                                    V5 : confusion.js (pointeur), sediment.js (sédiments), ecosystem.js (réglages)
  engine/                           partagé par les deux moteurs : prompts, gabarits, schémas, validation JS,
                                    moteur navigateur (local.js) ; engram/ : Engramme (schéma, prompts, validation,
                                    fusion, physique, rendu (render.js, dans un Worker), document de carte, démos Marie Curie et Ada Lovelace) ;
                                    nexus/ : prompts et schémas du Nexus (pensée, débat)
backend/   (FastAPI, Python 3.13)
  app.py        génération, santé, CORS, en-têtes de sécurité, garde-fous de production
  engram.py     Engramme, conversation, fusion      auth.py   comptes, sessions JWT, compte d'essai
  billing.py    Sparks (réservation, confirmation, remboursement, grand livre)
  nexus.py      V6 : pensée d'un esprit du Nexus, débat de War Room (vérifiés, remboursés en cas d'échec)
  widgets.py    Mon Hub      providers.py   Gemini (quotas par couple clé × modèle, relais) et Groq en secours
  db.py, models.py   SQLAlchemy : SQLite en local, PostgreSQL (Neon) en production
tools/     E2E Chrome (CDP), serveurs de test, contrôles de déploiement, mesures de performance
```

- **Déploiement** : API + frontend sur **Render** (image Docker, offre gratuite, déploiement seulement après une CI
  verte), base **PostgreSQL sur Neon**, site public sur **GitHub Pages** (branche `v3`) branché sur l'API par la balise
  `<meta name="prism-api">`. Secrets (clés Gemini, base, secret de session) uniquement dans le tableau de bord de Render.
- **Orchestre de modèles (V6.3)** : 13 modèles Gemini en quatre familles (Pro, Flash, Lite, Gemma 4), une chaîne par
  tâche (`engine/gemini.json` : widgets, Engrammes, conversation, Nexus, Profond, arbitre, voix du Conseil). Les clés
  se partagent le travail, et chaque couple clé × modèle a son quota (3 × 13 = 39) : un modèle au quota, saturé ou
  trop lent se repose sur cette clé (ou sur toutes s'il est trop lent), et la chaîne passe au suivant sans l'attendre ;
  dans le Nexus, un modèle qui tarde voit le suivant partir en parallèle (course), la première réponse valable gagne.
  `/api/health` décrit l'orchestre sans jamais montrer les clés. Pour ajouter une clé : l'ajouter à `GEMINI_API_KEY`
  dans Render (séparées par des virgules), elle rejoint aussitôt l'orchestre.
- **Socle (V5, phase 1)** : rendu des Engrammes dans un Web Worker ; une portée par carte défaite à sa fermeture (rien ne
  reste en mémoire, vérifié par la CI) ; bouclier API (une demande déjà servie au même compte revient sans appel au
  modèle).
- **Qualité** : 185 tests Python (sur SQLite et PostgreSQL), 97 tests Node, parité Python ↔ navigateur sur des cas
  partagés, sept scénarios E2E dans Chrome (site statique, serveur de démo, faux Gemini, GitHub Pages → API, Engramme en
  mode serveur et statique, Mode Nexus), contrôle de l'image Docker ; tout est rejoué par la CI GitHub à chaque envoi. Aucun test ne
  touche la production.

## 8. Historique

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
| 5.0.0-alpha.1 | V5 « Écosystème vivant » : route de fusion d'Engrammes (serveur) |
| alpha.2 | fusion par glisser-déposer et Hyper-Engramme animé, darwinisme d'interface, sédimentation, Paramètres → Écosystème |
| alpha.3 | répartition de charge entre les clés Gemini, section « Nouveautés » de ce document |
| alpha.4 | phase 1 : physique et dessin des Engrammes dans un Web Worker (OffscreenCanvas), physique v2, budget de calcul |
| alpha.5 | phase 1 : nettoyage mémoire, bouclier API ; phase 2 : Mode Miroir, aura sonore et haptique, mode spatial |
| 6.0.0-alpha.1 | V6 « Nexus » : logo (Lentille Continua), porte d'entrée Focus / Nexus, prototype du Mode Nexus (synapses, fil coupé, anatomie, War Rooms) |
| alpha.2 | le Nexus pense avec Gemini (compte, Sparks au clic), autres esprits, scène gardée ; la porte d'entrée devient l'accueil du site |
| alpha.3 | CI de nouveau verte (clics des tests à travers le toast), miniatures de Mon Hub, déploiement de l'API du Nexus |
| alpha.4 | Nexus : solde relu après « Penser » ; tests de bout en bout plus robustes (export, écran de rendu) |
| 6.1.0-alpha.1 | Nexus : les vrais Engrammes (vivants, pensée fondée sur leurs bulles, plongée), Néo-Constellation |
| alpha.2 | Nexus : couper un fil fonctionne à coup sûr (géométrie des fils testée par le Nexus) |
| 6.2.0-alpha.1 | Nexus : atmosphère volumétrique et météo, streaming prédictif des Engrammes, Inventaire (prisme, horloge, fusion, sans fil), bulles de dialogue, roue de réactions, canaux et fils de la War Room, Paramètres avec recherche et aperçu |
| 6.3.0-alpha.1 | orchestre de 13 modèles (Pro, Flash, Lite, Gemma), 39 quotas clé × modèle, course des modèles ; Nexus : profondeurs Rapide, Profond et Conseil (plusieurs modèles, un arbitre, une voix par esprit) |

## 9. Limites connues

- Un Engramme créé avant la 5.0.0-alpha.4 garde le moteur inscrit dans sa carte (rendu sur le fil de la carte) ; les
  nouveaux Engrammes profitent du Worker.
- Quand Google est saturé, les longues générations (Engramme) passent par le modèle « lite », moins riche ; un
  Engramme prend de 25 s à 1 min 30.
- L'hébergement gratuit s'endort : première visite après 15 minutes d'inactivité, environ une minute de réveil (Prism
  répond en moteur navigateur pendant ce temps).
- La reconnaissance vocale dépend du navigateur (Chrome, Edge, Safari) ; l'incantation demande que le focus ne soit pas
  dans un widget.
- Le Mode Nexus garde sa scène sur l'appareil seulement (pas encore dans Mon Hub) ; ses bulles de Rendu composent un
  écran à partir des pensées, pas encore un widget généré.
- La brume du Nexus demande une carte graphique (WebGL matériel) ; sinon, simples lueurs. Un Engramme endormi
  (hors champ) redémarre en une à deux secondes quand il revient à l'écran.
- Les Engrammes restent des interprétations : leur qualité dépend du dossier public de la personne et du modèle.
