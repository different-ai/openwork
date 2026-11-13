# Session and computer MCP events

`nativeMcpEvents` — cloud and self-hosted, **off by default**. Owner: `reachjalil`.

OpenWork publishes owner-scoped lifecycle observations through its authenticated `/mcp/agent` endpoint. This builds on MCP thread events without changing remote-session create/read/send/stop/answer, desktop dispatch, computer provisioning or control, or existing SSE/WebSocket streams.

## Contract

The gateway advertises both the `io.modelcontextprotocol/events` extension and the legacy `events` capability used by ChatGPT. `events/list`, `events/subscribe` and `events/unsubscribe` use the webhook subset of [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) and the [ChatGPT webhook profile](https://developers.openai.com/plugins/build/mcp-events). Poll and push delivery are not advertised. Modern MCP requests include matching `Mcp-Method` and `Mcp-Name` routing headers.

- `openwork.remote_session.status_changed`: exactly one `commandId` or `sessionId`, optionally `states` (`starting`, `running`, `waiting`, `idle`, `error`). Default: waiting, idle and error. Desktop observations reuse reported command state and current remote-access policy; Cloud observations reuse the authorized compact status reader. Observing never enqueues a desktop read or provisions a computer.
- `openwork.computer.state_changed`: `deviceId` of a computer owned by the member, including hosted cloud computers. Observes stored state and lifecycle activity. Viewer activity and ordinary continued-work reports are excluded. Shared computers are outside this first version.

Payloads contain identifiers and compact state only: no transcript, request text, screenshots, input stream or credentials. Events do not grant permission to answer questions, approve permissions or take actions. Read the source for authoritative current details.

## Subscribe and deliver

Enable the flag for a test organization/member, then discover the event catalog with an authenticated MCP token. Subscribe with the advertised name/arguments and `delivery: { mode: "webhook", url, secret }`. The secret is Standard Webhooks `whsec_` plus base64 of 24–64 random bytes. Den signs a fresh verification challenge and requires its exact echo before delivery. HTTPS and public destination addresses are required; addresses are resolved and pinned on every connection and redirects are not followed. The existing explicit private-MCP-URL opt-in allows local development fixtures and private self-hosted deployments.

Subscriptions use a deterministic identity scoped to the organization, user, name, canonical arguments and callback URL. Refresh keeps that identity, clamps TTL to one minute–one hour, and accepts `ttlMs: null` while granting a finite lease. Unchanged credentials reuse verification for five minutes. Rotation verifies the replacement key and dual-signs for five minutes. A failed rotation restores the prior active watch; cancellation wins during verification.

An observer checks sources approximately every five seconds. Changes and outbound receipts commit together. Replicas lease work from the database. Delivery retries preserve the event ID and serialized payload, regenerate the signature timestamp and back off for at most ten attempts. HTTP 410/413 stops that delivery, not the subscription. Pending payloads and secrets are encrypted; payloads clear after delivery, failure or cancellation. Receipts and expired subscriptions are pruned after seven days. `/admin` outcomes count callback/internal-receipt acceptance, not successful model work.

## Hosted chats

Enable **both** `nativeMcpEvents` and `mcpThreadEvents`. The existing chat tools discover and subscribe with `source: "openwork"` instead of a connection ID. Save the person's handling instruction just as for an external event. Internal delivery enters the existing durable receipt queue directly, then uses the same chat binding, current model permissions, stable turn ID and runner queue. No loopback webhook or synthetic MCP connection is needed. Watches of the originating chat itself or its own computer are refused to avoid self-triggering turns. Unsubscribe uses the existing chat tool.

## Limits and rollback

These are **observed changes**, not a complete transition log. Several transitions between checks can collapse; a changed source is baselined at subscription time. There is no replay (`cursor: null`, `truncated: false`), automatic renewal, or recovery of intermediate states during downtime. At most 20 publisher subscriptions per member, 10 watches per hosted chat, and 100 occurrences per finite watch. The event limit or revoked source access terminates the watch. ChatGPT currently does not process termination controls; OpenWork's thread receiver does.

Turning `nativeMcpEvents` off removes discovery/methods and suppresses queued native delivery; the worker stops affected watches. Turning `mcpThreadEvents` off additionally suppresses hosted-chat delivery. Re-enable and explicitly subscribe again. Existing remote sessions, computer controls, external MCP watches and live streams continue through their existing paths. A turn already handed to the runner keeps the normal chat Stop behavior.
