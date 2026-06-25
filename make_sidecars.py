#!/usr/bin/env python3
"""Génère un fichier .json (titre + description avec hashtags + tags) pour chaque
vidéo d'un dossier, prêt à être posté par yt-poster.

À lancer sur le PC qui contient les vidéos (ex. ton PC Arch) AVANT le rsync :

    python make_sidecars.py ~/Videos/chaine2
    python make_sidecars.py ~/Videos/chaine2 --force    # réécrit les .json existants

Le script ne « comprend » pas la vidéo : il pioche au hasard quelques hashtags
dans le réservoir que TU définis ci-dessous (CORE + POOL), pour que les
descriptions varient d'une vidéo à l'autre. Personnalise CORE/POOL selon ta niche.
"""

import argparse
import json
import random
import re
from pathlib import Path

# --- À PERSONNALISER selon le thème de la chaîne ---------------------------
# Hashtags TOUJOURS présents (le cœur de ta niche).
CORE = ["#football", "#foot"]
# Réservoir : on en pioche EXTRA_PER_VIDEO au hasard par vidéo.
POOL = ["#viral", "#sport", "#ligue1", "#but", "#skills", "#goal", "#soccer",
        "#fyp", "#pourtoi", "#clip", "#highlights", "#crazy"]
EXTRA_PER_VIDEO = 4            # combien on pioche dans POOL pour chaque vidéo
DESCRIPTION_INTRO = ""        # texte placé avant les hashtags (optionnel)
PRIVACY = "public"            # public | unlisted | private
# (#Shorts est ajouté automatiquement par yt-poster, inutile de le mettre ici.)
# ---------------------------------------------------------------------------

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".m4v"}


def nice_title(stem: str) -> str:
    """Transforme « mon_super-clip01 » en « Mon super clip01 »."""
    t = re.sub(r"[._-]+", " ", stem).strip()
    return (t[:1].upper() + t[1:]) if t else stem


def make_for(video: Path, force: bool) -> bool:
    sidecar = video.with_suffix(".json")
    if sidecar.exists() and not force:
        return False
    k = min(EXTRA_PER_VIDEO, len(POOL))
    hashtags = CORE + random.sample(POOL, k)
    description = (DESCRIPTION_INTRO + "\n\n" + " ".join(hashtags)).strip()
    meta = {
        "title": nice_title(video.stem)[:100],
        "description": description,
        "tags": [h.lstrip("#") for h in hashtags],   # tags YouTube = mots-clés SANS #
        "privacy": PRIVACY,
        "made_for_kids": False,
    }
    sidecar.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return True


def main():
    ap = argparse.ArgumentParser(description="Génère les .json pour yt-poster.")
    ap.add_argument("folder", help="dossier contenant les vidéos")
    ap.add_argument("--force", action="store_true", help="réécrit les .json existants")
    args = ap.parse_args()

    folder = Path(args.folder).expanduser()
    if not folder.is_dir():
        raise SystemExit(f"Dossier introuvable : {folder}")

    created = 0
    for video in sorted(folder.iterdir()):
        if video.suffix.lower() in VIDEO_EXTS and make_for(video, args.force):
            created += 1
    print(f"{created} fichier(s) JSON généré(s) dans {folder}")


if __name__ == "__main__":
    main()
