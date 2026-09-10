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

## Remaining scope

Cross-workspace/background draining and the natural return viewport are not
certified by this same-workspace scenario. The forced tool scrolling was removed
and the natural viewport assertion remains in the existing switch journey.
An attempted explicit web port encountered fixture provisioning limits: desktop
workspace creation did not select a second workspace on web, and the native
second-workspace API rejected the fixture's non-owner token with 401
`Invalid host token`. That port is separate from the scoped steering proof.

UI Stop-pauses-queue, parallel execution, and end-to-end unknown-admission fault
injection are not claimed here. Existing unit admission/no-replay coverage is
separate. Cmd/Ctrl+Enter remains platform-selected in this journey.
