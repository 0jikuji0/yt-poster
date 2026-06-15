# CLAUDE.md — contexte projet pour Claude Code

## Ce que fait ce projet
Outil CLI Python qui poste automatiquement les vidéos d'un dossier sur **YouTube en Shorts**,
via l'**API officielle YouTube Data v3**. Chaque vidéo a un fichier JSON du même nom contenant
ses métadonnées (titre, description, tags). Le script retient ce qui a déjà été posté pour
éviter les doublons.

## Architecture
- `poster.py` — tout le code (un seul fichier, volontairement simple).
  - `get_authenticated_service()` : OAuth 2.0 (génère/rafraîchit `token.json`).
  - `read_metadata()` : lit le JSON sidecar → corps de la requête `videos.insert`.
  - `upload_video()` : upload résumable + retry exponentiel sur erreurs 5xx.
  - `find_jobs()` : liste les couples (vidéo, json) non encore postés.
  - `main()` : CLI (argparse).
- `requirements.txt` — `google-api-python-client`, `google-auth-oauthlib`, `google-auth-httplib2`.
- `example.json` — modèle de fichier sidecar.
- `.uploaded.json` — créé à l'exécution dans le dossier des vidéos (état, non versionné).

## Structure attendue d'un dossier de vidéos
```
mes_shorts/
├── clip01.mp4
├── clip01.json   {"title": "...", "description": "...", "tags": [...]}
└── ...
```

## Commandes
```bash
pip install -r requirements.txt
python poster.py --folder ./mes_shorts --dry-run   # liste sans poster
python poster.py --folder ./mes_shorts             # poste
python poster.py --folder ./mes_shorts --max 5 --delay 300   # 5 vidéos, 5 min entre chaque
```
Premier lancement : ouvre le navigateur pour l'autorisation OAuth.

## Règles importantes
- **SÉCURITÉ** : ne jamais committer `client_secret.json` ni `token.json` (déjà dans `.gitignore`).
- **Short** = vidéo verticale (9:16) et ≤ 3 min. Détection automatique par YouTube, pas de flag API.
- **Quota API** : ~100 unités par upload depuis déc. 2025, quota gratuit 10 000/jour → ~100 vidéos/jour.
- **Limite chaîne** (≠ quota) : chaîne récente/non vérifiée bridée (~15–20/jour). D'où `--max`/`--delay`.
- Erreur `403` = quota/limite atteint : le script s'arrête proprement, aucun doublon au prochain run.

## Conventions de code
- Commentaires et messages de log en français.
- Identifiants (variables, fonctions) en anglais.
- Garder `poster.py` lisible et autonome ; ne pas sur-architecturer.
