# Installer yt-poster pour tes propres chaînes

yt-poster poste automatiquement tes vidéos en **YouTube Shorts**, sur une ou plusieurs
chaînes, à des heures aléatoires dans une fenêtre horaire que tu choisis. Tout se gère
depuis une interface web façon YouTube Studio (file d'attente, planification,
statistiques).

Ce guide part de zéro. Chacun utilise **son propre** projet Google Cloud, **son
propre** serveur et **ses propres** chaînes : rien n'est partagé avec l'auteur du dépôt.

Compte environ 1 h la première fois, dont la moitié dans Google Cloud Console.

**Sommaire**
1. [Ce qu'il te faut](#1-ce-quil-te-faut)
2. [Google Cloud : créer tes identifiants](#2-google-cloud--créer-tes-identifiants)
3. [Installer sur le serveur (Docker)](#3-installer-sur-le-serveur-docker)
4. [Mettre le HTTPS](#4-mettre-le-https)
5. [Premier accès : mot de passe et chaînes](#5-premier-accès--mot-de-passe-et-chaînes)
6. [Ajouter des vidéos](#6-ajouter-des-vidéos)
7. [Régler la planification](#7-régler-la-planification)
8. [Mettre à jour](#8-mettre-à-jour)
9. [Limites YouTube à connaître](#9-limites-youtube-à-connaître)
10. [Dépannage](#10-dépannage)
11. [Sécurité](#11-sécurité)

---

## 1. Ce qu'il te faut

- Un **serveur Linux** allumé en permanence, par exemple un VPS à quelques €/mois, avec
  **Docker** installé. Le planificateur poste tout seul, donc il doit tourner 24 h/24.
- Un **nom de domaine** ou sous-domaine qui pointe vers l'IP du serveur (enregistrement
  DNS de type A), par exemple `yt.mondomaine.fr`. Google exige du HTTPS pour la
  connexion des chaînes.
- Un **compte Google** qui gère tes chaînes YouTube.

> **Juste pour essayer sur ton PC ?** Pas besoin de serveur ni de domaine : voir
> [la variante locale](#variante-test-en-local-sans-serveur). Par contre, ton PC devra
> rester allumé pour que les vidéos partent.

Dans tout le guide, remplace `yt.mondomaine.fr` par **ton** domaine.

---

## 2. Google Cloud : créer tes identifiants

À faire une seule fois. C'est ce qui autorise **ton** application à poster sur **tes**
chaînes.

### 2.1 Créer le projet et activer les API

1. Va sur https://console.cloud.google.com, puis **Sélectionner un projet → Nouveau projet**.
2. **API et services → Bibliothèque**. Active ces deux API :
   - **YouTube Data API v3**, pour l'envoi des vidéos ;
   - **YouTube Analytics API**, pour les statistiques de l'interface.

### 2.2 Écran de consentement

**API et services → Écran de consentement OAuth** :
- type d'utilisateur : **Externe** ;
- nom de l'application (au choix), ton e-mail d'assistance et ton e-mail de contact ;
- pas besoin d'ajouter les scopes ici, l'appli les demande elle-même ;
- à la fin, clique **Publier l'application** pour passer en **« En production »**.

> ⚠️ Si tu restes en mode « Test », la connexion de tes chaînes **expire au bout de 7
> jours** et il faut tout reconnecter chaque semaine.

### 2.3 Créer le client OAuth

**API et services → Identifiants → Créer des identifiants → ID client OAuth** :
- type d'application : **Application Web** (et pas « Application de bureau ») ;
- **URI de redirection autorisés**, ajoute exactement :
  ```
  https://yt.mondomaine.fr/oauth/callback
  ```
  Ajoute aussi `http://localhost:8080/oauth/callback` si tu veux tester en local.
- **Créer**, puis **Télécharger le JSON**. Renomme le fichier `client_secret.json`.

> 🔒 Ce fichier, c'est la clé de ton application. Ne l'envoie à personne et ne le
> mets jamais sur GitHub.

### 2.4 Vidéos bloquées en privé : l'audit

Pour les projets API **non audités**, Google peut forcer les vidéos envoyées en
**privé**, même si tu as choisi « public ». Si ça t'arrive, demande l'audit via le
formulaire Google **« YouTube API Services – Audit and Quota Extension »**. C'est
gratuit, mais ça prend quelques jours ou semaines. Le même formulaire sert à demander
plus de quota.

---

## 3. Installer sur le serveur (Docker)

### 3.1 Récupérer le code

```bash
git clone https://github.com/0jikuji0/yt-poster.git
cd yt-poster
```

### 3.2 Indiquer ton domaine

Crée un fichier `.env` à côté de `docker-compose.yml` :

```bash
cat > .env <<'EOF'
BASE_URL=https://yt.mondomaine.fr
EOF
```

`BASE_URL` doit correspondre **exactement** à l'URI de redirection de l'étape 2.3,
sans `/oauth/callback` et sans `/` à la fin.

> ⚠️ Règle-la **avant le premier lancement** : elle est ensuite enregistrée dans la
> configuration de l'appli. Pour la changer plus tard, voir le [Dépannage](#10-dépannage).

Variable facultative : `SSH_HOST=utilisateur@ip-du-serveur`. Elle sert seulement à
afficher des commandes prêtes à copier sur la page d'aide « Ajouter des vidéos ».

### 3.3 Lancer

```bash
docker compose up -d --build
docker compose logs -f        # Ctrl+C pour quitter les logs (l'appli continue de tourner)
```

L'appli écoute sur le port **8090** du serveur. Pour changer ce port, modifie la ligne
`"8090:8080"` dans `docker-compose.yml`. Tout ce qui doit être gardé (config, chaînes
connectées, vidéos, journal) va dans le volume Docker `yt_data` et survit aux
redémarrages et aux mises à jour.

> **Avec Portainer :** **Stacks → Add stack → Repository**, mets l'URL du dépôt et
> `docker-compose.yml`. Ajoute `BASE_URL` (et éventuellement `SSH_HOST`) dans
> **Environment variables**, puis **Deploy**.

### Variante : test en local, sans serveur

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows : .venv\Scripts\activate
pip install -r requirements.txt
python webapp.py                   # puis ouvre http://localhost:8080
```

Sans `BASE_URL`, l'appli utilise `http://localhost:8080`. Pense à ajouter cette URI de
redirection dans Google Cloud (étape 2.3).

---

## 4. Mettre le HTTPS

Il faut un **reverse-proxy** devant l'appli : il gère le certificat HTTPS et transmet
les requêtes au port 8090. Si tu en as déjà un (Nginx Proxy Manager, SWAG, Traefik…),
ajoute simplement une redirection de `yt.mondomaine.fr` vers `localhost:8090`.

Sinon, le plus simple est **Caddy**, qui gère le certificat Let's Encrypt tout seul.
Les commandes d'installation sont dans `Caddyfile.example`. Le fichier
`/etc/caddy/Caddyfile` minimal :

```
yt.mondomaine.fr {
	request_body {
		max_size 4GB
	}
	reverse_proxy localhost:8090
}
```

```bash
sudo systemctl reload caddy
```

Les ports **80** et **443** doivent être ouverts sur le serveur. Le `max_size` autorise
l'envoi de gros fichiers vidéo depuis le navigateur.

---

## 5. Premier accès : mot de passe et chaînes

1. Ouvre `https://yt.mondomaine.fr`. L'appli demande de **créer le compte
   administrateur** : un identifiant et un mot de passe (8 caractères minimum). Le site
   est public sur Internet, prends un mot de passe solide.
2. Va dans **Paramètres** et dépose ton `client_secret.json`.
3. Va dans **Toutes les chaînes**, ajoute une chaîne (le nom est libre, il sert juste
   dans l'interface), puis clique **Connecter**.
4. Choisis le compte Google, puis **la chaîne YouTube** si le compte en a plusieurs.
5. Google affiche « **Google n'a pas validé cette application** ». C'est normal, c'est
   ta propre appli : clique **Paramètres avancés → Accéder à … (non sécurisé)**, puis
   accepte les autorisations.
6. Recommence les étapes 3 à 5 pour chaque chaîne.

La chaîne active se choisit sous l'avatar, en haut de la barre latérale. Toutes les
pages travaillent sur cette chaîne.

### Plusieurs comptes (partager ton installation)

Tu peux donner un accès à quelqu'un d'autre sans lui donner ton mot de passe :

1. **Utilisateurs** (barre latérale, visible seulement par un administrateur) →
   **Nouveau compte** : un identifiant, un mot de passe, et la ou les chaînes qu'il
   pourra gérer. Tu peux cocher des chaînes existantes ou en créer une nouvelle pour lui.
2. Donne-lui l'adresse du site, son identifiant et son mot de passe.
3. Il se connecte, va dans **Paramètres → Connecter à YouTube** et relie **sa** chaîne.

Ce que voit chaque rôle :

| | Administrateur | Utilisateur |
|---|---|---|
| Chaînes | toutes | seulement les siennes |
| Ajouter une chaîne | oui | oui (elle lui est attribuée) |
| Gérer les comptes | oui | non |
| Déposer `client_secret.json` | oui | non |
| Journal | tout | lignes de ses chaînes |
| Changer son mot de passe (**Mon compte**) | oui | oui |

> Tous les comptes partagent **le même projet Google** et donc le même quota API
> (~100 vidéos/jour au total). Un administrateur du serveur peut techniquement accéder
> aux autorisations YouTube de tout le monde : ne donne un compte qu'à des gens de
> confiance, et inversement.

---

## 6. Ajouter des vidéos

### Depuis l'interface

Bouton **＋ Créer** en haut de la page. Tu peux déposer plusieurs fichiers d'un coup.

- **Une vidéo seule** reçoit le titre et la description saisis dans le formulaire,
  plus les hashtags automatiques de la chaîne (réglés dans **Paramètres**).
- **Une vidéo avec son JSON** garde ses propres métadonnées. Le JSON doit avoir le
  **même nom** que la vidéo :

  ```
  clip01.mp4
  clip01.json
  clip02.mp4
  clip02.json
  ```

  Contenu d'un JSON (modèle complet dans `example.json`) :

  ```json
  {
    "title": "Mon premier Short 🎬",
    "description": "Une petite description.\nDeuxième ligne.",
    "tags": ["short", "demo"],
    "privacy": "public"
  }
  ```

### En masse, directement sur le serveur

Pour des centaines de vidéos, c'est plus rapide de passer par le terminal. Envoie le
dossier sur le serveur, puis copie-le dans le conteneur :

```bash
# Sur ton ordinateur
rsync -avP mes_videos/ utilisateur@ip-du-serveur:~/mes_videos/

# Sur le serveur (remplace <chaine> par le nom de la chaîne dans l'interface)
sudo docker exec yt-poster mkdir -p /data/channels/<chaine>
sudo docker cp ~/mes_videos/. yt-poster:/data/channels/<chaine>/
rm -rf ~/mes_videos
```

Les vidéos apparaissent dans **Contenus** au prochain rafraîchissement de la page. La
page **Documentation → Ajouter des vidéos** de l'interface donne ces commandes avec
les noms de tes chaînes déjà remplis.

### Pour que ce soit un Short

YouTube classe la vidéo en Short tout seul si elle est **verticale (9:16)** et dure
**3 minutes ou moins**. Il n'y a rien à cocher.

---

## 7. Régler la planification

Page **Planification**, pour chaque chaîne :
- **nombre de vidéos par jour** ;
- **fenêtre horaire** (par exemple 10 h–22 h) : les posts tombent à des heures
  aléatoires dans cette fenêtre, ou à des **heures fixes** si tu préfères ;
- la liste des **créneaux du jour** déjà tirés.

Les autres pages utiles :
- **Poster maintenant** envoie une vidéo tout de suite, pratique pour tester ;
- **Journal** liste ce que le planificateur a fait (envois, erreurs) ;
- **Meilleures heures** montre quelles heures de publication rapportent le plus de vues ;
- **Paramètres** règle la visibilité par défaut et les hashtags ajoutés automatiquement.

L'appli retient ce qui a déjà été posté : **jamais de doublon**, même après un
redémarrage.

---

## 8. Mettre à jour

```bash
cd yt-poster
git pull
docker compose up -d --build
```

Tes réglages, tes chaînes et tes vidéos sont dans le volume `yt_data` : ils ne bougent
pas. Avec Portainer, utilise **Pull and redeploy** sur la stack.

---

## 9. Limites YouTube à connaître

| Limite | Valeur | Conséquence |
|---|---|---|
| Quota de l'API (ton projet Google) | 10 000 unités/jour, ~100 par envoi | ~**100 vidéos/jour au total**, toutes chaînes réunies |
| Limite par chaîne | ~15–20 envois/jour pour une chaîne récente ou non vérifiée | reste en dessous dans la planification |
| Durée d'un Short | 3 min max, format vertical | sinon la vidéo est publiée en vidéo classique |

Quand une limite est atteinte, le Journal affiche une **erreur 403**. L'appli s'arrête
proprement et reprend au créneau suivant, sans doublon.

Vérifier ta chaîne (https://www.youtube.com/verify) lève une partie des limites.

---

## 10. Dépannage

| Symptôme | Cause probable et solution |
|---|---|
| `Erreur 400 : redirect_uri_mismatch` en cliquant sur Connecter | `BASE_URL` ne correspond pas à l'URI déclarée dans Google Cloud. Vérifie `https`, le sous-domaine, et qu'il n'y a pas de `/` final. |
| J'ai changé `BASE_URL` mais rien ne change | L'ancienne valeur est enregistrée dans la config. Supprime la ligne `"base_url"` de `/data/config.json` dans le conteneur, puis redémarre (voir ci-dessous). |
| Chaînes déconnectées au bout de 7 jours | L'écran de consentement est resté en « Test ». Publie-le (étape 2.2), puis reconnecte les chaînes. |
| Vidéos en privé alors qu'elles sont réglées en public | Projet API non audité (étape 2.4). |
| Mot de passe administrateur perdu | Supprime l'entrée `"users"` de `/data/config.json` (voir ci-dessous) et redémarre : l'appli redemande la création d'un compte administrateur. Les chaînes ne sont pas touchées. |
| `access_denied` à la connexion | Tu as refusé une autorisation, ou l'app est en « Test » et ton compte n'est pas dans les utilisateurs test. |
| Le site ne s'ouvre pas | Vérifie que le conteneur tourne (`docker compose ps`), que le DNS pointe bien vers le serveur et que les ports 80/443 sont ouverts. |
| L'envoi d'une grosse vidéo échoue dans le navigateur | Limite de taille du reverse-proxy : voir `max_size` à l'étape 4. |
| Rien ne se poste | Regarde la page **Journal**. Une chaîne connectée, des vidéos dans la file et une fenêtre horaire non vide sont nécessaires. |

Modifier la config à la main :

```bash
sudo docker cp yt-poster:/data/config.json ./config.json
nano config.json                    # modifie ce qu'il faut
sudo docker cp ./config.json yt-poster:/data/config.json
sudo docker restart yt-poster
rm config.json
```

---

## 11. Sécurité

- `client_secret.json`, `config.json` et les tokens des chaînes restent **uniquement
  sur ton serveur**, dans le volume `yt_data`. Ils ne sont jamais dans le dépôt Git.
- Les mots de passe des comptes sont la seule protection de l'interface, qui est
  publique sur Internet : choisis-les longs.
- Un utilisateur ne peut ni voir ni modifier les chaînes des autres, même en tapant
  leur adresse à la main.
- Pour retirer l'accès à une chaîne : https://myaccount.google.com/permissions →
  ton application → **Supprimer l'accès**.

---

Pour aller plus loin : `WEB.md` détaille l'interface web, et `README.md` explique le
mode ligne de commande (`poster.py`), sans interface ni serveur.
