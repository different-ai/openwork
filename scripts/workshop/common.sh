# Shared settings for the workshop scripts. Source, don't run.
# Override any value in your environment, e.g. WORKSHOP_SNAPSHOT=... ./start.sh 30
WORKSHOP_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Private per-launch files (attendee links, member test logins). Never inside a checkout.
WORKSHOP_HOME="${WORKSHOP_HOME:-$HOME/.openwork/workshops}"
# Reviewed app commit (must be merged into origin/dev) and the clean, signed-out
# desktop snapshot built from it. Leave WORKSHOP_SNAPSHOT empty to build each
# desktop from source instead (slower: ~3 min per seat instead of ~1).
WORKSHOP_REF="${WORKSHOP_REF:-ef0db73ae009b6904d13bb8b1f5a391db713d86c}"
WORKSHOP_SNAPSHOT="${WORKSHOP_SNAPSHOT-workshop-desktop-ef0db73-20261021}"
WORKSHOP_TIMEZONE="${WORKSHOP_TIMEZONE:-America/Los_Angeles}"
WORKSHOP_NODE_BIN="${WORKSHOP_NODE_BIN:-}"

workshop_dir() { printf '%s/%s' "$WORKSHOP_HOME" "$1"; }

# Node 24+, the Daytona team key and (for start) the model key, fetched from
# Infisical inside the repo so the project is known. Never printed.
workshop_env() {
  local need_model="${1:-0}"
  if [ -n "$WORKSHOP_NODE_BIN" ]; then export PATH="$WORKSHOP_NODE_BIN:$PATH"; fi
  local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" != 24 ] && [ -z "$WORKSHOP_NODE_BIN" ]; then
    # The workshop is verified on Node 24; prefer a pnpm-managed one when present.
    local candidate
    for candidate in $(ls -d "$HOME"/Library/pnpm/nodejs/24*/bin "$HOME"/.local/share/pnpm/nodejs/24*/bin 2>/dev/null | sort -V -r); do
      export PATH="$candidate:$PATH"; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; break
    done
  fi
  if [ "$major" -lt 24 ]; then echo "Node 24+ is required (found ${major}). Set WORKSHOP_NODE_BIN to its bin directory." >&2; return 1; fi
  cd "$WORKSHOP_REPO" || return 1
  export DAYTONA_API_URL=https://app.daytona.io/api
  export DAYTONA_API_KEY="${DAYTONA_API_KEY:-$(infisical secrets get DAYTONA_API_KEY --env dev --path /openwork-ops --plain --silent 2>/dev/null)}"
  if [ -z "$DAYTONA_API_KEY" ] || [ "$DAYTONA_API_KEY" = "*not found*" ]; then echo "Missing DAYTONA_API_KEY: run 'infisical login' and try again." >&2; return 1; fi
  if [ "$need_model" = 1 ]; then
    export OPENAI_API_KEY="${OPENAI_API_KEY:-$(infisical secrets get OPENAI_API_KEY --env dev --path / --plain --silent 2>/dev/null)}"
    if [ -z "$OPENAI_API_KEY" ] || [ "$OPENAI_API_KEY" = "*not found*" ]; then echo "Missing OPENAI_API_KEY: run 'infisical login' and try again." >&2; return 1; fi
  fi
}
