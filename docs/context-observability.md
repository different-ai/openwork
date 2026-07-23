# OpenWork context observability

OpenWork's managed OpenCode runtime exposes one opt-in diagnostic chain for:

1. which OpenWork contributor ran, was gated, or failed;
2. when the prepared `system[]` changed and which blocks changed;
3. the exact post-system-hook array, when separately authorized;
4. text correspondence between OpenWork contributor output and final spans;
5. MCP status transitions, including safe failure classes; and
6. the managed registry, plugin inventory, and effective engine configuration.

It is off by default. Exact output can contain messages, file content, workspace
context, remote skill metadata, and secrets.

## Controls and precedence

| Level | Output |
|---|---|
| `off` | No managed engine diagnostic forwarding |
| `metadata` | Contributor decisions and hashes, prepared-array fingerprints/deltas, sanitized catalog phases, and MCP status deltas; no prompt text or span matching |
| `exact` | Everything in metadata, plus each prepared block that fits the 2 MiB logical-record cap and contributor text-correspondence spans |

The first applicable control wins:

1. `OPENWORK_OBSERVABILITY=off|metadata|exact` is authoritative. Any other
   nonblank value fails closed to `off`.
2. Legacy `OPENWORK_PROMPT_LOG=1|true|yes|on` selects `exact`; its false values
   select `off`; an invalid nonblank value fails closed.
3. In desktop, **Developer Mode** selects `metadata`. The nested **Exact
   prepared-prompt tracing** switch is a separate consent and selects `exact`.
4. `OPENWORK_DEV_MODE=1` selects `metadata` for non-desktop development
   launches. It never authorizes exact content.
5. Otherwise the level is `off`.

The desktop shows the requested level, effective running level, and winning
source. A preference change requires an idle managed-engine restart because the
observer fixes its level when the plugin instance is created. Turning Developer
Mode off also revokes stored exact-content consent.

## Output sinks and retention

Managed records retain their normal Electron main-process stderr sink and are
mirrored live into **View → Toggle Developer Tools → Console** while metadata or
exact observability is effective. Terminal, launcher, OS, or enterprise log
collectors may retain stderr. DevTools is not the only sink.

The renderer bridge keeps no prompt or MCP history. It may retain one strictly
content-free observer-initialization record until the renderer preload is ready,
then replays it once. Logical records are capped at 2 MiB in both the managed
child forwarder and renderer bridge; an oversized record is replaced by an
omission notice. Unrelated OpenCode stdout/stderr is dropped.

## Records

All records have stable `[openwork][<scope>]` prefixes.

- `agent-prompt observer initialized` gives timestamp, level, enabled/exact
  booleans, and the winning control source. It contains no control value.
- `context trace=<id> id=<contributor>` gives include/omit/failure outcome,
  character count, and full SHA-256 for an OpenWork contributor.
- `connect-context` and `connect-skills` give bounded candidate source,
  candidate hash, cache state, MCP phase, HTTP status or JSON-RPC code, and
  selection/omission reasons. URLs, headers, payloads, and exception messages
  are excluded.
- `agent-prompt observed system array` gives a full SHA-256 of JSON `system[]`,
  per-block hashes and sizes, and an initial/unchanged/changed delta. The
  baseline is scoped by hashed session + agent + model so title, summary, and
  main requests do not overwrite one another.
- In metadata, provenance explicitly reports
  `match=unavailable reason=exact-provenance-disabled`.
- In exact, `provenance ... match=text-correspondence causalOrigin=unproven`
  maps a recorded OpenWork string to a final `[start,end)` span only when
  occurrence counts are unambiguous. Missing and repeated text is reported as
  `missing` or `ambiguous`. All remaining spans are labeled
  `classification=open-code-or-external-plugin`.
- In exact, `BEGIN/END OBSERVED SYSTEM ARRAY` is emitted on every prepared
  request, including unchanged prompts. Blocks are reversible JSON strings;
  terminal controls and forged log breaks are escaped.
- `mcp-status` identifies a bounded, terminal-safe server name plus a short
  hash and emits only transitions. Failed states include one of
  `auth|timeout|transport|protocol|unknown`; a failure-class change is emitted
  even if status remains `failed`. Raw MCP errors are never copied. Status is
  sampled while OpenCode is already preparing an actual prompt and immediately
  after MCP lifecycle events, when OpenCode has already initialized that state.
  There is no startup or background polling that would connect idle MCPs.

Trace IDs are process-random, content-free IDs shared by the independently
bundled context and observer plugins. They are sent only to the authenticated
loopback context route, allowing server, contributor, and final-array records
for concurrent requests to be joined.

## Exactness boundary

For one model request, the observer stores OpenCode's live array reference in
`experimental.chat.system.transform` inside `AsyncLocalStorage`. `chat.params`
then snapshots that same request after later system hooks and OpenCode's block
normalization. Request-local correlation prevents concurrent title and main
requests for the same session from being cross-paired. The raw reference is
deleted immediately after consumption.

This is the exact prepared OpenCode `system[]` at the post-system-hooks
boundary. It is not the provider HTTP body. Provider adapters may subsequently
reshape or annotate it. A hook chain that never reaches `chat.params` produces
an explicit missing-correlation boundary, never a guessed prompt.

Text correspondence is not causal provenance. A later plugin can remove text
and another source can add identical text. Proving the mutation owner requires
an upstream OpenCode request ID plus origin-tagged prepared-system components or
per-hook diffs.

## Inspection surfaces

All routes require the normal OpenWork client token. Live diagnostic responses
set `Cache-Control: no-store`.

### `GET /experimental/context/registry`

Returns the ordered contributor ID/kind/order, declared tool names, cache and
error policies, gate metadata, and current generic gate result. It never returns
environment values.

### `GET /experimental/connect/context`

Returns schema v1 of the same single bundle requested by the prompt plugin:

- passive steering snapshot resolved for the requested workspace/directory;
- server/account-scoped remote skill instruction and count;
- sanitized diagnostics and generation time.

Passive is the default and does not call OpenCode health. The engine's in-process
`mcp.status` remains authoritative; passive steering is used only when that MCP
entry is absent. Add `steering=active` only for an explicit live health probe,
or `steering=omit` to omit steering entirely.

The route does not write or promote local configuration and inspects runtime
SQLite read-only without creating a file/schema. A catalog cache miss can still
make remote MCP egress: at most four deduplicated candidates share a five-second
deadline, response bodies are capped at 512 KiB, the negotiated MCP protocol is
used, SSE notifications are skipped until the matching JSON-RPC response, and a
created MCP session is closed best-effort with `DELETE`.

### `GET /workspace/:id/config` and `/plugins`

Config distinguishes editable user intent from the read-only managed engine
object. Plugin inventory gives the known partial stage order, preserves visible
shadowing, labels uninspected global/account stages, and uses public labels for
OpenWork core bundles rather than exposing packaged absolute paths. The final
prepared array remains authoritative for the combined effect of all plugins
that actually loaded.

### `POST /workspace/:id/diagnostics/agent-context`

Compares registry-declared OpenWork tools with a bounded effective engine tool
catalog, while keeping recorded registration, passive policy, and direct Cloud
MCP evidence distinct. Unrelated engine tools are discarded before reporting.

## Trace one prompt change

1. Enable Developer Mode for metadata. Send one message.
2. Find `observed system array changed` and copy its `trace` and array `hash`.
3. Filter stderr/DevTools by the trace. Contributor and Connect records identify
   OpenWork decisions without exposing text.
4. Inspect `/experimental/context/registry` and the passive
   `/experimental/connect/context?directory=<encoded-directory>` bundle.
5. If raw content is necessary, separately enable exact tracing, apply the idle
   restart, and send another message. Read the exact block plus
   text-correspondence/unattributed spans.
6. Disable exact tracing immediately after diagnosis and apply the restart.

Current blind spots are deliberate: provider-wire payloads, causal attribution
for native/external plugins, and OpenCode's native skill winner/location are not
claimed by this framework.
