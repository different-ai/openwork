# Queue steering contract (#4599 / #4613)

## Scope

The supported claim is native acceptance of a follow-up while a tool is busy,
then execution at the next model step before locally queued follow-ups. It is
not a parallel model call or an implicit interruption of the running shell.

Sources inspected:

- #4613 describes "Busy-session X bypass preserves pending B/C, followed by
  exactly-once FIFO completion" and explicitly does not claim instant-message
  or fast-Stop certification.
- `apps/app/src/i18n/locales/en.ts`: `composer.steer_hint` is "Send now — the
  agent will adjust mid-task"; queued sends wait until the current task finishes.
- `session-surface.tsx`: the shared sender documents mid-run turn acceptance
  for the running loop to pick up. `handleSteer()` calls `handleSend()` without
  aborting the tool. Stop is separate.

## Authoritative witnesses

`unfinished-tool-lifecycle.e2e.test.ts` retains recovery, FIFO, exact-once,
other-session isolation, and lifecycle assertions. Its busy handoff requires:

1. Native acceptance of the exact X text with a nonempty identity:
   - v1: an authoritative native history GET, with user role and message ID.
   - v2: the real native `/api/event` stream's `session.inbox.enqueued`, with
     matching session ID, user payload, and inbox ID.
2. The original native shell is still running in the same observation.
3. B then C remain queued and none of X/B/C has reached the provider yet.
4. The accepted X identity persists exactly once in final native user history.
5. X's actual provider timestamp is at or after the original native tool's
   completion timestamp. The provider sequence remains long-tool, X, B, C.

The inbox ID is not inferred from an optimistic UI row or an empty v2 message.
It comes from the native engine event and is reconciled against persisted
history. Observers perform reads only; they do not submit or fabricate turns.

## Historical stronger claim was disproven

At `2337dae56b7e4256e68864c997fd429d31a210c1`, a stronger assertion required
the provider to receive X while the original shell was still running. Both
engines timed out with X visible, B/C queued, and no provider receipt for X.
Those red receipts remain historical evidence; no engine was fixed or forked:

- `evals/results/.testkit/cli-run-1789056031569.json` (v1)
- `evals/results/.testkit/cli-run-1789056081471.json` (v2)

The current test names and claims deliberately distinguish native acceptance
from provider execution. They do not reinterpret those historical reds as green.

## Workspace-switch proof

The existing switch journey now uses an explicit isolated app-web world:
`QUEUE-01` selects the same-workspace case and `QUEUE-02` the cross-workspace
case, on either engine. Original overlapping tools, queue ordering, per-session
isolation, background draining, and natural-return visibility assertions remain.
No `scrollIntoView` is used by the journey.

The fixture provisions its second workspace through `seed.workspace` using a
host credential from the newly created isolated runtime manifest. That credential
stays inside the fixture; the browser continues using its client token. The
initial 401 from trying a client token on the host API is retained as historical
setup evidence, not bypassed by disabling authentication. Deterministic providers
are configured through the owned engine-global provider API.

This exposed a server reload bug: after one directory refreshed the global
fingerprint, the pool skipped an explicit reload for a stale sibling directory.
The explicit operation route now uses the existing manual-reload path. Automatic
syncs retain fingerprint deduplication; no engine implementation was changed.

## Remaining scope

UI Stop-pauses-queue, parallel execution, and end-to-end unknown-admission fault
injection are not claimed here. Existing unit admission/no-replay coverage is
separate. Cmd/Ctrl+Enter remains platform-selected in this journey.
