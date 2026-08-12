# Creation-owned Automation runtime placement

## Outcome

The surface that creates an Automation owns its execution placement for the
Automation's lifetime:

- Desktop creation produces a `desktop` Automation and continues to use the
  authenticated desktop runner introduced by the existing Automations work.
- Web and Cloud Chat creation produce a `cloud` Automation. Den schedules the
  occurrence, wakes the owner's existing OpenWork Cloud container when it is
  stopped, and runs a native OpenWork thread headlessly inside that container.

Both surfaces read the same Den Automation and run history. Placement is shown
on list cards and receipts, but it is not an editable setting. Moving execution
between Desktop and Cloud requires creating a new Automation on that surface.

## Cloud lifecycle

A Cloud agent run reserves and persists its worker, workspace, native thread,
and deterministic user-message identity before it submits the prompt. Lease
recovery reattaches to that thread and observes-or-submits that exact message
instead of starting duplicate work. Den heartbeats the run while it waits,
requires an observed idle state after forwarding cancellation, records native
assistant/tool events and usage, and keeps active Cloud runs out of idle-stop
selection. Run deadlines include container wake-up and request admission.

Cloud creation requires the current owner to have an existing per-user Cloud
worker and an authorized model. It does not silently allocate a new Cloud
environment. A stopped worker is valid and is woken at execution time; a
missing or failed runtime is recorded as a durable failure and moves the
Automation to needs-attention. Timeouts are terminal receipts rather than
automatic retries because an agent may already have produced external side
effects; the user can inspect the native run and choose Run now explicitly.

Before prompt admission, Den probes and repairs the worker's persisted
`openwork-cloud` MCP registration for the selected model. A missing Connect
configuration or model projection becomes durable needs-attention rather than
a headless run that silently lacks the user's connected services.

The native thread client uses both the collaborator token and the internal
host credential when it passes through the Cloud worker proxy. No provider
credential or worker token is copied into the Automation receipt.

## Relationship to saved Script Automations

Saved Script Automations from the Dynamic Artifacts work remain Cloud-owned
and keep their existing Den Code Mode executor. This feature adds ordinary
agent actions as a second Cloud execution kind; it does not change Script
snapshot validation or artifact result retention.

## Verification boundary

Focused tests cover the Cloud-only MCP creation contract, deterministic prompt
admission, terminal errors, cancellation observation, dual worker credentials,
Cloud wake/idle lifecycle behavior, runtime-specific agent guidance, and
cross-surface execution labels. Den Web provides once/daily/weekly create and
edit flows plus activate/deactivate, archive, run-now, cancel, native thread,
usage, and event receipt controls. The testkit acceptance tape covers the
Web/Desktop creation language and verifies that no placement picker is exposed.

The deployment-shaped Daytona journey—stop a real user's container, let a due
occurrence wake it, execute against live model and Connect configuration, then
observe idle shutdown again—remains required for the production rollout and
merge decision. It is intentionally not claimed by local or mocked proof.
