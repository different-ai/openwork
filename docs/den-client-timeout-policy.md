# Den client timeout policy

OpenWork must not invent an availability failure while Den or a Den-connected
server operation is still running. This policy applies to the React app,
Electron shell, and the local OpenWork server boundary used by Cloud MCP.

## Standard

| Operation | Client deadline | Owner |
| --- | --- | --- |
| Interactive Den API request | None | Den and the network transport return the authoritative result. |
| Desktop install-connect preview or exchange | None | Den returns the authoritative result. |
| Cloud session restoration before submission | None | The session request resolves, fails, or is cancelled when app context changes. |
| Cloud MCP health or reconcile request | None | The OpenWork server owns its bounded stage probes and returns structured health. |
| OAuth completion polling | One visible workflow window | The poll loop may stop, but it must not abort or race an in-flight Den request. |
| Best-effort telemetry or sign-out cleanup | A local bound is allowed | Failure must be swallowed and must never become a user-visible Den error. |

Do not wrap an interactive request in `Promise.race`, `AbortSignal.timeout`, or
another caller deadline. Nested deadlines are not cancellation: the outer
caller can report failure while the inner operation continues and may still
mutate server state.

## Current intentional bounds

- Organization MCP OAuth polling stops after 90 seconds. This is a human
  workflow window, not an HTTP request timeout; individual Den polls are not
  aborted.
- Telemetry ingestion stops after 5 seconds. It is fire-and-forget and all
  failures are swallowed.
- Pre-sign-out cleanup yields after 5 seconds so cleanup cannot trap a user in
  a signed-in state. Cleanup failures are swallowed.
- Server-owned Cloud MCP probes use their own bounded stage deadlines and
  return structured failures. The app does not add a competing deadline around
  the overall health or reconcile request.

Asset fetches, local runtime startup probes, and non-Den clients have separate
availability and resource-safety requirements and are outside this policy.
