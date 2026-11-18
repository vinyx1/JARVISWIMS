# J.A.R.V.I.S. for Railway (or any Docker host). Public mode: a private room per visitor,
# rate limits and a daily AI budget. See DEPLOY.md.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf \
    JARVIS_PUBLIC=1 \
    JARVIS_DATA=/data

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

# Jarvis's ears, baked into the image so a deploy never waits on a ~150-480 MB download.
# base.en is ~3x faster than small.en on a shared CPU; pass --build-arg STT_MODEL=small.en for
# better accuracy in noise (needs ~1 GB more RAM).
ARG STT_MODEL=base.en
ENV JARVIS_STT_MODEL=${STT_MODEL}
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${STT_MODEL}', device='cpu', compute_type='int8')"

# Jarvis's voice: Linux has no macOS `say`, so Piper speaks instead, with a British male voice
# (en_GB-alan-medium, ~60 MB). JARVIS_PIPER_VOICE can point at another downloaded voice.
RUN python -m piper.download_voices --download-dir /opt/piper en_GB-alan-medium

COPY backend backend
COPY frontend frontend
COPY prompts prompts

# Run as an unprivileged user. Railway mounts the volume at /data owned by root, so the start
# command fixes its ownership, then drops privileges before starting the server.
RUN useradd --system --uid 10001 --home /app jarvis && mkdir -p /data && chown -R jarvis /data /opt/hf /opt/piper

EXPOSE 8000
# One worker on purpose: rooms, rate limits and the budget live in this process's memory.
CMD ["sh", "-c", "chown -R jarvis /data && exec setpriv --reuid=jarvis --regid=jarvis --init-groups \
  uvicorn main:app --app-dir backend --host 0.0.0.0 --port ${PORT:-8000} --workers 1 \
  --no-server-header --timeout-keep-alive 5 --limit-concurrency 200 --no-access-log"]
