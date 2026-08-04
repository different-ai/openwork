# Desktop runner for Den-scheduled Automations

## Outcome

Den remains the durable scheduler and source of truth for Automation schedules,
occurrences, leases, notification cursors, ordered events, usage, and terminal
results. Den no longer launches OpenCode or stores an Automation execution
runtime in its container.

An authenticated desktop installation registers as a `desktop` runner and
maintains a Server-Sent Events stream. SSE carries only a wake-up type and a
resumable notification cursor. After connecting or receiving a wake-up, the
desktop discovers work over HTTP, atomically claims one occurrence, and reports
attempt-bound heartbeats, ordered events, cancellation, usage, and completion.

The claimed Automation runs as a normal visible local OpenWork thread in the
desktop's active workspace. It uses the selected model and the same local
OpenCode tool and integration experience as a thread started by the user.

## Offline behavior

Scheduled desktop occurrences have a bounded claim window. If no eligible
desktop claims one before its deadline, Den durably records `skipped` with
`runner_unavailable`; the app displays **Missed — desktop runner unavailable**.
Run now fails immediately with **No desktop runner is online** while no desktop
SSE connection is present.

## Focused proof

The 2026-08-04 packaged macOS candidate was connected to the local Den test
profile and produced both required outcomes:

- `Desktop visible thread E2E 08:45:31` succeeded as a normal sidebar thread,
  with result `DESKTOP_VISIBLE_THREAD_OK`, ordered user/assistant/usage/terminal
  events, and token usage stored in Den.
- `Disconnected desktop final 08:46:51` was not claimed and became the explicit
  missed desktop-runner-unavailable receipt. Run now while disconnected returned
  the explicit no-runner-online response.

## Deferred hardening

Repository-wide suites, cross-platform packaged proof, multi-replica online
presence, exhaustive reconnect/race testing, fault injection, and broader
security review remain follow-up work. A future `sandbox` target can extend the
execution-target contract; it is not implemented here.
