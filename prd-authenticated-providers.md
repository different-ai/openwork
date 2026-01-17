# PRD — Authenticated Provider Discovery (Path Engine)

## Summary

In OpenWork, when the engine source is set to **Path** (i.e. OpenWork spawns the user-installed `opencode` binary), the model picker can incorrectly show only **free Zen (opencode) models** and omit providers/models the user is already authenticated to.

Users should **at minimum** see all providers the engine is authenticated to ("connected"), and ideally see the full provider catalog with clear connection status.

This PRD proposes:

1. **Parity**: Path engine should use the same credentials/config as the user’s normal `opencode` CLI.
2. **Visibility**: OpenWork should surface *why* providers are missing (missing env, missing auth store, wrong binary).
3. **Recovery**: Provide an in-app way to restore the expected provider list (import env, select auth location, or connect providers).

## Problem

### What users experience

- Toggle **Engine source → Path**.
- Connect/start the engine successfully.
- In the model picker, only free Zen models appear.
- Providers/models the user can use in the terminal (OpenAI, Anthropic, etc.) do not appear.

This breaks a core expectation: **OpenWork is a UI for OpenCode, not a different runtime**.

### Why it matters

- The UI appears “broken” or “limited to free”.
- Users can’t pick the model/provider they already pay for.
- It increases support burden (“works in terminal, not in app”).

## Root Cause (Current Behavior)

OpenWork’s model list is driven by OpenCode server APIs:

- `client.config.providers()` (OpenCode `GET /config/providers`) returns *configured/available* providers + default model mapping.
  - On the server this uses `Provider.list()`.

OpenCode determines which providers are “connected” primarily via:

- **Environment variables** (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
- **OpenCode auth store** (OpenCode `Auth.all()` → `${XDG_DATA_HOME}/opencode/auth.json` by default)
- **Config** (`opencode.json` provider options)

In Path engine mode, OpenWork spawns `opencode serve` from a **GUI process** (Tauri). Two common issues arise:

1. **GUI apps don’t inherit shell env**
   - Provider env vars set in `.zshrc`, `.bashrc`, `direnv`, etc. are not present.
   - Result: providers configured via env are “missing”.

2. **XDG path mismatch can hide `auth.json`**
   - If the user’s terminal session sets `XDG_DATA_HOME` (or related XDG vars) but the GUI app does not, OpenCode looks in a different directory for `auth.json`.
   - Result: providers configured via `opencode auth login` appear missing.

Additionally, a third issue can confuse debugging:

3. **OpenWork may be running a different `opencode` binary than the user expects**
   - If multiple installs exist (brew vs installer vs older binary), OpenWork may resolve a different executable.
   - The user may have authenticated using a different installation context.

All three present the same symptom: only free Zen models are returned because OpenCode believes it has no provider credentials.

## Goals

- In Path engine mode, OpenWork shows **all providers the engine is authenticated to**.
- OpenWork provides clear feedback when providers are missing:
  - which `opencode` binary is running
  - which auth/config directories are being used
  - whether any provider credentials were detected
- Users can fix the situation without leaving the app.

## Non-Goals

- Implementing a full provider marketplace or registry.
- Replacing OpenCode’s auth/config storage.
- Solving remote (Client mode) provider auth across machines (separate PRD).

## Proposed Solution

### 1) Switch model picker to “provider.list + connected” semantics

Today, `config.providers` is useful but opaque: it only returns providers the server believes are configured/available.

Instead, OpenWork should prefer:

- `client.provider.list()` (OpenCode `GET /provider`) which returns:
  - `all`: full provider catalog
  - `connected`: provider IDs that are authenticated
  - `default`: default model per provider

**UI behavior**

- Show “Connected” providers first.
- Show non-connected providers as disabled, with a clear “Connect” CTA.
- Preserve “Zen” as the default/fallback (free works out of the box), but don’t hide the rest.

This change ensures the user always sees the catalog and can understand “you’re not connected” vs “OpenWork is broken”.

### 2) Add a provider/auth diagnostics surface (Settings → Providers)

Add a compact diagnostics block (no secrets displayed):

- **Engine source**: Path | Sidecar
- **Resolved `opencode` binary** (from `engine_doctor.resolvedPath`)
- **Server version** (`/global/health.version`)
- **Effective workspace directory** (what OpenCode sees via `client.path.get()`)
- **Connected providers count** + list of IDs
- **Detected auth store location** (see section 3)

Include a “Refresh providers” action that re-fetches `provider.list()`.

### 3) Make Path engine use the same auth/config directories as the user’s CLI

#### 3a) Detect likely auth store locations

On start/connect, OpenWork should locate OpenCode’s auth store (without requiring the user to know XDG).

Detection strategy (ordered):

1. If `XDG_DATA_HOME` is present in the OpenWork process env, use it.
2. If absent, compute default XDG data dir for the platform.
3. Additionally, probe common legacy locations (if any exist) and present the chosen one in diagnostics.

#### 3b) Optional: import XDG env from login shell (user-consented)

If providers are unexpectedly missing, offer a safe recovery step:

- Button: **Import shell environment (recommended)**
- Explain: “GUI apps don’t inherit shell env. This will read your login shell environment variables and restart the engine. Only provider-related variables are imported.”

Implementation intent:

- Spawn the user’s login shell (e.g. `$SHELL -lc env`) and parse.
- Import only an allowlist:
  - `XDG_*` variables
  - Provider key env vars (derived from OpenCode ModelsDev provider env metadata)
- Restart engine with the merged env.

### 4) Provide an in-app provider connection path

Even with env import, the best long-term UX is first-class provider connection inside OpenWork.

Minimum viable flow:

- For providers that support API key auth:
  - Prompt for key → call `client.auth.set({ providerID, type: "api", key })`
- For providers that support OAuth:
  - Display guided steps and deep link to authorization URL using `client.provider.auth()` + OAuth endpoints.

This avoids reliance on shell env and makes Path engine work identically to Sidecar.

## User Flows

### Flow A — User already has `opencode auth` credentials

1. User selects Engine source → Path.
2. Starts engine.
3. OpenWork calls `provider.list()`.
4. Connected providers appear.

If connected providers are missing:

5. Settings → Providers shows:
   - binary path
   - auth store location
   - connected providers = 0
6. User clicks “Import shell environment” (or “Select auth store…” if we add it).
7. Engine restarts.
8. Connected providers appear.

### Flow B — User relies on env vars only (no auth store)

1. User starts Path engine.
2. Providers show as “Not connected”.
3. OpenWork offers:
   - “Import shell environment” (brings env vars into engine)
   - or “Connect” (stores key via `auth.set`)

### Flow C — Multiple `opencode` installs

1. OpenWork shows resolved binary path.
2. If it differs from the user’s expected install, user can:
   - set `OPENCODE_BIN_PATH` (already supported by engine doctor), or
   - choose a binary via a future “Pick engine binary…” UI.

## Acceptance Criteria

- With Engine source = Path:
  - If the user has provider credentials configured via `opencode auth login`, OpenWork shows those providers as connected.
  - If the user has provider credentials configured only via shell env, OpenWork can import those variables (with consent) and providers become connected.
  - If no credentials exist, OpenWork shows the provider catalog but clearly marks providers as “Not connected” (no more “only free exists” ambiguity).
- The model picker includes paid Zen models when the engine has an opencode key.
- Diagnostics page never prints secret values.

## Open Questions

- Should OpenWork ever *persist* imported env vars, or only apply them for the engine process lifetime?
- Where should OpenWork store user-entered keys?
  - In OpenCode’s `auth.json` via `auth.set` (simple, portable)
  - In OS keychain, then sync into `auth.set` on engine start (more secure)
- How should Sidecar and Path engines share auth?
  - Prefer a shared auth store for parity.
  - If isolation is required, provide an explicit “Import credentials from system OpenCode” action.
