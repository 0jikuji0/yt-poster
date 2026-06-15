#!/usr/bin/env python3
"""
yt-shorts-poster — poste automatiquement les vidéos d'un dossier sur YouTube
(en Shorts) via l'API officielle YouTube Data v3.

Chaque vidéo doit avoir un fichier JSON du MÊME NOM à côté :

    mon_dossier/
        clip01.mp4
        clip01.json     -> {"title": "...", "description": "...", "tags": [...]}
        clip02.mp4
        clip02.json

Une vidéo devient un Short automatiquement si elle est verticale (9:16) et
dure 3 minutes ou moins — aucun réglage spécial nécessaire côté API.

Usage rapide :
    python poster.py --folder ./mon_dossier
    python poster.py --folder ./mon_dossier --dry-run        # voir sans poster
    python poster.py --folder ./mon_dossier --max 10 --delay 300   # 10 vidéos, 5 min entre chaque
"""

import argparse
import json
import logging
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# --- Dépendances Google (pip install -r requirements.txt) ---
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

# Scope minimal : on demande uniquement le droit d'uploader.
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".m4v"}

# Codes HTTP sur lesquels on retente automatiquement (erreurs serveur passagères).
RETRIABLE_STATUS = {500, 502, 503, 504}
MAX_RETRIES = 8

# 4 Mo par morceau : permet d'afficher la progression et de reprendre en cas de coupure.
CHUNK_SIZE = 4 * 1024 * 1024

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("poster")


def get_authenticated_service(secrets_path: Path, token_path: Path):
    """Gère l'OAuth : réutilise le token, le rafraîchit, ou ouvre le navigateur."""
    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            log.info("Token expiré, rafraîchissement…")
            creds.refresh(Request())
        else:
            if not secrets_path.exists():
                log.error("Fichier d'identifiants introuvable : %s", secrets_path)
                log.error("Crée un « ID client OAuth » de type « Application de bureau » "
                          "dans Google Cloud et télécharge le JSON (voir README).")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(str(secrets_path), SCOPES)
            # Ouvre le navigateur, écoute sur un port local, récupère le code.
            creds = flow.run_local_server(port=0)
        token_path.write_text(creds.to_json())
        log.info("Token sauvegardé dans %s", token_path)

    return build("youtube", "v3", credentials=creds)


def load_state(state_path: Path) -> dict:
    """Charge la liste des vidéos déjà postées (pour ne pas les reposter)."""
    if state_path.exists():
        try:
            return json.loads(state_path.read_text())
        except json.JSONDecodeError:
            log.warning("Fichier d'état illisible, on repart de zéro : %s", state_path)
    return {}


def save_state(state_path: Path, state: dict):
    state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def read_metadata(json_path: Path, video_path: Path, add_shorts_tag: bool) -> dict:
    """Lit le JSON associé et construit le corps de la requête videos.insert."""
    try:
        meta = json.loads(json_path.read_text())
    except json.JSONDecodeError as e:
        raise ValueError(f"JSON invalide ({json_path.name}) : {e}")

    title = meta.get("title") or video_path.stem
    description = meta.get("description", "")
    tags = meta.get("tags", [])
    privacy = str(meta.get("privacy", "public")).lower()      # public | unlisted | private
    category_id = str(meta.get("category_id", "22"))          # 22 = People & Blogs
    publish_at = meta.get("publish_at")                       # ISO 8601, ex "2026-09-01T18:00:00Z"
    made_for_kids = bool(meta.get("made_for_kids", False))

    # Ajoute #Shorts à la description s'il est demandé et absent (sans casser ce que tu as mis).
    if add_shorts_tag and "#shorts" not in (description.lower() + title.lower()):
        description = (description + "\n\n#Shorts").strip()

    status = {
        "privacyStatus": privacy,
        "selfDeclaredMadeForKids": made_for_kids,
    }
    # Une publication programmée impose le statut "private" jusqu'à la date prévue.
    if publish_at:
        status["privacyStatus"] = "private"
        status["publishAt"] = publish_at

    return {
        "snippet": {
            "title": title[:100],            # YouTube : 100 caractères max
            "description": description[:5000],
            "tags": tags,
            "categoryId": category_id,
        },
        "status": status,
    }


def upload_video(youtube, video_path: Path, body: dict) -> str:
    """Upload résumable avec relance exponentielle. Retourne l'ID de la vidéo."""
    media = MediaFileUpload(str(video_path), chunksize=CHUNK_SIZE, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    error = None
    retry = 0
    log.info("→ Upload : %s", video_path.name)

    while response is None:
        try:
            status, response = request.next_chunk()
            if status:
                log.info("   %d %%", int(status.progress() * 100))
        except HttpError as e:
            if e.resp.status in RETRIABLE_STATUS:
                error = f"erreur serveur {e.resp.status}"
            else:
                raise
        except (IOError, OSError) as e:
            error = f"erreur réseau : {e}"

        if error:
            retry += 1
            if retry > MAX_RETRIES:
                raise RuntimeError(f"abandon après {MAX_RETRIES} tentatives ({error})")
            sleep = min(2 ** retry + random.random(), 60)
            log.warning("   %s — nouvelle tentative dans %.1f s", error, sleep)
            time.sleep(sleep)
            error = None

    vid = response["id"]
    log.info("   ✓ En ligne : https://youtu.be/%s", vid)
    return vid


def find_jobs(folder: Path, state: dict):
    """Liste les couples (vidéo, json) à poster : vidéo + json présents, pas déjà postée."""
    jobs = []
    for video in sorted(folder.iterdir()):
        if video.suffix.lower() not in VIDEO_EXTS:
            continue
        if video.name in state:
            continue
        sidecar = video.with_suffix(".json")
        if not sidecar.exists():
            log.warning("Pas de JSON pour %s — ignorée", video.name)
            continue
        jobs.append((video, sidecar))
    return jobs


def main():
    p = argparse.ArgumentParser(
        description="Poste les vidéos d'un dossier en YouTube Shorts (API officielle)."
    )
    p.add_argument("--folder", required=True, type=Path,
                   help="Dossier contenant les vidéos + leurs JSON")
    p.add_argument("--secrets", type=Path, default=Path("client_secret.json"),
                   help="Fichier d'identifiants OAuth (défaut : client_secret.json)")
    p.add_argument("--token", type=Path, default=Path("token.json"),
                   help="Où stocker le token OAuth (défaut : token.json)")
    p.add_argument("--delay", type=float, default=0,
                   help="Pause en secondes entre deux uploads (défaut : 0)")
    p.add_argument("--max", type=int, default=0,
                   help="Nombre max de vidéos à poster dans cette session (0 = illimité)")
    p.add_argument("--dry-run", action="store_true",
                   help="Liste ce qui serait posté, sans rien envoyer")
    p.add_argument("--no-shorts-hashtag", action="store_true",
                   help="Ne pas ajouter automatiquement #Shorts à la description")
    args = p.parse_args()

    folder = args.folder
    if not folder.is_dir():
        log.error("Dossier introuvable : %s", folder)
        sys.exit(1)

    state_path = folder / ".uploaded.json"
    state = load_state(state_path)

    jobs = find_jobs(folder, state)
    if args.max > 0:
        jobs = jobs[: args.max]

    if not jobs:
        log.info("Rien à poster (tout est déjà en ligne, ou aucun couple vidéo+JSON trouvé).")
        return

    log.info("%d vidéo(s) à poster.", len(jobs))

    if args.dry_run:
        for video, sidecar in jobs:
            body = read_metadata(sidecar, video, not args.no_shorts_hashtag)
            log.info("  • %-30s →  « %s »", video.name, body["snippet"]["title"])
        log.info("(dry-run : rien n'a été envoyé)")
        return

    youtube = get_authenticated_service(args.secrets, args.token)

    posted = 0
    for i, (video, sidecar) in enumerate(jobs):
        try:
            body = read_metadata(sidecar, video, not args.no_shorts_hashtag)
            vid = upload_video(youtube, video, body)
            state[video.name] = {
                "video_id": vid,
                "url": f"https://youtu.be/{vid}",
                "uploaded_at": datetime.now(timezone.utc).isoformat(),
                "title": body["snippet"]["title"],
            }
            save_state(state_path, state)        # on sauvegarde après chaque succès
            posted += 1
        except HttpError as e:
            log.error("Échec sur %s : %s", video.name, e)
            if e.resp.status == 403:
                log.error("403 — quota dépassé ou limite d'upload de la chaîne atteinte. "
                          "Réessaie plus tard (le quota repart à minuit, heure du Pacifique).")
                break
        except Exception as e:
            log.error("Échec sur %s : %s — on passe à la suivante.", video.name, e)
            continue

        # Pause entre deux uploads (utile pour étaler et ménager la limite de la chaîne).
        if args.delay and i < len(jobs) - 1:
            log.info("Pause de %.0f s…", args.delay)
            time.sleep(args.delay)

    log.info("Terminé : %d vidéo(s) postée(s).", posted)


if __name__ == "__main__":
    main()
