#!/usr/bin/env bash
# Execute the migrated eval specs against a REAL den stack + Electron inside a
# Daytona eval sandbox (created by .devcontainer/test-on-daytona.sh).
#
#   daytona exec <sandbox> -- bash -lc "cd /workspace && bash scripts/evals/daytona-real-run.sh"
#
# Steps: user-space MariaDB (no root in sandboxes), legacy flow baseline through
# the den stack, then the vitest spec lane against the same live stack.
set -euo pipefail
cd /workspace

# Sandbox exec sessions have private /tmp namespaces; the artifacts volume is
# the only log destination visible to other sessions (and over HTTP :8090).
# Default to the workspace so logs are readable from any exec session and over
# the results HTTP server; the artifacts volume restricts cross-session reads.
LOG_DIR="${OPENWORK_REAL_RUN_LOG_DIR:-/workspace/evals/results/real-run}"
mkdir -p "$LOG_DIR"
exec > >(tee "$LOG_DIR/real-run.log") 2>&1

# pnpm must never prompt in a sandbox: an interactive approve-builds/purge
# question kills the run before anything is logged.
export CI=true
export DISPLAY="${DISPLAY:-:99}"   # the host component verifies it answers

pnpm --dir evals install

H="$HOME"
MARIADB_VERSION="11.4.5"
if [ ! -x "$H/mariadb/bin/mariadbd" ]; then
  echo "==> Installing user-space MariaDB $MARIADB_VERSION"
  if [ ! -f /tmp/mariadb.tar.gz ]; then
    curl -sfL -o /tmp/mariadb.tar.gz "https://archive.mariadb.org/mariadb-$MARIADB_VERSION/bintar-linux-systemd-x86_64/mariadb-$MARIADB_VERSION-linux-systemd-x86_64.tar.gz"
  fi
  tar -xzf /tmp/mariadb.tar.gz -C "$H"
  rm -rf "$H/mariadb"
  mv "$H/mariadb-$MARIADB_VERSION-linux-systemd-x86_64" "$H/mariadb"
fi
export PATH="$H/mariadb/bin:$H/mariadb/scripts:$PATH"
mariadbd --version

# Member bootstrap (invitation flow) needs a way to mark the invited email
# verified; point it at the same native MariaDB the den stack runs on.
cat > "$H/mark-verified.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
email="${1:?email is required}"
escaped_email="${email//\'/\'\'}"
{
  printf "SET @openwork_eval_email = '%s';\n" "$escaped_email"
  cat <<'SQL'
UPDATE `user` SET email_verified = 1 WHERE email = @openwork_eval_email;
SQL
} | "$HOME/mariadb/bin/mariadb" --protocol=tcp -h 127.0.0.1 -P 3306 -uroot openwork_den
SH
chmod +x "$H/mark-verified.sh"
export OPENWORK_EVAL_MARK_VERIFIED_CMD="bash $H/mark-verified.sh {email}"

# Provider keys for vision validation live on the secrets volume when mounted.
if compgen -G "/daytona-secrets/*.env" > /dev/null; then
  set -a
  for secret_file in /daytona-secrets/*.env; do . "$secret_file"; done
  set +a
  echo "==> Sourced provider secrets from /daytona-secrets"
fi

if [ "${OPENWORK_REAL_RUN_SKIP_LEGACY:-0}" = "1" ]; then
  echo "==> Skipping legacy baseline (OPENWORK_REAL_RUN_SKIP_LEGACY=1)"
else
echo "==> Legacy baseline: org-connection-lifecycle-desktop through the den stack"
# Known caveat when the legacy flow runs INSIDE the sandbox: Frame 4 requests a
# sandbox-display capture (driven from outside via the daytona CLI), so its
# evidence validation can fail here even though the journey itself passes.
if pnpm evals --stack den --cdp-url http://127.0.0.1:9825 --flow org-connection-lifecycle-desktop 2>&1 | tee "$LOG_DIR/legacy-lifecycle.log"; then
  echo "LEGACY BASELINE: PASSED"
else
  echo "LEGACY BASELINE: FAILED (see legacy-lifecycle.log; expected in-sandbox at Frame 4 sandbox-capture)"
fi
fi

echo "==> New spec lane against the same live stack"
export OPENWORK_EVAL_DEN_API_URL="http://127.0.0.1:8790"
export OPENWORK_EVAL_DEN_WEB_URL="http://localhost:3005"
export OPENWORK_EVAL_CDP_URL="http://127.0.0.1:9825"
export OPENWORK_EVAL_APP_SPECS="1"
pnpm --dir evals run spec:nightly 2>&1 | tee "$LOG_DIR/specs-real.log"

echo "==> DONE"
