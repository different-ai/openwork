# OpenCode v2 parallel lane

## Summary

OpenCode v2 is a contract-first rewrite on the `v2` branch of
`github.com/anomalyco/opencode`.
It is published under the npm `beta` dist-tag, for example as
`@opencode-ai/cli@0.0.0-beta-18707`, and installs the `opencode2` binary.
Its architecture combines an Effect-TS server, a typed protocol with generated
clients in `packages/protocol`, SQLite storage, and one shared daemon serving
many directories (v2 `packages/protocol/src/api.ts:151-191`,
`packages/core/src/location-services.ts:25-44`).

The key property for OpenWork is that providers become usable at runtime with
no process restart and no instance reload.
The proof is `evals/specs/opencode-v2-provider-hot-inject.test.ts` in this PR,
using pinned binary `0.0.0-beta-18707`.
An injected provider appeared in about 750ms, served a prompt, retained the
same engine PID, and required only one engine boot
(`evals/specs/opencode-v2-provider-hot-inject.test.ts`).

This PR adds a parallel prototype lane in
`apps/server/src/managed-opencode-v2.ts`, pins it through
`constants.json` `opencodeV2Version`, and adds the proof spec
`evals/specs/opencode-v2-provider-hot-inject.test.ts`.

It also ships the testing surface: an experimental Settings feature flag
("OpenCode v2 engine preview", Settings > Advanced, default off) backed by
`apps/server/src/engine-v2-preview.ts`. When enabled, openwork-server runs the
v2 engine as a parallel sidecar and hot-mirrors every provider change from the
runtime provider store into it with no reload, while the app keeps using the
v1 engine. Live status (`GET /experimental/engine-v2-preview/status`) reports
pid, mirrored and skipped providers, and the sidecar's ingested model ids.
With the flag off (the default), nothing starts and zero v1 behavior changes.

## Why now

Provider changes in the current v1 integration force an engine reload.
Every provider add follows this path:

1. `PATCH /workspace/:id/config` updates the workspace configuration.
2. The server persists a runtime SQLite row in
   `apps/server/src/runtime-opencode-config-store.ts`.
3. The server materializes an `OPENCODE_CONFIG` file
   (`apps/server/src/openwork-runtime-config.ts:186-204`).
4. The server invokes `reloadOpencodeEngine`
   (`apps/server/src/server.ts:4063-4080`).
5. The reload either disposes the engine in place
   (`apps/server/src/server.ts:4082-4154`) or performs a blue/green rollover
   (`apps/server/src/engine-pool.ts:570-632`).
6. A rollover creates a standby process
   (`apps/server/src/engine-pool.ts:1094-1106`).

Authentication has a separate but coupled ordering requirement.
Keys are delivered through `PUT /auth/{providerID}` before the configuration
rebuild (`apps/server/src/managed-provider-auth.ts:256-260`).
The server enforces that ordering
(`apps/server/src/server.ts:2577-2584`), as does cloud provider sync
(`apps/server/src/cloud-provider-sync.ts:890-899`).

Reloads must account for interrupted or queued work, defer while busy
(`apps/server/src/engine-reload-defer.ts:15-22`), coordinate rollover, and
avoid credential, configuration, and readiness races. A live-config engine
eliminates those costs for provider changes
(v2 `packages/core/src/config.ts:287-338`,
`packages/core/src/model-resolver.ts:274-303`).

## v1 integration map (what exists today)

| Area | Current v1 integration |
| --- | --- |
| Engine binary | OpenWork uses the anomalyco/opencode fork pinned in `constants.json` as `"opencodeVersion": "v1.18.18"`; desktop sidecar preparation downloads it in `apps/desktop/scripts/prepare-sidecar.mjs:35-48`. |
| Spawn | `apps/server/src/managed-opencode.ts:147-234` runs `opencode serve --hostname --port --cors '*'`, supplies `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`, waits for stdout `opencode server listening on <url>`, and sets `OPENCODE_CONFIG` to the runtime configuration file. |
| Desktop boot | `apps/desktop/electron/main.mjs:1385-1445` enters `apps/desktop/electron/runtime.mjs:1882-2028` through `startOpenworkServerInner`, then starts the in-process server at `apps/server/src/embedded.ts:190-281`, which owns the child engine. |
| Server client | The engine client factory is `apps/server/src/server.ts:1246-1280`. |
| Raw proxy | The raw engine proxy begins at `apps/server/src/server.ts:1302+` and mounts at `:986` and `:1038`. |
| Dispose | The dispose URL builder is `apps/server/src/server.ts:3930-3942`. |
| Credentials | Credential delivery occurs at `apps/server/src/managed-provider-auth.ts:256,295`. |
| Renderer | `apps/app/src/app/lib/opencode.ts:272-328` wraps `@opencode-ai/sdk/v2/client`; that `/v2/` is the v1 SDK client namespace, not the v2 engine. |
| Provider settings | API-key setup calls engine `auth.set` and then `refreshProviders({dispose:true})` at `apps/app/src/react-app/domains/connections/provider-auth/store.ts:1623-1651`; cloud import is at `apps/app/src/react-app/domains/connections/provider-auth/store.ts:1653-1754`. |

There are exactly four server-to-engine touchpoints to adapt:

1. The client factory (`apps/server/src/server.ts:1246-1280`).
2. The raw proxy (`apps/server/src/server.ts:1302+`, mounts `:986`, `:1038`).
3. The dispose URL builder (`apps/server/src/server.ts:3930-3942`).
4. Credential delivery (`apps/server/src/managed-provider-auth.ts:256,295`).

## opencode v2 architecture (what we verified)

### Boot and authentication

The server starts with:

```text
opencode2 serve --hostname <host> --port <port> [--cors ...]
```

Basic authentication is mandatory.
The username is `opencode`, and the password comes from `OPENCODE_PASSWORD`
(v2 `packages/server/src/process.ts:54-55`,
`packages/cli/src/server-process.ts:68-80`).

Readiness can be observed either from stdout line
`server listening on <url>` or from `GET /api/health`, whose response contains
`{healthy, version, pid}` (v2 `packages/server/src/process.ts:179-228`).

### Isolation knobs

The v2 child can be isolated with these environment variables
(v2 `packages/cli/src/server-process.ts:83-128`):

| Variable | Purpose |
| --- | --- |
| `OPENCODE_DB` | SQLite database path. |
| `OPENCODE_CONFIG_DIR` | Always-watched global configuration directory. |
| `OPENCODE_DISABLE_MODELS_FETCH` | Disable network model-catalog fetching. |
| `OPENCODE_MODELS_URL` | Override the model source URL. |
| `OPENCODE_MODELS_PATH` | Override the model snapshot path. |
| `OPENCODE_CONFIG` | Point to a configuration file. |
| `OPENCODE_CONFIG_CONTENT` | Supply configuration content directly. |

### One daemon, many directories

Requests are scoped by `?location[directory]=...` query parameters.
The `x-opencode-directory` header remains supported
(v2 `packages/server/src/location.ts:69-79`).

The daemon caches per-location service graphs in a `LayerMap`
(v2 `packages/core/src/location-services.ts:25-44`).

### Typed API

The protocol is a typed `HttpApi` contract assembled in
v2 `packages/protocol/src/api.ts:151-191`.
The server publishes OpenAPI at `/openapi.json`
(v2 `packages/server/src/routes.ts:152`).

The relevant session calls are:

| Operation | Endpoint and shape |
| --- | --- |
| Create session | `POST /api/session`; choose the model with `model: {providerID, id}` (v2 `packages/protocol/src/groups/session.ts:170-186`). |
| Prompt | `POST /api/session/:id/prompt` with `{text, files?, agents?, skills?}` (v2 `packages/protocol/src/groups/session.ts:338-358`, `packages/schema/src/prompt-input.ts:29-34`). |
| Switch model | `POST /api/session/:id/model` (v2 `packages/protocol/src/groups/session.ts:302`). |
| Events | SSE at `GET /api/event`, including `catalog.updated`, `credential.updated`, and `config.updated` (v2 `packages/protocol/src/groups/event.ts:34`, `packages/server/src/handlers/event.ts:12-35`). |

### Storage

V2 stores sessions, messages, credentials, and a durable event log in one
SQLite `opencode.db` rather than v1 JSON files.
Provider API keys live in the `credential` table, not `auth.json`
(v2 `packages/core/src/credential/sql.ts:5-14`).

### Service discovery

`opencode2 serve --service` writes
`$XDG_STATE_HOME/opencode/service.json` with
`{id, version, url, pid, password}` and mode `0600`
(v2 `packages/cli/src/services/service-registration.ts:13-70`).
The TUI and desktop use that file for single-daemon discovery
(v2 `packages/cli/src/services/service-registration.ts:13-70`).

The OpenWork lane instead owns an isolated child in
`apps/server/src/managed-opencode-v2.ts` and does not use service discovery.

## Providers on v2: why no reload is needed

### Catalog as a projection

The provider catalog is a rebuildable projection rather than a static registry
(v2 `packages/core/src/catalog.ts:84-140`).
Catalog transforms replay on `reload()`, and state reload uses a 500ms debounce
(v2 `packages/core/src/state.ts:42,80-188`).

### Credentials resolved per request

Every prompt resolves its provider and credential from the live SQLite table,
then injects the key into SDK settings for that request
(v2 `packages/core/src/model-resolver.ts:274-303`,
`packages/core/src/integration.ts:660-689`).
Credentials are not cached
(v2 `packages/core/src/model-resolver.ts:274-303`).

### Content-keyed AI SDK instances

AI SDK instances are cached by the JSON content of provider settings,
including `apiKey` and `baseURL`
(v2 `packages/core/src/aisdk.ts:194-206,249-292`).
A changed key or base URL lazily creates a fresh SDK instance, and there is no
dispose step (v2 `packages/core/src/aisdk.ts:194-206,249-292`).

### Watched configuration and plugin rebuilds

Configuration files are watched
(v2 `packages/core/src/config.ts:287-338`).
A `config.updated` event causes `ConfigProviderPlugin` and `PluginSupervisor`
to rebuild integration and catalog state in roughly 100-600ms
(v2 `packages/core/src/config/plugin/provider.ts:15-19`,
`packages/core/src/plugin/supervisor.ts:133-154`).

Model reads wait up to five seconds for the generation to settle
(v2 `packages/server/src/handlers/plugin-readiness.ts:5-13`).

A configuration provider with `activation = "enabled"` is available with zero
credential rows when its settings include an inline `apiKey`
(v2 `packages/core/src/catalog.ts:67-69`,
`packages/core/src/model-resolver.ts:274-303`).
This is the `Auth.none` path used by the proof lane
(v2 `packages/core/src/model-resolver.ts:274-303`).

### Provider package loading

Built-in SDK packages such as
`@opencode-ai/ai/providers/openai-compatible` are compiled into the binary
(v2 `packages/core/src/provider.ts:36-74`).
Unknown `aisdk:<pkg>` specifiers are npm-installed on demand
(v2 `packages/core/src/provider.ts:76-103`).

### Runtime injection mechanisms

V2 offers three runtime injection mechanisms:

1. `POST /api/integration/:id/connect/key` adds a credential row for a stock,
   cataloged provider; live credential resolution picks it up on the next
   request (v2 `packages/core/src/credential/sql.ts:5-14`,
   `packages/core/src/model-resolver.ts:274-303`).
2. OpenWork can atomically write managed provider configuration into the
   always-watched `OPENCODE_CONFIG_DIR`; this lets OpenWork own both key
   material and configuration materialization, and is the mechanism used by
   `evals/specs/opencode-v2-provider-hot-inject.test.ts`
   (v2 `packages/cli/src/server-process.ts:83-128`,
   `packages/core/src/config.ts:287-338`).
3. `POST /api/experimental/integration/wellknown` accepts remote manifests
   (v2 `packages/protocol/src/groups/integration.ts:40-53`,
   `packages/core/src/wellknown.ts:147-160`).

Only boot-fixed `ServerOptions` require a restart: hostname, port, password,
CORS, database path, and models URL
(v2 `packages/server/src/options.ts:6-46`).
Provider configuration and credentials are not in that set
(v2 `packages/server/src/options.ts:6-46`,
`packages/core/src/config.ts:287-338`).

## Proof (this PR)

Any named e2e spec can exercise the v2 chat lane with
`OPENWORK_EVAL_ENGINE=v2 pnpm evals:e2e <slug> [--daytona]`; the harness starts
the app with chat routed through the OpenCode v2 sidecar, while an unset value
or `v1` preserves the existing lane. The resulting evidence header records the
engine used by the run.

`apps/server/src/managed-opencode-v2.ts` spawns and manages
`opencode2 serve` with an isolated database and configuration directory.
It uses health-based readiness and implements `injectProvider()` as an atomic
configuration write.
There is no reload or dispose call in
`apps/server/src/managed-opencode-v2.ts`.

`evals/specs/opencode-v2-provider-hot-inject.test.ts` covers five claims:

| Claim | Observable proof |
| --- | --- |
| C1 | The injected provider is absent from the baseline catalog (`evals/specs/opencode-v2-provider-hot-inject.test.ts`). |
| C2 | Hot injection becomes listed within 15 seconds (`evals/specs/opencode-v2-provider-hot-inject.test.ts`). |
| C3 | A prompt round-trips through the witness with the injected key, with key isolation between two providers (`evals/specs/opencode-v2-provider-hot-inject.test.ts`). |
| C4 | The engine PID stays the same, the child never exits, and stdout contains exactly one boot line (`evals/specs/opencode-v2-provider-hot-inject.test.ts`). |
| C5 | A second provider can be injected warm while the first remains available (`evals/specs/opencode-v2-provider-hot-inject.test.ts`). |

The equivalent manual smoke produced the same result:

- The model appeared about 750ms after the configuration write.
- The witness observed `Bearer witness-key-123`.
- The engine PID did not change.
- Stdout contained one `server listening on` line.

The feature flag has its own proof,
`evals/specs/engine-v2-preview-flag.e2e.test.ts` (app-driving):

| Claim | Observable proof |
| --- | --- |
| F1 | A fresh desktop reports the flag disabled with no sidecar pid, and the Settings switch renders unchecked. |
| F2 | Enabling from Settings > Advanced boots the sidecar (status turns running with a pid) while the v1 server keeps serving. |
| F3 | A provider added through the product config path is mirrored into the running sidecar: its model id appears in the sidecar catalog, a baseURL-less record lands in skipped (never mirrored), and the sidecar pid is unchanged. |
| F4 | Disabling from Settings stops the sidecar and it stays stopped. |

The pure v1-to-v2 provider mapping is unit-covered in
`apps/server/src/engine-v2-preview.test.ts`.
The end-to-end completion round trip is deliberately proven in the app-less
spec, not the e2e spec, so the e2e run needs no witness endpoint.

## How a full OpenWork-on-v2 lane would work (design)

### 1. Spawn and handshake

Keep `apps/server/src/managed-opencode-v2.ts` as a sibling of the current
manager at `apps/server/src/managed-opencode.ts:147-248`.
Select the manager per workspace with an engine-lane flag.
Provide an `OPENWORK_OPENCODE_BIN`-style override named
`OPENWORK_OPENCODE2_BIN` for the v2 binary.

The adapter starts the v2 command and uses Basic auth plus health readiness
(v2 `packages/cli/src/server-process.ts:68-80`,
`packages/server/src/process.ts:179-228`).

### 2. Engine pool

V2 makes most provider-change behavior in `engine-pool.ts` unnecessary because
configuration updates do not need rollovers
(v2 `packages/core/src/config.ts:287-338`).
Retain the pool only for engine-version upgrades.

If we preserve the pool abstraction, `EngineSpawnTemplate` and
`EnginePoolHooks` are already injectable at
`apps/server/src/engine-pool.ts:39-70`.

### 3. Server-to-engine dialect

Place a v2 adapter behind the four existing touchpoints:

| V1 seam | V2 replacement |
| --- | --- |
| Client factory (`apps/server/src/server.ts:1246-1280`) | Construct a generated v2 client or a narrow adapter around the typed v2 API (`packages/protocol/src/api.ts:151-191`). |
| Raw proxy (`apps/server/src/server.ts:1302+`, mounts `:986`, `:1038`) | Keep `/workspace/:id/opencode/*`, translate to Basic auth, and inject `location[directory]` (`packages/server/src/location.ts:69-79`). |
| Dispose URL (`apps/server/src/server.ts:3930-3942`) | Make workspace dispose a no-op or call `DELETE /api/debug/location` in the v2 dialect (v2 `packages/server/src/handlers/debug.ts:16-25`). |
| Credential delivery (`apps/server/src/managed-provider-auth.ts:256,295`) | Call `POST /api/integration/:id/connect/key` for stock providers or perform a managed configuration write (`packages/core/src/credential/sql.ts:5-14`, `packages/core/src/config.ts:287-338`). |

### 4. Configuration materialization

Keep `apps/server/src/runtime-opencode-config-store.ts` as the OpenWork source
of truth.
Render a v2 dialect using the `providers` key and v2 schema into
`OPENCODE_CONFIG_DIR/opencode.json`, following the existing
`buildOpenworkRuntimeConfigObjectFromSnapshot` materialization style at
`apps/server/src/openwork-runtime-config.ts:102-143`.

After that write, do not call reload.
The v2 watcher rebuilds the integration and catalog
(v2 `packages/core/src/config.ts:287-338`,
`packages/core/src/config/plugin/provider.ts:15-19`).

The v1 auth-before-reload invariant at
`apps/server/src/server.ts:2577-2584` dissolves in this lane.
The replacement invariant is that the managed configuration write must be
atomic using a temporary file and rename, matching
`apps/server/src/managed-opencode-v2.ts`.

### 5. Renderer

Point `createClient` at `apps/app/src/app/lib/opencode.ts:272` to a v2 client
adapter or to the openwork-server proxy when the workspace selects v2.
Keep the v1 SDK types in place for the v1 lane
(`apps/app/src/app/lib/opencode.ts:272-328`).

### 6. Events

Bridge v2 SSE events `catalog.updated` and `credential.updated` into the
existing reload-event plumbing so the model picker refreshes without polling
(v2 `packages/protocol/src/groups/event.ts:34`,
`packages/schema/src/catalog.ts:5`).

### 7. Migration

V2 includes a v1 importer at `GET /api/experimental/migration/v1` in
v2 `packages/core/src/database/v1-migration.bun.ts`.
That is the proposed continuity path for sessions and credentials.

### Rollout stages

1. This PR: land the pinned parallel lane, the proof specs, and the
   experimental Settings flag that runs the v2 sidecar with live provider
   mirroring (`apps/server/src/managed-opencode-v2.ts`,
   `apps/server/src/engine-v2-preview.ts`, `constants.json`,
   `evals/specs/opencode-v2-provider-hot-inject.test.ts`,
   `evals/specs/engine-v2-preview-flag.e2e.test.ts`).
2. Dogfood the flag; extend mirroring coverage (headers, model limits,
   disabled providers) and bridge sidecar SSE events into diagnostics.
3. Add a v2 dialect adapter behind the four server-to-engine touchpoints so a
   workspace can select the v2 lane end to end
   (`apps/server/src/server.ts:1246-1280`, `:1302+`, `:3930-3942`,
   `apps/server/src/managed-provider-auth.ts:256,295`).
4. On the v2 lane, remove the provider settings call to
   `refreshProviders({dispose:true})` at
   `apps/app/src/react-app/domains/connections/provider-auth/store.ts:1623-1651`.
5. Flip the default only after the parity checklist is complete.

### Parity gaps / risks

- V2 uses `0.0.0-beta-N` releases and has no stable semver contract yet.
- V2 Basic auth and password lifecycle differ from v1 per-boot environment
  credentials (v2 `packages/server/src/process.ts:54-55`,
  `packages/cli/src/server-process.ts:68-80`;
  v1 `apps/server/src/managed-opencode.ts:147-234`).
- The v2 single-daemon model differs from OpenWork's current per-workspace
  engine assumption. Location scoping covers directory isolation
  (v2 `packages/server/src/location.ts:69-79`), but `EngineInfo` IPC shapes must
  be versioned (`packages/types/src/desktop-ipc.ts:36-52,88-114`).
- `/api/experimental/*` surfaces may move, including the v1 importer at
  v2 `packages/core/src/database/v1-migration.bun.ts`.
- Plugin and tool ecosystems differ between the v1 and v2 engines.
- V2 requires network access for models.dev unless
  `OPENCODE_DISABLE_MODELS_FETCH=1` is paired with a bundled snapshot
  (v2 `packages/cli/src/server-process.ts:83-128`).

The parity checklist should therefore cover provider discovery, provider auth,
session creation, prompting, events, tools, plugins, persistence, migration,
proxy compatibility, desktop IPC, shutdown, and upgrades at the four existing
server seams (`apps/server/src/server.ts:1246-1280`,
`apps/server/src/server.ts:1302+`, `apps/server/src/server.ts:3930-3942`,
`apps/server/src/managed-provider-auth.ts:256,295`).

## Alternatives considered

### Embed `@opencode-ai/sdk` v2 in-process

Rejected for this lane.
The v2 implementation has Bun-flavored runtime dependencies, while OpenWork's
embedded server runs in Electron's Node environment.
The subprocess approach matches the existing managed-engine boundary at
`apps/server/src/managed-opencode.ts:147-234` and preserves process isolation.

### Wait for v2 GA

Rejected.
The parallel lane changes zero v1 behavior and allows provider UX work to begin
against the hot-injection architecture now.
Beta churn remains contained by the explicit `opencodeV2Version` pin in
`constants.json` and the isolated manager in
`apps/server/src/managed-opencode-v2.ts`.
