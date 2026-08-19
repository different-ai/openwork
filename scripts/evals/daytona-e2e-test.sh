#!/usr/bin/env bash
# Run ONE E2E test inside a Daytona sandbox, with the environment app tests need.
#
#   daytona exec <sandbox> -- bash -lc "cd /workspace && bash scripts/evals/daytona-e2e-test.sh specs/app-den-tls-fault.e2e.test.ts"
#
# Logs land in the workspace so they are readable from any exec session and over
# the results HTTP server.
set -euo pipefail
cd /workspace

TEST="${1:?E2E test path relative to evals/ is required}"
LOG_DIR="${OPENWORK_E2E_TEST_LOG_DIR:-/workspace/evals/results/e2e-test-run}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(printf '%s' "$TEST" | tr '/' '-').log"
exec > >(tee "$LOG") 2>&1

export CI=true
export DISPLAY="${DISPLAY:-:99}"   # the host component verifies it answers
export OPENWORK_EVAL_E2E_TESTS=1
if [ -x "$HOME/mark-verified.sh" ]; then
  export OPENWORK_EVAL_MARK_VERIFIED_CMD="bash $HOME/mark-verified.sh {email}"
fi

if compgen -G "/daytona-secrets/*.env" > /dev/null; then
  set -a
  for secret_file in /daytona-secrets/*.env; do . "$secret_file"; done
  set +a
fi


# Den-dependent tests need the stack up. ensureDenStack is idempotent, so this is
# safe to call repeatedly; it is skipped unless a test asks for it.
if [ "${OPENWORK_E2E_TEST_NEEDS_DEN:-0}" = "1" ]; then
  echo "==> Ensuring the Den stack is running"
  export PATH="$HOME/mariadb/bin:$HOME/mariadb/scripts:$PATH"
  node --input-type=module -e 'const m = await import("/workspace/evals/runner/den-stack.ts"); await m.ensureDenStack({ log: (line) => console.log("   " + line), cdpCandidates: [], skipApp: true });'
fi

# Den env is only exported when a Den actually answers. Exporting it blindly
# makes Den-gated tests run against nothing and fail with "fetch failed"
# instead of skipping with their own honest reason.
DEN_API_CANDIDATE="${OPENWORK_EVAL_DEN_API_URL:-http://127.0.0.1:8790}"
if curl -sf -m 3 -o /dev/null "$DEN_API_CANDIDATE/health"; then
  export OPENWORK_EVAL_DEN_API_URL="$DEN_API_CANDIDATE"
  export OPENWORK_EVAL_DEN_WEB_URL="${OPENWORK_EVAL_DEN_WEB_URL:-http://localhost:3005}"
  echo "==> Den answers at $OPENWORK_EVAL_DEN_API_URL"
else
  unset OPENWORK_EVAL_DEN_API_URL OPENWORK_EVAL_DEN_WEB_URL
  echo "==> No Den running; Den-gated tests will skip (set OPENWORK_E2E_TEST_NEEDS_DEN=1 to start one)"
fi

pnpm --dir evals install
echo "==> Running E2E test $TEST"
pnpm --dir evals exec vitest run --config vitest.config.ts --project e2e "$TEST"
