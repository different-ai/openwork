# Unsanitized Inputs Audit

Scope: repository audit of external and untrusted input boundaries for missing or inadequate Zod validation. Reviewed API routes, request bodies, path/query parameters, headers, environment variables, IPC messages, form submissions, webhook payloads, database/config JSON, CLI arguments, local config files, and third-party API responses. Findings below distinguish confirmed gaps from code paths that already have Zod or equivalent runtime validation.

## Summary

| Priority | Risk | Finding | Boundary | Location |
|---:|---|---|---|---|
| 1 | High | Remote sidecar manifest can choose download URL/name without schema validation | Remote manifest JSON -> executable download/cache | `apps/orchestrator/src/cli.ts:1919` |
| 2 | High | Generic workspace config patch bypasses narrower validators | Client HTTP JSON -> runtime OpenCode/OpenWork config | `apps/server/src/server.ts:2126` |
| 3 | High | Desktop IPC command channel lacks command-level runtime schemas | Renderer IPC -> Electron main/filesystem/runtime | `apps/desktop/electron/main.mjs:1544` |
| 4 | High | Workspace OpenWork config can be written/read as arbitrary JSON | Renderer IPC + workspace file -> persistent config | `apps/desktop/electron/main.mjs:1576`, `apps/desktop/electron/workspace-store.mjs:848` |
| 5 | High | UI-control HTTP bridge does not validate affordance request envelopes | Local MCP/client HTTP -> renderer control actions | `apps/desktop/electron/ui-control-server.mjs:145` |
| 6 | High | Handsfree CUA runner trusts model/tool response shapes | OpenAI Responses API/MCP tools -> local computer-use tools | `packages/handsfree/src/cua-runner.mjs:39` |
| 7 | Medium | Remote workspace creation accepts ad-hoc URLs/tokens with weak validation | Host HTTP body -> remote discovery fetch + persisted workspace | `apps/server/src/routes/workspaces.ts:326` |
| 8 | Medium | Billing return URLs trust forwarded headers | HTTP headers -> Stripe checkout/portal redirects | `ee/apps/den-api/src/routes/org/billing.ts:21` |
| 9 | Medium | OpenWork UI MCP trusts discovery file and bridge responses | Local config/HTTP responses -> MCP tools | `packages/openwork-ui-mcp/index.mjs:65` |
| 10 | Medium | Voice realtime body can select arbitrary model | Inference API JSON -> OpenAI Realtime session creation | `ee/apps/inference/src/voice.ts:123` |
| 11 | Medium | GitHub webhook payload is signed but not schema-validated | Webhook raw JSON -> queued sync payload | `ee/apps/den-api/src/routes/webhooks/github.ts:74` |
| 12 | Medium | Installer trusts deployment app version with only string checks | Deployment API JSON -> GitHub release URL/executable choice | `apps/installer/src/install.ts:149` |
| 13 | Medium | Env numeric values are Zod strings then `Number(...)` without range/NaN checks | Environment -> ports/timeouts/resources | `ee/apps/den-api/src/env.ts:370` |
| 14 | Low | Browser panel IPC accepts unvalidated bounds/point objects | Renderer IPC -> Electron BrowserView bounds/menu | `apps/desktop/electron/browser-panel.mjs:747` |
| 15 | Low | Central JSON body helper casts arbitrary JSON to object | HTTP body -> many server routes | `apps/server/src/server.ts:2899` |
| 16 | Low | Route parameter decoding can throw before handler validation | Raw URL path -> route params | `apps/server/src/routes/registry.ts:36` |
| 17 | Low | Ollama tags/pull responses are partially guarded, not schema-validated | Local third-party API -> settings UI/config | `apps/app/src/react-app/domains/settings/ollama-config.tsx:94` |
| 18 | Low | Bootstrap CLI trusts Den/cloud API response envelopes | CLI HTTP responses/config files -> local bootstrap state | `packages/openwork-bootstrap/bin/openwork.mjs:527` |
| 19 | Low | Worker proxy env numerics are Zod strings then `Number(...)` | Environment -> proxy ports/expiry | `ee/apps/den-worker-proxy/src/env.ts:60` |

No critical findings were confirmed in this pass. The highest-risk issues are validation gaps where untrusted input can influence executable downloads, persistent runtime configuration, privileged Electron main-process behavior, or local computer-use actions.

## Confirmed Findings

### 1. Remote sidecar manifest can choose download URL/name without schema validation

- **File path and line number:** `apps/orchestrator/src/cli.ts:1919`; sinks at `apps/orchestrator/src/cli.ts:1981`, `apps/orchestrator/src/cli.ts:1989`, `apps/orchestrator/src/cli.ts:2002`, `apps/orchestrator/src/cli.ts:2029`
- **Input source and trust boundary:** Remote JSON from `OPENWORK_SIDECAR_MANIFEST_URL`, `--sidecar-manifest`, or the default GitHub release manifest crosses into the local orchestrator and controls sidecar binary selection/download.
- **Current handling:** `response.json()` is cast directly to `RemoteSidecarManifest`. `manifest.entries[options.name]`, `entry.targets[...]`, `targetInfo.asset`, `targetInfo.url`, and `targetInfo.sha256` are trusted. `targetPath` is built with `join(targetDir, assetName)`, and SHA-256 verification is optional if the manifest omits `sha256`.
- **Why validation is missing or inadequate:** There is no Zod or equivalent schema ensuring `entries` contains only expected sidecar names, target keys are known platform targets, `asset` is a safe basename, `url` is HTTPS/allowed, `sha256` is present and a 64-character hex digest, or `version` is a valid release version.
- **Risk level:** High.
- **Recommended Zod schema and validation location:** Define `remoteSidecarManifestSchema` beside the sidecar types in `apps/orchestrator/src/cli.ts` or a new `apps/orchestrator/src/sidecar-schema.ts`, and parse immediately after `response.json()` at line 1919.

```ts
const sidecarTargetSchema = z.enum(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"])
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
const assetNameSchema = z.string().min(1).refine((value) => basename(value) === value && !value.includes(".."))

const remoteSidecarManifestSchema = z.object({
  version: z.string().min(1),
  generatedAt: z.string().optional(),
  entries: z.record(z.enum(["openwork-server", "opencode"]), z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/),
    targets: z.record(sidecarTargetSchema, z.object({
      asset: assetNameSchema.optional(),
      url: z.string().url().refine((value) => new URL(value).protocol === "https:").optional(),
      sha256: sha256Schema,
      size: z.number().int().positive().optional(),
    }).refine((value) => value.asset || value.url, "asset or url required")),
  })),
})
```

### 2. Generic workspace config patch bypasses narrower validators

- **File path and line number:** `apps/server/src/server.ts:2126`; unsafe casts/merge at `apps/server/src/server.ts:2127`, `apps/server/src/server.ts:2179`, `apps/server/src/server.ts:2187`
- **Input source and trust boundary:** Client-authenticated collaborator HTTP body to `PATCH /workspace/:id/config` crosses into workspace runtime config and OpenWork workspace config.
- **Current handling:** `readJsonBody()` returns a broad `Record<string, unknown>`. `body.opencode` and `body.openwork` are cast to records, shallow-merged into runtime/workspace config, and only `provider`/`permission` receive limited structural handling.
- **Why validation is missing or inadequate:** The route does not apply the validators used by narrower endpoints, such as plugin spec validation, MCP config validation, MCP name validation, or authorized-folder normalization. Arbitrary top-level config keys and nested shapes can be persisted.
- **Risk level:** High.
- **Recommended Zod schema and validation location:** Add a `configPatchSchema` next to the config route or in `apps/server/src/runtime-config-schema.ts`; parse the body before line 2127 and call existing plugin/MCP/folder validators after schema parsing.

```ts
const mcpConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), command: z.array(z.string().min(1)).min(1).max(64), enabled: z.boolean().optional() }).passthrough(),
  z.object({ type: z.literal("remote"), url: z.string().url(), enabled: z.boolean().optional() }).passthrough(),
])

const configPatchSchema = z.object({
  opencode: z.object({
    default_agent: z.enum(["openwork"]).optional(),
    plugin: z.array(z.string().min(1).max(2048)).max(128).optional(),
    mcp: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), mcpConfigSchema).optional(),
    provider: z.record(z.string(), z.unknown()).optional(),
    permission: z.object({ external_directory: z.record(z.string(), z.unknown()).optional() }).optional(),
  }).strict().optional(),
  openwork: z.record(z.string(), z.unknown()).optional(),
}).strict()
```

### 3. Desktop IPC command channel lacks command-level runtime schemas

- **File path and line number:** `apps/desktop/electron/main.mjs:1544`; dispatch path at `apps/desktop/electron/main.mjs:2222`; loose contract at `packages/types/src/desktop-ipc.ts:600`
- **Input source and trust boundary:** Renderer process calls `ipcRenderer.invoke("openwork:desktop", command, ...args)` into Electron main process.
- **Current handling:** Handlers are JSDoc-typed against `DesktopCommandHandlers`, but runtime args are passed through to handlers. Some handlers coerce selected fields with `String(...)` or default `{}`.
- **Why validation is missing or inadequate:** TypeScript/JSDoc contracts do not validate compromised renderer/preload runtime payloads. Many handlers trigger filesystem writes, workspace changes, config updates, runtime starts, terminal/browser operations, or network fetches.
- **Risk level:** High.
- **Recommended Zod schema and validation location:** Add a `desktopCommandSchemas` lookup in `apps/desktop/electron/main.mjs` or a shared schema beside `packages/types/src/desktop-ipc.ts`; validate in `handleDesktopInvoke` before dispatch.

```ts
const desktopCommandSchemas = {
  workspaceCreate: z.tuple([workspaceCreateInputSchema]),
  workspaceOpenworkWrite: z.tuple([workspaceOpenworkWriteSchema]),
  engineStart: z.tuple([z.string().trim().min(1), engineStartOptionsSchema.optional()]),
  opencodeCommandWrite: z.tuple([opencodeCommandWriteSchema]),
  terminalCreate: z.tuple([terminalCreateSchema]),
} satisfies Record<string, z.ZodTuple>
```

### 4. Renderer can write/read workspace OpenWork config as arbitrary JSON

- **File path and line number:** `apps/desktop/electron/main.mjs:1576`; `apps/desktop/electron/workspace-store.mjs:848`; `apps/desktop/electron/workspace-store.mjs:857`; type-only shape at `packages/types/src/desktop-ipc.ts:124`
- **Input source and trust boundary:** Renderer IPC payload and workspace `.opencode/openwork.json` cross into persistent workspace configuration.
- **Current handling:** `workspaceOpenworkWrite` passes `args[0]?.config` directly to `writeWorkspaceOpenworkConfig`, which writes `JSON.stringify(config)`. `readWorkspaceOpenworkConfig` parses JSON and returns it without runtime validation.
- **Why validation is missing or inadequate:** `WorkspaceOpenworkConfig` is only a TypeScript type. The write path accepts arbitrary object shapes; the read path trusts database/file-derived JSON.
- **Risk level:** High.
- **Recommended Zod schema and validation location:** Define `workspaceOpenworkConfigSchema` in `apps/desktop/electron/workspace-store.mjs` or a shared package; use it in both `workspaceOpenworkWrite` and `readWorkspaceOpenworkConfig`.

```ts
const workspaceOpenworkConfigSchema = z.object({
  version: z.number().int().optional(),
  authorizedRoots: z.array(z.string().trim().min(1)).optional(),
  workspace: z.object({ id: z.string().optional(), name: z.string().optional() }).partial().optional(),
  reload: z.object({ enabled: z.boolean().optional() }).partial().optional(),
}).strict()
```

### 5. UI-control HTTP bridge does not validate affordance request envelopes

- **File path and line number:** `apps/desktop/electron/ui-control-server.mjs:26`; `apps/desktop/electron/ui-control-server.mjs:94`; `apps/desktop/electron/ui-control-server.mjs:145`; shared schema exists at `packages/types/src/openwork-affordance.ts:61`
- **Input source and trust boundary:** Token-protected local MCP/client HTTP requests cross into renderer `window.__openworkControl` commands.
- **Current handling:** The server manually parses JSON with a size cap. `/query` and `/command` check only that `input.id` is a non-empty string inside injected JavaScript. `/execute` checks only `input.actionId` and passes `args` through.
- **Why validation is missing or inadequate:** Existing `openworkAffordanceRequestSchema` is not used. `args`, `expectedRevision`, and `actor` are not validated at the bridge boundary; action-specific handlers must defend themselves.
- **Risk level:** High.
- **Recommended Zod schema and validation location:** Import and use `openworkAffordanceRequestSchema` in `apps/desktop/electron/ui-control-server.mjs` before `runOpenworkControlCommand`. Add a legacy `/execute` schema if `actionId` remains supported.

```ts
const legacyExecuteRequestSchema = z.object({
  actionId: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
}).strict()
```

### 6. Handsfree CUA runner trusts OpenAI Responses API and tool response shapes

- **File path and line number:** `packages/handsfree/src/cua-runner.mjs:39`; action dispatch at `packages/handsfree/src/cua-runner.mjs:58` and `packages/handsfree/src/cua-runner.mjs:86`; tool JSON parse at `packages/handsfree/src/cua-runner.mjs:109`
- **Input source and trust boundary:** Third-party OpenAI Responses API output and MCP/computer-use tool responses cross into local computer-use tool calls.
- **Current handling:** `response.json()` is trusted; `result.output || []` is iterated; raw `computerCall.actions` are dispatched to `callTool`; tool text is parsed as JSON and only checked for `ok === false`.
- **Why validation is missing or inadequate:** No schema verifies response item types, `computer_call` shape, finite coordinates, key arrays, drag paths, text length, or tool result envelopes.
- **Risk level:** High.
- **Recommended Zod schema and validation location:** Add schemas in `packages/handsfree/src/cua-runner.mjs`; validate API output before `items.push(...output)` and validate each action before `executeCuaAction`.

```ts
const computerActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().finite(), y: z.number().finite(), button: z.enum(["left", "right", "middle"]).optional(), keys: z.array(z.string()).optional() }),
  z.object({ type: z.literal("type"), text: z.string().max(10_000) }),
  z.object({ type: z.literal("keypress"), keys: z.array(z.string().min(1)).min(1).max(16) }),
  z.object({ type: z.literal("scroll"), x: z.number().finite(), y: z.number().finite(), scroll_x: z.number().finite().optional(), scroll_y: z.number().finite().optional() }),
  z.object({ type: z.literal("wait") }),
  z.object({ type: z.literal("screenshot") }),
])
```

### 7. Remote workspace creation accepts ad-hoc URLs/tokens with weak validation

- **File path and line number:** `apps/server/src/routes/workspaces.ts:326`; discovery fetch at `apps/server/src/routes/workspaces.ts:355`; persistence at `apps/server/src/routes/workspaces.ts:374`
- **Input source and trust boundary:** Host-authenticated HTTP body to `POST /workspaces/remote` crosses into remote discovery fetches and persisted workspace metadata.
- **Current handling:** Fields are pulled with `readStringField`. `baseUrl` is checked only with `/^https?:\/\//i`; `remoteType` defaults to `openwork`; optional tokens, IDs, names, backend fields, and directory values are accepted with no length/format schema.
- **Why validation is missing or inadequate:** The route does not validate URL parsing, protocol policy, host/private-address policy, token lengths, workspace ID/name bounds, or extra fields.
- **Risk level:** Medium.
- **Recommended Zod schema and validation location:** Parse the request body at line 326 in `apps/server/src/routes/workspaces.ts`.

```ts
const remoteWorkspaceRequestSchema = z.object({
  baseUrl: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  remoteType: z.enum(["opencode", "openwork"]).default("openwork"),
  directory: z.string().max(4096).optional(),
  displayName: z.string().max(120).optional(),
  openworkHostUrl: z.string().url().optional(),
  openworkToken: z.string().max(4096).optional(),
  openworkHostToken: z.string().max(4096).optional(),
  openworkWorkspaceId: z.string().max(256).optional(),
  openworkWorkspaceName: z.string().max(256).optional(),
  sandboxBackend: z.string().max(64).optional(),
  sandboxRunId: z.string().max(256).optional(),
  sandboxContainerName: z.string().max(256).optional(),
}).strict()
```

### 8. Billing return/success URLs trust forwarded headers

- **File path and line number:** `ee/apps/den-api/src/routes/org/billing.ts:21`; Stripe URL construction uses this helper at `ee/apps/den-api/src/routes/org/billing.ts:31` and `ee/apps/den-api/src/routes/org/billing.ts:40`
- **Input source and trust boundary:** HTTP headers `x-forwarded-proto` and `x-forwarded-host` cross into generated Stripe checkout/portal return URLs.
- **Current handling:** `getRequestOrigin` returns `${forwardedProto || ...}://${forwardedHost}` whenever `x-forwarded-host` is present.
- **Why validation is missing or inadequate:** There is no Zod or equivalent allowlist for trusted proxy headers or configured application origins. If the deployment does not strip untrusted forwarded headers, clients can influence return URLs.
- **Risk level:** Medium.
- **Recommended Zod schema and validation location:** Add a central `requestOriginSchema`/helper in `billing.ts` or shared request utilities; validate protocol and host against configured public origins such as `env.webAppHosts`, `env.betterAuthUrl`, or `env.publicUrlTrustedOrigins`.

```ts
const forwardedOriginSchema = z.object({
  proto: z.enum(["http", "https"]),
  host: z.string().trim().min(1).max(255),
}).refine(({ host }) => configuredHostAllowlist.has(host.toLowerCase()))
```

### 9. OpenWork UI MCP trusts discovery file and bridge response shapes

- **File path and line number:** `packages/openwork-ui-mcp/index.mjs:65`; bridge response parse at `packages/openwork-ui-mcp/index.mjs:100`; request URL assembly at `packages/openwork-ui-mcp/index.mjs:88`
- **Input source and trust boundary:** Local discovery file, optionally overridden by `OPENWORK_UI_CONTROL_DISCOVERY`, and HTTP responses from the desktop bridge cross into MCP tool behavior.
- **Current handling:** The discovery file is parsed with `JSON.parse`; only `baseUrl` and `token` string types are checked. Bridge responses are parsed and returned as-is.
- **Why validation is missing or inadequate:** No schema requires `baseUrl` to be a URL or loopback-only. No schemas validate `/health`, `/context`, `/actions`, `/query`, or `/command` response envelopes.
- **Risk level:** Medium.
- **Recommended Zod schema and validation location:** In `packages/openwork-ui-mcp/index.mjs`, validate discovery and per-endpoint response envelopes before use.

```ts
const bridgeDiscoverySchema = z.object({
  baseUrl: z.string().url().refine((value) => ["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname)),
  token: z.string().min(1),
}).strict()
const bridgeEnvelopeSchema = z.object({ ok: z.boolean().optional(), error: z.string().optional() }).passthrough()
```

### 10. Voice realtime session body can select arbitrary model

- **File path and line number:** `ee/apps/inference/src/voice.ts:123`; body parse at `ee/apps/inference/src/voice.ts:265`
- **Input source and trust boundary:** Authenticated inference client JSON body to `/voice/realtime/session` crosses into OpenAI Realtime session creation and billing assumptions.
- **Current handling:** The body is parsed as `unknown`; `readStringField(input, "model")` extracts any string and uses it as `session.model`, falling back to `OPENWORK_VOICE_REALTIME_MODEL`.
- **Why validation is missing or inadequate:** Manual string extraction does not enforce a model allowlist, maximum length, or default-only policy. There is no route body schema.
- **Risk level:** Medium.
- **Recommended Zod schema and validation location:** Parse immediately after `c.req.json()` in `registerVoiceRoutes`, or at the start of `createOpenAiRealtimeClientSecret`.

```ts
const voiceRealtimeSessionSchema = z.object({
  model: z.enum([OPENWORK_VOICE_REALTIME_MODEL]).optional(),
}).strict()
```

If the client should not select models, use `z.object({}).passthrough()` and always use `OPENWORK_VOICE_REALTIME_MODEL`.

### 11. GitHub webhook payload is signed but not schema-validated

- **File path and line number:** `ee/apps/den-api/src/routes/webhooks/github.ts:74`; queued payload at `ee/apps/den-api/src/routes/webhooks/github.ts:84`
- **Input source and trust boundary:** GitHub webhook raw JSON and headers cross into queued plugin sync processing.
- **Current handling:** Raw body is HMAC-verified and event header is allowlisted, then `JSON.parse(rawBody) as Record<string, unknown>` is used. A few nested fields are manually type-checked; full `payload` is passed to `enqueueGithubWebhookSync`.
- **Why validation is missing or inadequate:** Signature verification authenticates source but does not validate payload shape. Malformed signed JSON can throw, and unexpected signed payload shapes can be queued.
- **Risk level:** Medium.
- **Recommended Zod schema and validation location:** Add `githubWebhookPayloadSchema` in `ee/apps/den-api/src/routes/webhooks/github.ts` and `safeParse` after JSON parsing.

```ts
const githubWebhookPayloadSchema = z.object({
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({ id: z.number().int().optional(), full_name: z.string().max(255).optional() }).optional(),
  ref: z.string().max(1024).optional(),
  after: z.string().max(128).optional(),
}).passthrough()
```

### 12. Installer trusts deployment app version with only string checks

- **File path and line number:** `apps/installer/src/install.ts:149`; release URL sink at `apps/installer/src/release-asset.ts:21` and `apps/installer/src/release-asset.ts:31`
- **Input source and trust boundary:** External deployment API response from `${apiUrl}/v1/app-version` crosses into installer release selection.
- **Current handling:** Response is cast to `{ latestAppVersion?: unknown }`; code checks only that the value is a non-empty string and not `0.0.0`. It is later normalized into a GitHub release path.
- **Why validation is missing or inadequate:** No schema validates semantic version format or rejects path/URL-special characters before constructing a release download URL.
- **Risk level:** Medium.
- **Recommended Zod schema and validation location:** In `apps/installer/src/install.ts` near `fetchLatestSupportedVersion`, parse the API response.

```ts
const appVersionResponseSchema = z.object({
  latestAppVersion: z.string().trim().regex(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/),
}).strict()
```

### 13. Den API env numeric fields are Zod-declared as strings, then converted with `Number(...)`

- **File path and line number:** `ee/apps/den-api/src/env.ts:370`; examples at `ee/apps/den-api/src/env.ts:412`, `ee/apps/den-api/src/env.ts:438`, `ee/apps/den-api/src/env.ts:456`; additional timeout/resource conversions later in the same file
- **Input source and trust boundary:** Runtime environment variables cross into service ports, scheduler intervals, timeout values, and Daytona provisioning resources.
- **Current handling:** `EnvSchema` accepts many numeric env vars as optional strings, then exported config uses `Number(...)`.
- **Why validation is missing or inadequate:** Zod is present but not validating the actual numeric type/range. `Number("abc")` becomes `NaN`; zero, negative, or extreme values can be accepted for ports/timeouts/resources.
- **Risk level:** Medium.
- **Recommended Zod schema and validation location:** In `ee/apps/den-api/src/env.ts`, replace string schemas with coercing numeric schemas and move conversions into `EnvSchema` transforms.

```ts
const portSchema = z.coerce.number().int().min(1).max(65535)
const positiveIntSchema = z.coerce.number().int().positive()
const nonNegativeIntSchema = z.coerce.number().int().min(0)
```

### 14. Browser panel IPC accepts unvalidated bounds/point objects

- **File path and line number:** `apps/desktop/electron/browser-panel.mjs:747`; `apps/desktop/electron/browser-panel.mjs:763`; `apps/desktop/electron/browser-panel.mjs:783`; arithmetic at `apps/desktop/electron/browser-panel.mjs:583`
- **Input source and trust boundary:** Renderer IPC payloads cross into Electron BrowserView bounds and context-menu placement.
- **Current handling:** `openwork:browser:show` and `openwork:browser:bounds` pass raw `bounds`; code assumes numeric `x`, `y`, `width`, and `height`. Context-menu code accepts raw `point`.
- **Why validation is missing or inadequate:** No runtime shape checks for object presence, finite numbers, non-negative sizes, or maximum reasonable dimensions.
- **Risk level:** Low.
- **Recommended Zod schema and validation location:** Add schemas in `apps/desktop/electron/browser-panel.mjs` and parse in `registerIpc` handlers.

```ts
const browserBoundsSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict()
const browserPointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict()
```

### 15. Central JSON body helper casts arbitrary JSON to object

- **File path and line number:** `apps/server/src/server.ts:2899`; example consumers include `apps/server/src/server.ts:2126`, `apps/server/src/server.ts:2249`, `apps/server/src/server.ts:2339`, `apps/server/src/server.ts:2440`
- **Input source and trust boundary:** HTTP JSON request bodies cross into route handlers.
- **Current handling:** `request.json()` result is cast to `Record<string, unknown>` regardless of whether it is an object, array, scalar, null, or excessively large.
- **Why validation is missing or inadequate:** No central object-only schema or general body size limit exists here. Some routes add route-specific validation later, but others coerce values with `String(...)` or cast nested records.
- **Risk level:** Low.
- **Recommended Zod schema and validation location:** Keep `readJsonBody` object-only and bounded in `apps/server/src/server.ts`, then layer route-specific schemas in each route.

```ts
const jsonObjectSchema = z.record(z.string(), z.unknown())
async function readJsonBody(request: Request) {
  const json = await readBoundedJson(request, DEFAULT_MAX_JSON_BYTES)
  return jsonObjectSchema.parse(json)
}
```

### 16. Route parameter decoding can throw before handler validation

- **File path and line number:** `apps/server/src/routes/registry.ts:36`
- **Input source and trust boundary:** Raw URL path segments cross into route params.
- **Current handling:** `decodeURIComponent(match[index + 1])` is called directly while matching a route.
- **Why validation is missing or inadequate:** Malformed percent encoding throws `URIError` before route handlers can return a controlled `400`. There is no safe decode or route-param schema.
- **Risk level:** Low.
- **Recommended Zod schema and validation location:** Add safe decoding in `apps/server/src/routes/registry.ts`.

```ts
const routeParamSchema = z.string().min(1).max(512)
function safeDecodeRouteParam(value: string) {
  try { return routeParamSchema.parse(decodeURIComponent(value)) }
  catch { throw new ApiError(400, "invalid_route_param", "Invalid route parameter") }
}
```

### 17. Ollama tags/pull responses are partially guarded, not schema-validated

- **File path and line number:** `apps/app/src/react-app/domains/settings/ollama-config.tsx:94`; streaming parse at `apps/app/src/react-app/domains/settings/ollama-config.tsx:142`
- **Input source and trust boundary:** Local third-party Ollama HTTP API responses cross into settings UI and provider config.
- **Current handling:** `/api/tags` accepts `Array.isArray(data?.models) ? data.models : []`. `/api/pull` parses each JSON line and checks selected fields manually.
- **Why validation is missing or inadequate:** Individual model entries and pull progress objects are not schema-validated before being treated as typed UI/config data.
- **Risk level:** Low.
- **Recommended Zod schema and validation location:** Add schemas in `ollama-config.tsx` near the query helpers.

```ts
const ollamaModelSchema = z.object({ name: z.string().min(1), model: z.string().optional(), modified_at: z.string().optional(), size: z.number().optional() }).passthrough()
const ollamaTagsResponseSchema = z.object({ models: z.array(ollamaModelSchema).default([]) }).passthrough()
const ollamaPullProgressSchema = z.object({ status: z.string().optional(), completed: z.number().optional(), total: z.number().optional(), error: z.string().optional() }).passthrough()
```

### 18. Bootstrap CLI trusts Den/cloud API response envelopes

- **File path and line number:** `packages/openwork-bootstrap/bin/openwork.mjs:527`; examples at `packages/openwork-bootstrap/bin/openwork.mjs:561`, `packages/openwork-bootstrap/bin/openwork.mjs:576`, `packages/openwork-bootstrap/bin/openwork.mjs:584`
- **Input source and trust boundary:** CLI HTTP responses from Den/cloud APIs and local bootstrap files cross into local bootstrap state and generated config.
- **Current handling:** `request()` parses response JSON into `body`; call sites check status codes and selected optional fields such as `signin.body?.token`, `marketplaces.body?.items`, or `plugin.body?.id`.
- **Why validation is missing or inadequate:** No Zod response schemas validate auth, marketplace, plugin, workspace bootstrap, or desktop bootstrap response envelopes. Shape drift fails late or can write incomplete local state.
- **Risk level:** Low.
- **Recommended Zod schema and validation location:** Add response schemas in `packages/openwork-bootstrap/bin/openwork.mjs` and parse at each API call boundary.

```ts
const signinResponseSchema = z.object({ token: z.string().min(1), user: z.object({ id: z.string().optional(), email: z.string().email().optional() }).passthrough().optional() }).passthrough()
const marketplaceListSchema = z.object({ items: z.array(z.object({ id: z.string().min(1), name: z.string().optional() }).passthrough()) }).passthrough()
```

### 19. Worker proxy env numeric fields are Zod strings, then converted with `Number(...)`

- **File path and line number:** `ee/apps/den-worker-proxy/src/env.ts:60`; related fields at `ee/apps/den-worker-proxy/src/env.ts:66` and `ee/apps/den-worker-proxy/src/env.ts:67`
- **Input source and trust boundary:** Runtime environment variables cross into proxy listen port, Daytona OpenWork port, and signed preview expiry.
- **Current handling:** `PORT`, `DAYTONA_OPENWORK_PORT`, and `DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS` are optional strings in `EnvSchema`, then converted with `Number(...)`.
- **Why validation is missing or inadequate:** Allows `NaN`, invalid ports, zero/negative values, or unexpectedly huge values.
- **Risk level:** Low.
- **Recommended Zod schema and validation location:** Update `ee/apps/den-worker-proxy/src/env.ts` so `EnvSchema` coerces and bounds these values.

```ts
PORT: z.coerce.number().int().min(1).max(65535).default(8789),
DAYTONA_OPENWORK_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS: z.coerce.number().int().min(1).max(86400).default(86400),
```

## Already Validated or No-Zod-Required Cases

| Area | Location | Decision |
|---|---|---|
| Agent diagnostics route | `apps/server/src/server.ts:1561`; bounded reader at `apps/server/src/server.ts:2908` | Already uses `agentContextDiagnosticsRequestSchema.safeParse(...)` and a dedicated bounded JSON reader. |
| Installer install-link config | `apps/installer/src/config-sources.ts:96`; `apps/installer/src/config-sources.ts:107` | External install config and experience config are validated with shared schemas. |
| File path APIs | `apps/server/src/routes/files.ts:46`; `apps/server/src/routes/files.ts:112` | Not Zod, but equivalent path traversal and child-path validation is consistently applied before filesystem access. |
| Direct MCP add/toggle path | `apps/server/src/mcp.ts:662`; `apps/server/src/mcp.ts:694` | Uses `validateMcpName` and `validateMcpConfig`; the confirmed gap is the broader config patch bypass, not these endpoints. |
| Workspace import preview | `apps/server/src/workspace-import-preview.ts:96` | Uses normalization and existing validators for skills, commands, portable files, and sanitized config imports. |
| Den API route validators | `ee/apps/den-api/src/middleware/validation.ts`; examples `ee/apps/den-api/src/routes/memory/core.ts:52`, `ee/apps/den-api/src/routes/bootstrap/index.ts:184` | Most org/admin/worker/memory/bootstrap routes use `jsonValidator`, `queryValidator`, or `paramValidator` and read `c.req.valid(...)`. |
| Telegram webhook | `ee/apps/den-api/src/routes/webhooks/telegram.ts:420` | Path params and payload are Zod-validated. |
| SCIM group bodies | `ee/apps/den-api/src/routes/auth/scim.ts:413` | Uses `scimGroupInputSchema` / `scimGroupPatchSchema`. |
| Den Web `/api/den` proxy | `ee/apps/den-web/app/api/_lib/upstream-proxy.ts:250` | Intended transparent proxy; validation belongs at Den API route boundaries. |
| Connect link claims | `packages/connect-link/src/node.ts:160` | JWS claims are validated with `connectLinkClaimsSchema.safeParse`. |
| Enterprise MCP client/mock protocol | `packages/enterprise-mcp-client/src/request-observer.ts:31`; `packages/enterprise-mcp-client/src/enterprise-mcp-client.ts:79`; `packages/enterprise-mcp-mock-server/src/protocol/mcp-handler.ts:293`; `packages/enterprise-mcp-mock-server/src/protocol/oauth-handler.ts:184` | JSON-RPC, OAuth, and constructor inputs are Zod-validated at protocol boundaries. |
| Den Web install config join flow | `apps/app/src/react-app/domains/cloud/join-organization-dialog.tsx:122` | Install config response is validated with `installConfigSchema.safeParse`. |
| Ollama vision capability probe | `apps/app/src/react-app/domains/settings/openai-image-extension.ts:45` | No Zod, but `parseOllamaVisionCapability` safely treats unknown payloads as false; low-risk and not a confirmed gap. |
| Inference OpenRouter usage webhook | `ee/apps/inference/src/webhooks.ts:231` | Manual structural parsing from `unknown` ignores malformed spans rather than trusting them directly; Zod would improve consistency but this was not counted as a confirmed gap. |

## Prioritized Remediation Plan

1. Add Zod schemas for executable-sidecar manifests and require SHA-256 for remote sidecar assets.
2. Add schema-gated config patching and reuse existing plugin/MCP/authorized-folder validators for `PATCH /workspace/:id/config`.
3. Add command-level IPC schemas for Electron main process commands, starting with config-writing, filesystem, runtime, terminal, browser, and fetch-like commands.
4. Validate UI-control bridge requests with the existing affordance schema before crossing into renderer actions.
5. Validate model/tool outputs before local computer-use actions in `packages/handsfree`.
6. Replace string-only env validation for numeric values with bounded `z.coerce.number()` schemas.
7. Add smaller schemas for webhooks, remote workspace creation, third-party UI APIs, and CLI response envelopes.
