# Flue engine facade notes

- The workspace engine flag defaults to `opencode`; only workspaces explicitly set to `flue` are served by the in-process facade.
- The facade exposes an OpenCode-compatible wire slice under existing `/opencode/*` mounts so the app can keep using the current SDK client and SSE event stream.
- The read model is stored in `.opencode/openwork/flue-state.json` and mirrors the protocol-owned session/message/todo schemas before responses or events are emitted.
- Prompt execution attempts to initialize a Flue harness with `defineAgent` and an abortable `session.prompt()` call. The deterministic `flue/default` model has a local fallback so Bun tests and keyless development do not require provider credentials or Node's `node:sqlite` runtime.

## Verified end-to-end (Daytona sandbox, 2026-07-29)

- Harness init MUST go through `createFlueContext({ env: process.env, req, ... })` +
  `ctx.initializeRootHarness(agent)`. The lower-level `initializeRootHarness(agent, config, handler)`
  import throws `[flue] Canonical conversation runtime is not configured.` (no
  conversationWriter/attachmentStore) — and an `env: {}` context starves Pi of provider API keys.
- Real-model chat proven in the real UI on `openai/gpt-5-nano` (key from env): composer-driven and
  `prompt_async`-driven, streamed via `message.part.delta` SSE, rendered as markdown.
- `buildProviderList()` advertises env-keyed providers (OPENAI_API_KEY / ANTHROPIC_API_KEY) next to
  the deterministic `flue/default`.
- Package resolution: `@openwork/engine-protocol` exports `default` must point at built `dist/*.js` —
  Electron's plain Node cannot load workspace `src/*.ts` (Bun tests mask this). apps/server `build`
  chains the engine-protocol build.
- Flue transitive deps (`@google/genai`, `@mongodb-js/zstd`, `node-liblzma`) need explicit
  `allowBuilds: false` entries in pnpm-workspace.yaml or pnpm 11's verify-deps loop fails installs.
- Tool observations are bridged from `observe()`: `tool_start` creates a running wire part and `tool`
  transitions it to the protocol's completed/error state (or creates a final orphan part), including timings.
- Known gaps (next iterations): durability via Flue durable admission (force-quit recovery), permission
  gating, abort wiring in UI, session titles,
  `bun test` picks up compiled `dist/*.test.js` copies when dist exists (clean dist before suite).

## Catalog bridge (2026-07-29)

- The Flue facade now resolves the same model catalog URL as the OpenCode engine (`resolveOpencodeModelsUrl()`), fetches `<base>/api.json`, validates providers/models, then materializes credential-resolvable catalog providers and runtime-managed providers next to the deterministic `flue/default` provider.
- Catalog `npm` to Flue/Pi api-kind mapping:
  | catalog `npm` | Flue `reg.api` |
  | --- | --- |
  | `@openrouter/ai-sdk-provider` | `openai-completions` |
  | `@ai-sdk/openai-compatible` | `openai-completions` |
  | `@ai-sdk/mistral` | `openai-completions` |
  | `@ai-sdk/anthropic` | `anthropic-messages` |
  | `@ai-sdk/openai` | `openai-responses` |
  | `@ai-sdk/azure` | `azure-openai-responses` |
  | `@ai-sdk/amazon-bedrock` | `bedrock-converse-stream` (listed but not registered: AWS credential sets are not yet supported) |
- Unknown `npm` values are registered as `openai-completions` only when the provider id/name/npm/base URL contains an OpenAI-compatible marker (`openai`, `openrouter`, `openwork`, or `compatible`); otherwise runtime-managed providers stay listed but disconnected with a diagnostic reason, while catalog-only entries are skipped.
- Cache/fallback behavior: one process-wide in-flight catalog fetch, 3.5s timeout, 10 minute memory TTL, and a workspace-local disk cache at `.opencode/openwork/flue-catalog-cache.json`. If network load fails, the facade logs once without secrets, then falls back to disk cache, runtime provider map only, and finally `flue/default`.
- Credential precedence: the OpenWork-owned Flue provider vault first, user env store provider lookup second, then `process.env`, trying every catalog/runtime `env[]` name for the latter two. Runtime-map providers with required env names and no resolved credential remain visible in provider-list `all`, but are omitted from `connected`/`default` and are not registered; with a credential they remain in `all` and are also registered and included in `connected`/`default`. Selecting an unconnected one fails with `provider_no_credential` rather than falling back. Unconfigured, uncredentialed catalog entries remain omitted. `OPENWORK_INFERENCE_BASE_URL` from env store/process overrides the hosted `openwork` base URL and is normalized to include `/api/v1`.
- Each catalog materialization logs one structured diagnostic with source (`url`, `disk-cache`, `runtime-only`, or `deterministic-only`), registered/listed/connected counts, and skipped provider ids/reasons; credentials and credential values are never logged. Provider normalization, mapping, and registration are fault-isolated per provider: malformed, unsupported, or throwing rows become listed-but-disconnected where they can be represented and otherwise become structured skips, while the remaining providers continue. A wholesale materialization failure is logged once and degrades to the deterministic provider only, so provider-list data cannot produce an HTTP 500.
- Runtime provider identity is the `provider` map key, matching OpenCode config semantics. Den may write a key such as `lpr_demo` with an inner `id: "mistral"`; that inner id is only a catalog-metadata reference used to inherit transport/model defaults. Listing/model `providerID`, vault lookup, runtime `env[]` lookup, Flue registration and `provider/model` resolution, and `disabled_providers` matching all use `lpr_demo`. Hosted OpenWork Models uses `openwork` for both values.
- Runtime provider map precedence: `readEffectiveRuntimeOpencodeConfig()` is merged over the catalog; base URL resolution is runtime `options.baseURL` -> runtime `api` -> catalog metadata `api` for the inner catalog id -> known Pi endpoint default. Flue requires a concrete URL for Den's custom `lpr_*` identities even though Pi can hydrate built-in `anthropic`/`openai` identities, so the final step supplies the empirically verified Anthropic (`https://api.anthropic.com`) and OpenAI (`https://api.openai.com/v1`) defaults (plus Mistral's known endpoint); genuinely endpoint-less unsupported kinds stay listed but disconnected. Runtime model maps replace catalog model maps when present, and `whitelist`/`blacklist` filter the final model map. Effective `disabled_providers` (global row plus workspace row, unique union) is then applied as the final map-key provider-id filter before credential resolution, Flue `registerProvider()`, and provider-list response building; it also removes the deterministic `flue/default` provider.
- Provider credentials received through the OpenCode v2 wire are stored in the dedicated runtime-SQLite `flue_provider_credentials` table as typed JSON. They are global by provider id, matching OpenCode auth-store semantics and the UI's workspace-free `auth.set` calls, so one explicit key works across Flue workspaces. They never enter runtime OpenCode config or workspace-local state/catalog cache files.
- The facade implements `PUT /auth/{providerID}` (including a `null` body for removal), `DELETE /auth/{providerID}`, and `GET /provider/auth`. Providers are traversed in the stable provider-list order and each advertised method array contains one API-key method at index 0, preserving the UI's positional method lookup. Writes immediately rematerialize and re-register providers without an engine restart.
- `POST /provider/{providerID}/oauth/authorize` and `/provider/{providerID}/oauth/callback` return `501 flue_oauth_unsupported`. OAuth remains unsupported, as does migration of credentials already held only in OpenCode's auth store; users must authenticate once through the Flue auth wire. The Zen/free-tier materialization path also remains unsupported.

## MCP bridge (2026-07-29)

| Runtime MCP type | Flue support | Behavior |
| --- | --- | --- |
| `remote` | ✅ | Connected with `connectMcpServer()` and attached directly to the Flue agent tool array. The default transport is `streamable-http`; an explicit runtime extension `transport: "sse"` or a URL whose path ends in `/sse` selects legacy SSE. |
| `local` / stdio | ❌ | Flue's MCP client is remote-only. The server remains isolated and is reported as `{ "status": "failed", "error": "unsupported_transport_stdio" }`; it is never spawned or presented as connected. |

- The facade implements the OpenCode v2 routes mined from `@opencode-ai/sdk@1.17.11`: `GET /mcp` (status), `POST /mcp` (dynamic add), `POST /mcp/{name}/connect`, `POST /mcp/{name}/disconnect`, `GET /experimental/tool`, and `GET /experimental/tool/ids`. It also handles `POST /instance/dispose` so the server's existing dispose/re-register loop can rebuild Flue MCP state.
- OpenCode's model/wire convention is `<server>_<tool>`: the v2 experimental tool routes return those IDs, `cloud-mcp-health.ts` expects `openwork-cloud_search_capabilities` / `openwork-cloud_execute_capability`, and app steering, permission, and tool-part consumers use the same IDs. Flue's MCP adapter initially returns `mcp__<server>__<tool>`, so the facade clones each definition as the OpenCode ID while copying (not wrapping with `defineTool()`) the non-public `flue.preparedToolAdapter` symbol and its parameter/execute contract. The raw Flue name is now only an adapter-discovery input; model calls, tool lists/IDs, observations, and persisted tool parts all use the OpenCode ID.
- Effective global + workspace runtime MCP config is checked at facade initialization, before every facade request, and before harness initialization. Config hashes detect runtime-DB changes without a process restart. A changed or explicitly reconnected entry establishes a replacement connection and invalidates the harness so the next prompt gets the new tool array. Harness initialization snapshots an MCP revision and retries initialization if that revision changes. Prompt leases keep superseded clients open until every prompt that could hold their definitions finishes, so refresh/disconnect ordering cannot hand an in-flight prompt a client the facade just closed.
- Tool adapters detect the MCP SDK transport failures observed in this stack: `Not connected`; `Connection closed` / closed transport or channel; HTTP/SSE 404 or 410 session expiry; non-caller aborts; fetch/network/socket termination; `ECONNREFUSED`, `ECONNRESET`, `EPIPE`, `ENET*`, `EHOST*`, and `UND_ERR_SOCKET`; and Flue/Pi's `Unable to connect` projection. Caller-requested aborts and MCP/application tool errors are not retried. On a transport failure the facade reconnects only that server, resolves the same tool on the replacement client, and retries once. A failed reconnect removes the dead tools, sets a safe failed status reason, and returns a tool error naming the server/tool and retry reason without transport inputs or credentials.
- `McpServerConnection` publicly exposes only `tools` and `close()`—not the underlying client, `tools/list`, ping, or transport-close events—so cached-client probing cannot be added without breaking Flue's prepared-adapter boundary. Instead, a successful connect is treated as a positive liveness observation for 30 seconds; after that interval the per-request reconciliation path establishes a fresh listed connection and atomically replaces the cached one. This bounded rotation avoids reporting `connected` forever from a fingerprint hit, while immediate adapter-level failure detection heals drops inside the 30-second window. Disconnect and dispose retire clients through the same prompt-lease path; per-server failures remain isolated from healthy peers, provider listing, and prompting.
- MCP request headers remain in-memory transport inputs only. Header values are not included in statuses, tool responses, diagnostics, logs, or Flue's workspace state files. The default per-request timeout is 5 seconds (runtime `timeout`/`timeoutMs` can select 100ms–30s).
- The exact message `The selected provider/model was not found in OpenCode provider catalog.` is produced by `cloud-mcp-health.ts` in the `/provider` capability fallback, not by the app. Flue previously returned no tools from `/experimental/tool`, forcing that fallback; stale selections whose provider identity was absent from the incomplete facade catalog then produced the message. The MCP tool projection now supplies direct live evidence before that fallback, while the catalog continues to list runtime providers without credentials and prompt submission still rejects them with `provider_no_credential`.
