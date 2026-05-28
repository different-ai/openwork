# Skill: Daytona Dev Environment

Launch the OpenWork Electron app in a Daytona cloud sandbox. The real desktop
app runs on Daytona's XFCE/noVNC desktop stack and is accessible through your
browser.

## Prerequisites

- Daytona CLI installed: `brew install daytonaio/cli/daytona` or download from [GitHub releases](https://github.com/daytonaio/daytona/releases)
- Logged in: `daytona login`
- Using the "Different AI" org: `daytona organization use "Different AI"`

## Quick Start

### 1. Create and start the sandbox

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit]
```

The helper uses the VNC snapshot when available, falls back to the VNC Dockerfile
when needed, starts noVNC/Vite/Electron, and prints the URLs.

Or SSH in after the helper prints the sandbox name:

```bash
daytona ssh <sandbox>
cd /workspace
```

### 2. Get the noVNC URL

```bash
daytona preview-url openwork-dev -p 6080
```

Open that URL in your browser. You'll see the real Electron OpenWork app.

### 4. Get other URLs

```bash
# Den Web dashboard (if Den stack is running)
daytona preview-url openwork-dev -p 3005

# CDP debugging endpoint
daytona preview-url openwork-dev -p 9825
```

## What's Running

| Service | Port | Description |
|---------|------|-------------|
| **noVNC** | 6080 | See and interact with the Electron app in your browser |
| **Vite HMR** | 5173 | Hot module replacement for the React UI |
| **CDP** | 9825 | Chrome DevTools Protocol — for automation |
| **Den Web** | 3005 | Admin dashboard (only if MySQL is available) |
| **Den API** | 8788 | Control plane (only if MySQL is available) |

## Running with Den (full stack)

The devcontainer's `docker-compose.yml` includes MySQL. If you're using Daytona's raw sandbox mode (no Docker Compose), the Den stack won't start because there's no MySQL. Two options:

### Option A: Daytona sandbox + production Den

Just point the app to the production Den:
1. Open the app via noVNC
2. Sign in normally (uses production `app.openworklabs.com`)
3. All cloud features work

### Option B: Daytona sandbox + local Den

If you need a local Den (for testing customization, restrictions, etc.):
1. Use the `docker-compose.yml` approach (requires Docker-in-Docker)
2. Or run Den on your local machine and tunnel to the sandbox

## Common Commands

```bash
# List running sandboxes
daytona list

# SSH into sandbox
daytona ssh openwork-dev

# Check logs
daytona exec openwork-dev 'tail -50 /tmp/electron.log'
daytona exec openwork-dev 'tail -50 /tmp/vite.log'
daytona exec openwork-dev 'tail -50 /tmp/start-vnc.log'

# Take a screenshot via CDP
daytona exec openwork-dev 'curl -s http://127.0.0.1:9825/json/list'

# Restart just the Electron app
daytona exec openwork-dev 'bash -lc "pkill -f electron || true; pkill -f electron-dev || true"'
daytona exec openwork-dev 'bash -lc "cd /workspace && bash /opt/openwork-daytona/start-daytona-electron.sh --detach"'

# Stop the sandbox (preserves state)
daytona stop openwork-dev

# Start it again
daytona start openwork-dev

# Delete (destroys everything)
daytona delete openwork-dev
```

## Updating the Code

Inside the sandbox, the repo is at `/workspace`. To pull latest:

```bash
daytona ssh openwork-dev
cd /workspace
git pull origin dev
pnpm install
# Then restart Vite/Electron
```

## Troubleshooting

**Electron shows blank window:**
Vite might not be running. Check `tail /tmp/vite.log`. Restart with:
```bash
cd /workspace/apps/app && OPENWORK_DEV_MODE=1 nohup npx vite --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 &
```

**noVNC shows black screen:**
Xvfb/XFCE may have crashed. Restart the desktop stack:
```bash
bash /opt/openwork-daytona/start-daytona-vnc.sh
```

**"no space left on device" when creating sandbox:**
Use `--disk 10`. The default Daytona disk can be 3 GB, which is not enough for
OpenWork dependencies and sidecar prep. Also don't use `--context .` — it
uploads the entire repo (with worktrees, node_modules). Use individual
`--context` flags for just the files needed.

**Electron can't connect to localhost:5173:**
Vite must listen on `0.0.0.0`, not just `localhost`. The start script handles this, but if running manually use `npx vite --host 0.0.0.0`.
