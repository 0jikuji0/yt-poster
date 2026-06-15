# yt-shorts-poster

Petit outil en ligne de commande qui **poste automatiquement toutes les vidéos d'un dossier
sur YouTube en Shorts**, via l'API officielle YouTube Data v3.

Tu déposes tes vidéos dans un dossier, chacune avec un fichier JSON du même nom (titre,
description, tags), tu lances le script, et il les envoie une par une. Il retient ce qui a
déjà été posté pour ne jamais faire de doublon, même si tu le relances.

---

## 1. Prérequis

- Python 3.9 ou plus
- Installer les dépendances :

```bash
pip install -r requirements.txt
```

---

## 2. Configuration Google Cloud (à faire une seule fois)

C'est l'étape la plus longue, mais on ne la fait qu'une fois.

1. Va sur https://console.cloud.google.com → crée un **projet** (ou réutilises-en un).
2. **APIs & Services → Library** → cherche **« YouTube Data API v3 »** → **Enable**.
3. **APIs & Services → OAuth consent screen** :
   - Type : **External**.
   - Renseigne un nom d'app + ton e-mail.
   - **Important** : passe l'app **« In production »** (bouton *Publish app*). Tu verras un
     écran « Google n'a pas vérifié cette application » à la première connexion — c'est normal
     pour un usage perso, tu cliques *Paramètres avancés → Accéder à l'app*.
     ⚠️ Si tu laisses l'app en mode **« Testing »**, ton token expire **au bout de 7 jours** et
     tu devras te ré-authentifier chaque semaine. En *Production*, il reste valide.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** :
   - Type d'application : **Application de bureau** (*Desktop app*).
   - Télécharge le JSON, renomme-le **`client_secret.json`** et mets-le à côté de `poster.py`.

---

## 3. Préparer le dossier de vidéos

Chaque vidéo doit avoir un fichier `.json` portant **exactement le même nom** :

```
mes_shorts/
├── clip01.mp4
├── clip01.json
├── clip02.mp4
└── clip02.json
```

Contenu d'un JSON (voir `example.json`) :

```json
{
  "title": "Mon premier Short 🎬",
  "description": "Une petite description.",
  "tags": ["short", "demo"],
  "privacy": "public",
  "category_id": "22",
  "made_for_kids": false,
  "publish_at": null
}
```

Seul `title` est vraiment utile (s'il manque, le nom du fichier est utilisé). Le reste est
optionnel :

| Champ          | Rôle                                                                 |
|----------------|----------------------------------------------------------------------|
| `description`  | Description (le script y ajoute `#Shorts` tout seul).                |
| `tags`         | Liste de mots-clés.                                                  |
| `privacy`      | `public`, `unlisted` ou `private`.                                  |
| `category_id`  | ID de catégorie YouTube (`22` = People & Blogs par défaut).         |
| `made_for_kids`| `true`/`false` (obligatoire pour YouTube, `false` par défaut).      |
| `publish_at`   | Date ISO pour programmer (`"2026-09-01T18:00:00Z"`). Met la vidéo en privé jusque-là. |

---

## 4. Lancer

```bash
# Voir ce qui serait posté, sans rien envoyer :
python poster.py --folder ./mes_shorts --dry-run

# Tout poster :
python poster.py --folder ./mes_shorts

# Poster 10 vidéos max, avec 5 min entre chaque (recommandé, voir limites ci-dessous) :
python poster.py --folder ./mes_shorts --max 10 --delay 300
```

À la **première** exécution, le navigateur s'ouvre pour autoriser l'accès. Le token est ensuite
stocké dans `token.json` et réutilisé automatiquement.

### Options

| Option                 | Effet                                                            |
|------------------------|------------------------------------------------------------------|
| `--folder PATH`        | Dossier des vidéos (**obligatoire**).                           |
| `--dry-run`            | Affiche la liste sans rien poster.                              |
| `--max N`              | Limite le nombre d'uploads par session (`0` = illimité).        |
| `--delay SECONDES`     | Pause entre deux uploads.                                       |
| `--no-shorts-hashtag`  | N'ajoute pas `#Shorts` automatiquement.                         |
| `--secrets PATH`       | Chemin du `client_secret.json` (défaut : à côté du script).     |
| `--token PATH`         | Chemin du token OAuth (défaut : `token.json`).                  |

---

## 5. Ce qu'il faut savoir (limites)

- **Short = vertical (9:16) et ≤ 3 min.** YouTube classe la vidéo en Short tout seul, il n'y a
  pas de réglage API. Veille juste à exporter tes vidéos au bon format.
- **Quota API : ~100 vidéos/jour.** Depuis le 4 décembre 2025, un upload coûte ~100 unités de
  quota (contre 1600 avant) sur un quota gratuit de 10 000/jour. Le quota repart à minuit
  (heure du Pacifique).
- **Limite de la chaîne (différente du quota).** YouTube limite aussi le nombre d'uploads par
  chaîne et par jour. Une chaîne récente / non vérifiée est souvent bridée (≈ 15–20/jour) tant
  que le numéro de téléphone n'est pas validé. Si tu en balances trop d'un coup, les dernières
  seront refusées → d'où l'intérêt de `--max` et `--delay`.
- En cas d'erreur `403`, le script s'arrête proprement : quota ou limite chaîne atteint,
  réessaie plus tard. Les vidéos déjà postées ne seront pas renvoyées.

---

## 6. Automatiser (optionnel)

Pour que ça tourne tout seul, ajoute une tâche cron (Arch/Linux) qui lance le script chaque
jour, par ex. 5 vidéos par jour pour rester sous les limites :

```cron
0 10 * * *  cd /chemin/vers/yt-poster && /usr/bin/python poster.py --folder /chemin/mes_shorts --max 5 --delay 600 >> poster.log 2>&1
```

(La première authentification doit avoir été faite à la main une fois, pour générer `token.json`.)
