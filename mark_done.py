#!/usr/bin/env python3
"""Marque des vidéos comme déjà postées (anti-doublon) sans les uploader.

Usage (dans le conteneur) :
    python3 /tmp/mark_done.py <chaine> <numero_max>
Ex. : python3 /tmp/mark_done.py frenchclip0 19
  → marque comme postées toutes les vidéos dont le suffixe _NN est <= 19.

N'écrase JAMAIS une entrée existante (préserve video_id / url des vraies postées).
"""
import json
import os
import re
import sys
from glob import glob

DATA_DIR = os.environ.get("YT_DATA_DIR", "/data")


def main():
    if len(sys.argv) != 3:
        print("Usage : python3 mark_done.py <chaine> <numero_max>")
        sys.exit(1)
    channel, nmax = sys.argv[1], int(sys.argv[2])
    folder = os.path.join(DATA_DIR, "channels", channel)
    state_path = os.path.join(folder, ".uploaded.json")

    state = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)

    added = []
    for path in sorted(glob(os.path.join(folder, "*.mp4"))):
        name = os.path.basename(path)
        m = re.search(r"_(\d+)\.mp4$", name)
        if not m:
            continue
        if int(m.group(1)) <= nmax and name not in state:
            state[name] = {"manual": True, "note": "marquée déjà postée à la main"}
            added.append(name)

    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    print(f"{len(added)} vidéo(s) marquée(s) comme postées :")
    for n in added:
        print("  +", n)
    print(f"Total enregistrées : {len(state)}")


if __name__ == "__main__":
    main()
