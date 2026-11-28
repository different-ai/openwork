# Cloud Automation runtime limits

`automationHourRuntime` lets an owner explicitly change the saved runtime of a Cloud **agent** Automation, up to 60 minutes. It is off by default on cloud and self-hosted deployments. Owner: `benjaminshafii`.

## Scope and operation

With the feature enabled for the organization/member, send `PATCH /v1/automations/{id}` with `{"maximumRuntimeMs":3600000}`. The existing owner and organization checks apply. Values must be integer milliseconds between 10,000 and 3,600,000. Desktop Automations and saved Workflow actions reject this setting. A Cloud Automation with a limit above 15 minutes cannot be moved to Desktop, run once on Desktop, or changed to a saved Workflow. Lower its Cloud limit to 15 minutes first; this also applies while the feature is off.

A changed limit creates an immutable revision and contributes to its digest. The response, list, and existing Automation detail runtime display use the saved value. Already-created runs stay pinned to their original revision. Sending the same value again does not create another revision. Omission preserves the saved value, including when an older client edits the name or instructions.

Creation still defaults to 15 minutes. No existing Automation is upgraded automatically; no data migration or environment change is needed. Copying a shared Automation continues to create a new definition with the creation default.

A platform admin must enable the feature before a person can change this setting. Enabling it does not itself authorize any Automation run or connector write. A longer runtime allows more model/tool spending and keeps a concurrency slot occupied longer, potentially four times as long as the default. It does not change the action's authority, schedule, overlap behavior, or retry policy.

## What turning it off does

The kill switch refuses further runtime edits. It does not rewrite saved revisions, shorten in-flight runs, or alter historical receipts. Ordinary edits remain available. To lower a saved limit, explicitly save the desired value while the feature is enabled, then disable it. Runs already admitted retain their pinned revision.

## Deadlines that stay separate

- Both Cloud agent executors consume the revision's `maximumRuntimeMs`. Headless enforces a total timer starting before session setup; the Web-computer executor's outer deadline includes worker startup. Headless cancellation may need up to another 15 seconds to confirm the remote turn stopped; an unconfirmed stop is a failure requiring inspection, not an automatic retry.
- Cloud leases remain 60 seconds by default, renewed at most every 10 seconds. Lease expiry detects a lost executor; it is not a 15-minute runtime ceiling. Desktop claim windows are unrelated.
- The headless runner defaults to no engine-wide turn-time or step-count cap. An operator's `HEADLESS_TURN_TIMEOUT_MS` or `HEADLESS_MAX_STEPS` override can still terminate a run earlier. Check deployment configuration before promising an hour of execution.
- Headless repeated-result waiting is limited to one third of the runtime: 20 minutes for a one-hour run, versus five minutes at the default. Three identical failures are still the limit. A stuck polling loop can end earlier than the total budget.
- Headless run credentials remain capped at one hour; interrupted credential stretches resume the same message with fresh credentials. There is no token-TTL extension.
- Model requests/idle streams (180 seconds), headless MCP calls (120 seconds), Den capability calls (180 seconds), worker readiness (120 seconds), and worker requests (15 seconds) remain bounded separately. An hour-long agent can make many short calls; no single hung call gets an hour.
- A saved Workflow has its own 120-second default and 170-second cap. This feature does not extend it. `DEN_AUTOMATIONS_RUN_TIMEOUT_MS` is not consumed by these executors and does not override saved revision limits.
- The executor budget is per execution attempt, not a durable elapsed-time cap across recovery/re-entry. This change does not alter recovery semantics or guarantee successful completion.

## Verification and observation

Run from `ee/apps/den-api` with local MySQL available:

```sh
node --conditions=development --import tsx --test test/api/automation-runtime.api.test.ts
node --conditions=development --import tsx --test test/automation-runtime.test.ts
```

The API check boots Den against a disposable database and covers flag-off rejection, owner isolation, revision pinning, digest changes, bounds, preservation, and explicit lowering. The executor check uses an injected runner transport and a simulated clock: work continues beyond 15 minutes, an interrupted turn obtains fresh credentials under the same message ID, work can finish after 20 minutes, and a running turn is aborted at 60 minutes. It also verifies the unchanged 15-minute case. No live connectors or models are called; simulated time is not a wall-clock endurance test.

After an authorized rollout, inspect run receipts for `execution_timed_out`, `lease_lost`, connection/model errors, duration, and queue pressure. A timeout is not evidence that connector writes were rolled back. Inspect retained step/provider evidence before deciding whether a retry is safe. Timeout paths may retain only the terminal event, so missing steps do not prove no side effects occurred.
