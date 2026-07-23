# Stage 1: extract the docker CLI binary from the official image.
# The observer only needs the `docker` command for `docker ps`,
# `docker inspect`, and `docker logs` — not the full Docker engine
# (containerd, iptables, etc.) that `docker.io` pulls in on Debian.
FROM docker:cli AS docker-cli

# Stage 2: runtime image with just the Python app + docker CLI binary.
FROM python:3.12-slim
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY observer ./observer
COPY dashboard ./dashboard
COPY pyproject.toml README.md ./
ENV PYTHONUNBUFFERED=1 VLLM_OBSERVER_PORT=8088
EXPOSE 8088
ENTRYPOINT ["python", "-m", "observer.server"]
