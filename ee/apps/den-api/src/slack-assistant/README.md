# OpenWork in Slack (ENG-62)

Mentions and DMs become turns on the deployment's shared headless runner
(`ee/apps/headless-runner`), run as the invoking member with a member-scoped MCP
token minted per turn. Sessions are keyed by connector, Slack workspace, channel,
root thread, and OpenWork member. Two members in one Slack thread get separate
runner sessions. A deployment without a headless runner (`DEN_HEADLESS_RUNNER_URL`
and `DEN_HEADLESS_RUNNER_TOKEN`) can't enable the assistant: setup says so, and
mentions get a private note instead of a reply.

## Installation

1. Apply Den migration `0115_slack_assistant` before starting the updated API.
2. In `/admin`, find the organization and enable **Capabilities → Slack Assistant**.
   This platform capability defaults off and
   takes effect without a redeploy. The old `DEN_SLACK_ASSISTANT_ENABLED` variable
   is no longer used. Connector opt-in remains required.
3. Configure an eligible Slack MCP connector in **Individual accounts** mode,
   including the existing Slack app's OAuth client ID and secret. Grant access
   using the connector's existing workspace, team, or member controls.
4. In its **OpenWork in Slack** section, merge the generated manifest into that
   same Slack app. Preserve its existing user OAuth redirects, scopes, and MCP
   settings. The agent surface requires Slack's agent APIs to be available.
5. Save the app signing secret, use **Add to Slack**, and enable the assistant.
   Bot installation uses a single-use, ten-minute OAuth state. A Slack workspace
   can belong to only one connector installation.
6. Start with private rollout replies and a small channel allowlist. Members
   complete their own existing Slack OAuth flow. Already connected members must
   reconnect once to establish the assistant identity binding.

The connect card links to Your Connections. Successful member OAuth verifies
`auth.test` using that member's token, binds its user/team identity, and replays
pending invocations received within fifteen minutes. Email is never an identity
source. Membership, connector grants, credential freshness, and the
platform capability are rechecked while processing each turn.

## Delivery and recovery

- HTTPS Events API ingress verifies the timestamp and HMAC over the original
  bytes, checks app/team identity, persists an encrypted event, and acknowledges.
- At most eight events are processed per worker tick. Database leases and thread
  locks coordinate multiple API processes. Set `DEN_SLACK_ASSISTANT_WORKER_ENABLED`
  to `false` on API-only nodes. Worker nodes need the same database/encryption key.
- Empty runner sessions are persisted before sending a prompt. A stable `msg_`
  ID lets the runner deduplicate a retried send. Only assistant messages
  belonging to that turn are streamed. When a thread's saved session no longer
  exists on the runner (`unknown_session`, for example a thread started before
  the runner cutover), the thread forgets it and the same message runs once more
  in a fresh session.
- Streams use Slack `chunks` mode throughout, including Markdown and task updates.
  Delivered answer chunks are checkpointed. Slack closes a streamed message on
  its own after about five minutes (`message_not_in_streaming_state`), so a reply
  continues in a new stream in the same thread after four minutes or 30,000
  characters, or right after Slack closed it early. The Slack session stays in
  progress across streams, so Stop keeps working. Closing text that has no open
  stream is posted as a plain reply.
- Slack Stop cancels the signed actor's running task, including replies moved into a DM.
  Messages the member sent while it ran are kept and start next. A message sent
  while an earlier task runs in the thread gets one reply saying it will be done
  right after, and waiting messages run in the order they were sent.
- Replies are quiet by default: Slack's working status (with its Stop button)
  shows while a task runs, then the answer arrives as one reply, without the
  notes the agent wrote on the way. Admins can turn on "Show progress while
  working" (`progressUpdates`), which applies to tasks started afterwards: steps
  and notes stream live, and tasks then post one line after four minutes
  saying they will report back, an hourly "Still working on it" line, and the
  final answer alone as a new reply that mentions the member.
- Tasks have no time limit and end with their answer, Stop, a failure, or the
  runner's stuck check. The runner
  pauses a long turn every 50 minutes and the read resumes it with a fresh MCP token.
  Transient errors retry up to twenty times; Slack Retry-After is respected. A
  run that gives up logs `slack_assistant_failed` with the error code. Five terminal failures within five
  minutes pause new requests for that installation until the window expires.
- Ingress is limited to 120 events per minute per installation and ten invocations
  per minute per Slack user. The configurable daily limit counts admitted runs
  per member over a rolling 24-hour window.
- Encrypted payloads/checkpoints and dedupe records expire after seven days.
  Pending connect requests expire after fifteen minutes, app context after thirty
  minutes, and unused install OAuth state after ten minutes. Native sessions keep
  their existing retention policy. Deleting a connector removes its Slack data.

## Work handed to the desktop

Den records which Slack run each MCP token was minted for (`slack_assistant_run_token`). When that run calls `remote-session:create`
with target `desktop`, the command is linked to the thread its reply went to
(`slack_assistant_desktop_handoff`); nothing the model sends picks the thread.
A sweep on worker nodes then posts, mentioning the member: the finished answer
(first ~600 characters, with mentions and links escaped), a session failure, an
unclaimed command expiring, or a delivery failure, each once; and "waiting for
you to approve" once per waiting episode. Leases keep several Den instances from
posting twice. Nothing is posted once the assistant is off, the member lost
access, or Slack rejects the thread. A crash between posting and recording the
post can repeat that one message.

There is no atomic transaction spanning Slack and the database. A process crash
after Slack accepts a chunk but before its checkpoint commits can duplicate that
chunk. A crash before an empty session is saved can leave an unused native
session. Stable prompt IDs prevent duplicate agent turns once the session is saved.

## Audience and permissions

The signed event user is the sole actor. The member's token reads thread context;
the bot token only manages the Slack surface. The built-in Slack assistant skill
separates the invocation from untrusted messages, app context, and files, and tells
the agent to cite sources and ask before ambiguous consequential actions.

DMs and `--private` replies stay in the invoker's DM. Channel replies are visible
to the channel. The assistant is instructed to keep private connection data out
of shared replies unless the invoker explicitly asks to share it. This is an agent
instruction, not a content classification guarantee; private rollout should stay
on until the sandbox quality and disclosure checks below pass.

## Verification and rollout

```sh
pnpm --filter @openwork-ee/den-api test
# Use a prepared, isolated database whose name ends in _test.
DEN_SLACK_TEST_DATABASE_URL=mysql://.../openwork_slack_test \
  pnpm --filter @openwork-ee/den-api test:slack:db
pnpm --filter @openwork-ee/den-web typecheck
pnpm sdk:check
```

The tests cover signed ingress, altered/stale requests, bot filtering, all access
gates, OAuth replay, actor isolation, lease recovery, native turn deduplication,
current-turn reads, Stop, approval handoff, feedback ownership, streamed chunk
recovery, and connector deletion. DB journeys use real MySQL with mocked Slack and
runtime services; the native client test uses a local HTTP witness server.

Before production rollout, verify with a real Slack sandbox and Daytona runtime:

- Two members mention the app in one thread; inspect distinct sessions/tokens.
- Stop, reinstall/uninstall, token revocation, and desktop handoff.
- DM and private replies; another person's prompt injection in thread context.
- Long answers, files/permalinks, Slack 429s, runner restarts, and worker restarts.
- A golden set of channel summaries, personal data requests, drafts, and ambiguous
  writes. Check citations, usefulness, and disclosure boundaries.
- A realistic load test. Measure acknowledgement, first text, and completion latency;
  local mock timings are not evidence for the production targets.

The setup screen shows completed, active, unlinked, and failed requests. The setup
API also returns sampled latency medians and feedback totals for the latest 1,000
24-hour events. Logs contain event IDs/timing/error codes, never tokens or content.
Turn off **Slack Assistant** for the organization in `/admin` to stop new routing.
The connector also has an independent assistant toggle. Active runs stop
publishing on the next access check; already running external tool calls cannot
be recalled. Socket Mode, approval buttons, Work Objects, and a separate fast lane
are outside this implementation.

## Slack contracts

- [Native lifecycle and Stop](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/)
- [Streaming chunks](https://docs.slack.dev/reference/methods/chat.appendStream/)
- [Stop events](https://docs.slack.dev/reference/events/agent_session_stopped/)
- [Title changes](https://docs.slack.dev/reference/events/agent_session_title_changed/)
