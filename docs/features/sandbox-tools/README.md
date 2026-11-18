# Local sandbox tools

Feature `sandboxTools`, cloud and self-hosted, **off by default**. Owner: `benjaminshafii`.

## What changes

OpenCode v2 can use a local microsandbox microVM in two ways:

- Extra tools: `sandbox_shell`, `sandbox_read`, `sandbox_write`, `sandbox_edit`, `sandbox_glob`, `sandbox_grep`.
- Sandbox only: native `shell/read/write/edit/glob/grep` are removed and replaced under the same names. All other
  tools and MCP transports are withheld initially, including desktop computer use and the built-in browser.

A sandbox failure never executes a host implementation. This is agent-tool confinement, not an OS jail for the
trusted engine process. Authorized live rw bind mounts intentionally let the guest change their host files.

## Control it

Settings -> Permissions begins with **Where the agent runs commands**: **On this computer** or **In a sandbox
(isolated)**. The sandbox choice requires the six guest replacements. Its one explanatory sentence connects it to
**Folders the sandbox can see** below; actual enforced access is shown beside each folder. The ordinary folder list
is still Authorized Folders when computer execution is selected. A quiet Sandbox indicator in chat follows applied
execution authority, not a pending personal choice.

Den member/team agent permissions use the same execution-location words. Everyone can leave **Member chooses**;
teams follow Everyone's actual value unless changed, with the existing **Use Everyone's** reset. Explicit managed
computer and sandbox choices are read-only in the desktop with **Managed by your organization**. Restriction remains
stricter-wins: an organization computer choice never silently relaxes a stricter device sandbox requirement. That
case keeps the effective sandbox selection locked and says the stricter device choice is kept.

The preference is engine-global, not imported from workspace files. Saving during a task persists desired intent and returns
200 with `pending: true`: “Saved. Applies when current tasks finish.” Current tasks keep the applied local policy,
including subsequent tool calls in the same turn; organization denials remain live and strict. New native admissions
are refused while the desired/applied policy or native process isolation differs. Existing session metadata/messages,
global activity/job snapshots, and explicit Stop (`POST /api/session/:id/interrupt`) remain available through global
native APIs without initializing a caller-supplied location. Session access still verifies its persistent workspace
home. Cold location metadata/configuration remains blocked. No task is automatically canceled. A global
session-and-background-job idle check automatically refreshes the native process in both directions, without another
save or message. Unknown activity remains pending rather than authorizing a restart. Required startup disables
project configuration and project extension discovery; a tool reload alone is not enough.

### Settings API

`GET` and `PUT /workspace/:id/sandbox-settings` describe the engine-global setting (the workspace path scopes access,
not the preference). PUT still accepts exactly `{ allowHostExecution: boolean }`, with existing approval and audit
checks. Both responses retain `allowHostExecution`, `effectiveAllowHostExecution`, `managed`, and `featureEnabled`,
and add `pending: boolean`, managed-choice provenance (`managedMode`, `deviceRestricted`), actual `folderAccess`,
and an optional `runtime` observation. `allowHostExecution` is durable desired local intent; `effectiveAllowHostExecution` is the
applied host policy, bounded by native process isolation and live organization authority, including tasks allowed to
finish under the previous local preference. During
a local disable, `false / true / pending: true` is intentional, not an authorization grant for a new turn. During a
local enable, `true / false / pending: true` means the reverse transition has not yet applied. Clients poll while
pending and render personal radio choices from desired intent, never from the old process's permission. Managed
choices display the effective restriction and remain read-only. Older synchronous hosts
omit `pending`; the client treats that as false.

Desired and applied local preferences are separate host-owned runtime database rows. Cold startup installs desired
intent before spawning a fresh native process. During a running process, only its verified global idle boundary
advances applied intent; failed refreshes never fall back to a host engine. Feature-off ordinary mode stays ordinary;
a saved or managed restriction is not cleared by rollout loss.

The desktop section is hidden when the rollout is off, as requested; this is visibility only. Existing requirements
survive rollout loss and host tools do not come back. Older desktops get conservative compatibility rules; use managed version constraints for organizations
requiring complete confinement, because old binaries cannot enforce new read-tool restrictions.

## Folders and runtime

Workspace plus concrete allowed Authorized Folders bind live at their original absolute paths. The source is the
engine-wide `permission.external_directory` row, **not** `config.authorizedRoots`. Current folder grants do not
encode a separate write mode; readonly server mounts are ro, and policies that cannot safely become binds are
refused. Canonical aliases and protected runtime paths are checked before mounting.

Changing grants stops/recreates the guest before reuse. Host bind contents survive; guest-only scratch is reset,
with a restart receipt. In-flight operations are bounded, not promised instantaneous descendant cancellation.

`POST /workspace/:id/sandbox-prepare` idempotently starts or retries the real shared guest. It acknowledges asynchronously;
GET reports `idle`, `starting`, `ready`, `unsupported`, or `failed` without creating a guest. Starting uses two measured
steps (bundled-file preparation, then guest startup), not a fictitious image download. The image is bundled and
pinned. Unsupported installations give a plain recovery action; genuine guest failures offer Retry. Expected file,
edit, or readonly errors do not mark a healthy sandbox as failed. A real guest-health inspection distinguishes them.

Use Apple Silicon macOS or Linux KVM, a short `MSB_HOME` on macOS, and the normal feature registry for rollout in a
disposable test organization. No production rollout is changed here. Missing runtime/image/hypervisor support is
an error. Native release signing/packaging still needs validation before broad enablement.

## Turning it off and watching it

Off with host allowed preserves normal behavior. Off while sandbox-only is required keeps the requirement and
refuses guest execution, rather than silently restoring the host. Watch policy/runtime errors, mount recreation,
unknown execution outcomes and leftover VM disks.

The pinned Claude Agent integration disables native CLI tools and sends advertised tools through OpenCode's
registry; do not block it merely by provider name. Live API-provider tests and source verification are distinct
from a live Claude CLI/SDK-provider test, which remains unverified.

## Evidence

[Design](design.md), [verification](verification.md), [Fable](model-check-fable.md), [Sol](model-check-sol.md).
Those original source-run results do not establish packaged availability. See the
[packaged repair acceptance boundary](packaged-verification.md) for the distributable regression and final build evidence.
Proofs: `evals/proofs/sandbox-only.proof.test.ts` (native Electron/real microVM on Mac) and
`sandbox-controls.proof.test.ts` (portable Den/Settings UI). Real readonly provider checks supplement the UI proof.
Daytona had no usable KVM access for its default user, so microVM proof is explicitly local.

Remote sandbox backends and guest secret injection are future work only; no gateway flag or remote routing changes.
