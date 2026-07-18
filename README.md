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
     - Type **Text** — nom `ALLOWED_ORIGIN` — valeur : l'URL de ton site, ex. `https://TON-COMPTE.github.io`
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

> 💻 *Alternative pour développeurs* : le dossier `worker/` contient aussi un `wrangler.toml` pour déployer via `npx wrangler deploy` si tu préfères la ligne de commande (elle nécessite Node.js installé sur un ordinateur — c'est ce qui coince souvent, la méthode navigateur ci-dessus fait exactement la même chose).

### 3c. Brancher l'app sur le worker

1. Ouvre `js/config.js` et renseigne :
   ```js
   const WORKER_URL = "https://studio-vocal-auth.ton-compte.workers.dev";
   ```
2. Pousse la modification sur GitHub (`git add . && git commit -m "worker" && git push`).
3. Dans l'app : **Réglages → Connecter Google Agenda** → connexion avec le compte Google de la professeure → c'est fait ✅

### Ce que fait la synchro

- Chaque cours créé/modifié/supprimé dans l'app est **poussé dans son Google Agenda** (avec 🎤 dans le titre).
- Le bouton **Synchroniser** de l'onglet Agenda **affiche aussi ses événements Google** (rendez-vous perso, etc.) dans la vue agenda de l'app.

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
- La synchro Google fonctionne dans le sens app → Google en continu, et Google → app via le bouton « Synchroniser ».
- La sauvegarde automatique a lieu au maximum une fois par 24 h, quand l'app est ouverte avec du réseau.
