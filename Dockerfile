# Prism — image de production (API FastAPI + frontend servi par le même processus).
# Construire : docker build -t prism .
# Lancer     : docker run -p 8000:8000 -e PRISM_JWT_SECRET=… -e PRISM_DATABASE_URL=postgresql://… -e GEMINI_API_KEY=… prism
FROM python:3.13-slim

# Node.js : vérification syntaxique du JavaScript des widgets générés (sanitize.js_syntax_errors).
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend

# Pas de droits root à l'exécution ; data/ reste inscriptible (secret de développement, SQLite local).
RUN useradd --create-home --uid 10001 prism && mkdir -p /app/data && chown -R prism:prism /app/data
USER prism

# PORT est fourni par l'hébergeur (Render : 10000) ; 8000 sinon.
ENV PYTHONUNBUFFERED=1 \
    PRISM_ENV=production \
    PRISM_HOST=0.0.0.0 \
    FORWARDED_ALLOW_IPS=*
EXPOSE 8000
CMD ["python", "backend/app.py"]
