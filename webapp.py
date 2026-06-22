#!/usr/bin/env python3
"""
yt-shorts-poster — interface web.

Permet, depuis un navigateur :
  - de connecter chaque chaîne YouTube (OAuth 2.0, bouton « Connecter ») ;
  - de déposer des vidéos + leurs métadonnées (titre, description, tags) ;
  - de régler par chaîne le nombre de posts/jour et la fenêtre horaire ;
  - de laisser un PLANIFICATEUR INTÉGRÉ poster tout seul, à des heures
    réparties aléatoirement dans la journée (plus besoin de cron).

Lancement :
    python webapp.py                 # écoute sur http://0.0.0.0:8080
    PORT=9000 python webapp.py       # autre port

Au premier accès, l'interface demande de créer un mot de passe.

Les réglages sont dans config.json (non versionné). Les vidéos vont dans
channels/<nom>/, les tokens OAuth dans tokens/token_<nom>.json.
"""

import io
import logging
import os
import random
import threading
from collections import defaultdict, deque
from datetime import datetime, time as dtime, timedelta
from functools import wraps
from pathlib import Path
from secrets import token_hex

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    from backports.zoneinfo import ZoneInfo  # type: ignore

import json

from flask import (Flask, abort, flash, redirect, render_template, request,
                   send_from_directory, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from apscheduler.schedulers.background import BackgroundScheduler

# On réutilise la logique d'upload déjà écrite et testée dans poster.py.
from poster import (SCOPES, VIDEO_EXTS, find_jobs, load_state, read_metadata,
                    save_state, upload_video)

# --- Chemins ---
# Le code et les templates restent dans ROOT ; tout l'ÉTAT (config, tokens, vidéos,
# logs) va dans DATA_DIR. En Docker, on règle YT_DATA_DIR=/data et on monte un volume.
ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("YT_DATA_DIR", ROOT))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_PATH = DATA_DIR / "config.json"
SECRETS_PATH = DATA_DIR / "client_secret.json"
CHANNELS_DIR = DATA_DIR / "channels"
TOKENS_DIR = DATA_DIR / "tokens"
LOGS_DIR = DATA_DIR / "logs"

# oauthlib refuse par défaut un scope renvoyé différent de celui demandé
# (YouTube ajoute parfois des scopes « déjà accordés »). On tolère.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

# --- Journalisation : fichier + tampon mémoire affiché dans l'UI ---
LOG_BUFFER: deque = deque(maxlen=400)


class _BufferHandler(logging.Handler):
    def emit(self, record):
        LOG_BUFFER.appendleft(self.format(record))


def _setup_logging():
    LOGS_DIR.mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")

    fileh = logging.FileHandler(LOGS_DIR / "webapp.log", encoding="utf-8")
    fileh.setFormatter(fmt)
    bufh = _BufferHandler()
    bufh.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(fileh)
    root.addHandler(bufh)


log = logging.getLogger("webapp")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_CHANNEL_NAMES = ["chaine1", "chaine2", "chaine3"]


def default_channel() -> dict:
    return {
        "enabled": True,
        "posts_per_day": 10,
        "window_start": 7,     # heure de début de la fenêtre de publication
        "window_end": 21,      # heure de fin
        "privacy": "public",   # valeur par défaut pour les nouvelles vidéos
        "title": None,         # nom de la chaîne (rempli à la connexion OAuth)
        "views": [],           # relevés manuels de vues : [{"date": "...", "views": N}, ...]
    }


def load_config() -> dict:
    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    else:
        cfg = {}

    cfg.setdefault("password_hash", None)
    cfg.setdefault("secret_key", token_hex(32))
    cfg.setdefault("base_url", os.environ.get("BASE_URL", "http://localhost:8080"))
    cfg.setdefault("timezone", "Europe/Paris")
    cfg.setdefault("channels", {})

    if not cfg["channels"]:
        for name in DEFAULT_CHANNEL_NAMES:
            cfg["channels"][name] = default_channel()

    # Complète les clés manquantes si on a fait évoluer le format.
    for ch in cfg["channels"].values():
        for k, v in default_channel().items():
            ch.setdefault(k, v)

    return cfg


def save_config():
    CONFIG_PATH.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


config = load_config()
save_config()  # écrit le fichier au premier lancement (génère secret_key)

# Sur http (test local), oauthlib exige une autorisation explicite du transport non-TLS.
if config["base_url"].startswith("http://"):
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

TZ = ZoneInfo(config["timezone"])


# ---------------------------------------------------------------------------
# Helpers chaînes / OAuth / YouTube
# ---------------------------------------------------------------------------
def channel_folder(name: str) -> Path:
    folder = CHANNELS_DIR / name
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def token_path(name: str) -> Path:
    TOKENS_DIR.mkdir(exist_ok=True)
    return TOKENS_DIR / f"token_{name}.json"


def redirect_uri() -> str:
    return config["base_url"].rstrip("/") + "/oauth/callback"


def get_credentials(name: str):
    """Retourne des credentials valides pour la chaîne, ou None si non connectée."""
    tp = token_path(name)
    if not tp.exists():
        return None
    try:
        creds = Credentials.from_authorized_user_file(str(tp), SCOPES)
    except Exception:
        return None
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                tp.write_text(creds.to_json())
            except Exception as e:
                log.warning("[%s] échec du rafraîchissement du token : %s", name, e)
                return None
        else:
            return None
    return creds


def get_youtube(name: str):
    creds = get_credentials(name)
    if not creds:
        return None
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def fetch_channel_title(name: str):
    """Récupère et mémorise le nom de la chaîne (1 unité de quota)."""
    youtube = get_youtube(name)
    if not youtube:
        return None
    try:
        resp = youtube.channels().list(part="snippet", mine=True).execute()
        items = resp.get("items", [])
        if items:
            title = items[0]["snippet"]["title"]
            config["channels"][name]["title"] = title
            save_config()
            return title
    except HttpError as e:
        log.warning("[%s] impossible de lire le nom de la chaîne : %s", name, e)
    return None


# Cache mémoire des stats YouTube : nom -> (timestamp epoch, data). Évite de
# rappeler l'API à chaque chargement de page (quota + latence).
_STATS_CACHE: dict = {}
STATS_TTL = 600  # secondes (10 min)


def fetch_youtube_stats(name: str, force: bool = False) -> dict:
    """Récupère les stats via l'API : abonnés + vues totales de la chaîne, et
    vues/likes/commentaires de chaque vidéo postée (via les video_id stockés).
    Renvoie un dict avec une clé 'error' explicite si le scope manque (403)."""
    now = datetime.now(TZ).timestamp()
    cached = _STATS_CACHE.get(name)
    if cached and not force and now - cached[0] < STATS_TTL:
        return cached[1]

    data = {"channel": None, "videos": [], "total_views": 0, "total_likes": 0,
            "total_comments": 0, "n_live": 0, "error": None, "fetched_at": None}

    youtube = get_youtube(name)
    if not youtube:
        data["error"] = "Chaîne non connectée."
        return data

    try:
        # --- Niveau chaîne (1 unité de quota) ---
        resp = youtube.channels().list(part="statistics,snippet", mine=True).execute()
        items = resp.get("items", [])
        if items:
            s = items[0]["statistics"]
            data["channel"] = {
                "title": items[0]["snippet"]["title"],
                "subs": int(s.get("subscriberCount", 0)),
                "subs_hidden": s.get("hiddenSubscriberCount", False),
                "views": int(s.get("viewCount", 0)),
                "videos": int(s.get("videoCount", 0)),
            }

        # --- Par vidéo postée (1 unité par lot de 50 IDs) ---
        state = load_state(channel_folder(name) / ".uploaded.json")
        ids = [info["video_id"] for info in state.values() if info.get("video_id")]
        vids = []
        for i in range(0, len(ids), 50):
            batch = ids[i:i + 50]
            rv = youtube.videos().list(part="statistics,snippet",
                                       id=",".join(batch)).execute()
            for it in rv.get("items", []):
                st = it.get("statistics", {})
                vids.append({
                    "id": it["id"],
                    "url": f"https://youtu.be/{it['id']}",
                    "title": it["snippet"]["title"],
                    "views": int(st.get("viewCount", 0)),
                    "likes": int(st.get("likeCount", 0)),
                    "comments": int(st.get("commentCount", 0)),
                })
        vids.sort(key=lambda v: v["views"], reverse=True)
        data["videos"] = vids
        data["n_live"] = len(vids)
        data["total_views"] = sum(v["views"] for v in vids)
        data["total_likes"] = sum(v["likes"] for v in vids)
        data["total_comments"] = sum(v["comments"] for v in vids)
        data["fetched_at"] = datetime.now(TZ).strftime("%H:%M")
    except HttpError as e:
        if "insufficient" in str(e).lower() or e.resp.status == 403:
            data["error"] = ("Permission de lecture manquante. Reconnecte la chaîne "
                             "(bouton « Connecter ») pour autoriser l'accès aux stats.")
        else:
            data["error"] = f"Erreur API : {e}"
        log.warning("[%s] échec récupération stats : %s", name, e)

    _STATS_CACHE[name] = (now, data)
    return data


def ensure_sidecars(name: str) -> int:
    """Crée un .json par défaut (titre = nom du fichier) pour toute vidéo du dossier
    qui n'en a pas. Permet de déposer des vidéos en SSH sans préparer les métadonnées."""
    ch = config["channels"].get(name, {})
    folder = channel_folder(name)
    created = 0
    for video in folder.iterdir():
        if video.suffix.lower() not in VIDEO_EXTS:
            continue
        sidecar = video.with_suffix(".json")
        if not sidecar.exists():
            meta = {
                "title": video.stem,
                "description": "",
                "tags": [],
                "privacy": ch.get("privacy", "public"),
                "made_for_kids": False,
            }
            sidecar.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
            created += 1
    return created


def channel_status(name: str) -> dict:
    """Infos affichées sur le dashboard pour une chaîne."""
    ch = config["channels"][name]
    folder = channel_folder(name)
    ensure_sidecars(name)
    state = load_state(folder / ".uploaded.json")
    pending = find_jobs(folder, state)
    return {
        "name": name,
        "cfg": ch,
        "connected": token_path(name).exists(),
        "pending": len(pending),
        "posted": len(state),
        "planned": [t.strftime("%H:%M") for t in SCHEDULE_TODAY.get(name, [])
                    if t > datetime.now(TZ)],
    }


# ---------------------------------------------------------------------------
# Planificateur
# ---------------------------------------------------------------------------
scheduler = BackgroundScheduler(timezone=TZ)
SCHEDULE_TODAY: dict = {}     # nom -> [datetime, ...] prévus aujourd'hui
_post_lock = threading.Lock()


def generate_times(ch: dict, now: datetime):
    """Tire `posts_per_day` horaires aléatoires dans la fenêtre [start, end] du jour."""
    n = int(ch.get("posts_per_day", 0))
    ws, we = int(ch["window_start"]), int(ch["window_end"])
    if n <= 0 or we <= ws:
        return []
    day = now.date()
    start = datetime.combine(day, dtime(ws, 0), tzinfo=TZ)
    end = datetime.combine(day, dtime(we, 0), tzinfo=TZ)
    total = (end - start).total_seconds()
    offsets = sorted(random.uniform(0, total) for _ in range(n))
    return [start + timedelta(seconds=o) for o in offsets]


def plan_channel(name: str):
    """(Re)génère les créneaux du jour pour UNE seule chaîne (sans toucher aux autres)."""
    # Retire les jobs déjà programmés pour cette chaîne (le ':' final évite de matcher
    # une chaîne dont le nom est un préfixe d'une autre).
    for job in scheduler.get_jobs():
        if job.id.startswith(f"post:{name}:"):
            job.remove()
    ch = config["channels"].get(name)
    if not ch or not ch.get("enabled"):
        SCHEDULE_TODAY[name] = []
        return
    now = datetime.now(TZ)
    times = generate_times(ch, now)
    SCHEDULE_TODAY[name] = times
    for t in times:
        if t > now:
            scheduler.add_job(
                post_one, "date", run_date=t, args=[name],
                id=f"post:{name}:{t.timestamp()}", misfire_grace_time=3600,
            )


def plan_day():
    """Recalcule les horaires du jour et (re)programme les jobs futurs (toutes chaînes)."""
    for job in scheduler.get_jobs():
        if job.id.startswith("post:"):
            job.remove()
    SCHEDULE_TODAY.clear()
    for name in list(config["channels"]):
        plan_channel(name)
    log.info("Planification du jour : %s",
             {n: len(ts) for n, ts in SCHEDULE_TODAY.items()})


def post_one(name: str):
    """Poste UNE vidéo en attente sur la chaîne. Appelé par le planificateur."""
    with _post_lock:  # un seul upload à la fois (ménage le réseau et le quota)
        ch = config["channels"].get(name)
        if not ch:
            return
        folder = channel_folder(name)
        ensure_sidecars(name)  # rend postables les vidéos déposées en SSH sans .json
        state_path = folder / ".uploaded.json"
        state = load_state(state_path)
        jobs = find_jobs(folder, state)
        if not jobs:
            log.info("[%s] rien à poster.", name)
            return

        youtube = get_youtube(name)
        if not youtube:
            log.warning("[%s] non connectée (OAuth) — post ignoré.", name)
            return

        video, sidecar = jobs[0]
        try:
            body = read_metadata(sidecar, video, add_shorts_tag=True)
            vid = upload_video(youtube, video, body)
            state[video.name] = {
                "video_id": vid,
                "url": f"https://youtu.be/{vid}",
                "uploaded_at": datetime.now(TZ).isoformat(),
                "title": body["snippet"]["title"],
            }
            save_state(state_path, state)
            log.info("[%s] posté : %s", name, video.name)
        except HttpError as e:
            log.error("[%s] échec %s : %s", name, video.name, e)
            if getattr(e, "resp", None) is not None and e.resp.status == 403:
                log.error("[%s] 403 — quota/limite de chaîne atteint, on réessaiera plus tard.", name)
        except Exception as e:
            log.error("[%s] échec %s : %s", name, video.name, e)


def start_scheduler():
    if scheduler.running:
        return
    # Replanifie chaque nuit à 00h01, et tout de suite pour le reste de la journée.
    scheduler.add_job(plan_day, "cron", hour=0, minute=1, id="planner")
    scheduler.start()
    plan_day()


# ---------------------------------------------------------------------------
# Flask
# ---------------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = config["secret_key"]
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4 Go par upload
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

# En production HTTPS (derrière un reverse-proxy), on sécurise le cookie de session
# et on fait confiance aux en-têtes X-Forwarded-* du proxy.
if config["base_url"].startswith("https://"):
    app.config["SESSION_COOKIE_SECURE"] = True
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if config["password_hash"] is None:
            return redirect(url_for("setup"))
        if not session.get("logged_in"):
            return redirect(url_for("login", next=request.path))
        return f(*args, **kwargs)
    return wrapper


@app.route("/setup", methods=["GET", "POST"])
def setup():
    if config["password_hash"] is not None:
        return redirect(url_for("login"))
    if request.method == "POST":
        pwd = request.form.get("password", "")
        if len(pwd) < 6:
            flash("Le mot de passe doit faire au moins 6 caractères.", "error")
        else:
            config["password_hash"] = generate_password_hash(pwd, method="pbkdf2:sha256")
            save_config()
            session["logged_in"] = True
            flash("Mot de passe créé. Bienvenue !", "ok")
            return redirect(url_for("dashboard"))
    return render_template("setup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if config["password_hash"] is None:
        return redirect(url_for("setup"))
    if request.method == "POST":
        if check_password_hash(config["password_hash"], request.form.get("password", "")):
            session["logged_in"] = True
            return redirect(request.args.get("next") or url_for("dashboard"))
        flash("Mot de passe incorrect.", "error")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


def build_spa_data() -> list:
    """Données injectées dans la SPA (front « clipstudio ») : une entrée par chaîne
    avec relevés (vues + abonnés), réglages, créneaux du jour et statut."""
    now = datetime.now(TZ)
    chans = []
    for name, ch in config["channels"].items():
        folder = channel_folder(name)
        ensure_sidecars(name)
        state = load_state(folder / ".uploaded.json")
        readings = sorted(ch.get("views", []), key=lambda e: e.get("date", ""))
        readings = [{"date": e["date"], "views": int(e.get("views", 0)),
                     "subs": int(e.get("subs", 0))} for e in readings]
        connected = token_path(name).exists()
        chans.append({
            "id": name,
            "connected": connected,
            "status": "connectée" if connected else "non connectée",
            "ytTitle": ch.get("title") or "—",
            "readings": readings,
            "settings": {
                "active": bool(ch.get("enabled")),
                "perDay": int(ch.get("posts_per_day", 0)),
                "start": int(ch.get("window_start", 0)),
                "end": int(ch.get("window_end", 0)),
                "privacy": ch.get("privacy", "public"),
            },
            "slots": [t.strftime("%H:%M") for t in SCHEDULE_TODAY.get(name, []) if t > now],
            "pending": len(find_jobs(folder, state)),
            "posted": len(state),
        })
    return chans


@app.route("/")
@login_required
def dashboard():
    return render_template("app.html", channels=build_spa_data(),
                           initial_view="global", has_secrets=SECRETS_PATH.exists())


@app.route("/stats")
@login_required
def stats():
    """Stats globales + détail filtrable par chaîne."""
    channels = [channel_status(n) for n in config["channels"]]
    totals = {
        "total_posted": sum(c["posted"] for c in channels),
        "total_pending": sum(c["pending"] for c in channels),
        "n_channels": len(channels),
        "n_connected": sum(1 for c in channels if c["connected"]),
        "max_posted": max((c["posted"] for c in channels), default=0),
    }
    sel = request.args.get("channel") or ""
    if sel not in config["channels"]:
        sel = ""
    detail = None
    if sel:
        ch = config["channels"][sel]
        views = sorted(ch.get("views", []), key=lambda e: e["date"])
        rows, prev = [], None
        for e in views:
            delta = None if prev is None else int(e["views"]) - prev
            rows.append({"date": e["date"], "views": int(e["views"]), "delta": delta})
            prev = int(e["views"])
        detail = {
            "name": sel, "cfg": ch,
            "st": next((c for c in channels if c["name"] == sel), None),
            "views": list(reversed(rows)),
            "spark": views_sparkline(views),
            "yt": fetch_youtube_stats(sel, force=request.args.get("refresh") == "1"),
        }
    return render_template("stats.html", channels=channels, stats=totals,
                           sel=sel, detail=detail)


@app.route("/logs")
@login_required
def logs_page():
    """Journal récent, filtrable par chaîne (lignes contenant son nom)."""
    sel = request.args.get("channel") or ""
    if sel not in config["channels"]:
        sel = ""
    lines = list(LOG_BUFFER)
    if sel:
        lines = [ln for ln in lines if sel in ln]
    return render_template("logs.html", lines=lines[:300],
                           names=list(config["channels"]), sel=sel)


def views_sparkline(views, w=600, h=140, pad=14):
    """Construit les données d'un mini-graphe SVG à partir des relevés de vues."""
    vals = [int(e["views"]) for e in views]
    if len(vals) < 2:
        return None
    vmin, vmax = min(vals), max(vals)
    span = (vmax - vmin) or 1
    n = len(vals)
    pts = []
    for i, v in enumerate(vals):
        x = pad + (w - 2 * pad) * (i / (n - 1))
        y = h - pad - (h - 2 * pad) * ((v - vmin) / span)
        pts.append(f"{x:.1f},{y:.1f}")
    return {"points": " ".join(pts), "w": w, "h": h, "vmin": vmin, "vmax": vmax}


@app.route("/channel/<name>")
@login_required
def channel(name):
    if name not in config["channels"]:
        abort(404)
    return render_template("app.html", channels=build_spa_data(),
                           initial_view=name, has_secrets=SECRETS_PATH.exists())


@app.route("/channel/<name>/settings", methods=["POST"])
@login_required
def channel_settings(name):
    if name not in config["channels"]:
        abort(404)
    ch = config["channels"][name]
    ch["enabled"] = request.form.get("enabled") == "on"
    ch["posts_per_day"] = max(0, int(request.form.get("posts_per_day", ch["posts_per_day"])))
    ch["window_start"] = min(23, max(0, int(request.form.get("window_start", ch["window_start"]))))
    ch["window_end"] = min(24, max(0, int(request.form.get("window_end", ch["window_end"]))))
    ch["privacy"] = request.form.get("privacy", ch["privacy"])
    save_config()
    plan_day()  # les changements prennent effet immédiatement
    flash("Réglages enregistrés.", "ok")
    return redirect(url_for("channel", name=name))


def _read_json_text(fstorage):
    """Lit et valide un fichier JSON envoyé. Retourne (texte, None) ou (None, erreur)."""
    try:
        text = fstorage.read().decode("utf-8")
        json.loads(text)
        return text, None
    except Exception as e:
        return None, str(e)


@app.route("/channel/<name>/upload", methods=["POST"])
@login_required
def upload(name):
    if name not in config["channels"]:
        abort(404)
    folder = channel_folder(name)
    files = [f for f in request.files.getlist("videos") if f and f.filename]
    if not files:
        flash("Aucun fichier sélectionné.", "error")
        return redirect(url_for("channel", name=name))

    # Métadonnées du formulaire — utilisées seulement pour les vidéos SANS JSON fourni.
    tags = [t.strip() for t in request.form.get("tags", "").split(",") if t.strip()]
    privacy = request.form.get("privacy", config["channels"][name]["privacy"])
    made_for_kids = request.form.get("made_for_kids") == "on"
    base_title = request.form.get("title", "").strip()
    description = request.form.get("description", "")

    def form_meta(title):
        return json.dumps({
            "title": base_title or title,
            "description": description,
            "tags": tags,
            "privacy": privacy,
            "made_for_kids": made_for_kids,
        }, indent=2, ensure_ascii=False)

    # On regroupe par nom de base pour associer les paires vidéo + JSON déposées
    # en masse (clip01.mp4 + clip01.json), comme la structure attendue par poster.py.
    groups = defaultdict(dict)
    ignored = []
    for f in files:
        p = Path(f.filename)
        ext = p.suffix.lower()
        stem = secure_filename(p.stem) or "video"
        if ext in VIDEO_EXTS:
            groups[stem]["video"] = f
            groups[stem]["ext"] = ext
        elif ext == ".json":
            groups[stem]["json"] = f
        else:
            ignored.append(f.filename)

    n_videos = n_json = 0
    for stem, g in groups.items():
        if "video" in g:
            # Trouve un nom libre et applique le MÊME au JSON pour garder la paire.
            ext = g["ext"]
            final, i = stem, 1
            while (folder / f"{final}{ext}").exists():
                final = f"{stem}_{i}"
                i += 1
            video_dest = folder / f"{final}{ext}"
            g["video"].save(str(video_dest))
            n_videos += 1

            json_dest = video_dest.with_suffix(".json")
            if "json" in g:
                text, err = _read_json_text(g["json"])
                if err:
                    flash(f"JSON invalide pour {final} ({err}) — métadonnées du formulaire utilisées.", "error")
                    json_dest.write_text(form_meta(video_dest.stem), encoding="utf-8")
                else:
                    json_dest.write_text(text, encoding="utf-8")
                    n_json += 1
            else:
                json_dest.write_text(form_meta(video_dest.stem), encoding="utf-8")
        elif "json" in g:
            # JSON seul → métadonnées pour une vidéo existante du même nom.
            text, err = _read_json_text(g["json"])
            if err:
                flash(f"JSON invalide ({stem}.json) ignoré : {err}", "error")
            else:
                (folder / f"{stem}.json").write_text(text, encoding="utf-8")
                n_json += 1

    parts = []
    if n_videos:
        parts.append(f"{n_videos} vidéo(s)")
    if n_json:
        parts.append(f"{n_json} fichier(s) JSON")
    if parts:
        flash(" + ".join(parts) + " ajouté(s).", "ok")
    if ignored:
        flash("Ignoré(s) (ni vidéo ni .json) : " + ", ".join(ignored[:5])
              + ("…" if len(ignored) > 5 else ""), "error")

    if request.form.get("next") == "library":
        return redirect(url_for("library", channel=name))
    return redirect(url_for("channel", name=name))


@app.route("/channel/<name>/delete", methods=["POST"])
@login_required
def delete_pending(name):
    if name not in config["channels"]:
        abort(404)
    folder = channel_folder(name)
    target = secure_filename(request.form.get("video", ""))
    video = folder / target
    if video.exists() and video.suffix.lower() in VIDEO_EXTS:
        video.unlink()
        sidecar = video.with_suffix(".json")
        if sidecar.exists():
            sidecar.unlink()
        flash(f"Supprimé : {target}", "ok")
    return redirect(url_for("channel", name=name))


@app.route("/channel/<name>/post-now", methods=["POST"])
@login_required
def post_now(name):
    if name not in config["channels"]:
        abort(404)
    # Lance l'upload en tâche de fond pour ne pas bloquer la page.
    scheduler.add_job(post_one, args=[name], misfire_grace_time=60)
    flash("Upload lancé en arrière-plan — voir les logs.", "ok")
    return redirect(url_for("channel", name=name))


@app.route("/schedule/regenerate", methods=["POST"])
@login_required
def regenerate_schedule():
    """Re-tire au hasard les horaires de publication du jour (toutes chaînes)."""
    plan_day()
    now = datetime.now(TZ)
    remaining = sum(len([t for t in ts if t > now]) for ts in SCHEDULE_TODAY.values())
    flash(f"Horaires régénérés — {remaining} créneau(x) restant(s) aujourd'hui.", "ok")
    return redirect(request.referrer or url_for("dashboard"))


@app.route("/channel/<name>/cadence", methods=["POST"])
@login_required
def set_cadence(name):
    """Modifie rapidement le nombre de vidéos/jour d'une chaîne (depuis le dashboard)."""
    if name not in config["channels"]:
        abort(404)
    try:
        n = max(0, min(50, int(request.form.get("posts_per_day", ""))))
    except (TypeError, ValueError):
        flash("Cadence invalide.", "error")
        return redirect(request.referrer or url_for("dashboard"))
    config["channels"][name]["posts_per_day"] = n
    save_config()
    plan_channel(name)  # applique tout de suite la nouvelle cadence
    flash(f"Cadence de « {name} » : {n} vidéo(s)/jour.", "ok")
    return redirect(request.referrer or url_for("dashboard"))


@app.route("/channel/<name>/schedule/regenerate", methods=["POST"])
@login_required
def regenerate_channel_schedule(name):
    """Re-tire au hasard les horaires du jour pour cette chaîne uniquement."""
    if name not in config["channels"]:
        abort(404)
    plan_channel(name)
    now = datetime.now(TZ)
    remaining = len([t for t in SCHEDULE_TODAY.get(name, []) if t > now])
    flash(f"Horaires régénérés pour cette chaîne — {remaining} créneau(x) restant(s) aujourd'hui.", "ok")
    return redirect(url_for("channel", name=name))


# --- Bibliothèque (vue galerie « façon Drive ») ---
@app.route("/library")
@login_required
def library():
    names = list(config["channels"])
    sel = request.args.get("channel") or (names[0] if names else None)
    items, total_mb = [], 0.0
    if sel and sel in config["channels"]:
        ensure_sidecars(sel)
        folder = channel_folder(sel)
        state = load_state(folder / ".uploaded.json")
        for video, sidecar in find_jobs(folder, state):
            meta = {}
            try:
                meta = json.loads(sidecar.read_text())
            except Exception:
                pass
            size_mb = video.stat().st_size / 1024 / 1024
            total_mb += size_mb
            items.append({
                "file": video.name,
                "title": meta.get("title") or video.stem,
                "size_mb": round(size_mb, 1),
            })
    # Compteurs des autres chaînes pour les onglets.
    counts = {}
    for n in names:
        ensure_sidecars(n)
        f = channel_folder(n)
        counts[n] = len(find_jobs(f, load_state(f / ".uploaded.json")))
    titles = {n: config["channels"][n].get("title") for n in names}
    return render_template("library.html", names=names, sel=sel, items=items,
                           counts=counts, titles=titles, total=len(items),
                           total_mb=round(total_mb, 1),
                           ch=config["channels"].get(sel))


@app.route("/channel/<name>/media/<path:filename>")
@login_required
def media(name, filename):
    """Sert un fichier vidéo de la chaîne (pour l'aperçu/lecture dans la galerie)."""
    if name not in config["channels"]:
        abort(404)
    safe = secure_filename(filename)
    return send_from_directory(channel_folder(name), safe, conditional=True)


# --- Gestion des chaînes (ajout / suppression) ---
@app.route("/channels/add", methods=["POST"])
@login_required
def add_channel():
    raw = request.form.get("name", "").strip()
    name = secure_filename(raw)
    if not name:
        flash("Nom de chaîne invalide.", "error")
    elif name in config["channels"]:
        flash("Cette chaîne existe déjà.", "error")
    else:
        config["channels"][name] = default_channel()
        save_config()
        plan_day()
        flash(f"Chaîne « {name} » ajoutée.", "ok")
    return redirect(url_for("dashboard"))


@app.route("/channel/<name>/rename", methods=["POST"])
@login_required
def rename_channel(name):
    if name not in config["channels"]:
        abort(404)
    new = secure_filename(request.form.get("new_name", "").strip())
    back = url_for("channel", name=name)
    if not new:
        flash("Nom invalide.", "error")
        return redirect(back)
    if new == name:
        return redirect(back)
    if new in config["channels"]:
        flash("Une chaîne porte déjà ce nom.", "error")
        return redirect(back)
    # Déplace le dossier des vidéos et le token associés.
    old_folder = CHANNELS_DIR / name
    if old_folder.exists():
        old_folder.rename(CHANNELS_DIR / new)
    old_tok = token_path(name)
    if old_tok.exists():
        old_tok.rename(TOKENS_DIR / f"token_{new}.json")
    config["channels"][new] = config["channels"].pop(name)
    save_config()
    plan_day()
    flash(f"Chaîne renommée en « {new} ».", "ok")
    return redirect(url_for("channel", name=new))


# --- Identifiants OAuth (client_secret.json), partagés entre les chaînes ---
@app.route("/credentials/upload", methods=["POST"])
@login_required
def upload_credentials():
    back = request.referrer or url_for("dashboard")
    f = request.files.get("secrets")
    if not f or f.filename == "":
        flash("Aucun fichier sélectionné.", "error")
        return redirect(back)
    try:
        data = json.loads(f.read().decode("utf-8"))
    except Exception:
        flash("Fichier JSON invalide.", "error")
        return redirect(back)
    if "web" not in data and "installed" not in data:
        flash("Ce JSON n'est pas un identifiant OAuth Google (clé « web » ou « installed » absente).", "error")
        return redirect(back)
    SECRETS_PATH.write_text(json.dumps(data, ensure_ascii=False))
    if "web" not in data:
        flash("Enregistré, MAIS c'est un client « Application de bureau ». Pour le bouton "
              "« Connecter », il faut un client « Application Web ». (Voir WEB.md)", "error")
    else:
        flash("Identifiants OAuth enregistrés ✓", "ok")
    return redirect(back)


# --- Suivi manuel des vues ---
@app.route("/channel/<name>/views/add", methods=["POST"])
@login_required
def add_views(name):
    if name not in config["channels"]:
        abort(404)
    back = url_for("channel", name=name)
    date = request.form.get("date", "").strip()
    raw = request.form.get("views", "").replace(" ", "").replace(",", "")
    if not date:
        flash("Date manquante.", "error")
        return redirect(back)
    try:
        views = int(raw)
    except ValueError:
        flash("Nombre de vues invalide.", "error")
        return redirect(back)
    # Abonnés : optionnel. Si vide, on reprend la dernière valeur connue.
    raw_subs = request.form.get("subs", "").replace(" ", "").replace(",", "")
    lst = [e for e in config["channels"][name].get("views", []) if e.get("date") != date]
    lst.sort(key=lambda e: e["date"])
    try:
        subs = int(raw_subs)
    except ValueError:
        subs = lst[-1].get("subs", 0) if lst else 0
    lst.append({"date": date, "views": views, "subs": subs})
    lst.sort(key=lambda e: e["date"])
    config["channels"][name]["views"] = lst
    save_config()
    flash("Relevé enregistré.", "ok")
    return redirect(back)


@app.route("/channel/<name>/views/delete", methods=["POST"])
@login_required
def delete_views(name):
    if name not in config["channels"]:
        abort(404)
    date = request.form.get("date", "")
    config["channels"][name]["views"] = [
        e for e in config["channels"][name].get("views", []) if e.get("date") != date]
    save_config()
    flash("Relevé supprimé.", "ok")
    return redirect(url_for("channel", name=name))


# --- OAuth web ---
@app.route("/channel/<name>/connect")
@login_required
def connect(name):
    if name not in config["channels"]:
        abort(404)
    if not SECRETS_PATH.exists():
        flash("client_secret.json manquant sur le serveur.", "error")
        return redirect(url_for("dashboard"))
    flow = Flow.from_client_secrets_file(str(SECRETS_PATH), scopes=SCOPES,
                                         redirect_uri=redirect_uri())
    auth_url, state = flow.authorization_url(
        access_type="offline", include_granted_scopes="true", prompt="consent")
    session["oauth_state"] = state
    session["oauth_channel"] = name
    # PKCE : le code_verifier généré ici doit être réutilisé au callback (autre requête,
    # autre objet Flow), sinon Google renvoie « Missing code verifier ».
    session["oauth_verifier"] = flow.code_verifier
    return redirect(auth_url)


@app.route("/oauth/callback")
@login_required
def oauth_callback():
    name = session.get("oauth_channel")
    state = session.get("oauth_state")
    if not name or not state:
        flash("Session OAuth expirée, réessaie.", "error")
        return redirect(url_for("dashboard"))
    flow = Flow.from_client_secrets_file(str(SECRETS_PATH), scopes=SCOPES,
                                         state=state, redirect_uri=redirect_uri())
    # Réinjecte le code_verifier PKCE mémorisé à l'étape /connect.
    flow.code_verifier = session.get("oauth_verifier")
    # On reconstruit l'URL de retour depuis base_url pour éviter les soucis http/https
    # derrière un reverse-proxy.
    authorization_response = config["base_url"].rstrip("/") + request.full_path
    try:
        flow.fetch_token(authorization_response=authorization_response)
    except Exception as e:
        flash(f"Échec de la connexion OAuth : {e}", "error")
        return redirect(url_for("dashboard"))

    creds = flow.credentials
    token_path(name).write_text(creds.to_json())
    title = fetch_channel_title(name)
    flash(f"Chaîne « {title or name} » connectée ✓", "ok")
    return redirect(url_for("dashboard"))


def main():
    _setup_logging()
    if not SECRETS_PATH.exists():
        log.warning("client_secret.json absent — la connexion OAuth ne marchera pas tant qu'il manque.")
    start_scheduler()
    port = int(os.environ.get("PORT", 8080))
    log.info("Interface web sur le port %d (base_url=%s)", port, config["base_url"])
    # waitress = serveur WSGI de production (mono-process → un seul planificateur).
    # On retombe sur le serveur de dev Flask s'il n'est pas installé.
    try:
        from waitress import serve
        log.info("Serveur : waitress (production)")
        serve(app, host="0.0.0.0", port=port, threads=8)
    except ImportError:
        log.warning("waitress absent — serveur de développement Flask (déconseillé en prod).")
        app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
