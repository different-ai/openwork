#!/usr/bin/env bash
# Run ONE eval spec inside a Daytona sandbox, with the environment app specs need.
#
#   daytona exec <sandbox> -- bash -lc "cd /workspace && bash scripts/evals/daytona-spec.sh specs/app-den-tls-fault.slow.test.ts"
#
# Logs land in the workspace so they are readable from any exec session and over
# the results HTTP server.
set -euo pipefail
cd /workspace

SPEC="${1:?spec path relative to evals/ is required}"
LOG_DIR="${OPENWORK_SPEC_LOG_DIR:-/workspace/evals/results/spec-run}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(printf '%s' "$SPEC" | tr '/' '-').log"
exec > >(tee "$LOG") 2>&1

export CI=true
export DISPLAY="${DISPLAY:-:99}"   # the host component verifies it answers
export OPENWORK_EVAL_APP_SPECS=1
if [ -x "$HOME/mark-verified.sh" ]; then
  export OPENWORK_EVAL_MARK_VERIFIED_CMD="bash $HOME/mark-verified.sh {email}"
fi

if compgen -G "/daytona-secrets/*.env" > /dev/null; then
  set -a
  for secret_file in /daytona-secrets/*.env; do . "$secret_file"; done
  set +a
fi


# Den-dependent specs need the stack up. ensureDenStack is idempotent, so this is
# safe to call repeatedly; it is skipped unless a spec asks for it.
if [ "${OPENWORK_SPEC_NEEDS_DEN:-0}" = "1" ]; then
  echo "==> Ensuring the Den stack is running"
  export PATH="$HOME/mariadb/bin:$HOME/mariadb/scripts:$PATH"
  node --input-type=module -e 'const m = await import("/workspace/evals/runner/den-stack.ts"); await m.ensureDenStack({ log: (line) => console.log("   " + line), cdpCandidates: [], skipApp: true });'
fi

# Den env is only exported when a Den actually answers. Exporting it blindly
# makes den-gated specs run against nothing and fail with "fetch failed"
# instead of skipping with their own honest reason.
DEN_API_CANDIDATE="${OPENWORK_EVAL_DEN_API_URL:-http://127.0.0.1:8790}"
if curl -sf -m 3 -o /dev/null "$DEN_API_CANDIDATE/health"; then
  export OPENWORK_EVAL_DEN_API_URL="$DEN_API_CANDIDATE"
  export OPENWORK_EVAL_DEN_WEB_URL="${OPENWORK_EVAL_DEN_WEB_URL:-http://localhost:3005}"
  echo "==> Den answers at $OPENWORK_EVAL_DEN_API_URL"
else
  unset OPENWORK_EVAL_DEN_API_URL OPENWORK_EVAL_DEN_WEB_URL
  echo "==> No Den running; den-gated specs will skip (set OPENWORK_SPEC_NEEDS_DEN=1 to start one)"
fi

pnpm --dir evals install
echo "==> Running $SPEC"
pnpm --dir evals exec vitest run --config vitest.config.ts --project nightly "$SPEC"
