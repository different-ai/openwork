---
title: openwrk multi-workspace router
description: Keep a single opencode process alive and switch workspaces JIT via openwrk daemon + CLI.
---

## Set context
OpenWork currently restarts the OpenCode engine whenever a local workspace changes. That is slow, drops session streams, and makes it impossible to keep multiple local workspaces warm at once. OpenCode already supports routing requests by `directory`, and caches per-directory instances in a single server process. The missing piece is a stable local control plane that keeps one OpenCode process alive, manages multiple workspaces, and exposes a CLI for programmatic tests and automation.

---

## Define goals
- Keep a single OpenCode server running while switching workspaces.
- Support multiple local workspaces concurrently without process restarts.
- Provide a CLI that can add/list/switch workspaces and route OpenCode calls by directory.
- Provide a daemon control plane (local only) that owns process lifecycle and workspace registry.
- Provide 100 percent programmatic test coverage via CLI scripts.
- Keep the design ready for desktop integration later.

---

## Call out non-goals
- No new UI flows in this phase (desktop wiring is future work).
- No remote workspace pooling or proxying (remote stays a registry entry only).
- No multi-user auth or network exposure beyond localhost.
- No opencode protocol changes.

---

## User stories
- As a CLI user, I can add two workspaces and switch instantly without killing OpenCode.
- As a tester, I can run a script that proves workspace isolation and PID stability.
- As a desktop app, I can later call a local daemon to pick an active workspace without restarting OpenCode.

---

## Proposed architecture

### openwrk daemon
- Runs on localhost only.
- Spawns a single `opencode serve` process and keeps it alive.
- Exposes a small HTTP control plane to manage workspaces and report status.
- Stores state in a JSON file under an OpenWork data directory.
- Provides JIT instance creation by calling OpenCode endpoints with `directory`.

### Workspace registry
- Stores local and remote workspaces in a shared state file.
- Uses a stable id derived from normalized path or URL.
- Tracks last used timestamps for future idle eviction.

### Request routing
- openwrk never changes OpenCode internals.
- It passes `directory` to the OpenCode SDK client.
- OpenCode `Instance.provide` creates or reuses per-directory instances.

### JIT lifecycle
- Instances are created when the first request for a workspace is made.
- Instances can be disposed explicitly via `/instance/dispose` with `directory`.
- Future: daemon can evict idle instances based on last-used timestamps.

---

## CLI design

### Daemon
- `openwrk daemon` (foreground)
- `openwrk daemon start` (background)
- `openwrk daemon stop`
- `openwrk status` (includes opencode PID + baseUrl)

### Workspaces
- `openwrk workspace add <path> [--name]`
- `openwrk workspace add-remote <baseUrl> [--directory] [--name]`
- `openwrk workspace list [--json]`
- `openwrk workspace switch <id>`
- `openwrk workspace info <id>`
- `openwrk workspace path <id>` (calls OpenCode `/path` with directory)

### Instances
- `openwrk instance dispose <id>` (calls OpenCode `/instance/dispose` for directory)

### Programmatic output
- All commands support `--json` for machine parsing.
- Errors are structured JSON in `--json` mode.

---

## Control plane API (localhost only)

### GET /health
Returns daemon + opencode status, pid, baseUrl, workspace count, activeId.

### GET /workspaces
Returns `{ activeId, workspaces }`.

### POST /workspaces
Adds a local workspace.

### POST /workspaces/remote
Adds a remote workspace.

### POST /workspaces/:id/activate
Sets active workspace id.

### GET /workspaces/:id/path
Calls OpenCode `/path` for the workspace directory and returns path info.

### POST /instances/:id/dispose
Calls OpenCode `/instance/dispose` with the workspace directory.

---

## Data model (state file)
```json
{
  "version": 1,
  "daemon": {
    "pid": 12345,
    "port": 6174,
    "baseUrl": "http://127.0.0.1:6174",
    "startedAt": 1730000000000
  },
  "opencode": {
    "pid": 23456,
    "port": 6175,
    "baseUrl": "http://127.0.0.1:6175",
    "startedAt": 1730000000000
  },
  "activeId": "ws-abc123",
  "workspaces": [
    {
      "id": "ws-abc123",
      "name": "OpenWork",
      "path": "/Users/me/openwork",
      "workspaceType": "local",
      "lastUsedAt": 1730000000000
    },
    {
      "id": "ws-remote",
      "name": "Remote",
      "path": "",
      "workspaceType": "remote",
      "baseUrl": "https://example.com",
      "directory": "",
      "lastUsedAt": 1730000000000
    }
  ]
}
```

---

## Testing strategy (CLI only, 100 percent programmatic)
- Multi-workspace test:
  - start daemon in a temp data dir
  - add two local workspaces
  - call `workspace path` for both
  - assert directories match and opencode PID is unchanged
- JIT test:
  - add workspace without touching it
  - call `workspace path` to trigger instance creation
- Disposal test:
  - dispose a workspace and call `workspace path` again to recreate
- Failure test:
  - invalid path returns a structured error
  - opencode process kill triggers daemon restart on next request

---

## Alternative implementations
1. Per-workspace OpenCode processes
   - Pros: isolation, per-workspace config
   - Cons: heavy, many ports, slower switch
2. UI-only router without daemon
   - Pros: no new process
   - Cons: no shared CLI and no centralized lifecycle
3. Hybrid pool
   - Pros: isolate heavy workspaces
   - Cons: complexity, more scheduling logic

---

## Rollout plan
- Phase 0: openwrk daemon + CLI only, programmatic tests.
- Phase 1: OpenWork desktop can read openwrk state and attach to baseUrl + directory.
- Phase 2: Add idle eviction and remote workspace helpers.

---

## Risks and mitigations
- Long-running OpenCode process memory growth: add disposal CLI and optional TTL.
- Stale daemon state: health check and restart if pid is dead.
- Permission prompts across workspaces: keep directory-scoped instances to preserve isolation.

---

## Open questions
- Where should openwrk store its state on each platform (XDG vs OS app data)?
- Should openwrk reuse OpenWork desktop workspace registry for compatibility?
- Should we standardize a `workspaceId` format shared by desktop and CLI?
