#!/usr/bin/env bash
set -euo pipefail

# Start the Den server stack inside a Daytona sandbox.
# Services: MySQL, Den API, and Den Web.

if [ -n "${OPENWORK_WORKSPACE_DIR:-}" ]; then
  REPO_DIR="$OPENWORK_WORKSPACE_DIR"
elif [ -f /workspace/package.json ]; then
  REPO_DIR="/workspace"
else
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$REPO_DIR"

# Per-test Den env from the eval harness (base64 KEY=VALUE lines, one per
# line). Exported first so a caller's value wins over the defaults below.
if [ -n "${OPENWORK_DEN_EXTRA_ENV_B64:-}" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      [A-Z_]*=*) export "$line" ;;
      *) echo "ERROR: invalid Den env line from OPENWORK_DEN_EXTRA_ENV_B64." >&2; exit 1 ;;
    esac
  done <<EOF_EXTRA_ENV
$(printf %s "$OPENWORK_DEN_EXTRA_ENV_B64" | base64 -d)
EOF_EXTRA_ENV
fi

DEN_API_PORT="${DEN_API_PORT:-8788}"
DEN_WEB_PORT="${DEN_WEB_PORT:-3005}"
PNPM_STORE="${PNPM_STORE:-$REPO_DIR/.openwork-daytona/pnpm-store}"

DEN_API_PUBLIC_URL="${DEN_API_PUBLIC_URL:-http://localhost:$DEN_API_PORT}"
DEN_WEB_PUBLIC_URL="${DEN_WEB_PUBLIC_URL:-http://localhost:$DEN_WEB_PORT}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_URL#http://}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_HOST#https://}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_HOST%%/*}"

export OPENWORK_DEV_MODE="${OPENWORK_DEV_MODE:-1}"
export DEN_ORG_MODE="${DEN_ORG_MODE:-multi_org}"
# Eval sign-ups must not depend on the HIBP API.
export DEN_PASSWORD_BREACH_SCREENING_ENABLED="${DEN_PASSWORD_BREACH_SCREENING_ENABLED:-false}"
export DEN_GENERATED_ARTIFACT_VIEWS_ENABLED="${DEN_GENERATED_ARTIFACT_VIEWS_ENABLED:-false}"
export DATABASE_URL="${DATABASE_URL:-mysql://root:password@127.0.0.1:3306/openwork_den}"
export DEN_DB_ENCRYPTION_KEY="${DEN_DB_ENCRYPTION_KEY:-daytona-den-db-encryption-key-please-change-1234567890}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-daytona-den-auth-secret-please-change-1234567890}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-$DEN_WEB_PUBLIC_URL}"
export DEN_BETTER_AUTH_URL="$BETTER_AUTH_URL"
export DEN_API_PUBLIC_URL
export DEN_MCP_RESOURCE_URL="${DEN_MCP_RESOURCE_URL:-$DEN_API_PUBLIC_URL/mcp}"
# DEN_API_BASE is Den Web's server-side upstream; keep it on loopback so each
# browser request doesn't leave the sandbox and re-enter through the public
# preview proxy (~250 ms per call). Desktops still get the public origin:
# /api/runtime-config publishes DEN_API_PUBLIC_URL as denApiUrl (see
# packages/docs/start-here/private-network-deployment.mdx).
export DEN_API_BASE="${DEN_API_BASE:-http://127.0.0.1:$DEN_API_PORT}"
export DEN_AUTH_ORIGIN="${DEN_AUTH_ORIGIN:-$DEN_WEB_PUBLIC_URL}"
export DEN_AUTH_FALLBACK_BASE="${DEN_AUTH_FALLBACK_BASE:-http://127.0.0.1:$DEN_API_PORT}"
export NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL="${NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL:-$DEN_WEB_PUBLIC_URL}"
export DEN_PROVISIONER_MODE="${DEN_PROVISIONER_MODE:-${PROVISIONER_MODE:-stub}}"
export DEN_WORKER_URL_TEMPLATE="${DEN_WORKER_URL_TEMPLATE:-https://workers.local/{workerId}}"
export DEN_WEB_ALLOWED_DEV_ORIGINS="${DEN_WEB_ALLOWED_DEV_ORIGINS:-$DEN_WEB_PUBLIC_HOST}"

DEFAULT_ORIGINS="$DEN_WEB_PUBLIC_URL,$DEN_API_PUBLIC_URL,http://localhost:$DEN_WEB_PORT,http://127.0.0.1:$DEN_WEB_PORT,http://localhost:$DEN_API_PORT,http://127.0.0.1:$DEN_API_PORT"
export CORS_ORIGINS="${CORS_ORIGINS:-$DEFAULT_ORIGINS}"

# Daytona mints a fresh preview hostname on every preview-url call, so any
# origin baked at boot goes stale immediately. Trust the preview proxy domain
# by wildcard (better-auth supports wildcard trusted origins) so rotated
# preview URLs keep working. Local hosts produce no wildcard.
PREVIEW_PROXY_HOST="${DEN_WEB_PUBLIC_URL#http://}"
PREVIEW_PROXY_HOST="${PREVIEW_PROXY_HOST#https://}"
PREVIEW_PROXY_HOST="${PREVIEW_PROXY_HOST%%/*}"
PREVIEW_PROXY_WILDCARD=""
case "$PREVIEW_PROXY_HOST" in
  localhost*|127.*|0.0.0.0*|\[*) ;;
  *.*.*)
    PREVIEW_PROXY_WILDCARD="https://*.${PREVIEW_PROXY_HOST#*.}"
    ;;
esac
# Preview hosts are not app.*: tell den-api the preview domain serves den-web
# so desktop handoff links point at the den-web /api/den proxy.
export DEN_WEB_APP_HOSTS="${DEN_WEB_APP_HOSTS:-${PREVIEW_PROXY_WILDCARD:+.${PREVIEW_PROXY_HOST#*.}}}"
export DEN_BETTER_AUTH_TRUSTED_ORIGINS="${DEN_BETTER_AUTH_TRUSTED_ORIGINS:-$CORS_ORIGINS${PREVIEW_PROXY_WILDCARD:+,$PREVIEW_PROXY_WILDCARD}}"
# The Daytona preview proxy answers CORS itself, reflecting the caller's
# origin on every response. den-api's own headers would then be duplicates,
# which browsers reject, so den-web-in-a-browser could never reach den-api.
export DEN_CORS_HANDLED_BY_EDGE="${DEN_CORS_HANDLED_BY_EDGE:-${PREVIEW_PROXY_WILDCARD:+true}}"

# AI Gateway: when the caller turns it on, den-api needs both gateway origins
# at boot and the gateway service runs here, sharing Den's database and key.
# The proxy origin is this sandbox's loopback; the public origin is the
# desktop-reachable preview URL the runner derived for GATEWAY_PORT.
GATEWAY_ENABLED="${GATEWAY_ENABLED:-false}"
if [ "$GATEWAY_ENABLED" = "true" ]; then
  export GATEWAY_PORT="${GATEWAY_PORT:-8791}"
  export GATEWAY_PROXY_BASE_URL="${GATEWAY_PROXY_BASE_URL:-http://127.0.0.1:$GATEWAY_PORT}"
  export GATEWAY_PUBLIC_BASE_URL="${GATEWAY_PUBLIC_BASE_URL:-${GATEWAY_PUBLIC_URL:-$GATEWAY_PROXY_BASE_URL}}"
  export GATEWAY_WEBHOOK_SECRET="${GATEWAY_WEBHOOK_SECRET:-daytona-gateway-webhook-secret-not-for-production}"
fi

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "ERROR: root privileges are required to start MySQL." >&2
    exit 1
  fi
}

# The snapshot ships Oracle MySQL 8.4 (.devcontainer/Dockerfile.daytona-server).
# Its Debian package only has a systemd unit and Daytona has no systemd, so run
# mysqld directly when no SysV service exists (older MariaDB snapshots have one).
start_mysql_server() {
  if run_root service mysql start || run_root service mariadb start; then
    return 0
  fi
  run_root install -d -o mysql -g mysql /var/run/mysqld
  run_root mysqld --daemonize --user=mysql --pid-file=/var/run/mysqld/mysqld.pid
}

stop_mysql_server() {
  run_root service mysql stop || run_root service mariadb stop || {
    if [ -f /var/run/mysqld/mysqld.pid ]; then
      run_root kill "$(run_root cat /var/run/mysqld/mysqld.pid)"
      for _ in $(seq 1 30); do
        pgrep -x mysqld >/dev/null || return 0
        sleep 1
      done
      return 1
    fi
  }
}

# Workshop-only production cohosting. The provisioning wrapper must first
# confirm provider public:false; never use an alias to evade origin validation.
if [ "${OPENWORK_WORKSHOP_PRIVATE_COHOST:-0}" = "1" ]; then
  if [ "${OPENWORK_DAYTONA_PRIVATE_SANDBOX:-0}" != "1" ] || [ "$OPENWORK_DEV_MODE" != "0" ] || [ "$GATEWAY_ENABLED" != "true" ]; then
    echo "ERROR: workshop cohosting requires a confirmed private sandbox, production mode, and Gateway." >&2
    exit 1
  fi
  COHOST_IP="$(node - "$(hostname -I)" <<'COHOST_IP_JS'
const { networkInterfaces } = require('node:os');
const owned = new Set(Object.values(networkInterfaces()).flat().filter(Boolean)
  .filter((entry) => !entry.internal && entry.family === 'IPv4').map((entry) => entry.address));
const privateIp = process.argv[2].trim().split(/\s+/).find((ip) => {
  const parts = ip.split('.').map(Number);
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && parts.every((part) => part >= 0 && part <= 255)
    && owned.has(ip) && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168));
});
if (!privateIp) { console.error('ERROR: no actual private IPv4 interface for workshop cohosting.'); process.exit(1); }
process.stdout.write(privateIp);
COHOST_IP_JS
)"
  # Bind only the actual container interface, not all interfaces. MySQL's unix
  # socket remains available for local schema/bootstrap operations below.
  # MySQL first: the base image also ships mariadb-common's directory, which
  # Oracle MySQL never reads.
  if command -v mysqld >/dev/null 2>&1 && mysqld --version | grep -q 'MySQL Community' && [ -d /etc/mysql/mysql.conf.d ]; then
    cohost_mysql_config=/etc/mysql/mysql.conf.d/99-openwork-workshop.cnf
  elif [ -d /etc/mysql/mariadb.conf.d ]; then
    cohost_mysql_config=/etc/mysql/mariadb.conf.d/99-openwork-workshop.cnf
  elif [ -d /etc/mysql/mysql.conf.d ]; then
    cohost_mysql_config=/etc/mysql/mysql.conf.d/99-openwork-workshop.cnf
  else
    echo "ERROR: unsupported MySQL configuration layout for private cohosting." >&2
    exit 1
  fi
  printf '[mysqld]\nbind-address = %s\n' "$COHOST_IP" | run_root tee "$cohost_mysql_config" >/dev/null
  # The snapshot may already have MySQL running with its old loopback binding.
  stop_mysql_server >/dev/null 2>&1 || true
  # The private interface carries no shared or fixed credential: Den uses a
  # per-boot random password for an account limited to its own database and to
  # connections from this backend's own address. Root stays socket/loopback-only.
  WORKSHOP_DB_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
  export DATABASE_URL="mysql://openwork_den:$WORKSHOP_DB_PASSWORD@$COHOST_IP:3306/openwork_den"
  export GATEWAY_PROXY_BASE_URL="http://$COHOST_IP:$GATEWAY_PORT"

  # Private workshop mail is deliberately discarded, never delivered or exposed
  # through an HTTP outbox. Keep this inline: provisioning uploads this script.
  smtp_script="$(mktemp /tmp/workshop-smtp.XXXXXX)"
  chmod 600 "$smtp_script"
  cat > "$smtp_script" <<'WORKSHOP_SMTP_JS'
import net from 'node:net';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const banner = '220 workshop-discard ESMTP';
export function createDiscardServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const lifetime = setTimeout(() => socket.destroy(), 120_000);
    lifetime.unref();
    socket.on('close', () => { clearTimeout(lifetime); sockets.delete(socket); });
    socket.on('error', () => {});
    socket.setTimeout(30_000, () => socket.destroy());
    let pending = Buffer.alloc(0);
    let greeted = false;
    let sender = false;
    let recipients = false;
    let data = false;
    let bytes = 0;
    const reset = () => { sender = false; recipients = false; data = false; bytes = 0; };
    const reply = (text) => socket.write(`${text}\r\n`);
    reply(banner);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const raw = pending.subarray(0, end);
        pending = pending.subarray(end + 2);
        if (data) {
          if (raw.length === 1 && raw[0] === 46) {
            reset();
            reply('250 Discarded');
          } else {
            bytes += raw.length + 2;
            if (bytes > 1024 * 1024) {
              socket.end('552 Message too large\r\n', () => socket.destroy());
              return;
            }
          }
          continue;
        }
        if (raw.length > 4096) { socket.destroy(); return; }
        const line = raw.toString('utf8');
        if (/^(EHLO|HELO) \S+$/i.test(line)) {
          greeted = true;
          reset();
          reply('250-workshop-discard');
          reply('250 SIZE 1048576');
        } else if (/^QUIT$/i.test(line)) {
          socket.end('221 Bye\r\n');
          return;
        } else if (/^NOOP$/i.test(line)) {
          reply('250 OK');
        } else if (/^RSET$/i.test(line)) {
          reset();
          reply('250 OK');
        } else if (/^MAIL FROM:<[^<>\r\n]*>(?: SIZE=\d+)?$/i.test(line)) {
          reset();
          if (!greeted) { reply('503 EHLO first'); continue; }
          sender = true;
          reply('250 OK');
        } else if (/^RCPT TO:/i.test(line)) {
          if (!sender) { reply('503 MAIL first'); continue; }
          // A deliberately small addr-spec subset; no display names, routing,
          // quoted local parts, subdomains, whitespace or external recipients.
          const recipient = /^RCPT TO:<([a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*)@workshop\.test>$/i.exec(line);
          if (!recipient || recipient[1].length > 64) {
            reply('550 Only workshop.test recipients accepted');
            continue;
          }
          recipients = true;
          reply('250 OK');
        } else if (/^DATA$/i.test(line)) {
          if (!recipients) { reply('503 RCPT first'); continue; }
          data = true;
          reply('354 End with <CRLF>.<CRLF>');
        } else {
          reply('502 Command not supported');
        }
      }
      if (pending.length > (data ? 1024 * 1024 - bytes : 4096)) {
        socket.end('552 Input too large\r\n', () => socket.destroy());
      }
    });
  });
  server.maxConnections = 16;
  server.on('close', () => { for (const socket of sockets) socket.destroy(); });
  return server;
}

async function healthy() {
  return new Promise((resolve) => {
    const socket = net.connect(2525, '127.0.0.1');
    let text = '';
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000, () => done(false));
    socket.on('error', () => done(false));
    socket.on('close', () => done(false));
    socket.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\r\n')) done(text === `${banner}\r\n`);
      else if (text.length > 100) done(false);
    });
  });
}

async function start() {
  const pidFile = '/tmp/workshop-smtp.pid';
  let previous;
  try { previous = (await readFile(pidFile, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    if (!/^[1-9]\d*$/.test(previous)) throw new Error('Invalid workshop SMTP ownership');
    let command;
    try { command = await readFile(`/proc/${previous}/cmdline`, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (command) {
      const args = command.split('\0');
      if (args[1] !== '/tmp/workshop-smtp.mjs' || args[2] !== '--serve') {
        throw new Error('Workshop SMTP PID belongs to another process');
      }
      if (!await healthy()) throw new Error('Owned workshop SMTP is unhealthy');
      return;
    }
    await unlink(pidFile);
  }
  // Never terminate a port occupant. A bind collision fails closed.
  const child = spawn(process.execPath, ['/tmp/workshop-smtp.mjs', '--serve'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    // Mail discarding needs no model, database or other inherited credentials.
    env: {},
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Workshop SMTP startup timed out')); }, 5000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Workshop SMTP bind failed')); });
    child.once('message', async () => {
      clearTimeout(timer);
      try {
        await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600, flag: 'wx' });
        if (!await healthy()) throw new Error('Workshop SMTP greeting failed');
        child.disconnect();
        child.unref();
        resolve();
      } catch (error) { child.kill(); reject(error); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--serve') {
      const server = createDiscardServer();
      server.on('error', () => process.exit(1));
      server.listen(2525, '127.0.0.1', () => process.send('ready'));
    } else {
      await start();
    }
  } catch {
    console.error('ERROR: private workshop SMTP could not start safely.');
    process.exit(1);
  }
}
WORKSHOP_SMTP_JS
  mv -f "$smtp_script" /tmp/workshop-smtp.mjs
  node /tmp/workshop-smtp.mjs
  export SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_SECURE=false
  export EMAIL_FROM='Workshop <host@workshop.test>' SMTP_USER= SMTP_PASS=
fi

MYSQL_ROOT_CMD=(run_root mysql -uroot)

wait_for_http() {
  local url="$1"
  local label="$2"
  local max_wait="${3:-180}"
  local elapsed=0

  while [ "$elapsed" -lt "$max_wait" ]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "==> $label ready after ${elapsed}s"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  echo "ERROR: $label did not become ready at $url" >&2
  return 1
}

echo "==> Starting MySQL..."
start_mysql_server >/tmp/openwork-mysql-service.log 2>&1 || true

for _ in $(seq 1 60); do
  if mysql -uroot -ppassword -e "SELECT 1" >/dev/null 2>&1; then
    MYSQL_ROOT_CMD=(mysql -uroot -ppassword)
    break
  fi
  if run_root mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
    MYSQL_ROOT_CMD=(run_root mysql -uroot)
    break
  fi
  sleep 2
done

if [ "${OPENWORK_WORKSHOP_PRIVATE_COHOST:-0}" = "1" ]; then
  # MySQL listens on the private interface here, so no network root account and
  # no fixed password may exist: only the per-boot Den account, from this host.
  "${MYSQL_ROOT_CMD[@]}" <<SQL
CREATE DATABASE IF NOT EXISTS openwork_den;
ALTER USER 'root'@'localhost' IDENTIFIED BY 'password';
DROP USER IF EXISTS 'root'@'%';
DROP USER IF EXISTS 'openwork_den'@'%';
DROP USER IF EXISTS 'openwork_den'@'$COHOST_IP';
CREATE USER 'openwork_den'@'$COHOST_IP' IDENTIFIED BY '$WORKSHOP_DB_PASSWORD';
GRANT ALL PRIVILEGES ON openwork_den.* TO 'openwork_den'@'$COHOST_IP';
FLUSH PRIVILEGES;
SQL
else
  "${MYSQL_ROOT_CMD[@]}" <<'SQL'
CREATE DATABASE IF NOT EXISTS openwork_den;
ALTER USER 'root'@'localhost' IDENTIFIED BY 'password';
CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY 'password';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL
fi

echo "==> Installing dependencies if needed..."
mkdir -p "$PNPM_STORE" .openwork-daytona
baseline=.openwork-daytona/pnpm-lock.sha256
current="$(sha256sum pnpm-lock.yaml | cut -d " " -f 1)"
# The server stack never runs Electron or browser automation; skip their
# binary downloads on reinstalls too.
INSTALL_ENV=(CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 CYPRESS_INSTALL_BINARY=0)
if [ ! -d node_modules ] || [ ! -f "$baseline" ] || [ "$(cat "$baseline")" != "$current" ]; then
  env "${INSTALL_ENV[@]}" pnpm install --store-dir "$PNPM_STORE" --frozen-lockfile \
    || env "${INSTALL_ENV[@]}" pnpm install --store-dir "$PNPM_STORE"
  printf "%s" "$current" > "$baseline"
else
  echo "==> Skipping pnpm install (node_modules present and lockfile unchanged)."
fi

# Content keys for the sandbox-invariant builds baked into the snapshot.
# A build is skipped only when the git trees that feed it and the lockfile
# both match what the snapshot (or a previous boot) built. Snapshots without
# markers, refs that changed those trees, or refs where a tree is missing
# rebuild exactly as before. An empty key never matches and is never stored.
build_key() {
  local trees
  trees="$(git rev-parse "$@" 2>/dev/null)" || return 0
  # Byte-identical to the snapshot bake: one tree hash per line, then the
  # lockfile sha, all newline-terminated.
  printf '%s\n%s\n' "$trees" "$current" | sha256sum | cut -d ' ' -f 1
}

echo "==> Pushing Den DB schema..."
pnpm --filter @openwork-ee/den-db db:push > /tmp/den-db-push.log 2>&1

den_api_assets_marker=.openwork-daytona/den-api-assets.tree
den_api_assets_key="$(build_key HEAD:packages/mcp-apps)"
if [ -n "$den_api_assets_key" ] && [ -d packages/mcp-apps/dist ] && [ -f "$den_api_assets_marker" ] \
  && [ "$(cat "$den_api_assets_marker")" = "$den_api_assets_key" ]; then
  echo "==> Skipping Den API runtime asset build (baked assets match this ref)."
else
  echo "==> Building Den API runtime assets..."
  pnpm --filter @openwork-ee/den-api run build:mcp-apps
  if [ -n "$den_api_assets_key" ]; then
    printf "%s" "$den_api_assets_key" > "$den_api_assets_marker"
  else
    rm -f "$den_api_assets_marker"
  fi
fi

echo "==> Starting Den API on :$DEN_API_PORT..."
# The den-api process cmdline is "tsx watch src/main.ts" (cwd-relative), so a
# pattern anchored on the repo path never matches and restarts silently keep
# the old server alive on the port. main.ts is unique to den-api here.
pkill -f "tsx watch src/main.ts" >/dev/null 2>&1 || true
nohup env \
  PORT="$DEN_API_PORT" \
  DATABASE_URL="$DATABASE_URL" \
  DEN_DB_ENCRYPTION_KEY="$DEN_DB_ENCRYPTION_KEY" \
  BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  BETTER_AUTH_URL="$BETTER_AUTH_URL" \
  DEN_API_PUBLIC_URL="$DEN_API_PUBLIC_URL" \
  DEN_WEB_APP_HOSTS="$DEN_WEB_APP_HOSTS" \
  DEN_MCP_RESOURCE_URL="$DEN_MCP_RESOURCE_URL" \
  DEN_BETTER_AUTH_TRUSTED_ORIGINS="$DEN_BETTER_AUTH_TRUSTED_ORIGINS" \
  CORS_ORIGINS="$CORS_ORIGINS" \
  DEN_BOOTSTRAP_ADMIN_EMAILS="${DEN_BOOTSTRAP_ADMIN_EMAILS:-}" \
  PROVISIONER_MODE="$DEN_PROVISIONER_MODE" \
  WORKER_URL_TEMPLATE="$DEN_WORKER_URL_TEMPLATE" \
  DEN_ORG_MODE="$DEN_ORG_MODE" \
  DEN_PASSWORD_BREACH_SCREENING_ENABLED="$DEN_PASSWORD_BREACH_SCREENING_ENABLED" \
  DEN_GENERATED_ARTIFACT_VIEWS_ENABLED="$DEN_GENERATED_ARTIFACT_VIEWS_ENABLED" \
  OPENWORK_DEV_MODE="$OPENWORK_DEV_MODE" \
  NODE_OPTIONS="--conditions=development" \
  pnpm --filter @openwork-ee/den-api exec tsx watch src/main.ts > /tmp/den-api.log 2>&1 &

wait_for_http "http://127.0.0.1:$DEN_API_PORT/health" "Den API" 180

if [ "$GATEWAY_ENABLED" = "true" ]; then
  echo "==> Starting AI Gateway on :$GATEWAY_PORT..."
  GATEWAY_CORS_ORIGINS="$CORS_ORIGINS"
  if [ "${OPENWORK_WORKSHOP_PRIVATE_COHOST:-0}" = "1" ]; then
    # Gateway validates every browser origin as public HTTPS in production;
    # Den's ordinary local-development CORS defaults are not suitable here.
    GATEWAY_CORS_ORIGINS="$DEN_WEB_PUBLIC_URL,$DEN_API_PUBLIC_URL"
  fi
  pkill -f "tsx src/server.ts" >/dev/null 2>&1 || true
  # GATEWAY_* and DATABASE_URL are already exported above; only the process
  # port and the shared runtime flags need naming here.
  nohup env \
    PORT="$GATEWAY_PORT" \
    CORS_ORIGINS="$GATEWAY_CORS_ORIGINS" \
    DB_MODE=mysql \
    NODE_ENV=test \
    SENTRY_DSN= \
    SENTRY_LOG_LEVEL=off \
    NODE_OPTIONS="--conditions=development" \
    pnpm --filter @openwork-ee/gateway exec tsx src/server.ts > /tmp/gateway.log 2>&1 &
  wait_for_http "http://127.0.0.1:$GATEWAY_PORT/ready" "AI Gateway" 180
fi

if [ "${RUN_SEED:-0}" = "1" ]; then
  demo_email="${DEN_DEMO_OWNER_EMAIL:-alex@acme.test}"
  demo_password="${DEN_DEMO_OWNER_PASSWORD:-OpenWorkDemo123!}"
  signin_ok() {
    curl -sf -o /dev/null -X POST "http://127.0.0.1:$DEN_API_PORT/api/auth/sign-in/email" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"$demo_email\",\"password\":\"$demo_password\"}"
  }
  if signin_ok; then
    echo "==> Demo org already present ($demo_email)"
  else
    echo "==> Seeding demo org..."
    (cd ee/apps/den-api && env \
      DATABASE_URL="$DATABASE_URL" \
      DEN_DB_ENCRYPTION_KEY="$DEN_DB_ENCRYPTION_KEY" \
      BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
      BETTER_AUTH_URL="$BETTER_AUTH_URL" \
      DEN_API_PUBLIC_URL="$DEN_API_PUBLIC_URL" \
      DEN_ORG_MODE="$DEN_ORG_MODE" \
      OPENWORK_DEV_MODE=1 \
      DEN_DEMO_SEED_FETCH_GITHUB="${DEN_DEMO_SEED_FETCH_GITHUB:-0}" \
      node --conditions=development --import tsx scripts/seed-demo-org.ts) > /tmp/den-seed.log 2>&1
    if signin_ok; then
      echo "==> Demo org seeded ($demo_email)"
    else
      echo "ERROR: seed completed but $demo_email cannot sign in. See /tmp/den-seed.log" >&2
      tail -40 /tmp/den-seed.log >&2 || true
      exit 1
    fi
  fi
  echo "DEMO_OWNER_READY=$demo_email"
fi

den_web_marker=.openwork-daytona/den-web-build.tree
den_web_key="$(build_key HEAD:packages/ui HEAD:ee/packages/utils HEAD:ee/apps/den-web)"
if [ -n "$den_web_key" ] && [ -d ee/apps/den-web/.next ] && [ -f "$den_web_marker" ] \
  && [ "$(cat "$den_web_marker")" = "$den_web_key" ]; then
  echo "==> Skipping Den Web build (baked build matches this ref)."
else
  # Production build instead of next dev: dev-mode HMR websockets 502 through
  # the preview proxy and block hydration. The build bakes no per-sandbox
  # values (all DEN_* env is consumed at runtime by next start), so a build
  # from the snapshot's base commit is reusable across sandboxes.
  echo "==> Building Den Web..."
  if ! env \
    DEN_WEB_PORT="$DEN_WEB_PORT" \
    DEN_API_BASE="$DEN_API_BASE" \
    DEN_AUTH_ORIGIN="$DEN_AUTH_ORIGIN" \
    DEN_AUTH_FALLBACK_BASE="$DEN_AUTH_FALLBACK_BASE" \
    NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL="$NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL" \
    NEXT_PUBLIC_POSTHOG_KEY= \
    NEXT_PUBLIC_POSTHOG_API_KEY= \
    DEN_ORG_MODE="$DEN_ORG_MODE" \
    OPENWORK_DEV_MODE="$OPENWORK_DEV_MODE" \
    DEN_WEB_ALLOWED_DEV_ORIGINS="$DEN_WEB_ALLOWED_DEV_ORIGINS" \
    DEN_WEB_BUILD_CPUS="${DEN_WEB_BUILD_CPUS:-4}" \
    bash -c 'pnpm --filter @openwork/ui build && pnpm --filter @openwork-ee/utils build && pnpm --filter @openwork-ee/den-web build' > /tmp/den-web-build.log 2>&1; then
    echo "ERROR: Den Web build failed. Last 80 lines:" >&2
    tail -n 80 /tmp/den-web-build.log >&2
    exit 1
  fi
  if [ -n "$den_web_key" ]; then
    printf "%s" "$den_web_key" > "$den_web_marker"
  else
    rm -f "$den_web_marker"
  fi
fi

echo "==> Starting Den Web on :$DEN_WEB_PORT..."
pkill -f "next dev --hostname 0.0.0.0 --port $DEN_WEB_PORT" >/dev/null 2>&1 || true
pkill -f "next start --hostname 0.0.0.0 --port $DEN_WEB_PORT" >/dev/null 2>&1 || true
nohup env \
  DEN_WEB_PORT="$DEN_WEB_PORT" \
  DEN_API_BASE="$DEN_API_BASE" \
  DEN_AUTH_ORIGIN="$DEN_AUTH_ORIGIN" \
  DEN_AUTH_FALLBACK_BASE="$DEN_AUTH_FALLBACK_BASE" \
  NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL="$NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL" \
  NEXT_PUBLIC_POSTHOG_KEY= \
  NEXT_PUBLIC_POSTHOG_API_KEY= \
  DEN_ORG_MODE="$DEN_ORG_MODE" \
  OPENWORK_DEV_MODE="$OPENWORK_DEV_MODE" \
  DEN_WEB_ALLOWED_DEV_ORIGINS="$DEN_WEB_ALLOWED_DEV_ORIGINS" \
  pnpm --filter @openwork-ee/den-web exec next start --hostname 0.0.0.0 --port "$DEN_WEB_PORT" > /tmp/den-web.log 2>&1 &

wait_for_http "http://127.0.0.1:$DEN_WEB_PORT/api/den/health" "Den Web" 180

cat > .openwork-daytona/server-env <<EOF
DEN_API_URL=$DEN_API_PUBLIC_URL
DEN_WEB_URL=$DEN_WEB_PUBLIC_URL
BETTER_AUTH_URL=$BETTER_AUTH_URL
DEN_MCP_RESOURCE_URL=$DEN_MCP_RESOURCE_URL
DEN_PROVISIONER_MODE=$DEN_PROVISIONER_MODE
${GATEWAY_PUBLIC_BASE_URL:+GATEWAY_URL=$GATEWAY_PUBLIC_BASE_URL}
EOF

echo ""
echo "============================================"
echo "  OpenWork Daytona server stack ready"
echo ""
echo "  Den Web:       $DEN_WEB_PUBLIC_URL"
echo "  Den API:       $DEN_API_PUBLIC_URL"
[ "$GATEWAY_ENABLED" = "true" ] && echo "  AI Gateway:    $GATEWAY_PUBLIC_BASE_URL"
echo ""
echo "  Logs:"
echo "    /tmp/den-api.log"
echo "    /tmp/den-web.log"
[ "$GATEWAY_ENABLED" = "true" ] && echo "    /tmp/gateway.log"
echo "    /tmp/den-db-push.log"
echo "============================================"
