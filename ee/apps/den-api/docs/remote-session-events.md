# Remote session receipt subscriptions

`remoteSessionEvents` is off by default on cloud and self-hosted deployments.
This is a caller-facing optimization, not desktop dispatch. Existing durable
commands, requests, runner polling, and `remote-session:read` remain unchanged
when it is disabled. No Tasks API, queue, sessionful transport, GET stream, or
replay has been added.

When enabled, desktop command/request tool results expose `statusResourceUri`
in `structuredContent`:

- `openwork://remote-sessions/commands/{commandId}`
- `openwork://remote-sessions/requests/{requestId}`

The resource templates are discoverable; receipts are not globally enumerated.
Every read and requested subscription URI must belong to both the authenticated
organization and the creating user. Unknown and foreign receipts have the same
error. Resource reads return JSON with `cacheScope: "private"` and `ttlMs: 0`.
The command receipt carries state and the latest session progress. The request
receipt carries state and the eventual action outcome. Neither carries command
prompts, token material, or ownership identifiers.

## Consumer sequence (MCP 2026-07-28)

1. POST `subscriptions/listen` to `/mcp/agent` with the same authenticated headers
   used for ordinary MCP calls. Use the modern per-request `_meta` envelope,
   `MCP-Protocol-Version: 2026-07-28`, and `Mcp-Method: subscriptions/listen`.
   Request exact URIs in `params.notifications.resourceSubscriptions`.
2. Wait for the SDK's `notifications/subscriptions/acknowledged`. Inspect its
   honored filter, and match its `io.modelcontextprotocol/subscriptionId` to
   the listen request id.
3. **Immediately call `resources/read` for each honored URI.** Include the
   modern envelope and the standard `Mcp-Method` / `Mcp-Name` headers. A change
   may have happened while establishing the subscription.
4. On `notifications/resources/updated`, read that URI again. The notification
   contains only the URI and standard subscription metadata, not a receipt
   payload or an event log. Intermediate states may be coalesced.
5. After a disconnect, reauthenticate if necessary, listen again, wait for its
   acknowledgment, and read current state. There is no `Last-Event-ID` replay.
   Clients without modern subscription support continue polling
   `remote-session:read`.

## Isolation and liveness

The HTTP wrapper authorizes every URI **before SDK entry**. The SDK's modern
listen router bypasses ordinary server request handlers, so a resource read
handler alone cannot secure subscriptions. The SDK retains wire grammar,
acknowledgment, honored filters, subscription ids, and exact URI matching.

Each live subscription polls its owner-scoped shared database snapshots every
2 seconds. A replica sees writes from any other replica without a distributed
event bus. Stable projections suppress heartbeat-only timestamp changes. The
local audience bus is just a delivery adapter; watcher publications are also
scoped to the individual stream to prevent duplicate invalidations for two
same-member subscriptions.

There are at most ten requested URIs and four streams per member **per API
replica**, plus the SDK's process-wide subscription limit. There is no database
polling when a stream is disconnected. Cancellation of either Request.signal
or Response.body tears down timers, the SDK stream, and member capacity.

The same original auth headers are reverified about every 15 seconds. Fresh
membership, grant/session, and feature reads bypass cached liveness. Token
expiry has its own exact-deadline timer. Authorization/database checks have a
5-second timeout; a revoked credential, membership removal, feature kill,
missing receipt, error, or hung check closes the stream fail-closed. This does
not mutate or cancel the underlying work. After a kill, callers can still use
the original status/read capability.

## Verification

`test/remote-session-receipts.test.ts` uses the installed server 2.2 SDK and Node
Fetch streams, injected clocks and scoped stores. It covers real modern wire
acknowledgments, metadata, private reads, URI filtering, owner denial, bounded
streams, heartbeat coalescing, cross-replica snapshots, disconnect/relisten,
feature/auth/database failure, cancellation, and expiry during a hung auth
check. It does not substitute for an authenticated database-backed route
journey after the stacked branch is rebased.

After rebasing onto the target-discovery feature, regenerate both flags with
`pnpm features:sync` (including the Den contract), then rerun the checks on the
combined head before rollout.
