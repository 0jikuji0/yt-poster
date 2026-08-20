# Interface web yt-poster

Interface pour gérer plusieurs chaînes YouTube : connexion OAuth, dépôt de vidéos,
réglages par chaîne, et **planificateur intégré** qui poste tout seul à des heures
réparties aléatoirement dans la journée (plus besoin de cron).

## 1. Installation des dépendances

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. Reconfigurer le client OAuth en « Application Web »

Le bouton « Connecter » utilise le flow OAuth web, qui exige un client de type
**Application Web** (et non « Application de bureau »).

Dans **Google Cloud Console → API et services → Identifiants** :
1. Crée un identifiant **« ID client OAuth »** → type **« Application Web »**.
2. Dans **URI de redirection autorisés**, ajoute EXACTEMENT :
   ```
   http://localhost:8080/oauth/callback          (pour tester en local)
   https://ton-domaine.tld/oauth/callback        (en production)
   ```
   L'URL doit correspondre à `base_url` de la config + `/oauth/callback`.
3. Télécharge le JSON et place-le à la racine sous le nom **`client_secret.json`**.

> Important : l'écran de consentement OAuth doit être en **« Production »**
> (pas « Test »), sinon les refresh tokens expirent au bout de 7 jours.

## 3. Lancer

```bash
python webapp.py                 # http://0.0.0.0:8080
PORT=9000 python webapp.py       # autre port
BASE_URL=https://ton-domaine.tld python webapp.py
```

Au **premier accès**, l'interface demande de **créer un mot de passe**.

## 4. Connecter les chaînes

Sur le **Tableau de bord**, clique **« Connecter »**, choisis le bon compte Google,
accepte. Le token est stocké dans `tokens/token_<nom>.json`. Le planificateur peut
alors poster sur cette chaîne.

## 5. L'interface (façon YouTube Studio)

L'interface travaille **sur une chaîne à la fois** : la chaîne active se choisit
sous l'avatar, en haut de la barre latérale (le choix est mémorisé en session, et
l'URL `?c=<nom>` fonctionne partout).

| Page | Ce qu'on y fait |
|---|---|
| **Tableau de bord** (`/`) | dernière vidéo publiée, file d'attente, créneaux du jour, stats de la chaîne |
| **Contenus** (`/contenus`) | file d'attente (suppression multiple) et vidéos publiées avec leurs vues |
| **Données analytiques** (`/analytics`) | 4 onglets (Aperçu, Contenu, Audience, Tendances) : vues / durée de visionnage / abonnés sur 28 j avec comparatif, courbe, carte « Temps réel », contenus populaires |
| **Planification** (`/planification`) | cadence, fenêtre horaire, heures fixes, créneaux du jour, cadence des autres chaînes |
| **Meilleures heures** (`/heures`) | quelles heures de publication rapportent des vues |
| **Journal** (`/journal`) | activité du planificateur (uploads, erreurs 403…) |
| **Toutes les chaînes** (`/chaines`) | tableau comparatif + ajout de chaîne |
| **Paramètres** (`/parametres`) | visibilité par défaut, hashtags automatiques, `client_secret.json`, renommage |
| **Documentation** (`/aide`) | fiches pas-à-pas |

- **Ajouter des vidéos** : bouton **＋ Créer** de la barre du haut (ou `?create=1`).
  Plusieurs fichiers d'un coup ; les paires `clip01.mp4` + `clip01.json` gardent
  leurs métadonnées, les autres reçoivent celles du formulaire (ou les hashtags de
  la chaîne). Tout est rangé dans `channels/<nom>/`.
- **Poster maintenant** : force un upload immédiat (test).
- Les anciennes URL (`/library`, `/stats`, `/logs`, `/hours`, `/channel/<nom>`)
  redirigent vers les nouvelles pages.

## 6. Faire tourner en permanence (serveur Linux)

Voir `yt-poster-web.service` (unité systemd fournie). En résumé :

```bash
sudo cp yt-poster-web.service /etc/systemd/system/
# adapte User / WorkingDirectory / BASE_URL dans le fichier
sudo systemctl daemon-reload
sudo systemctl enable --now yt-poster-web
journalctl -u yt-poster-web -f      # suivre les logs
```

### HTTPS (obligatoire en prod)

Le serveur Python (waitress) écoute en HTTP sur le port 8080 ; un reverse-proxy gère
le TLS. Le plus simple : **Caddy** (certificat Let's Encrypt automatique). Voir
`Caddyfile.example`. `base_url` doit être l'URL HTTPS publique (`https://yt.etiodocplateforme.fr`),
identique à l'URI de redirection OAuth.

> waitress est inclus dans requirements.txt : `webapp.py` l'utilise automatiquement
> (serveur de production, mono-process pour ne pas dupliquer le planificateur).

### ⚠️ Changement de domaine = reconnexion des chaînes

L'URI de redirection OAuth dépend du domaine. Pour la prod sur `yt.etiodocplateforme.fr`, il
faut un client OAuth **« Application Web »** avec `https://yt.etiodocplateforme.fr/oauth/callback`
enregistré. Comme ce client a un `client_id` différent de celui utilisé en local, les
tokens connectés en local ne seront plus valides : **reconnecte chaque chaîne** depuis
l'interface une fois en production (bouton « Connecter »).

## Fichiers (non versionnés, voir .gitignore)

| Chemin | Rôle |
|---|---|
| `config.json` | réglages (mot de passe haché, base_url, chaînes) |
| `client_secret.json` | identifiants OAuth de l'appli (à fournir) |
| `tokens/token_<nom>.json` | autorisation par chaîne |
| `channels/<nom>/` | vidéos + JSON + `.uploaded.json` (anti-doublon) |
| `logs/webapp.log` | journal |
