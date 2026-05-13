#!/usr/bin/env bash
set -euo pipefail

# Start all services in the background for the Daytona/devcontainer workspace.
# Called by devcontainer.json postStartCommand.

cd /workspace

echo "==> Pushing DB schema..."
pnpm --filter @openwork-ee/den-db db:push 2>&1 || echo "DB push failed (may already be up to date)"

echo "==> Starting Den API on :8788..."
pnpm dev:den:api &
DEN_API_PID=$!

echo "==> Waiting for Den API to be healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8788/health >/dev/null 2>&1; then
    echo "Den API is healthy."
    break
  fi
  sleep 2
done

echo "==> Starting Den Web on :3005..."
pnpm dev:den:web &
DEN_WEB_PID=$!

echo "==> Starting App (Vite) on :5173..."
pnpm --filter @openwork/app dev:web &
APP_PID=$!

echo ""
echo "============================================"
echo "  All services started!"
echo ""
echo "  App (React UI):  http://localhost:5173"
echo "  Den Web:         http://localhost:3005"
echo "  Den API:         http://localhost:8788"
echo ""
echo "  To test customization:"
echo "    1. Open Den Web → Sign up → Create org"
echo "    2. Go to Org Settings → UI Customization"
echo "    3. Set overrides → Save"
echo "    4. Open the App → Cloud → Sign in with localhost:3005"
echo "    5. Go to Customization → see locked toggles"
echo "============================================"
echo ""

# Keep the script alive so devcontainer doesn't think it exited
wait
