FROM node:22-bookworm-slim

ARG OPENWORK_SERVER_VERSION=0.18.4
# The OpenCode engine version; keep it equal to constants.json `opencodeV2Version`.
ARG OPENCODE2_VERSION=2.0.26

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "openwork-server@${OPENWORK_SERVER_VERSION}"

# npm pack verifies the per-platform engine tarball against the registry's
# integrity hash before it is unpacked.
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) package="@opencode/cli-linux-x64-baseline" ;; \
    arm64) package="@opencode/cli-linux-arm64" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  tmpdir="$(mktemp -d)"; \
  (cd "$tmpdir" && npm pack --silent "${package}@${OPENCODE2_VERSION}"); \
  tar -xzf "$tmpdir"/*.tgz -C "$tmpdir" package/bin/opencode; \
  install -m 0755 "$tmpdir/package/bin/opencode" /usr/local/bin/opencode2; \
  rm -rf "$tmpdir"

# Persistent directories (mount volumes here on PaaS/SSH).
# The data path deliberately keeps its historical name: existing deployments
# have volumes mounted at /data/openwork-orchestrator, and renaming it here
# would silently orphan their state. The orchestrator CLI itself is gone; this
# is only a directory name kept for compatibility.
ENV OPENWORK_DATA_DIR=/data/openwork-orchestrator
ENV OPENWORK_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV OPENWORK_WORKSPACE=/workspace

# OpenWork host contract surface.
EXPOSE 8787

VOLUME ["/workspace", "/data"]

# Defaults:
# - OpenWork server is published intentionally via --host 0.0.0.0
# - OpenCode is managed by openwork-server and stays internal
CMD ["/bin/sh", "-lc", "plugin_dir=\"$(npm root -g)/openwork-server/dist/opencode-plugins\"; test -d \"$plugin_dir\"; export OPENWORK_OPENCODE2_BIN=/usr/local/bin/opencode2 OPENWORK_EXTENSIONS_PLUGIN_DIR=\"$plugin_dir\"; exec openwork-server --workspace \"${OPENWORK_WORKSPACE:-/workspace}\" --host 0.0.0.0 --port \"${OPENWORK_PORT:-8787}\" --cors \"${OPENWORK_CORS_ORIGINS:-*}\" --approval \"${OPENWORK_APPROVAL_MODE:-manual}\""]
