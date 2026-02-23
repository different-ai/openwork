# PRD: OpenWork Orchestrator (Host-First + Fallback Remote)

## Summary
Reframe OpenWork as the lifecycle supervisor for OpenCode. Clients connect to an OpenWork host, which returns the OpenCode connection details for the active workspace. If the host URL is not an OpenWork server, fall back to the existing direct-OpenCode flow so remote workspaces still work.

**Simplest design decision:** the OpenWork host exposes **only the active workspace**. No multi-workspace share list. When the host switches workspaces, clients follow it.

## Goals
- Host mode: OpenWork starts and supervises OpenCode and exposes a pairing endpoint for clients.
- Client mode: connect to OpenWork host URL + token; host provides OpenCode base URL + directory.
- Fallback: if a user enters a URL that is not an OpenWork host, connect directly to OpenCode as today.
- UI: the connection flow and workspace surfaces reflect OpenWork host vs direct OpenCode.

## Non-goals
- Multiple shared workspaces or “pinned” workspace lists.
- Peer discovery or QR pairing (future).
- New auth systems beyond bearer token.
- New OpenCode APIs.

## User flows
### Host mode
1) User picks a local workspace.
2) OpenWork starts OpenCode (`opencode serve`).
3) OpenWork starts OpenWork server and registers the active workspace.
4) Settings shows pairing URL + client token.

### Client mode (OpenWork host)
1) User enters **OpenWork Host URL** + token.
2) OpenWork client calls host `/health` and `/workspaces`.
3) Host returns active workspace + OpenCode base URL + directory.
4) Client connects to OpenCode using existing SDK flow.
5) Skills/plugins/config actions route to OpenWork host (preferred). If unavailable, fall back to OpenCode or show read-only.

### Client mode (fallback to OpenCode)
1) User enters a URL that is not an OpenWork host.
2) Client attempts OpenWork `/health` and fails with non-OpenWork response.
3) Client treats the URL as OpenCode base URL (existing flow).

## API contract (OpenWork host)
**Base URL:** `http(s)://<host>:<port>`
**Auth:** `Authorization: Bearer <token>`

### `GET /health`
Returns `{ healthy: true, version: string }`.
If missing or 404, treat as non-OpenWork host and fallback to OpenCode.

### `GET /workspaces`
Returns only the active workspace:
```
{
  active: {
    id: "ws-123",
    name: "My Workspace",
    opencode: {
      baseUrl: "http://127.0.0.1:4096",
      directory: "/path/to/workspace"
    }
  }
}
```

### `GET /workspaces/active`
Alias for the active workspace payload (optional).

### `GET /capabilities`
Returns `{ skills: { read, write }, plugins: { read, write }, mcp: { read, write } }`.

## Data model changes
**WorkspaceInfo** (Tauri + UI) must differentiate remote OpenWork vs direct OpenCode:
- `remoteType: "openwork" | "opencode"`
- `openworkHostUrl?: string`
- `openworkWorkspaceId?: string`
- `opencodeBaseUrl?: string` (existing `baseUrl` becomes this)
- `opencodeDirectory?: string` (existing `directory` becomes this)

**Workspace ID**
- For OpenWork remote: stable ID should include `openworkHostUrl + openworkWorkspaceId`.
- For OpenCode remote: keep current `stable_workspace_id_for_remote(baseUrl, directory)`.

## UI rewires (specific components)
### Onboarding client step
File: `packages/app/src/app/pages/onboarding.tsx`
- Replace “Remote base URL” with **OpenWork Host URL**.
- Add **Access token** input.
- Add “Advanced: Connect directly to OpenCode” toggle that reveals the current baseUrl + directory inputs.
- Submit button calls `onConnectClient()` which attempts OpenWork first, then fallback.

### Create Remote Workspace modal
File: `packages/app/src/app/components/create-remote-workspace-modal.tsx`
- Primary fields: **OpenWork Host URL** + **Access token**.
- Advanced toggle: **Direct OpenCode base URL** + directory.
- Store `remoteType` in workspace state based on which input path is used.

### Workspace picker + switch overlay
Files:
- `packages/app/src/app/components/workspace-picker.tsx`
- `packages/app/src/app/components/workspace-switch-overlay.tsx`
Changes:
- Show badge: **OpenWork** vs **OpenCode** for remote workspaces.
- Primary line: OpenWork host URL (if OpenWork remote) else OpenCode baseUrl.
- Secondary line: workspace name from host (OpenWork) or directory (OpenCode).

### Settings connection card
File: `packages/app/src/app/pages/settings.tsx`
- Show **OpenWork host status** when in client mode: URL, connection state, token status.
- Host mode: show **pairing URL + client token** from OpenWork server.
- Keep OpenCode engine status visible for host mode only.

## State + logic rewires (exact mapping)
### Workspace connection flow
File: `packages/app/src/app/context/workspace.ts`
- Split current `connectToServer()` into:
  - `connectToOpenworkHost(hostUrl, token)`
  - `connectToOpencode(baseUrl, directory)` (existing logic)
- Update `createRemoteWorkspaceFlow()` to:
  1) Try OpenWork host handshake.
  2) If handshake fails (non-OpenWork), fallback to OpenCode base URL path.
- Update `activateWorkspace()` to branch based on `remoteType`.

### Client + header status
File: `packages/app/src/app/app.tsx`
- Track OpenWork host connection state alongside OpenCode client state.
- Header status should prefer OpenWork host state in client mode (e.g., “Connected · OpenWork”).

### Extensions (skills/plugins/mcp)
File: `packages/app/src/app/context/extensions.ts`
- If remoteType is `openwork` and host capabilities allow, use OpenWork server endpoints for:
  - skills list/install/remove
  - plugin list/add/remove (project scope only)
- If remoteType is `opencode`, keep current OpenCode-only behavior (read-only or host-only).

## Host lifecycle changes
**OpenWork host** must manage OpenWork server alongside OpenCode:
- Start OpenWork server after OpenCode engine starts.
- Update OpenWork server when active workspace changes.
- Expose pairing URL + token to UI.

Files (desktop):
- `packages/desktop/src-tauri/src/commands/engine.rs`
- `packages/desktop/src-tauri/src/lib.rs`
- `packages/desktop/src-tauri/src/types.rs`
- `packages/desktop/src-tauri/src/commands/workspace.rs`

## Fallback behavior (explicit)
- If `GET /health` fails (404, network error, non-JSON), treat the input as a direct OpenCode base URL.
- The UI should show a small inline hint: “Connected via OpenCode (not OpenWork).”

## Migration
- Existing remote workspaces stored as OpenCode remotes remain valid.
- New OpenWork remotes store `remoteType = openwork` with host URL + workspace ID.
- No changes to local workspaces.

## Risks
- Confusing connection state (OpenWork vs OpenCode). Mitigate with badges + status text.
- Host switching workspace unexpectedly disconnects client. Mitigate with a short toast + auto-reconnect.
- Non-OpenWork URLs falsely detected. Mitigate with clear fallback flow.

## Open questions
- Do we need a QR pairing artifact now, or later?
- Should host expose a “Read-only mode” toggle for shared clients?
- Should OpenWork server enforce token rotation or persistence?

## Acceptance criteria
- Client can connect to OpenWork host and OpenWork supplies OpenCode base URL + directory.
- Entering a non-OpenWork URL still connects via OpenCode with no regression.
- UI clearly distinguishes OpenWork vs OpenCode remote connections.
