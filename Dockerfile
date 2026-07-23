FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io docker-cli \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY observer ./observer
COPY dashboard ./dashboard
COPY pyproject.toml README.md ./
ENV PYTHONUNBUFFERED=1 VLLM_OBSERVER_PORT=8088
EXPOSE 8088
ENTRYPOINT ["python", "-m", "observer.server"]
