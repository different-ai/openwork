# MCP thread events

`mcpThreadEvents` — cloud and self-hosted, **off by default**. Owner: `reachjalil`.

A person can ask a hosted Workbot chat to watch a webhook event advertised by a connected MCP server. The chat discovers events, saves the person's handling instruction, and subscribes. Den verifies and retains incoming events before acknowledging them. A worker queues each event into that same chat through the existing headless runner. The runner keeps its ordinary permissions, model authorization, queue and Stop control.

This is a webhook consumer aligned with the [ChatGPT MCP Events webhook profile](https://developers.openai.com/plugins/build/mcp-events), with discovery support for both legacy `events` and the [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) `io.modelcontextprotocol/events` capability. It is not a claim of complete Events extension support. There is no streaming/poll delivery, gateway event publisher, Automations integration, native-provider event adapter, or desktop-local receiver in this change.

## Trying it

1. Run the database migration, configure Den's existing public API URL and headless runner, and enable `mcpThreadEvents` for a test organization/member through the existing feature controls. Hosted HTTPS must be reachable by the provider; local loopback HTTP is accepted for development fixtures only.
2. Connect an MCP server that advertises webhook event delivery. Start a new hosted chat turn with a selected model; its member-scoped turn token receives a trusted thread binding.
3. Ask it to list MCP events, then watch one event with a filter and an explicit instruction, such as summarizing matching document changes in this chat. The tools are `list_mcp_events`, `subscribe_mcp_event`, `list_mcp_event_subscriptions`, and `unsubscribe_mcp_event`.
4. Deliver the server's signed verification challenge during subscribe, then a signed event. The event becomes one new turn in the originating chat. Resending the same event must not add another turn.
5. Ask to stop watching. Further callbacks are refused and pending receipts are cancelled. The normal chat Stop control stops a turn already accepted by the runner; use unsubscribe to end the watch itself.

No callback URL, secret, organization, member or thread id is accepted from the model. Den derives the callback from configured API origin and checks the runner's session owner before subscribing and delivering. Existing per-member OAuth/API-key handling and connection grants are reused. The receiver accepts Standard Webhooks signatures over raw bytes, checks a five-minute timestamp window, validates the remote subscription and event name, and caps the body at 256 KiB. Event content is explicitly identified as untrusted source data beside the saved instruction.

## First-version limits and rollback

Subscriptions last at most one hour (or the provider's earlier `refreshBefore`), with no automatic renewal or cursor replay. There are at most ten active watches per chat and one hundred accepted events per watch. Overflow receives a retryable failure; delivery is not guaranteed after expiry. Ask to subscribe again after expiry. Pagination is supported; subscribe searches up to ten catalog pages.

Turning the flag off hides the tools, refuses callbacks and cancels pending delivery when the worker next evaluates it. It does not interrupt a turn already queued in the runner. Re-enabling does not restore watches the worker has stopped; explicitly subscribe again. Unsubscribe stops locally first and reports whether upstream cancellation succeeded. Provider TTL bounds a watch left behind by a failed cancellation.

Receipts survive Den restarts. A stable event message id lets the runner deduplicate an ambiguous send retry. Delivery retries are bounded to ten attempts with backoff. This does not promise exactly-once model tool side effects. Secrets, filters, instructions and pending payloads use Den's existing encryption. Payloads are cleared on delivery/cancellation/failure. Receipts and expired subscription rows are removed after seven days; token bindings expire with their turn token.

`/admin` feature outcomes count accepted event turns as delivered, pending deliveries, failures and skips, with seven-day coverage. They do not claim successful model completion. The worker logs only a content-free queue availability warning; callback bodies and secrets are not logged. No production rollout is part of this PR.
