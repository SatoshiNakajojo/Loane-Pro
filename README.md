# 🎤 Studio Vocal

Application web installable (PWA) pour une professeure de chant : agenda synchronisé avec Google Agenda, profils d'élèves avec photo, suivi des paiements, notes de cours, factures & devis, et répertoire de morceaux (paroles + partitions).

L'app s'ouvre dans Safari puis s'installe sur l'écran d'accueil de l'iPhone comme une vraie application. Toutes les données (élèves, cours, paiements, notes, morceaux) sont stockées **directement sur le téléphone** — le Worker Cloudflare sert à la connexion Google Agenda et à la **sauvegarde cloud** quotidienne (protégée par une phrase secrète).

---

## 1. Mettre l'app en ligne sur GitHub Pages (10 min)

1. Crée un compte sur [github.com](https://github.com) si besoin, puis un nouveau dépôt, par exemple `studio-vocal` (public).
2. Envoie tous les fichiers de ce dossier dans le dépôt :
   ```bash
   cd studio-vocal
   git init
   git add .
   git commit -m "Studio Vocal"
   git branch -M main
   git remote add origin https://github.com/TON-COMPTE/studio-vocal.git
   git push -u origin main
   ```
   (ou glisse simplement les fichiers dans l'interface web de GitHub : *Add file → Upload files*)
3. Dans le dépôt : **Settings → Pages → Source : Deploy from a branch → Branch : main / (root) → Save**.
4. Après 1-2 minutes, l'app est en ligne à l'adresse :
   `https://TON-COMPTE.github.io/studio-vocal/`

## 2. Installer l'app sur l'iPhone

1. Ouvre l'adresse ci-dessus dans **Safari** sur l'iPhone.
2. Touche le bouton **Partager** (carré avec flèche) → **Sur l'écran d'accueil** → **Ajouter**.
3. L'icône « Studio Vocal » apparaît sur l'écran d'accueil et l'app s'ouvre en plein écran, même hors ligne.

> ⚠️ **Important** : les données sont stockées dans l'app, sur le téléphone. Pense à faire régulièrement **Réglages → Exporter une sauvegarde** (le fichier peut être rangé dans iCloud/Fichiers). En cas de changement de téléphone, il suffit de restaurer la sauvegarde.

## 3. Activer la synchronisation Google Agenda (optionnel, ~20 min)

La synchro nécessite deux choses : des identifiants Google (gratuits) et un Worker Cloudflare (gratuit) qui garde le « secret » Google en sécurité.

### 3a. Créer les identifiants Google

1. Va sur [console.cloud.google.com](https://console.cloud.google.com) → crée un projet (ex. « Studio Vocal »).
2. Menu **API et services → Bibliothèque** → cherche **Google Calendar API** → **Activer**.
3. **API et services → Écran de consentement OAuth** : type **Externe**, remplis le nom de l'app et ton e-mail. Dans **Utilisateurs test**, ajoute l'adresse Gmail de la professeure (indispensable tant que l'app n'est pas « publiée »).

   > ⚠️ **Important — la synchro qui s'arrête toute seule au bout d'une semaine.**
   > Tant que le projet reste en mode **Test**, Google invalide l'autorisation **tous les 7 jours** : la synchro cesse alors de fonctionner jusqu'à ce qu'on reclique sur « Connecter Google Agenda ». L'app le détecte et affiche « Autorisation Google expirée » dans l'agenda et dans les réglages.
   > Pour ne plus jamais avoir à reconnecter : publie l'application. Dans la console Google, **Google Auth Platform → Audience** (ancienne interface : *API et services → Écran de consentement OAuth*) → **Publier l'application**.
   >
   > Si le bouton est **grisé**, Google réclame d'abord quatre informations dans **Google Auth Platform → Branding** :
   >
   > | Champ | Valeur |
   > |---|---|
   > | Nom de l'application | `Loane Pro` |
   > | E-mail d'assistance | à choisir dans la liste déroulante |
   > | URL de la page d'accueil | `https://TON-COMPTE.github.io/Loane-Pro/` |
   > | URL des règles de confidentialité | `https://TON-COMPTE.github.io/Loane-Pro/confidentialite.html` |
   >
   > La page `confidentialite.html` est fournie dans ce dépôt : elle est en ligne dès que GitHub Pages a publié. Les deux URL doivent être différentes — c'est pour cela qu'il faut une page dédiée.
   >
   > Une fois publiée, l'avertissement « Google n'a pas validé cette application » apparaît à la connexion : **Paramètres avancés → Continuer**. Sans conséquence pour un usage personnel (limite de 100 utilisateurs sans validation).
   >
   > **Ordre conseillé** : publier d'abord, reconnecter ensuite — le jeton est alors émis en production et n'expire plus.
4. **API et services → Identifiants → Créer des identifiants → ID client OAuth** :
   - Type : **Application Web**
   - URI de redirection autorisé : `https://studio-vocal-auth.TON-COMPTE.workers.dev/auth/callback`
     (tu connaîtras l'adresse exacte du worker à l'étape suivante — tu peux revenir la corriger)
5. Note le **Client ID** et le **Client Secret**.

### 3b. Déployer le Worker Cloudflare — **sans ligne de commande** (tout dans le navigateur)

1. Crée un compte gratuit sur [dash.cloudflare.com](https://dash.cloudflare.com).
2. Dans le menu de gauche : **Workers & Pages** (ou « Compute ») → **Create** → **Create Worker** (modèle « Hello World »).
3. Donne-lui le nom `studio-vocal-auth` → **Deploy**.
4. Clique sur **Edit code** : efface tout le code affiché, **colle à la place le contenu complet du fichier `worker/worker.js`** de ce projet → **Deploy** (en haut à droite).
5. Reviens sur la page du worker → onglet **Settings** :
   - **Variables and Secrets → Add** :
     - Type **Text** — nom `ALLOWED_ORIGIN` — valeur : l'**origine** de ton site, sans chemin ni `/` final, ex. `https://TON-COMPTE.github.io`
       (plusieurs origines possibles, séparées par des virgules ; un `/` final ou une URL complète sont tolérés)
     - Type **Secret** — nom `GOOGLE_CLIENT_ID` — valeur : le Client ID de l'étape 3a
     - Type **Secret** — nom `GOOGLE_CLIENT_SECRET` — valeur : le Client Secret
     - Clique **Deploy** pour appliquer.
6. **Pour la sauvegarde cloud** (recommandé) :
   - Menu de gauche → **Storage & Databases → KV** → **Create namespace** → nom : `studio-vocal-backups`.
   - Retourne sur ton worker → **Settings → Bindings → Add → KV Namespace** :
     - Variable name : `BACKUPS` (exactement en majuscules)
     - Namespace : `studio-vocal-backups`
     - **Deploy**.
7. L'URL du worker est affichée sur sa page d'accueil, par ex. `https://studio-vocal-auth.ton-compte.workers.dev`. **Copie-la**, et vérifie côté Google (étape 3a-4) que l'URI de redirection est bien cette URL suivie de `/auth/callback`.
8. **Vérification** : ouvre `https://TON-WORKER.workers.dev/health` dans le navigateur. Tu dois voir `{"ok":true,"google":true,"kv":true,"origines":["https://TON-COMPTE.github.io"]}`. Un `false` t'indique exactement ce qui manque. Le bouton **Réglages → Données & sauvegarde → Tester l'accès au cloud** fait la même vérification depuis l'app et affiche le problème en clair.

> 💻 *Alternative pour développeurs* : le dossier `worker/` contient aussi un `wrangler.toml` pour déployer via `npx wrangler deploy` si tu préfères la ligne de commande (elle nécessite Node.js installé sur un ordinateur — c'est ce qui coince souvent, la méthode navigateur ci-dessus fait exactement la même chose).

### 3c. Brancher l'app sur le worker

1. Ouvre `js/config.js` et renseigne :
   ```js
   const WORKER_URL = "https://studio-vocal-auth.ton-compte.workers.dev";
   ```
2. Pousse la modification sur GitHub (`git add . && git commit -m "worker" && git push`).
3. Dans l'app : **Réglages → Connecter Google Agenda** → connexion avec le compte Google de la professeure → c'est fait ✅

### Ce que fait la synchro

**La synchro est en lecture seule : l'app ne modifie jamais Google Agenda.** Rien n'y est ajouté, modifié ni supprimé.

- L'app **lit** les événements du calendrier principal (rendez-vous horaires **et** journées entières) et les affiche dans l'agenda.
- **La couleur de l'événement dit s'il s'agit d'un cours**, et où il a lieu. Par défaut : **lavande** = cours à domicile, **raisin** = cours à l'école. Les événements d'une autre couleur — ou sans couleur attribuée — sont ignorés : ils n'encombrent ni l'agenda ni la liste « à rattacher ». Ces deux couleurs se changent dans **Réglages → Google Agenda**.
- Un événement de la bonne couleur dont le titre désigne **un seul élève existant** est **rattaché automatiquement**. Le cours est créé « en attente » : il ne compte ni dans les heures ni dans les forfaits tant qu'il n'a pas été validé depuis la **fiche de l'élève** (section « Cours en attente », bouton ✓ Valider).
- Si un cours a déjà été saisi à la main au même moment pour cet élève, l'app ne crée pas de doublon : elle rapproche les deux.
- Ne restent donc « à rattacher » que les événements que l'app ne peut pas décider seule : **nouveaux élèves**, **homonymes de prénom**, ou séances qui ne sont pas des cours.
- Le rattachement automatique s'annule **en un seul geste** avec le bouton ↺, quel que soit le nombre de cours concernés.
- Un cours déjà rattaché n'est **jamais reproposé ni dupliqué**, même si Google change l'identifiant de l'événement (ce qui arrive quand une série est modifiée ou recréée). L'app se repère au **créneau horaire**, pas seulement à l'identifiant.
- Pour le reste, la carte « **N événements passés à rattacher** » ouvre un écran qui **regroupe les événements par intitulé** : « Cecile » revient 30 fois, on choisit l'élève une seule fois et les 30 suivent. On peut y créer l'élève à la volée, ou ignorer tout un intitulé d'un coup (les événements restent intacts dans Google Agenda). Indispensable quand l'agenda contient des centaines de séances.
- Un glissement vers la gauche permet d'**ignorer** un événement (il reste intact dans Google Agenda).
- La synchro a lieu à l'ouverture de l'app, au retour au premier plan (au plus une fois par heure) et via le bouton **🔄 Synchroniser**. Les événements de la dernière synchro sont conservés sur l'appareil : l'agenda reste complet même hors ligne.

---

## Fonctionnalités

| Onglet | Contenu |
|---|---|
| **Agenda** | Cours à venir groupés par jour, événements Google, ajout/modif/suppression de cours |
| **Élèves** | Profils avec photo, coordonnées, niveau, points forts, difficultés · historique des cours faits et à venir · suivi des paiements avec alerte « À encaisser » · notes de cours datées |
| **Factures** | Factures **et devis** numérotés automatiquement, menus déroulants élève / type de cours / forfait, impression ou export PDF depuis Safari |
| **Répertoire** | Fiches morceaux : titre, artiste, tags, paroles, et pièces jointes (partitions PDF, images), avec recherche |
| **Réglages** | Coordonnées pour les factures, types de cours et forfaits personnalisables, connexion Google (avec diagnostic de la synchro), sauvegarde/restauration |

## Suivi des paiements — comment ça marche

Quand tu enregistres un paiement sur le profil d'un élève, tu indiques **combien de cours il couvre** (ex. forfait 10 cours). L'app compte ensuite les cours effectués depuis ce paiement :
- tant qu'il reste des cours payés → badge vert « X cours restants » ;
- dès que le forfait est épuisé → badge rouge **« À encaisser »** dans la liste des élèves.

## Sauvegarde cloud ☁️ — comment ça marche

Une fois le worker déployé avec le stockage KV (étape 3b-6) et `WORKER_URL` renseigné dans `js/config.js` :

1. Dans l'app : **Réglages → Sauvegarde cloud** → choisis une **phrase secrète** (6 caractères minimum, ex. `mimosa-vocalise-1987`).
2. Touche **« Sauvegarder dans le cloud maintenant »**. Ensuite, l'app refait automatiquement une sauvegarde **une fois par jour** à l'ouverture.
3. Sur un nouveau téléphone : installe l'app, saisis la même phrase secrète, puis **« Restaurer depuis le cloud »** — tout revient (élèves, cours, paiements, notes, factures, répertoire).

La phrase secrète n'est jamais stockée en clair sur le serveur : elle sert de clé d'accès. **Note-la quelque part** — sans elle, la sauvegarde est irrécupérable.

## Limites à connaître

- Les pièces jointes du répertoire sont limitées à ~8 Mo par fichier, et la sauvegarde cloud à 20 Mo au total (largement suffisant sauf si tu stockes énormément de partitions PDF — dans ce cas garde aussi l'export JSON local).
- La synchro Google est **en lecture seule** (Google → app). L'app n'écrit jamais dans Google Agenda.
- La sauvegarde cloud est une **copie de sécurité**, pas une synchronisation permanente entre deux téléphones : elle part automatiquement à chaque modification, mais la restauration reste une action manuelle.
- Le cloud garde les **6 dernières versions** antérieures, archivées au plus une fois toutes les 6 h (Réglages → Données & sauvegarde → Historique cloud).

## Suppressions et restauration

Une sauvegarde ne contient que ce qui **existe**. Sans précaution, un élève supprimé sur un téléphone réapparaissait à la restauration suivante, ressuscité par la copie de l'autre appareil. L'app note donc chaque suppression dans une petite marque qui voyage avec la sauvegarde, et distingue deux gestes :

| Geste | Effet |
|---|---|
| **Restaurer depuis le cloud** (version courante) | Se remettre au même état que le cloud. Les suppressions faites sur l'autre appareil sont appliquées ici aussi — l'app annonce combien d'enregistrements seront retirés **avant** de le faire. Ce qui a été supprimé ici n'est pas ressuscité. |
| **Restaurer une version de l'historique** | Revenir en arrière après une fausse manœuvre. Tout est remis en place, **y compris ce qui a été supprimé depuis**. Rien n'est effacé. |
| **Restaurer un fichier JSON** | Comme une version de l'historique : tout est remis en place, rien n'est effacé. |

Les marques de suppression sont purgées au bout de 6 mois.

## Doublons

Deux séances du même élève sur le même créneau sont forcément la même. **Réglages → Données & sauvegarde → 🧹 Chercher les doublons** les repère et les fusionne : la plus complète est conservée (validée de préférence, avec sa note et son lien Google), et l'opération s'annule d'un seul ↺.

À utiliser si les heures effectuées ou le décompte des forfaits paraissent gonflés.

## En cas de problème

| Symptôme | Cause la plus probable |
|---|---|
| « Autorisation Google expirée » | Projet Google encore en mode « Test » : l'autorisation expire tous les 7 jours. Reconnecter, ou publier l'application (étape 3a-3). |
| ☁︎! dans la barre du haut | Toucher l'icône ouvre les réglages du cloud, où le motif exact est affiché. |
| ☁︎✕ dans la barre du haut | La phrase secrète a disparu (iOS efface les données des sites peu utilisés). La ressaisir dans Réglages → Données & sauvegarde. |
| « Worker injoignable » au test | `WORKER_URL` erroné dans `js/config.js`, ou `ALLOWED_ORIGIN` du worker qui ne correspond pas à l'adresse du site. |
| « Stockage KV absent » | Le binding `BACKUPS` n'est pas ajouté au worker (étape 3b-6). |
| « Envoi refusé : X contre Y » | Garde-fou : l'appareil contient beaucoup moins de données que le cloud. Vérifier avant de forcer l'envoi. |
