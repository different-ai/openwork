# Local sandbox tools and sandbox-only mode

Feature: `sandboxTools`, cloud and self-hosted, **off by default**. Owner: `benjaminshafii`.
Scope: local microsandbox only. Remote options appear solely as future work below. No production configuration or
rollout is changed by this PR.

## 1. Modes and security boundary

| Effective mode | Agent tools | Failure |
| --- | --- | --- |
| Off, host allowed | Existing host behavior; no additional sandbox tools | Unchanged |
| Extra tools | Existing catalog plus `sandbox_shell/read/write/edit/glob/grep` | Guest failures never call a host implementation |
| Sandbox only | Replace native `shell/read/write/edit/glob/grep` under the **same names**, with exactly those six direct guest tools advertised | A missing/disabled/unverifiable sandbox yields an error; never restore host primitives |

This is **agent-tool confinement**, not a VM for the OpenWork/OpenCode process. Trusted engine internals still read
configuration, maintain history and may perform filesystem bookkeeping. A malicious same-user host process or
trusted installed engine plugin is outside this boundary. Live rw mounts deliberately allow writes to their host
sources; sandbox-only does not mean host files cannot change through authorized mounts. External host watchers
that consume writable files are not sandboxed by this mode. Do not grant writable access to trusted harness,
configuration or installation directories; use readonly/scratch workflows for untrusted changes.

The v2 plugin uses `context.tool.transform`: remove native implementations and install guest replacements, as Pi
removes built-ins with `--no-builtin-tools`. There is no shell-prefix mechanism. The host resolves the mode; neither
model input nor workspace config can grant host access.

## 2. Reuse the existing sandbox contract

```
agent -> v2 registry tool -> authenticated loopback bridge -> server policy + mount plan
       -> @openwork/sandbox -> @openwork/sandbox-microsandbox -> embedded SDK -> msb -> microVM
```

Reuse `SandboxProvider`, `SandboxBlocks`, `SandboxError`, `ensureRunning`, opaque references, scope helpers and
conformance suites. Isolation already includes `microvm`. The internal SDK driver is only an adapter test seam,
not a competing application-facing contract.

The native SDK loads in the server, not a plugin bundle. Local backend selection is pinned; no SDK-hosted cloud
backend can be silently selected. Apple Silicon macOS and Linux KVM are supported targets; Windows remains outside
v1. The Alpine 3.22 guest image is digest-pinned per architecture in `packaged-sandbox-image.json`. Packaged builds
ship a verified OCI archive and import it into a fresh SDK home; missing packaged assets cannot fall back to a
registry download. See [packaged verification](packaged-verification.md) for the distributable acceptance boundary.

Implementation:

- `packages/sandbox-microsandbox`: lifecycle, guest run/files/pause, explicit mount/network options and loopback
  endpoints. No volumes, detached exec, memory restore or secrets capability is falsely claimed.
- `sandbox-tool-host.ts`: UTF-8 guest operations, input/path validation, exact edits, quoted search commands and
  output limits. No host filesystem/process fallback.
- `openwork-sandbox-v2.ts`: replacement/additive catalog, stale-call guards, MCP transform and final inference filter.
- `sandbox-tools-bridge.ts`, `local-sandbox-runtime.ts`: bridge auth, registered-workspace validation, fresh feature
  admission, guest lifecycle and mount reconciliation.
- `sandbox-settings-store.ts`, `managed-desktop-policy.ts`, `sandbox-host-guards.ts`: local preference, verified
  organization authority and guards for host routes that bypass native tools.

## 3. Why Code Mode also needs enforcement

A real Fable session found the initial six-name execution guard blocked Code Mode's outer `execute`, making the
sandbox unusable. Temporarily allowing that outer tool in a diagnostic copy revealed its own `fetch` could reach
the host's loopback, outside guest network policy. That diagnostic change is **not shipped**.

Root fix: sandbox-only registers the six tools with `codemode: false`, removes every other registry implementation,
and filters the final inference context too. Code Mode synthesizes its own `execute` and browser namespaces after
registry transforms, so catalog removal alone was insufficient. Required mode advertises only the six direct tools;
`execute` remains denied, including its host-network interpreter. OpenCode's built-in patch hook also removes
`edit`/`write` for `gpt-*` models after registry transforms. Required mode restores only the validated guest
descriptors on context/generate/compaction hooks; executable registry snapshots still decide whether a tool can
run. This fixes the real Sol failure without enabling host patch or weakening the six-tool assertion.

Execution guards recheck current mode. Previously captured host implementations are wrapped while host mode is
allowed, so a stale snapshot cannot execute the old host shell merely because its ID equals the new guest shell.
Mode transitions reload tools and MCP state or refuse the prompt if the required reload capability is unavailable.
An initial status failure refuses setup rather than guessing host mode; a newly signed-in, never-verified policy
cannot grant host authority, and a known requirement never relaxes on a status error. A previously verified Allow
can retain the existing same-session offline policy; this is not instantaneous offline organization revocation. This can make an unavailable control plane visible as a blocked turn, which is preferable to escape.

## 4. Other host-touching surfaces

Required mode intentionally has a small default-deny supported surface. Before spawning, the native engine receives
supported `OPENCODE_CONFIG_PROJECT_DISABLE=1`, because `.opencode/plugins` and configured project modules execute
host JavaScript before any tool hook. Native regression fixtures prove ordinary discovery really executes those
modules while required startup and later project writes do not. Required mode therefore ignores project
`opencode.json(c)` and project extension discovery; use trusted host-managed provider settings instead.

A live ordinary-to-required transition needs a **new native process**, not merely a tool/config reload. The host
restarts safely as section 6 describes. Legacy bootstrap/command repair, reloads, reaper registration and native
location reads are also guarded: metadata must not initialize an unsafe legacy/project location.

Supported tool surfaces:

| Surface | Decision |
| --- | --- |
| Desktop computer use, scripting, clipboard/files | Block via host `computer-agent-permissions.mjs` and server browser/computer bridges, not just tool hiding |
| Built-in browser | Block: page JavaScript, uploads/downloads and loopback access run on the host, not under guest egress rules |
| Local/stdio MCP | Disable before connection/spawn through the MCP transform |
| Other MCP, including remote | Disable all transports initially. A remote tool can also command the host; no namespace is presumed safe |
| Host files/transfer/office helpers | Remove from required catalog and guard local path APIs, file attachments and fulfillment bridges |
| Patch, worktree mutation, custom tools | Default-deny unless they are one of the six verified guest implementations |
| Delegation | Not available initially; no child task may create a host-capable execution rail |
| Engine HTTP shell/PTY/commands/config/extensions | Host admission denies alternate execution and mutations outside the narrow supported session API |
| Session metadata/context updates | Allow supported text-only native inference/session operations; specifically the app's text instructions-entry update, not file attachments or arbitrary mutations |

Defense in depth: host dispatch denies these operations even if a stale/foreign catalog still names them. Required
server admission checks the pinned engine and active sandbox plugin before inference. OpenCode v1 cannot enforce
this replacement contract and is blocked when sandbox-only is required. Ordinary flag-off/host-allowed behavior
remains covered by the product proof.

## 5. Claude Agent provider: inspect the pinned source, do not infer from the CLI

The pinned engine is OpenCode **2.2.6** (`apps/server/src/opencode-v2-artifacts.json`). Actual upstream source at
[`v2.2.6`](https://github.com/anomalyco/opencode/tree/v2.2.6) was inspected:

- `packages/core/src/plugin/provider/claude-agent/claude/query-options.ts:58–71,98–104`: `tools: []`, empty setting
  sources/skills, strict MCP configuration, disabled configured hooks, and only `mcp__opencode__*` allowed. It
  creates OpenCode's MCP tool server from the supplied definitions.
- `.../claude-agent/tools/server.ts:16–30`: tool calls go through `pending.call`, not native Bash/Read/Edit.
- `.../language-model/convert-claude-stream.ts:93–104`: recognized MCP names become ordinary OpenCode tool calls.
- `packages/core/src/session/runner/step.ts:119–130` and `packages/core/src/tool.ts:121–182,201–319`: transformed
  registry and execution hooks dispatch them.

Decision: **do not block `claude-agent` just for using the user's CLI**. In this integration, advertised calls
traverse the registry and see the replacements. Recheck on upgrades. Live Fable API-provider sessions are distinct
from a live Claude CLI/SDK-provider regression; the latter remains unverified. Unknown integrations with their own
native execution must not be presumed confined by this evidence.

## 6. Controls: local plus organization, stricter wins

> The single "Run tools on this computer" switch described below shipped in the first release. It is now two
> settings, **Use OpenWork Sandbox** and **Force OpenWork Sandbox**; [modes.md](modes.md) is the current contract.
> Force is exactly the `hostExecution: deny` behavior this section specifies, and every guarantee here still holds
> for it. Use is the "Extra tools" row of section 1, now opt-in instead of following the rollout.

Definition in `packages/types/src/den/agent-permissions.ts`:

- Key `hostExecution`, host action `host_execution`, Commands section, toggle **Run tools on this computer**.
- Default `allow` preserves current behavior. `deny` requires sandbox-only. No `ask` variant or allow/block lists
  for a whole-run mode.
- Included in harness keys/actions. **Not added to the engine `v2Action` permission grammar.**

Den's existing member/team agent-permission editor and free-text `permission_key` storage carry the setting. No
new independent provider-policy table. Existing team-versus-Everyone semantics are retained; the effective org
result is then merged with the local preference using `stricterAgentPermissionDecision`. Local Allow cannot undo
org Deny; local Deny is stricter than org Allow.

Settings -> Permissions adds an editable row below Authorized Folders. Local storage is a typed engine-global
SQLite row, never imported from workspace JSON. GET/PUT `/workspace/:id/sandbox-settings` returns local/effective
allow, managed status and feature availability. Writes use the existing collaborator/approval boundary. A corrupt
explicit local preference fails restrictive. A managed requirement locks the row; a direct local-allow request
still cannot weaken the effective org decision.

Saving records desired intent separately from applied local policy. Busy or unknown native activity returns a
successful save with `pending: true`; current tasks retain their applied local authority, while the switch and its
state line explicitly show the saved choice and whether current work can still use this computer. No running task
is killed. New admissions wait behind the pending policy boundary. Safe global activity reads, owned existing-chat
reads and explicit Stop remain available without initializing a new workspace location.

A reconciler automatically applies the saved choice after global sessions/background jobs are idle, refreshing the
native process under the engine fence in either direction. The panel polls until the pending state clears. Cold
startup applies durable intent before spawning. Organization restrictions remain independently strict/live; local
pending intent is never an org-policy bypass. A refresh failure remains restrictive rather than falling back, and
forwarding resolves fresh connection credentials after the fence. Guest scratch can reset during refreshes;
workspace/Authorized Folder bind data remains intact.

The host sends `X-OpenWork-Sandbox-Only: 1` for desktop config. Den filters unknown actions for older clients and
returns conservative known-action denies when a required policy cannot be represented. Old clients have no
read/glob/grep policy action, so this fallback alone is **not a complete guarantee for obsolete desktops**: use
`allowedDesktopVersions`/managed rollout to require compatible clients. This release does not retrofit old binaries.

The Den editor admits new managed restrictions during the rollout; the local UI is offered while the rollout is
on or a requirement already exists. Existing restrictions stay visible and removable when the flag is off.
An explicit privileged local API request can still choose the more restrictive preference while unavailable;
that blocks execution rather than granting a feature or restoring the host. Feature loss never relaxes a requirement: keep guest-only tools that fail unavailable rather
than restore the host. Verified restrictive knowledge is persisted per control-plane/org scope for offline
restart, deliberately conservative across members until a fresh policy is obtained.

Signed-out instances read `/v1/features` from a trusted configured/activated/public Den origin. A failed managed
identity read is not a sign-out or an authorization grant. Restrictive shell/edit/external-folder rules not yet
representable by the guest implementation make it unavailable rather than bypass approvals through a new name.

## 7. Authorized Folders are live binds at unchanged paths

Source: engine-wide runtime `permission.external_directory` in `runtime-opencode-config-store.ts`, written by the
Authorized Folders route in `server.ts`. **Not `config.authorizedRoots`.**

- Mount workspace plus concrete allowed Authorized Folders. Guest path is the model's original absolute path.
  Canonicalize host sources (e.g. `/var` -> `/private/var`) without changing guest aliases.
- Current editor entries are `"/absolute/folder/*": "allow"`. They do not encode ro/rw: OpenCode separately checks
  read/edit permission. Do not invent a readonly enum or treat `ask` as preauthorized read-only access.
- Writable allowed folders bind rw; `config.readOnly` makes every bind ro. Restrictive managed approvals fail closed
  rather than permit writes around their policy. Unknown future value shapes are refused.
- Honor concrete deny/ask exceptions; reject roots, unsupported hidden globs, restricted subtrees reachable through
  a granted parent, and canonical aliases of restricted paths. Resolve missing-path ancestors too.
- Exclude runtime DB/vault state and actual `MSB_HOME`, including ancestor/descendant overlaps. Host rename races,
  hardlink aliases and same-user tampering remain adversarial filesystem concerns, not solved by string matching.

On change, capture the written grants, recompute/fingerprint the mount plan and serialize transitions with tool
calls. Force-destroy revoked instances rather than relying on guest cooperation with graceful stop, then recreate
before use (plain SDK stop/start keeps old configuration). Invalidated tombstones prevent reuse even for A→B→A;
only typed `not_found` is tolerated during destruction, and a failed destroy blocks later calls. The restart receipt
states guest scratch was reset. Live bind contents survive. Unrelated config writes do not restart. Bounded
in-flight work can finish before the queued mount transition; zero-latency descendant cancellation is not claimed.

Account/install/workspace scope plus mount fingerprints prevent reuse across authorities. After server restart,
recreate old stable-name instances rather than adopting unknown old grants. Guest-only scratch persistence across
recreation remains future work; the v1 product is intentionally scratch-oriented.

## 8. Network, credentials and packaging

Pilot network is off; the adapter always sets policy because the SDK's unconfigured default allows egress. Its
optional exact host allow-list requires TLS interception for HTTPS enforcement, with DNS rebinding protection.
Do not claim method/path limits or complete HTTP-only enforcement: raw TCP on allowed port 80 was accepted in a
probe. No guest secret injection in v1. Raw-value SDK secrets persisted in host WAL in experiments, and an echoing
upstream returned them to the guest, so the adapter exposes no secret option.

SDK/native runtime load lazily. Missing KVM, incompatible platform, image error or runtime failure never selects a
host command implementation. `MSB_HOME` must be short on macOS due to Unix socket limits.

The server context-bridge bundle must preserve its host policy/runtime singleton identities. Those host modules
remain external; extension transport retains its bundled AsyncLocalStorage identity. Bun-only SQLite and JSONC
remain external too, avoiding Electron Node eagerly loading `bun:` or unresolved UMD require paths. The product
proof caught both startup and duplicate-policy-cache defects; they are fixed in the bundle boundary.

Release packaging still needs signed/notarized native-addon/helper/library validation on macOS and Linux before
broad rollout. The rollout stays off. The Docker snapshot manifest includes both new server workspace dependencies;
CI's dependency-closure assertion remains unchanged.

## 9. Verification and placement decisions

See [verification.md](verification.md) and the per-model reports.

- Unit/API/native-engine checks cover mode merging, header compatibility, tool/MCP catalog enforcement, host guards,
  old snapshots, mount aliases, readonly behavior, flag loss and guest failure.
- `sandbox-controls.proof.test.ts` exercises the real Den and signed-out Permissions UI, with screenshots and
  per-member negative assertions. `sandbox-only.proof.test.ts` drives real native Electron, local microVM tools,
  unmounted nonce isolation, live edits, unavailable runtime, flag-off host behavior and org-over-local enforcement.
- A separate actual-provider API test checks readonly writes from files and guest shell. There is no fabricated
  readonly UI toggle.
- Real Fable 5.2 and GPT-6.1 Sol sessions run through pinned OpenCode with only the six direct tools. Dev provider
  keys stay in an in-memory loopback inference proxy; engine config receives only a scoped test token. No production
  org/flag is touched. Real-model checks are not substituted for the deterministic UI proof or vice versa.

Daytona's default test sandbox had `/dev/kvm` but the normal user could not open it (PermissionError). The probe
sandbox was deleted. Therefore Apple Silicon macOS runs real microVM/native Electron tests; Daytona runs portable
controls/UI checks. Do not reroute a failed Daytona microVM test into a claimed Daytona pass, and do not claim local
screenshots came from the remote host.

## 10. External protocol and future work

[Prime Radiant](https://blog.primeradiant.com/external-sandboxes-for-coding-agents/),
[protocol revision 1](https://github.com/prime-radiant-inc/external-sandbox/blob/main/PROTOCOL.md), and
[Simon Willison](https://simonwillison.net/2026/Nov/17/) motivate explicit ro/rw mounts, default-deny networking,
host-held secrets and Pi-style replacement. No wire client/server in v1: the existing contract and embedded SDK
provide local lifecycle/run/files without another experimental unauthenticated-loopback API.

Future only: Differently/Freestyle/Daytona remote execution, provider selection and remote credentials. Existing
adapters/gateway rollout remain unchanged. Further work includes durable call-id receipts, guest background jobs,
scoped authenticated previews, scratch retention and strict release packaging. No remote backend is imported by
the local tool implementation.

## Review provenance

The main agent is GPT-6.1 Sol. Independent Fable 5.2 and Sol subagents implemented and tested separate parts; their
real-session results are recorded separately. Early assumptions about Claude CLI bypass and Code Mode safety were
corrected from pinned source and executable witnesses, not by weakening tests. Earlier failures remain recorded;
only final unmodified-product runs support final verdicts. This does not claim the harness itself ran as Fable.
