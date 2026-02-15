FROM node:22-bookworm-slim

ARG OPENWRK_VERSION=0.11.22

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "openwrk@${OPENWRK_VERSION}"

# Persistent directories (mount volumes here on PaaS/SSH).
ENV OPENWRK_DATA_DIR=/data/openwrk
ENV OPENWRK_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV OPENWORK_WORKSPACE=/workspace

# OpenWork host contract surface.
EXPOSE 8787

# Optional: opencode-router health (only relevant if you enable the router).
EXPOSE 3005

VOLUME ["/workspace", "/data"]

# Defaults:
# - OpenWork server is public (0.0.0.0:8787)
# - OpenCode stays internal (127.0.0.1:4096)
# - OpenWork server proxies OpenCode via localhost
# - OpenCode Router disabled by default
CMD [
  "openwrk",
  "serve",
  "--workspace", "/workspace",
  "--openwork-host", "0.0.0.0",
  "--openwork-port", "8787",
  "--opencode-host", "127.0.0.1",
  "--opencode-port", "4096",
  "--connect-host", "127.0.0.1",
  "--cors", "*",
  "--approval", "manual",
  "--no-opencode-router"
]
