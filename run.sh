#!/usr/bin/env bash
#
# Wrapper appelé par cron pour poster UNE vidéo sur une chaîne.
#
#   Usage : run.sh <nom_chaine> [jitter_max_secondes]
#
#   <nom_chaine>          : nom du dossier ET suffixe du token
#                          (ex. "chaine1" -> dossier ./chaine1, token token_chaine1.json)
#   [jitter_max_secondes] : décalage aléatoire avant de poster (défaut 3000 = ~50 min),
#                          pour ne jamais poster pile à l'heure ronde.
#
# Le jitter est fait ici (et non dans le cron) car /bin/sh de cron n'a pas $RANDOM.
#
set -euo pipefail

CHANNEL="${1:?usage: run.sh <nom_chaine> [jitter_max_secondes]}"
JITTER_MAX="${2:-3000}"

# Se place dans le dossier du script, quel que soit le répertoire d'appel de cron.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Décalage aléatoire dans la fenêtre (0..JITTER_MAX secondes).
sleep $(( RANDOM % (JITTER_MAX + 1) ))

mkdir -p logs

# Active le venv s'il existe (adapte si ton venv est ailleurs).
[ -d .venv ] && source .venv/bin/activate

python poster.py \
  --folder  "./$CHANNEL" \
  --token   "token_$CHANNEL.json" \
  --secrets client_secret.json \
  --max 1 \
  >> "logs/$CHANNEL.log" 2>&1
