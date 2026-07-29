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
pnpm --dir evals install

# Sandbox exec sessions have private /tmp namespaces; the artifacts volume is
# the only log destination visible to other sessions (and over HTTP :8090).
LOG_DIR="${OPENWORK_REAL_RUN_LOG_DIR:-/daytona-artifacts/real-run}"
mkdir -p "$LOG_DIR"
exec > >(tee "$LOG_DIR/real-run.log") 2>&1

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
export OPENWORK_EVAL_MARK_VERIFIED_CMD="$H/mariadb/bin/mariadb --protocol=tcp -h 127.0.0.1 -P 3306 -uroot openwork_den -e \"UPDATE \\\`user\\\` SET email_verified = 1 WHERE email = '{email}'\""

echo "==> Legacy baseline: org-connection-lifecycle-desktop through the den stack"
# Known caveat when the legacy flow runs INSIDE the sandbox: Frame 4 requests a
# sandbox-display capture (driven from outside via the daytona CLI), so its
# evidence validation can fail here even though the journey itself passes.
if pnpm evals --stack den --cdp-url http://127.0.0.1:9825 --flow org-connection-lifecycle-desktop 2>&1 | tee "$LOG_DIR/legacy-lifecycle.log"; then
  echo "LEGACY BASELINE: PASSED"
else
  echo "LEGACY BASELINE: FAILED (see legacy-lifecycle.log; expected in-sandbox at Frame 4 sandbox-capture)"
fi

echo "==> New spec lane against the same live stack"
export OPENWORK_EVAL_DEN_API_URL="http://127.0.0.1:8790"
export OPENWORK_EVAL_DEN_WEB_URL="http://localhost:3005"
export OPENWORK_EVAL_CDP_URL="http://127.0.0.1:9825"
pnpm --dir evals run spec:nightly 2>&1 | tee "$LOG_DIR/specs-real.log"

echo "==> DONE"
