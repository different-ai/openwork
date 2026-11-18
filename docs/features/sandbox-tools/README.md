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

Den member/team agent permissions add **Run tools on this computer**. Turn it off to require sandbox-only.
Settings -> Permissions has the same editable local control below Authorized Folders. Effective restriction is
stricter-wins: local Allow cannot undo org Deny. Managed restrictions lock the local switch. The setting is
engine-global, not imported from workspace files. Mode changes safely refresh the native engine before being
acknowledged; busy or unknown activity returns 409 without changing the preference or stopping someone else's task.
Required startup disables project configuration and project extension discovery; a tool reload alone is not enough.

Existing requirements survive rollout loss: the member sees why the sandbox is unavailable and host tools do not
come back. Older desktops get conservative compatibility rules; use managed version constraints for organizations
requiring complete confinement, because old binaries cannot enforce new read-tool restrictions.

## Folders and runtime

Workspace plus concrete allowed Authorized Folders bind live at their original absolute paths. The source is the
engine-wide `permission.external_directory` row, **not** `config.authorizedRoots`. Current folder grants do not
encode a separate write mode; readonly server mounts are ro, and policies that cannot safely become binds are
refused. Canonical aliases and protected runtime paths are checked before mounting.

Changing grants stops/recreates the guest before reuse. Host bind contents survive; guest-only scratch is reset,
with a restart receipt. In-flight operations are bounded, not promised instantaneous descendant cancellation.

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
Proofs: `evals/proofs/sandbox-only.proof.test.ts` (native Electron/real microVM on Mac) and
`sandbox-controls.proof.test.ts` (portable Den/Settings UI). Real readonly provider checks supplement the UI proof.
Daytona had no usable KVM access for its default user, so microVM proof is explicitly local.

Remote sandbox backends and guest secret injection are future work only; no gateway flag or remote routing changes.
