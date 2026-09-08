# Managed response reliability

This change makes the existing OpenWork managed Chat Completions gateway report
broken transport honestly, preserve usable partial work, and stop upstream work
when the client cancels. It does not change model configuration or billing.

## Transport contract

- A complete response retains its text, reasoning, tool deltas, usage and provider
  finish reason. SSE requires terminal choices followed by `[DONE]`; premature EOF
  or malformed framing produces a safe error without a success marker.
- A first frame split across HTTP chunks, UTF-8 bytes or SSE delimiters continues
  reading until it can deliver a frame or a bounded terminal outcome. Backpressure
  remains downstream-controlled.
- Tool-argument validity belongs to the client/tool consumer. A provider's terminal
  `length` response may include truncated arguments; this is not a broken connection.
  The gateway forwards those arguments and usage rather than replacing them with
  an error. It does not execute tools.
- Completion indexes are checked against the requested count (one by default, or
  a positive integer `n`). JSON and SSE share that constraint. Supporting a response
  shape does not promise that any particular managed provider accepts `n > 1`.
- Provider usage frames may repeat a terminal choice without adding output. They
  remain observable without synthesizing duplicate assistant content.

Header and non-streaming body deadlines default to 120 seconds, configured by
`INFERENCE_UPSTREAM_TIMEOUT_MS`. The SSE transport-idle deadline defaults to
120 seconds, configured by `INFERENCE_STREAM_IDLE_MS`. Both accept 1000–900000 ms.
Heartbeats count as transport progress: there is no separate visible-output timer
that cuts off hidden reasoning. JSON buffering is limited to 16 MiB; SSE frame
text is bounded. A buffered partial frame is still subject to idle expiry.

Client cancellation closes the upstream connection, including before the first
complete frame. It cannot guarantee zero provider cost. The gateway never retries
generation or switches model, credential or organization. Client/engine retry
policy is separate.

## Errors, recovery and diagnostics

Safe error categories distinguish provider authorization/rate/quota failures,
context/request rejection, unreachable providers, deadlines and malformed or
unfinished responses. Valid `Retry-After` and the OpenWork request ID are retained.
Provider error bodies and credential-bearing headers are not copied into routine
request diagnostics; request summaries contain counts and known role names, never
prompt, tool arguments or completion text. The organization-specific full-payload
logging exception is removed.

The existing optional task analytics observer receives validated frames and the
actual completion/cancellation/failure outcome. Observer failures cannot interrupt
delivery. First-output latency is recorded when output is emitted, even if a later
frame in the same chunk is malformed.

The recovery UI shows the partial-work warning alongside Resume for managed
interruptions. Ordinary user aborts keep their quiet presentation. Resume remains
an explicit user action; the gateway does not replay work.

## Unchanged boundaries

Authentication, model allowlists, model discovery, request settings, catalog
maintenance commands, saved reasoning selections, provider materialization,
allowance policies, usage settlement and admin resets retain current `dev`
behavior. There are no schema migrations or new runtime imports in the packaged
server. Earlier accounting and catalog proposals are outside this patch; this
change does not claim to repair their underlying limitations.

## Verification

`pnpm evals:pr specs/managed-inference.test.ts` runs the real gateway and OpenWork
server/OpenCode engine against a controlled HTTP provider, with disposable baseline
SQL only for authentication/admission. It checks success, fragmentation, terminal
length responses, choice handling, errors, cancellation, heartbeats, request
preservation and transcript readback. No billing or catalog-delivery claim is made.

`pnpm evals:e2e session-error-technical-details` extends the existing real UI
journey to verify visible warning/Resume behavior and unchanged ordinary aborts.
The existing packaged Desktop smoke remains the packaging gate. Supporting proxy
and rendered component tests do not replace those journey and packaging checks.
Live provider performance, account provisioning and production usage broadcasts
are not certified by deterministic fixtures.
