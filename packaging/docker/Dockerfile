FROM oven/bun:1.2.20

WORKDIR /repo

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    nodejs \
    npm \
    tar \
    unzip \
  && npm install -g pnpm@10.27.0 \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN pnpm install --frozen-lockfile

# Persistent directories (mount volumes here on PaaS/SSH).
ENV OPENWORK_DATA_DIR=/data/openwork-orchestrator
ENV OPENWORK_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV OPENWORK_WORKSPACE=/workspace

# OpenWork host contract surface.
EXPOSE 8787

# Optional: opencode-router health (only relevant if you enable the router).
EXPOSE 3005

VOLUME ["/workspace", "/data"]

# Defaults:
# - OpenWork server is published intentionally via --remote-access
# - OpenCode stays internal (127.0.0.1:4096)
# - OpenWork server proxies OpenCode via localhost
# - OpenCode Router disabled by default
CMD [ \
  "sh", \
  "-lc", \
  "TOKEN_FILE=/data/openwork-worker.env; if [ -f \"$TOKEN_FILE\" ]; then . \"$TOKEN_FILE\"; fi; if [ -z \"${OPENWORK_TOKEN:-}\" ]; then OPENWORK_TOKEN=owc_$(node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"); export OPENWORK_TOKEN; fi; if [ -z \"${OPENWORK_HOST_TOKEN:-}\" ]; then OPENWORK_HOST_TOKEN=owh_$(node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"); export OPENWORK_HOST_TOKEN; fi; umask 077; printf 'OPENWORK_TOKEN=%s\\nOPENWORK_HOST_TOKEN=%s\\n' \"$OPENWORK_TOKEN\" \"$OPENWORK_HOST_TOKEN\" > \"$TOKEN_FILE\"; echo \"OpenWork worker tokens are stored in $TOKEN_FILE\"; bun apps/orchestrator/src/cli.ts serve --workspace /workspace --remote-access --openwork-port ${OPENWORK_PORT:-8787} --opencode-host 127.0.0.1 --opencode-port 4096 --connect-host ${OPENWORK_CONNECT_HOST:-127.0.0.1} --cors ${OPENWORK_CORS_ORIGINS:-'*'} --approval ${OPENWORK_APPROVAL_MODE:-manual} --no-opencode-router" \
]
