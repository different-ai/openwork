# OpenWork Desktop Bootstrap And Org Runtime Config

## Goal

Support three desktop distribution modes while still allowing all of them to update from the default app build:

1. Default build pointing at the default OpenWork server with no forced sign-in.
2. Custom build pointing at the default OpenWork server with forced sign-in.
3. Custom build pointing at a client-specific server with forced sign-in.

After install, the desktop app should preserve its initial server/sign-in behavior across app updates, then fetch org-specific runtime config from the server after the user signs in.

## Non-Goals

- No server-wide default desktop config.
- No anonymous org config fetch before sign-in.
- No attempt to make the web build own persisted bootstrap state.

## Product Decision

Use two config layers only:

1. `bootstrap config`
2. `org runtime config`

### Bootstrap config

Bootstrap config is install-level configuration. It is set by the app build, then persisted locally by the desktop app so it survives future updates.

It contains only:

- `server.baseUrl`
- `server.apiBaseUrl` if needed
- `requireSignin`

Bootstrap config decides startup behavior before normal app UI renders.

### Current `apps/app` locations

Today, the main Den bootstrap URL logic in `apps/app` lives in:

- `_repos/openwork/_worktrees/Desktop-config-den-endpoint/apps/app/src/app/lib/den.ts`

Specifically:

- `DEFAULT_DEN_BASE_URL` is sourced from `import.meta.env.VITE_DEN_BASE_URL`
- the stored Den API URL is tracked as `apiBaseUrl`
- `resolveDenBaseUrls(...)` derives or resolves both the user-facing Den base URL and the API base URL
- `readDenSettings()` and `writeDenSettings()` are the current read/write path for persisted Den URL state

This PRD assumes that the future bootstrap-config implementation will either extend this location or replace it with a more durable desktop-owned persisted config source, while keeping `apps/app` as the consumer of that state.

## Ownership model

For the update-safe version of this system, `apps/app` should not be the source of truth for bootstrap config.

Instead:

- the desktop shell owns persisted bootstrap config
- `apps/app` consumes resolved bootstrap config
- build-time env values are only used to seed first launch

This means `apps/app` should stop treating `VITE_DEN_BASE_URL` or browser-side persisted URL state as authoritative in desktop mode after bootstrap config has been created.

## How config should be passed into `apps/app`

Recommended flow:

1. The desktop shell starts first.
2. It loads persisted bootstrap config from desktop app data.
3. If no persisted bootstrap config exists yet, it seeds one from build-time defaults.
4. The desktop shell passes the resolved bootstrap config into `apps/app` before normal UI startup completes.
5. `apps/app` uses that resolved config for Den base URL, API base URL, and `requireSignin`.

Recommended interface:

- `getBootstrapConfig()`
- `setBootstrapConfig()` if editing is allowed

This can be implemented with a Tauri command, a shell-injected bootstrap object, or another desktop-owned bridge. The important part is that the desktop shell is the owner and `apps/app` is the consumer.

## Build-time environment variables

The desktop app supports build-time bootstrap seeding for custom distributions.

Preferred desktop build variables:

- `OPENWORK_DESKTOP_DEN_BASE_URL`
- `OPENWORK_DESKTOP_DEN_API_BASE_URL`
- `OPENWORK_DESKTOP_DEN_REQUIRE_SIGNIN`

Fallback variables currently recognized by the app and desktop build:

- `VITE_DEN_BASE_URL`
- `VITE_DEN_API_BASE_URL`
- `VITE_DEN_REQUIRE_SIGNIN`

These values are baked into the desktop build as the initial bootstrap seed. After launch, the desktop shell resolves the effective bootstrap config using the external bootstrap file and any persisted bootstrap state.

### Example

```bash
OPENWORK_DESKTOP_DEN_BASE_URL="https://client.example.com" \
OPENWORK_DESKTOP_DEN_API_BASE_URL="https://client.example.com/api/den" \
OPENWORK_DESKTOP_DEN_REQUIRE_SIGNIN="1" \
pnpm --filter @openwork/desktop build
```

### Accepted boolean values

`OPENWORK_DESKTOP_DEN_REQUIRE_SIGNIN` and `VITE_DEN_REQUIRE_SIGNIN` are treated as enabled when set to one of:

- `1`
- `true`
- `yes`
- `on`

## Update-safe bootstrap behavior

To preserve custom builds across updates:

1. A one-time custom build ships with seed values such as server URL and `requireSignin`.
2. On first launch, the desktop shell copies those seed values into persisted desktop app data.
3. Future app updates may install the default build artifacts.
4. On next launch, the desktop shell reads the previously persisted bootstrap config instead of reusing the default build values.
5. `apps/app` receives the persisted bootstrap config and starts with the correct URLs and sign-in behavior.

This ensures that updates do not silently reset a client build back to the default server or disable forced sign-in.

## Storage boundary

Bootstrap config should live outside the bundled web app and outside browser-only storage.

Recommended location:

- Tauri-side persisted store or app-data file

For the current external bootstrap-file approach, the desktop shell should look for `desktop-bootstrap.json` in the host config directory under `OpenWork/`, unless an explicit override path is provided with `OPENWORK_DESKTOP_BOOTSTRAP_PATH`.

Expected default locations:

- macOS: `~/Library/Application Support/OpenWork/desktop-bootstrap.json`
- Linux: `~/.config/OpenWork/desktop-bootstrap.json`
- Windows: `%AppData%\OpenWork\desktop-bootstrap.json`

Avoid using browser `localStorage` as the long-term source of truth for install identity in desktop mode.

`localStorage` may still be used as a compatibility layer or temporary cache inside `apps/app`, but the authoritative desktop bootstrap config should live in shell-owned persisted storage.

## Desktop startup contract

In desktop mode, startup should behave like this:

1. shell loads bootstrap config
2. shell returns bootstrap config to `apps/app`
3. `apps/app` initializes URL resolution from shell-provided values
4. `apps/app` applies `requireSignin` before rendering normal UI
5. signed-in flows then fetch org runtime config

In web mode, `apps/app` can continue using its existing env-based defaults because there is no desktop shell layer.

### Org runtime config

Org runtime config is authenticated, org-specific configuration fetched from the server after sign-in.

Initial examples:

- `disallowNonCloudModels`
- `blockZenModel`
- `blockMultipleWorkspaces`

Org runtime config should use sparse negative restriction keys. An empty object means the desktop app keeps its normal default behavior.

In the cloud admin UI, these restrictions may be presented as positive capability toggles for clarity. For example, the UI can show `Allow non-cloud deployed models`, while the stored config saves `disallowNonCloudModels: true` only when that capability is turned off.

This config is cached locally, applied in memory while the app runs, and refreshed from the server over time.

## Why this split exists

Builds 2 and 3 will only be built once, but later update using artifacts from build 1. That means any important startup behavior cannot live only in the bundled web app or binary defaults.

So:

- build-time config seeds the first launch
- the desktop shell persists bootstrap config locally
- later updates read that persisted bootstrap config instead of replacing it

This preserves custom server targeting and forced sign-in across updates.

## Required behavior

### Startup

On desktop app start:

1. Load persisted bootstrap config.
2. Use it to resolve the Den server / API base.
3. If `requireSignin` is true and there is no valid signed-in session, show a blocking full-screen sign-in screen before rendering normal app UI.
4. If the user is signed in, load cached org runtime config immediately.
5. Fetch fresh org runtime config from the server.
6. Apply fresh config in memory when it arrives.

### Refresh triggers for org runtime config

The app should download org runtime config:

- on every successful sign-in
- on every app start when the user is already signed in
- every 1 hour while the app is running

### Update behavior

App updates must not overwrite persisted bootstrap config.

The app should continue using the locally persisted bootstrap config after updating, even if the new binary is the default build.

## Suggested storage model

### Persisted desktop storage

Store these values in desktop app data, not just in browser `localStorage`:

- bootstrap config
- last known org runtime config
- metadata for the cached org config if needed, such as fetched time or org id

### In-memory runtime state

During app execution, maintain the current effective config in memory.

Recommended merge order:

1. bootstrap config
2. cached org runtime config
3. freshly fetched org runtime config

Bootstrap config should only contain startup-critical fields. Org runtime config should control ongoing product behavior.

## Server contract

Server config is org-specific and authenticated.

Recommended endpoint:

- `GET /v1/me/desktop-config`

Example response:

```json
{
  "blockZenModel": true,
  "blockMultipleWorkspaces": true
}
```

`requireSignin` should not be part of this runtime payload. It belongs in bootstrap config.

## Distribution modes

### 1. Default build

- `server.baseUrl`: default OpenWork server
- `requireSignin`: `false`

### 2. Custom build against default server

- `server.baseUrl`: default OpenWork server
- `requireSignin`: `true`

### 3. Custom build against client server

- `server.baseUrl`: client-specific server
- `requireSignin`: `true`

For modes 2 and 3, the build is only used to seed first launch. After that, the persisted bootstrap config is the source of truth.

## UX requirements

- Forced sign-in must block normal app UI until a valid session exists.
- Manual navigation to other routes while forced sign-in is active should redirect back to the sign-in screen.
- Once signed in, the app can load and apply org runtime config.
- If cached org runtime config exists, the app may use it immediately while refreshing in the background.

## Open implementation notes

- Prefer a Tauri-side persisted store or app-data file for bootstrap config instead of relying on web storage alone.
- The desktop shell should own persisted bootstrap state; the web UI should consume it.
- If org changes matter for config, the cache key should include org identity.
- If the org runtime config fetch fails, keep using the last known cached config when available.

## Success criteria

- A custom build can point at a custom server, update from the default release artifacts, and still keep its server target and forced sign-in behavior.
- Forced sign-in works before normal UI renders.
- Org runtime config is refreshed on sign-in, startup, and hourly.
- Model-related config can change over time without rebuilding the app.
