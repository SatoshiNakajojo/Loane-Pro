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
   > Pour ne plus jamais avoir à reconnecter : dans **Écran de consentement OAuth**, clique sur **Publier l'application** (l'avertissement « application non vérifiée » à la première connexion est sans conséquence pour un usage personnel).
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
- Toucher un événement Google permet de le **rattacher** à un élève : il devient une séance de l'app et compte dans les heures effectuées et les forfaits.
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
| **Réglages** | Coordonnées pour les factures, types de cours et forfaits personnalisables, connexion Google, sauvegarde/restauration |

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
- La sauvegarde cloud est une **copie de sécurité**, pas une synchronisation entre deux téléphones : la restauration **fusionne** le cloud avec l'appareil, et une suppression faite sur un appareil n'est pas répercutée sur l'autre. À n'utiliser en pratique que depuis un seul téléphone à la fois.
- Le cloud garde les **6 dernières versions** antérieures, archivées au plus une fois toutes les 6 h (Réglages → Données & sauvegarde → Historique cloud).

## En cas de problème

| Symptôme | Cause la plus probable |
|---|---|
| « Autorisation Google expirée » | Projet Google encore en mode « Test » : l'autorisation expire tous les 7 jours. Reconnecter, ou publier l'application (étape 3a-3). |
| ☁︎! dans la barre du haut | Toucher l'icône ouvre les réglages du cloud, où le motif exact est affiché. |
| ☁︎✕ dans la barre du haut | La phrase secrète a disparu (iOS efface les données des sites peu utilisés). La ressaisir dans Réglages → Données & sauvegarde. |
| « Worker injoignable » au test | `WORKER_URL` erroné dans `js/config.js`, ou `ALLOWED_ORIGIN` du worker qui ne correspond pas à l'adresse du site. |
| « Stockage KV absent » | Le binding `BACKUPS` n'est pas ajouté au worker (étape 3b-6). |
| « Envoi refusé : X contre Y » | Garde-fou : l'appareil contient beaucoup moins de données que le cloud. Vérifier avant de forcer l'envoi. |
