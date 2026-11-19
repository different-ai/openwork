# Local sandbox tools

Feature `sandboxTools`, cloud and self-hosted, **off by default**. Owner: `benjaminshafii`.

## What changes

OpenCode v2 can use a local sandbox on the member's computer. Two settings control it; see [modes.md](modes.md)
for the full contract (labels, storage, policy, API, lifecycle).

- **Use OpenWork Sandbox** (opt-in): adds `sandbox_shell`, `sandbox_read`, `sandbox_write`, `sandbox_edit`,
  `sandbox_glob`, `sandbox_grep` next to the normal tools. Nothing is removed; the agent picks the sandbox for
  risky or isolated work.
- **Force OpenWork Sandbox**: native `shell/read/write/edit/glob/grep` are removed and replaced under the same
  names. All other tools and MCP transports are withheld, including desktop computer use and the built-in browser.
  Force implies Use.

Both off is the default and is the behavior without the feature. A sandbox failure never runs anything on the
computer instead. This is agent-tool confinement, not an OS jail for the trusted engine process. Authorized live
read-write folders intentionally let the sandbox change their files.

## Control it

Settings -> Permissions shows both switches for a single user. In Den, member/team agent permissions let an
admin require Use and/or Force with the same words; the desktop then shows that switch locked with "Managed by
your organization". The stricter of the local and organization choice wins. The settings are engine-global, not
imported from workspace files.

- Use applies on the next message. A sandbox command already offered in the current turn still finishes.
- Force keeps the idle-boundary process restart: saving during a task returns `pending: true` ("Saved. Applies
  when current tasks finish."), current tasks keep their mode, and the change applies automatically when sessions
  and background jobs are idle. A message sent meanwhile gets a neutral note, not an error.
- Turning either on starts preparing the sandbox in the background (image, start, folders) with visible progress,
  then Ready with the folders it can see. It also prepares at app start when a setting is on, and before a message
  runs. Opening Settings never starts it. Failures show a plain message and Retry.
- One sandbox per project is kept by the server across chats and across the restart a Force change needs.

Existing requirements survive rollout loss: the member sees why the sandbox is unavailable and the computer's
tools do not come back. Older desktops: see the capability table in [modes.md](modes.md).

### Settings and status API

`GET`/`PUT /workspace/:id/sandbox-settings`, `GET /workspace/:id/sandbox-status` and
`POST /workspace/:id/sandbox-status/prepare` are specified in [modes.md](modes.md). The GETs answer from local
state: they never wait for the network and never start the sandbox. The first release's
`{ allowHostExecution }` body and response fields are still accepted and returned.

## Folders and runtime

Workspace plus concrete allowed Authorized Folders bind live at their original absolute paths. The source is the
engine-wide `permission.external_directory` row, **not** `config.authorizedRoots`. Current folder grants do not
encode a separate write mode; readonly server mounts are ro, and policies that cannot safely become binds are
refused. Canonical aliases and protected runtime paths are checked before mounting.

Changing grants stops/recreates the guest before reuse and prepares the replacement right away, so the next
command does not pay for it. Host bind contents survive; guest-only scratch is reset, with a restart notice on the
next result. A command queued behind a grant change never runs in a sandbox that still has the revoked folder.
In-flight operations are bounded, not promised instantaneous descendant cancellation.

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
