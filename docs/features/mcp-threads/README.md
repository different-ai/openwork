# Threads over MCP

`mcpThreads` — cloud and self-hosted, **off by default**. Owner: `reachjalil`.

A person can start, follow and answer OpenWork sessions from any MCP client, and the client hears about a session's changes through MCP Events instead of polling its status. This builds on [session and computer MCP events](../native-mcp-events/README.md) (`nativeMcpEvents`) and [MCP thread events](../mcp-thread-events/README.md) (`mcpThreadEvents`). It changes nothing about how a session runs: create, send, read, stop, answer, desktop dispatch and the status call keep their behavior.

## What the flag adds

| With | What changes |
| --- | --- |
| `mcpThreads` | Clients other than OpenWork's own (Claude, ChatGPT, any other MCP client) list the remote-session actions as tools of their own: `remote_session_create`, `_send`, `_read`, `_status`, `_stop`, `_list`, `_targets`, and `_answer` / `_attach` where those are allowed. Each runs the same capability as `execute_capability`, with the same grants, scopes and audit. |
| `mcpThreads` + `nativeMcpEvents` | A successful create or send names the event to follow: `event: { name: "openwork.remote_session.status_changed", arguments: { commandId or sessionId }, delivery: ["webhook", "poll"] }`. The event catalog offers poll delivery, and `events/poll` answers it. |
| all three flags | A hosted chat that starts or continues a session is watched at once. The result carries `watch: { id, expiresAt }` and tells the model to end its turn. When the session finishes, fails or needs an answer, the chat gets one new turn. |

OpenWork's own chats keep capability search: the nine tools would add to every turn's tool list for no gain.

## Poll delivery

`events/poll` follows the poll mode of [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415): `{ name, arguments, cursor }` in, `{ events, cursor, truncated, hasMore, nextPollMs }` out. It is for clients that cannot receive a webhook.

Den keeps nothing per client. The cursor is the state the client last saw, so each poll reads the source once and reports a change since then. A first poll (`cursor: null`) returns no events and a cursor. A cursor from another subscription starts from now with `truncated: true`. `nextPollMs` is 5000, the same interval as the publisher's own observer. A retried poll returns the same `eventId`. Polls are limited to 120 a minute per member and need no write scope, since they change nothing.

As with webhook delivery these are observed changes, not a transition log: several changes between two polls collapse into one event, and a state outside the subscription's `states` (default waiting, idle and error) advances the cursor without an event. The payload is state and identifiers only; read the session for its result.

## Hosted chats

The watch is the one the chat's own `subscribe_mcp_event` tool makes with `source: "openwork"`, with a fixed instruction: read the session, then tell the person its result, its error or the question it waits on, and ask before answering a question or approving a permission. The same limits apply: one hour, ten watches per chat, one hundred events per watch, no renewal. A follow-up to a session the chat already watches reuses the watch.

Starting the watch never fails the create or send. When it cannot start (ten watches, a session not readable yet, the runner away), the result is unchanged and the chat follows the session with `remote-session:status` as before. A Slack run is left alone: OpenWork already posts its result in the thread.

## Trying it

1. Turn on `mcpThreads` and `nativeMcpEvents` for a test organization, and `mcpThreadEvents` for the hosted-chat part.
2. From an outside MCP client connected to OpenWork, list tools: the `remote_session_*` tools appear. Start a session and check the result's `event`.
3. Poll `events/poll` with that name and arguments, first with `cursor: null`, then with each returned cursor. An event arrives when the session goes idle, waits or fails. A client with webhook support subscribes with `events/subscribe` instead.
4. In a hosted chat, ask it to run a task on one of your computers. The chat says the task started and ends its turn. When the task settles, the chat reports the result in a new turn.

## Limits

- No push delivery (`events/stream`). A client needs webhook or poll support in its MCP client; a model cannot poll by itself, so a client with neither still uses `remote-session:status` with `waitMs`.
- A task that runs longer than the one-hour watch reports nothing after it expires. The result says when the watch ends.
- The observer still checks each watched session about every five seconds. Sessions on OpenWork Cloud report no state change to Den, so this cannot yet be driven by the write itself.
- Shared computers are outside this version, as for the events it builds on.

## Rollback

Turning `mcpThreads` off removes the tools, the `event` and `watch` fields, poll delivery and the automatic watch. Watches that already exist stay until they expire or are unsubscribed, and deliver through the two event features as before.
