# Local sandbox tools

Feature `sandboxTools`, cloud and self-hosted, off. Owner: `benjaminshafii`.

**First slice:** local microsandbox adapter, v2 plugin, authenticated bridge and live Authorized Folders mounts.
The full [sandbox-only design](design.md) is specified but its permission controls are follow-ups. No remote
backend or gateway rollout is used.

## What changes

With the pilot rollout enabled for a signed-in organization member, v2 offers `sandbox_shell`, `sandbox_read`,
`sandbox_write`, `sandbox_edit`, `sandbox_glob` and `sandbox_grep`. They execute only through the local guest's
`@openwork/sandbox` run/files blocks. Normal host tools stay available in this pilot: **this is not confinement
of the whole agent**.

The workspace and allowed engine-wide Authorized Folders are live bind mounts at the same absolute paths. The
source is `permission.external_directory` in the runtime row, not `config.authorizedRoots`. Current folder grants
are access permissions, not per-folder write modes. A read-only server creates ro binds; restrictive/unrepresentable
rules fail closed. Managed shell/edit/folder approvals must not be bypassed by new tool names, so the initial pilot
is unavailable while such restrictions exist.

The plugin also implements same-name `shell/read/write/edit/glob/grep` replacement via registry transforms, tested
through an injected mode resolver. The actual host bridge returns only off/additive modes. Do not expose its `only`
mode before the Den/local permission store, host computer/browser/local-MCP blocks and other execution-route checks
in design sections 5–6 and 11 are complete.

## Try the pilot

On a development checkout with Apple Silicon macOS or Linux KVM, install dependencies and build `openwork-server`.
Use the normal registry rollout for `sandboxTools` in a disposable organization; this PR changes no rollout state.
Open a registered workspace with v2, configure Authorized Folders normally, and ask for a sandbox command.
The runtime uses `alpine:3.22`, no network and a 15-minute idle stop. A missing/unsupported native runtime is an
error, never host execution. Use a short `MSB_HOME` on macOS; no automatic runtime install or privilege change.

Runtime folder changes stop the old instance; the next guest call recreates it with the new grants and a restart
receipt. Live host files survive, but guest scratch is reset. Unrelated runtime-row changes do not reset it.
The native-runtime packaging/signing and end-to-end Settings workflow remain follow-ups before broad enablement.

## Turning it off

Off/unverified refuses calls even if the engine still has a listed tool. Refresh/reload removes the additive tool
catalog at the next prompt. Existing host behavior is unchanged in this pilot. Once required sandbox-only exists,
flag loss must block execution rather than restore host primitives; that policy is not reachable yet.

Watch unavailable-runtime/policy errors, create latency, mount-restart receipts and leftover VM disks. Timeout means
an outcome may be unknown, not permission to rerun on the host.

## Evidence

Adapter: `pnpm --filter @openwork/sandbox-microsandbox test` and opt-in `MICROSANDBOX_LIVE=1 ... test:live`.
Server tests: `sandbox-tools.vitest.test.ts`, `sandbox-mounts.vitest.test.ts`, `local-sandbox-runtime.vitest.test.ts`;
real local bridge test: `local-sandbox-bridge.live.vitest.test.ts`. Design sections 10–11 list the remaining product proofs
and exact permission/UI follow-ups. No production or remote provider is exercised.
