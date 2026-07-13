# OpenWork Tag for Slack

OpenWork Tag turns an approved Slack thread into a durable shared OpenCode
session. Slack delivery, credentials, policy, deduplication, and run history are
owned by Den. Workspace execution remains on the OpenWork worker selected by an
organization admin.

## Set up

### Managed OAuth installation

1. A Den deployment owner creates one Slack app and grants these bot token scopes:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `groups:history`
   - `groups:read`
   - `users:read`
2. Configure the app with Den's displayed OAuth Redirect URI and managed Events
   endpoint. Subscribe to `app_mention`, `message.channels`, `message.groups`,
   `app_uninstalled`, and `tokens_revoked`.
3. Set `DEN_TAG_SLACK_CLIENT_ID`, `DEN_TAG_SLACK_CLIENT_SECRET`, and
   `DEN_TAG_SLACK_SIGNING_SECRET` in Den's secret manager.
4. In Den, open **Connections → OpenWork Tag**, choose a healthy worker and
   explicit channel IDs, and select **Install with Slack**.
5. Approve the app in Slack, then invite it to every approved channel.

Den signs a ten-minute OAuth state token and stores the setup policy separately
in an encrypted, single-use database row. The callback exchanges the temporary
code with HTTP Basic client authentication, verifies the granted scopes and bot
identity, validates each channel, and only then persists the installation.

When Slack token rotation is enabled, Den encrypts both access and refresh
tokens and refreshes them through a distributed lease before expiry. Concurrent
replicas cannot consume the same one-time refresh token. `app_uninstalled` and
`tokens_revoked` events immediately disable the installation, cancel active Den
runs, and attempt to abort their linked OpenCode sessions.

### Self-managed fallback

If the deployment does not configure the three OAuth variables, Den keeps the
manual setup path: create and install a Slack app, enter its bot token and
signing secret, then copy the connection-specific Events Request URL into that
app. Manual and managed credentials use the same encrypted storage, policy,
queue, session, and audit boundaries.

`DEN_API_PUBLIC_URL` must resolve to the public HTTPS Den API origin. The
`/v1/webhooks/tag/slack/*` path must reach Den without an upstream login or
Access challenge; Slack requests are authenticated in-handler with its HMAC
signature and five-minute replay window.

## Use

- Mention the bot with a request to start work.
- Reply in the resulting Slack thread to continue the same OpenCode session.
  Authorized teammates do not need to mention the bot again.
- Send `status` for the durable run state.
- Send `cancel` to immediately cancel the Den run and abort the linked OpenCode
  session without waiting behind the active request.
- Send `what can you access?` to inspect the current execution boundary and
  immutable policy snapshot hash.
- Send `help` to see the command summary.

Tag posts an accepted state, updates the same Slack message from live OpenCode
todo progress, and replaces it with a terminal result or visible error. Recent
runs in the Den dialog correlate the Slack channel/thread, policy snapshot,
OpenWork workspace, and OpenCode session.

## Security model

- Bot tokens, signing secrets, Slack payloads, prompts, and responses use Den's
  encrypted database columns. Tokens and signing secrets are never returned by
  an API.
- Slack credentials stay in Den and are never included in the worker request,
  model context, or run record.
- DMs are disabled. Channels are deny-by-default. Guests and Slack Connect
  channels are disabled unless an admin explicitly enables them.
- Slack user and channel state are rechecked at execution time. An optional
  user-ID allowlist can further reduce access.
- One `(Slack workspace, channel, thread timestamp)` maps to one durable
  OpenCode session. The thread's service identity, worker, channel
  instructions, and sharing posture are frozen into a SHA-256-addressed
  snapshot.
- Webhook `event_id` values are durably claimed before acknowledgement. Stable
  OpenCode message IDs make ambiguous worker failures safe to retry.
- Connection creation, updates, and deletion emit organization audit events
  without secret values.
- OAuth client credentials remain deployment secrets; they are never stored in
  an organization policy, browser state, OAuth `state`, Slack message, worker,
  or model context.

## Operations and rollback

- Set `DEN_TAG_SLACK_ENABLED=false` and restart Den API to stop new connection
  changes and webhook intake without deleting stored state.
- Disconnecting in Den first asks Slack to revoke the bot token, then removes
  encrypted credentials, pending OAuth setup, channel policy, queued events,
  thread bindings, and run records. Self-managed apps should also remove their
  Request URL.
- Slack `429`, network, and server errors are retried through the durable queue.
  The worker uses the same idempotent session/message recovery path as Den's
  other agent channel integrations.
- Watch Den logs for `[tag] event dispatcher failed`, inspect **Recent execution
  records**, and verify the selected worker remains healthy with live host and
  client connections.

For local conformance tests only, `DEN_SLACK_API_ROOT` can point at a
protocol-compatible Slack Web API stand-in.
