# Sandbox tools

Tool rollout: `sandboxTools` (cloud and self-hosted, off). Remote availability reuses `sandboxGateway` (off).
Author: `benjaminshafii`.

**Status: design and local microVM adapter foundation only. The tools are not wired into the app.** Turning either
flag on does not enable these new tools today. [design.md](design.md) covers the architecture, prerequisites and
verification plan.

## What changes

The agent gets extra tools next to its usual host shell and file tools:

| Tool | For |
| --- | --- |
| `sandbox_bash` | run a command in the selected sandbox |
| `sandbox_job` | inspect or stop background work |
| `sandbox_read`, `sandbox_write` | read and write guest files |
| `sandbox_preview` | obtain an approved web preview |
| `sandbox_status` | see location, verified grants, mounts, state and jobs |

Setup chooses one execution location:

- **Remote** (the default remote path): use the existing Differently gateway and an approved template/profile.
  Differently chooses the Freestyle/Daytona pool by policy and holds the provider keys. OpenWork has only a
  project-scoped gateway connection, not separate upstream accounts or credentials.
- **This computer**: local microsandbox, in-process, on Apple Silicon macOS or Linux with KVM. No gateway or
  provider key is needed. Differently explicitly does not support microsandbox's embedded runtime.

The workspace starts off until setup is accepted. It never changes execution location because a runtime or gateway
is unavailable. Remote sees no local workspace folder; Local sees only approved mounts, read-only by default.
Network defaults to denied. Required remote isolation/network/preview grants must be enforceable by the gateway;
otherwise the Remote option is unavailable on that connection.

## Flags and failure behavior

`sandboxTools` rolls out the new tool surface. `sandboxGateway` is reused for Remote, which requires both flags.
Local does not require `sandboxGateway`. No duplicate remote-provider rollout or direct-provider setup is added.
Both use the registry's normal member/org/deployment resolution. Den org settings bound each workspace choice;
without an org, use the deployment's `/v1/features` and explicitly configured local/gateway setup.

Gateway down, missing connection, policy refusal, flag off: return unavailable. **No fallback to a direct provider,
local VM or host execution.** Existing Workbot's different fallback behavior is unchanged; these tools do not use
its fallback router. A dispatched command whose result is lost is outcome-unknown, not proof it did not run.

Killing `sandboxTools` stops new admission for both modes; killing `sandboxGateway` stops only Remote, without
switching it to Local. Authorization is checked server-side on each call with at most 60 seconds of verified-policy
reuse. Stop owned sandboxes on revocation/sign-out; retain disks as the documented provider TTL permits.

## Implementation and evidence

- `packages/sandbox-microsandbox`: the new unwired local adapter; run its `test` and opt-in `test:live` scripts.
- `packages/sandbox-differently`: reuse this existing remote adapter. Design section 9 lists its metadata and
  admission gaps and the required Differently-side network/preview/profile work.
- `packages/features/src/flags/sandbox-gateway.ts` and
  [Workbot gateway documentation](../../computer-use/workbot.md#through-a-sandbox-gateway): existing gateway setup.

Watch unavailable reasons, gateway policy refusals, unknown execution outcomes, start latency and uncollected
sandboxes. No guest application-secret injection in v1. No provider keys leave Differently.
