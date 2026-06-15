FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    YT_DATA_DIR=/data \
    PORT=8080

WORKDIR /app

# Dépendances d'abord (cache Docker).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Code + interface.
COPY poster.py webapp.py ./
COPY templates ./templates
COPY static ./static

# Tout l'état (config, tokens, vidéos, logs) vit ici → à monter en volume.
VOLUME ["/data"]
EXPOSE 8080

CMD ["python", "webapp.py"]
