#!/usr/bin/env bash
set -euo pipefail

# Start all services for the Daytona/devcontainer workspace.
# Launches the real Electron app with a virtual display.

cd /workspace

# 1. Start virtual display + noVNC
echo "==> Starting virtual display..."
/usr/local/bin/start-display.sh
sleep 2

# 2. Push DB schema
echo "==> Pushing DB schema..."
pnpm --filter @openwork-ee/den-db db:push 2>&1 || echo "DB push failed (may already be up to date)"

# 3. Start Den API
echo "==> Starting Den API on :8788..."
pnpm dev:den:api &
DEN_API_PID=$!

echo "==> Waiting for Den API health..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8788/health >/dev/null 2>&1; then
    echo "Den API healthy."
    break
  fi
  sleep 2
done

# 4. Start Den Web
echo "==> Starting Den Web on :3005..."
pnpm dev:den:web &
DEN_WEB_PID=$!

# 5. Start the Electron app (uses Xvfb display)
echo "==> Starting OpenWork desktop app..."
OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9825 pnpm dev &
APP_PID=$!

echo ""
echo "============================================"
echo "  All services running!"
echo ""
echo "  Desktop App (noVNC):  http://localhost:6080"
echo "  Den Web Dashboard:    http://localhost:3005"
echo "  Den API:              http://localhost:8788"
echo "  CDP Debug:            ws://localhost:9825"
echo ""
echo "  Open noVNC in your browser to see and"
echo "  interact with the real Electron app."
echo "============================================"
echo ""

wait
