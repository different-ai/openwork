# Daytona / Dev Container Setup

Full-stack dev environment that runs the **real Electron app** + Den stack in a cloud sandbox. You see and steer the desktop app through your browser via noVNC.

## What's included

| Service | Port | Description |
|---------|------|-------------|
| **Desktop App (noVNC)** | 6080 | The real Electron app rendered in a virtual display, accessible in your browser |
| **Den Web** | 3005 | Admin dashboard for managing orgs, restrictions, providers |
| **Den API** | 8788 | Control plane API |
| **CDP Debug** | 9825 | Chrome DevTools Protocol — for app and browser automation |
| **Vite HMR** | 5173 | Hot module replacement for the React UI |
| **MySQL** | 3306 | Database (internal) |

## Quick start with Daytona Electron/noVNC

```bash
bash .devcontainer/create-daytona-openwork-snapshot.sh   # one-time / refresh when deps change
bash .devcontainer/test-on-daytona.sh [branch-or-commit]
```

The test script creates a sandbox from the reusable `openwork-eval-vnc` snapshot
when present, checks out the target ref, skips `pnpm install` if the lockfile is
unchanged, starts XFCE/noVNC, Vite, and Electron, then prints the noVNC and CDP
URLs. If the snapshot is missing, it falls back to the VNC Dockerfile path. The
snapshot intentionally does not bake `node_modules`; installs use the reusable
`openwork-eval-pnpm-store` volume so the image stays under Daytona's 20 GB limit.

For OpenAI/provider evals, create the reusable Daytona secrets volume once:

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken
```

Future Daytona test sandboxes mount `openwork-eval-secrets:/daytona-secrets`
and source `/daytona-secrets/openai.env` automatically before Electron starts.

For downloadable eval artifacts or optional video recording, use:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --record-video
```

The artifacts flow mounts `openwork-eval-artifacts:/daytona-artifacts`, starts a
static download server on port 8090, and prints a Daytona preview URL. Recording
writes mp4 files to `/daytona-artifacts/recordings` and prints the direct video
URL. Stop recording with the printed `pkill -INT -f "ffmpeg.*x11grab"` command so
ffmpeg finalizes the file cleanly.

Do not use the generic `daytona create https://github.com/different-ai/openwork`
flow for Electron/noVNC tests. The default resource size is too small and the
generic image path does not guarantee the desktop stack we need.

## Quick start with Daytona server

```bash
bash .devcontainer/create-daytona-openwork-server-snapshot.sh  # one-time / refresh when deps change
bash .devcontainer/test-server-on-daytona.sh [branch-or-commit]
```

The server helper creates a separate public Daytona sandbox for the Den stack:
MySQL, Den API, Den Web, and the worker proxy. It prints public preview URLs and
the exact Electron command to point a desktop sandbox at that server:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] \
  --den-base-url https://3005-...daytonaproxy... \
  --den-api-base-url https://8788-...daytonaproxy...
```

This keeps the architecture simple: the server sandbox owns cloud auth, orgs,
policies, workers, and persistence; the Electron sandbox stays a real desktop
client and talks to the server through public Daytona preview URLs.

## How it works

1. `.devcontainer/Dockerfile.daytona-vnc` starts from `daytonaio/sandbox:0.6.0`,
   which includes Daytona's expected desktop packages: Xvfb, XFCE, x11vnc,
   noVNC, websockify, and dbus-x11.
2. `.devcontainer/create-daytona-openwork-snapshot.sh` bakes that image into
   `openwork-eval-vnc` without `node_modules`.
3. `/opt/openwork-daytona/start-daytona-vnc.sh` starts Xvfb, XFCE, x11vnc, and
   noVNC on display `:99`.
4. `test-on-daytona.sh` installs dependencies through the reusable
   `openwork-eval-pnpm-store` volume when `node_modules` is missing or the
   lockfile changed.
5. Vite serves the React UI on port 5173.
6. `/opt/openwork-daytona/start-daytona-electron.sh` sources optional secrets,
   applies Daytona-safe Chromium flags, and starts Electron on display `:99`.
7. **CDP on port 9825** enables Chrome MCP and browser-tool automation.
8. Optional artifact capture mounts `/daytona-artifacts`, serves it on port 8090,
   and records display `:99` with ffmpeg when `--record-video` is passed.

## Testing the customization system

1. Open **Den Web** (port 3005) in a separate tab
2. Sign up → create org → Org Settings → UI Customization
3. Set overrides → Save
4. In the **Electron app** (noVNC on port 6080):
   - Cloud → developer mode → base URL `http://localhost:3005`
   - Sign in → Customization → see locked toggles

## Architecture

```
Your Browser
    │
    ├── :6080 noVNC ──▶ x11vnc ──▶ XFCE/Xvfb ──▶ Electron App
    │                              │
    │                              ├── CDP :9825 (automatable)
    │                              └── Vite HMR :5173
    │
    ├── :3005 Den Web (Next.js)
    │
    └── :8788 Den API (Hono) ──▶ MySQL :3306
```

With a separate server sandbox, the Electron box uses Daytona preview URLs for
Den Web/API instead of `localhost`, while the server sandbox still keeps its
internal service graph local.

## Automation

The Electron app exposes CDP on port 9825. You can:

- Connect Playwright: `const browser = await chromium.connectOverCDP('ws://localhost:9825')`
- Connect Chrome MCP for AI agent testing
- Take screenshots, run UI tests, etc.
