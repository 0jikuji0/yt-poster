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

Sur le tableau de bord, clique **« Connecter »** sur chaque chaîne, choisis le bon
compte Google, accepte. Le token est stocké dans `tokens/token_<nom>.json`.
Le planificateur peut alors poster sur cette chaîne.

## 5. Utilisation

- **Déposer des vidéos** : page d'une chaîne → « Déposer des vidéos ». Tu peux en
  mettre plusieurs d'un coup ; renseigne titre/description/tags/confidentialité.
  Chaque vidéo est rangée dans `channels/<nom>/` avec son JSON de métadonnées.
- **Réglages par chaîne** : nombre de vidéos/jour, fenêtre horaire (ex. 7h–21h),
  confidentialité par défaut, activer/désactiver la planification.
- **Planificateur** : chaque jour, il tire au hasard N horaires dans la fenêtre et
  poste 1 vidéo à chacun. Les prochains créneaux du jour sont affichés.
- **Poster maintenant** : bouton pour forcer un upload immédiat (test).
- **Journal** : les derniers événements (uploads, erreurs 403, etc.) sont visibles
  en bas du tableau de bord et dans `logs/webapp.log`.

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
