# Den and Cloud operation deadline policy

OpenWork uses operation deadlines only where it can cancel the work it starts
and explain the outcome to the user. There is no global Den HTTP timeout.
Ordinary Den calls may take as long as their owning product flow permits.

## Why this exists

PR #957 introduced a 12-second timeout around every Den client request while
adding the first desktop Den session bootstrap. The code and PR history do not
record a Den-specific service limit. The surrounding behavior shows the goal
was to prevent a failed or unreachable control plane from leaving the desktop
in an indefinite loading state.

That guard later became unsafe for two reasons:

- the renderer used `Promise.race`, so it could report failure while Electron
  main and Den continued processing the request;
- newer workflows added independent 10-, 12-, 60-, and 120-second bounds, so
  an outer timer could expire before the server's intentional retry or probe
  sequence had finished.

The replacement preserves the original UX goal at the workflow boundary,
where the app knows what the user is waiting for, while allowing unrelated or
long-running Den calls to complete normally.

## Standard operation budgets

The product source of truth is `@openwork/types/operation-deadlines`. The
standalone Electron connect-link module mirrors the 35-second handoff value
because packaged Electron code has no runtime workspace-package dependency;
`connect-link.test.mjs` asserts the mirror matches the policy source.

| Operation | Budget | Purpose and owner |
| --- | ---: | --- |
| Den session restoration | 35 seconds | Bounds the startup `checking` state. Failure becomes signed-in service unavailable; it does not become signed out. |
| Install-connect preview | 10 seconds | Read-only lookup that fills the connect confirmation dialog. Short because the user is staring at an empty dialog, and freely retryable because nothing is consumed. |
| One-time desktop handoff or install-connect exchange | 35 seconds | Bounds the visible sign-in/connect action. A stable request ID makes a retry recover the committed result safely. |
| One Cloud MCP server health or reconcile operation | 60 seconds | Lets the server complete bounded engine registration, polling, and health probes. The server returns `cloud_mcp_deadline_exceeded` when this budget is exhausted. |
| One Cloud MCP client transport | 65 seconds | Gives the server five seconds to return its structured 60-second result. It is not an independent product retry window. |
| Complete pre-send Cloud MCP preparation | 135 seconds | Covers one health check, one one-second delay, and one repair. No further client retries run. |

The ordering is intentional:

```text
5-second stage probe < 60-second server operation < 65-second transport
2 transports + 1-second repair delay <= 135-second submission workflow
```

Do not add another timeout around one of these operations. Extend the owning
workflow budget when the product requirement changes, and keep every inner
budget strictly smaller than its caller.

## Cancellation contract

Deadlines and context changes use the same `AbortSignal` from the workflow to
the work:

1. The React submission coordinator aborts when the workspace/model changes
   or the component unmounts.
2. The OpenWork client forwards the signal to fetch and keeps the absolute
   deadline through response-body parsing.
3. Electron assigns the request an ID. Renderer cancellation invokes the
   matching main-process cancellation command, which aborts `electronNet.fetch`.
4. The OpenWork server combines client disconnect with its 60-second operation
   signal and passes it to engine registration, polling, SDK probes, Cloud MCP
   endpoint fetches, and response parsing.

Stopping the UI wait without cancelling the underlying request is not allowed.

Each budget has exactly one timer owner. When a workflow passes its signal
down, the callee must not mint a second timer for the same budget; the signal
already carries both the deadline and cancellation.

When the deadline elapses inside the Electron main proxy, main rejects with
the `openwork_desktop_fetch_deadline_exceeded` marker
(`DESKTOP_FETCH_DEADLINE_EXCEEDED` in `@openwork/types/desktop-ipc`). Clients
classify deadline failures from that marker or their own timeout signal —
never from wall-clock arithmetic — so caller cancellation and network failures
keep their own errors.

This contract relies on `AbortSignal.any` and `AbortSignal.timeout`
(Chromium 116+ / Node 20.3+ / Bun 1.1+ / Safari 17.4+ / Firefox 124+). The
packaged desktop app and the OpenWork server clear this floor; keep it in
mind if the web bundle must support older browsers.

## Retry and mutation rules

- A submission performs one read-only health check followed by at most one
  reconcile repair. Server polling is part of that repair and is not another
  client retry.
- One-time grant exchanges are retryable only with a stable idempotency ID.
  Den stores only its SHA-256 hash and returns the original claims/session for
  the same grant and ID. A different ID still receives the replay error.
- A deadline means "the operation did not produce a result in its supported
  window," not "Den is down" and not "the user is signed out."

Best-effort telemetry, sign-out cleanup, OAuth polling, local runtime probes,
and large file transfers have separate product semantics. Their existing
bounds are not Den availability policy and must not be reused for interactive
Den or Cloud MCP work.
