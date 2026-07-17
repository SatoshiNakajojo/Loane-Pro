# 🎤 Studio Vocal

Application web installable (PWA) pour une professeure de chant : agenda synchronisé avec Google Agenda, profils d'élèves avec photo, suivi des paiements, notes de cours, factures & devis, et répertoire de morceaux (paroles + partitions).

L'app s'ouvre dans Safari puis s'installe sur l'écran d'accueil de l'iPhone comme une vraie application. Toutes les données (élèves, cours, paiements, notes, morceaux) sont stockées **directement sur le téléphone** — rien ne transite par un serveur, sauf la connexion à Google Agenda qui passe par un petit Worker Cloudflare.

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

### 3b. Déployer le Worker Cloudflare

1. Crée un compte gratuit sur [cloudflare.com](https://dash.cloudflare.com).
2. Sur ton ordinateur, dans le dossier `worker/` :
   ```bash
   cd worker
   # Modifie d'abord ALLOWED_ORIGIN dans wrangler.toml
   # avec l'URL de ton site : https://TON-COMPTE.github.io
   npx wrangler login
   npx wrangler secret put GOOGLE_CLIENT_ID      # colle le Client ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET  # colle le Client Secret
   npx wrangler deploy
   ```
3. Wrangler affiche l'URL du worker, par ex. `https://studio-vocal-auth.ton-compte.workers.dev`.
   Vérifie que cette URL + `/auth/callback` est bien l'URI de redirection déclarée côté Google (étape 3a-4).

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

## Limites à connaître

- Les données sont **locales au téléphone** : fais des sauvegardes régulières (Réglages).
- Les pièces jointes du répertoire sont limitées à ~8 Mo par fichier pour ne pas saturer le stockage.
- La synchro Google fonctionne dans le sens app → Google en continu, et Google → app via le bouton « Synchroniser ».
