# Windows contributor setup (PowerShell)

Verified on Windows 11 + PowerShell 7, Node 24, pnpm 11. The repo's `dev`
scripts use Unix inline env (`VAR=1 cmd`), which PowerShell/cmd cannot parse
(see #5860), so this page shows the manual launch sequence until that is fixed.

## Prerequisites

| Tool | Install |
| --- | --- |
| Node 24 (pinned in `.nvmrc`) | `winget install Schniz.fnm`, then `fnm install 24`. PowerShell setup: `fnm env --use-on-cd --shell power-shell \| Out-String \| Invoke-Expression` (note: `power-shell`, not `powershell`), then `fnm use 24` |
| pnpm 11 | `corepack enable` (uses the pinned `packageManager`) |
| bun | `winget install Oven-sh.Bun`. Must be on PATH — the `apps/server` build runs `bun build`. If `bun` is not recognized, prepend its winget package dir to `$env:Path` |
| `opencode` CLI | `npm i -g opencode-ai@latest` — must be on PATH; the desktop spawns it as a sidecar |
| Build tools | VS2022 with C++ workload (needed by `better-sqlite3` via node-gyp) + Python 3 |

## First run

```powershell
git clone https://github.com/different-ai/openwork.git
cd openwork
corepack enable
pnpm install
```

## Launch (two shells, repo root)

Shell 1 — Vite UI (bypasses the Unix-only `apps/app:dev` wrapper):

```powershell
$env:OPENWORK_DEV_MODE = 1
$env:PORT = 5173
pnpm --filter @openwork/app exec vite
```

Wait for `VITE ready` at `http://localhost:5173`.

Shell 2 — Electron (detects the running Vite instance and skips spawning its own):

```powershell
$env:OPENWORK_DEV_MODE = 1
$env:OPENWORK_ELECTRON_REMOTE_DEBUG_PORT = 9823
node ./scripts/electron-dev.mjs   # from apps/desktop
```

This rebuilds workspace packages, rebuilds `better-sqlite3` for Electron, and
opens the app in the isolated dev profile. First launch takes several minutes;
later launches reuse the build.

## Verify

- Vite responds: `http://localhost:5173/@vite/client` returns the client source.
- Electron banner prints `[openwork] dev profile=... cdp=http://127.0.0.1:9823`.
- The desktop window opens; `POST /tokens 201` and `GET /workspaces 200` appear in the log.

## Troubleshooting

| Error | Cause / fix |
| --- | --- |
| `'OPENWORK_DEV_MODE' is not recognized` | Unix inline env in a pnpm script; use the `$env:` sequence above instead of `pnpm dev` |
| `'bun' is not recognized` (during `apps/server` build) | Install bun and ensure it is on PATH in the same shell |
| `Timed out waiting for Vite dev server` from `electron-dev.mjs` | Start shell 1 first; the script only spawns its own UI server on Unix |
| `fnm use` says env vars missing | Run the `fnm env` invocation above in each new shell |
