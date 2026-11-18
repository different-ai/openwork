# Local sandbox tools and sandbox-only mode

Revised 2026-11-17. Feature: `sandboxTools`, cloud and self-hosted, **off**. Owner: `benjaminshafii`.

**Scope:** local microsandbox only. This supersedes earlier gateway/provider-routing designs. The PR restores the
existing gateway flag and Workbot docs unchanged. No remote backend or provider credentials are added.

**Delivery boundary:** this PR implements the adapter, local tool host, authenticated bridge, v2 plugin and live
mount planning. It exposes only the additive pilot through a verified org rollout. The plugin's same-name
replacement mechanism is implemented and tested, but **sandbox-only is not exposed as a product setting yet**.
The policy/UI and host-escape controls below must land together before that setting can be enabled. The user
explicitly allowed this first-slice delivery; follow-ups are listed in section 11 and the PR body.

## 1. Two local modes, one flag

| Mode | Tool catalog | Host execution |
| --- | --- | --- |
| Off | Existing catalog | Unchanged |
| Extra sandbox tools | Add `sandbox_shell`, `sandbox_read`, `sandbox_write`, `sandbox_edit`, `sandbox_glob`, `sandbox_grep` | Normal host tools remain; this is not agent confinement |
| Sandbox only | Remove native `shell/read/write/edit/glob/grep`; install guest implementations under those exact names | No host implementations of those IDs, no shell prefix and no fallback; other execution rails must also be blocked as section 5 specifies |

The plugin uses `context.tool.transform(editor => editor.remove(id))`, following
`openwork-agent-permissions-v2.ts`, then registers sandbox implementations. Validate all schemas before modifying
the catalog: an invalid replacement must abort rather than silently leave a host tool behind. Reload on prompt
when mode changes, but verify mode and authorization before **every execution**, including stale catalog calls. Additive status outages withhold sandbox tools without
breaking unrelated prompts; a previously required-only catalog must never restore host primitives on a status error.
A missing/unavailable sandbox produces an error. Never restore host primitives as error recovery.

The first-slice bridge can return only `off` or `tools`, not `only`. No renderer, environment variable or workspace
file can enable replacement mode through this bridge. Tests exercise `only` through the plugin's dependency seam;
that is not a claim that full sandbox-only security has shipped.

`sandboxTools` is the sole feature gate. No additional backend/gateway flag. Off/unverifiable denies sandbox calls.
When full sandbox-only is required, killing the rollout must **not re-enable host execution**: refuse new agent
turns with an actionable error until the requirement is removed or the rollout/runtime is restored.

## 2. Existing abstraction and code path

```
v2 engine plugin (registry tools)
  -> authenticated loopback sandbox bridge
    -> OpenWork server: rollout + workspace + mount-plan validation
      -> @openwork/sandbox contract
        -> @openwork/sandbox-microsandbox
          -> native microsandbox SDK -> local msb child -> Linux microVM
```

Use existing `SandboxProvider`, `SandboxBlocks`, `SandboxError`, opaque references, `withBlocks`, `ensureRunning`,
`sandboxName` and the conformance suites. Isolation already includes `microvm`. The internal SDK driver in the
adapter is a test seam, not a second application-facing provider contract.

Plugin bundles cannot carry the native runtime. The SDK loads lazily in the host server. The engine receives only
a scoped loopback credential, never host API tokens or sandbox-provider credentials. The bridge does not expose
host shell or filesystem operations. Unsupported platforms/runtime errors remain errors.

Implementation files:

- `packages/sandbox-microsandbox/`: existing shared-contract adapter; explicit network, mounts, lifecycle, guest
  run/files/pause, loopback endpoint support; no SDK-hosted backend selection and no secrets option.
- `apps/server/src/sandbox-tool-host.ts`: bounded guest command/read/write/edit/glob/grep implementations.
- `apps/server/src/opencode-plugins/openwork-sandbox-v2.ts`: additive or same-name replacement transform.
- `apps/server/src/sandbox-tools-bridge.ts`: authenticated server-side API, rejects browser Origins and unknown
  operations; validates the engine's workspace directory against registered workspaces.
- `apps/server/src/local-sandbox-runtime.ts`: local lifecycle, scope, mount refresh, serialized operations and
  fail-closed feature access. It imports neither remote adapters nor a host command executor.
- `managed-opencode-v2.ts`, `engine-v2-preview.ts`, `opencode-v2-context-bridge.ts`: plugin loader and bridge wiring.

No v1 implementation: there is no shell-prefix facility to redirect v1, and v1 inherits host environment state.
A required sandbox-only policy will block legacy engine execution rather than degrade to v1.

## 3. Tool behavior and failure model

The first slice implements six primitives against guest `run`/`files` blocks only:

- `shell`: POSIX sh in the guest, absolute guest cwd, timeout up to 120 seconds. Nonzero exits are ordinary results;
  stdout/stderr are visibly separated in returned text and output is bounded to 32 KB.
- `read`: UTF-8 guest file, 1-based line pagination, 128 KB file limit.
- `write`: UTF-8 guest file; existing parent required, no implicit host directory creation.
- `edit`: exact replacement, ambiguous matches refused unless `replaceAll`; no host file I/O. Not atomic against
  unrelated guest processes, so the host serializes its own operations per workspace.
- `glob`/`grep`: guest Linux `find`, `grep` and `head`, shell-quoted inputs and bounded output. This is a small
  primitive implementation, not a promise of every native-tool option or regex dialect.

The pilot image is `alpine:3.22`, with no network. A product image should be digest-pinned, release-tested and have
explicitly documented utilities. Guest command names are `shell`, not a claim that Bash is installed.

Preview/background-job product tools are follow-ups. The adapter's loopback endpoint support remains covered by
its live suite. Do not silently map unrelated host tools (PDF readers, process launchers, patches) to a partial
replacement: remove or block them in sandbox-only until a reviewed guest implementation exists.

**Failure distinctions:** invalid input/disabled feature/allocation failure means the command did not start.
Execution timeout/disconnect may mean guest side effects happened. Do not retry automatically or assert that
nothing ran. Never switch to a host tool, another backend or another provider. A guest that is stopped or missing
must report unavailable unless explicitly restarted on the same local backend with unchanged grants.

Follow-up: durable call-id deduplication, guest background status/cancel, and richer receipts. The first slice has
no transparent exec retries. Cancellation is propagated to the bridge; provider deadlines bound guest operations,
but a dropped request is not proof that every guest descendant was killed.

## 4. Verify the Claude Agent provider, do not assume its CLI bypasses tools

The checked engine version is pinned in `apps/server/src/opencode-v2-artifacts.json`: OpenCode **2.2.6**.
The sibling engine checkout was absent, so the independent mapper inspected the actual upstream tag
[`v2.2.6`](https://github.com/anomalyco/opencode/tree/v2.2.6), not generic Claude CLI behavior:

1. `packages/core/src/plugin/provider/claude-agent/claude/query-options.ts:58–71,98–104` sets `tools: []`,
   `settingSources: []`, `strictMcpConfig: true`, disables configured hooks/skills and allows only
   `mcp__opencode__*`; it installs OpenCode's in-process MCP tool server.
2. `.../claude-agent/tools/server.ts:16–30` advertises OpenCode's supplied definitions and sends calls through
   `pending.call`, rather than executing native Bash/Read/Edit.
3. `.../language-model/convert-claude-stream.ts:93–104` turns recognized MCP names into normal tool-call events.
4. `packages/core/src/session/runner/step.ts:119–130` and `packages/core/src/tool.ts:121–182,201–230,247–319`
   execute through the transformed registry and before/after hooks, including Code Mode child calls.

**Decision:** do **not** block `claude-agent` merely because it launches the user's CLI: in this pinned integration,
its advertised primitive calls traverse OpenCode's tool registry and therefore see the replacements. This is not
native Bash interception. Add a regression witness for this route before product sandbox-only rollout and recheck
on engine/SDK upgrades. Unoffered-tool handling and SDK native-tool exclusion still need live verification.
Unknown provider integrations that execute their own native tools must be refused in required-only mode until their
path is verified. Tool replacement cannot prevent trusted engine internals from reading config or writing history.

## 5. Other host-touching tools: policy for sandbox-only

Removing six IDs is **not sufficient**. Product sandbox-only must use default-deny for unreviewed host execution
rails and enforce in the host as well as the model catalog:

| Surface | Sandbox-only decision and enforcement |
| --- | --- |
| Desktop computer use and scripting | Block `computer_*`, `computer_run`, AppleScript/JXA/Blender, clipboard and computer file transfer. Inject denies into `apps/desktop/electron/computer-agent-permissions.mjs` checks so direct/stale bridge calls cannot bypass catalog removal. Never control the user's desktop as an alternate terminal. |
| Built-in browser | Disable the browser tool family and refuse calls at the server/desktop bridge in the initial only-mode release. A host browser runs page JavaScript outside guest network policy and may expose uploads/downloads or localhost. A guest browser can be designed later. |
| Local MCP servers | Disable local/stdio servers before connection/spawn through `context.mcp.transform`; block local HTTP MCP too unless explicitly classified and approved. Names such as `openwork-cloud` are not sufficient identity. Preserve only verified organization remote connections with their own grants, and review them for local host-execution routes. |
| Host file/transfer tools | Remove and host-block Drive pull/upload, mail attachment fulfillment, office/PDF/spreadsheet readers and other local path tools until they explicitly resolve paths in the guest. |
| Other native tools | Block `patch`, worktree mutation and any tool that can execute or mutate host files. Catalog default-deny must cover aliases, custom tools, late transforms and Code Mode, not just the six names. |
| Delegation/app commands | New child sessions inherit the requirement. Refuse commands that create an unconstrained engine/session or mutate tool/MCP config. Direct engine session-shell/PTY, command templates and public execution routes need admission checks. |
| Engine background work | History/config/snapshots may touch the host outside tools. Describe only-mode as agent-tool confinement, not a VM for the entire OpenWork/OpenCode process. |

Remote MCP network access remains a deliberate capability, not "network off everywhere". The initial safe choice
is to withhold any unreviewed remote tool that can command this host. A policy editor must describe this loss of
computer/browser/local-MCP capability before the member opts in.

**Not shipped in the first slice:** these host-surface controls. Accordingly there is no reachable `only` mode in
the server policy yet, even though the replacement transform itself is tested. Extra-tool pilot behavior leaves
these surfaces unchanged and does not claim to confine the agent.

## 6. Organization and local control (follow-up, specified now)

### Organization member permissions

Use `packages/types/src/den/agent-permissions.ts`'s definition system, not a separate sandbox org/provider setting:

- Add key `hostExecution`, host action `host_execution`, section Commands, toggle label **Run tools on this
  computer**, default `allow`. `deny` means sandbox-only is required. The UI explains that commands/files go into
  the local VM and desktop/browser/local MCP access is blocked. No `ask` variant for a whole-run confinement mode.
- Add to `AGENT_PERMISSION_ACTIONS`, `AGENT_HARNESS_PERMISSION_KEYS` and `AGENT_HARNESS_PERMISSION_ACTIONS`.
  This is host-enforced; **do not add it to `agent-permission-engine.ts`'s `v2Action` grammar**.
- The Den member/team editor (`agent-permissions-editor.tsx`) and free-text `permission_key` storage pick up the
  definition; no enum migration or new independent permissions table is needed.
- Add `X-OpenWork-Sandbox-Only: 1`. In `/v1/me/desktop-config`, filter the new action for clients without it,
  following the existing capability-header filters at `routes/me/index.ts:513–519`, so older clients can parse
  their known actions. **Filtering alone must not allow legacy host execution:** require a compatible desktop
  version before assigning the policy, and refuse execution on unsupported clients/engines. Test old-client
  parsing separately from fail-closed policy admission.
- `managed-desktop-policy.ts` reads the action with a verified current identity, resolves the effective mode and
  enforces it on engine admission and all host bridges. Plugin options come from this trusted resolver, never the
  workspace or renderer. A signed-in policy that cannot be checked cannot relax a known requirement.

### Single user without an organization

Add a typed local **allowHostExecution** setting, persisted outside workspace files in the server runtime database,
written through the Settings -> Permissions privileged host path. Add a row next to Authorized Folders; the current
`effective-permissions-panel.tsx` is read-only and is not an editable store. The row shows effective mode, restart
requirement, provider compatibility and the reason if managed. Read `/v1/features` for signed-out rollout access;
an unreachable managed session is not equivalent to signed-out.

Normalize local `true/false` into `allow/deny` and merge with the org `host_execution` decision via
`stricterAgentPermissionDecision`. A local Allow cannot undo org Deny; local Deny remains stricter than org Allow.
Default Allow preserves existing behavior. Remove access to the row when flag off, but do not relax a stored
managed/local requirement on flag loss: block incompatible execution instead. Changes apply at a safe turn boundary,
reload the tool registry and dispose old host-capable MCP sessions; stale calls are denied at dispatch.

### Safe first-slice access today

Only an org member with a freshly verified `sandboxTools` rollout gets additive tools. The server separately reads
`/v1/me/desktop-config` and refuses the pilot for restrictive shell/edit/external-directory rules, including `ask`:
new sandbox tool names must not bypass existing approvals via writable bind mounts. Signed-out/local controls are
not implemented yet. No policy settings are changed by this PR.

## 7. Mount the Authorized Folders list, not authorizedRoots

Source of truth: engine-wide runtime row in `runtime-opencode-config-store.ts`,
`permission.external_directory`. `server.ts:3345–3401` writes Authorized Folders there. Do **not** derive guest
mounts from `config.authorizedRoots`, which is a separate server filesystem boundary.

- Mount workspace **plus every representable allowed Authorized Folder** as live bind mounts.
- Guest path equals the original **absolute** host path used by the model, not `/workspace` remapping. Canonicalize
  the host source with `realpath` (e.g. macOS `/var` -> `/private/var`) while preserving the guest alias.
- Current editor entries look like `"/absolute/folder/*": "allow"`. `ask` and `deny` are not preauthorized mounts.
  The current external-directory permission has **no per-folder ro/rw distinction**. OpenCode checks read/edit
  permissions separately. Do not invent a readonly enum or interpret `ask` as readonly.
- First slice uses rw for explicit allow + writable workspace, and ro for every bind when `config.readOnly` is true.
  It refuses restrictive managed edit/command/folder policies rather than bypass their permission prompts. Full
  policy integration must intersect read/edit grants: edit-not-allowed means ro or unavailable, never a writable
  parent alias. If future values explicitly encode readonly, parse them before allowing a mount; unknown shapes
  currently fail closed.
- Arbitrary hidden glob policies cannot always be represented as bind mounts. Refuse unrepresentable patterns,
  roots, or a granted parent containing a restricted subtree. Respect later broad deny/ask rules. A denied child
  must not remain reachable through a parent bind or alias. Canonicalize restrictions as well as grants (including
  existing ancestors of missing paths) before checking overlap; lexical `/var` versus `/private/var` checks alone
  are insufficient. Conservative alias conflicts are refused rather than widened.
- Exclude runtime DB/vault folders and actual `MSB_HOME`, including ancestor/descendant overlaps. Symlinks inside a
  guest bind resolve under guest semantics; hardlink aliases and host-side rename races still require adversarial
  testing. This is not protection from another same-user process controlling the mount source.

### Changes while running

Microsandbox's persisted configuration survives stop/start; merely restarting the old instance would retain its
old mounts. Therefore the first slice fingerprints the canonical mount plan and serializes mount transitions with
its own tool calls. Runtime-row writes trigger re-evaluation; changed/invalid grants stop the old VM. On the next
call a changed plan **destroys and recreates** the VM, with a visible `sandboxRestarted` receipt. Host bind contents
survive; guest-only scratch is reset. Unrelated runtime writes with the same plan do not restart it.

On server restart, an old instance with the stable scope/name is recreated before reuse, never adopted with stale
mount grants. The pilot is intentionally scratch-oriented. Follow-up: preserve a separate authorized data disk and
show a restart notice in Settings; immediate interruption of active long-running guest commands on revocation needs
explicit cancellation tests. No remount API is assumed.

## 8. Local adapter security and packaging

Local only, Apple Silicon macOS and Linux KVM; Windows preview is not admitted. The adapter always sets the network
policy because the SDK's unconfigured default is open egress. Pilot has no network; host-name allow-list support is
adapter-level only. HTTPS host-name enforcement needs interception; no claim of exact protocol equivalence or
HTTP-only enforcement on allowed TCP ports. No raw secrets or proxy keys are mounted/provisioned in v1.

VM identity includes an install/verified-account scope, workspace and mount fingerprint. The SDK backend is pinned
local and foreign/cloud handles refused. Slow create is cancelled; failed cleanup checks its per-attempt owner;
port collision retries do not replay commands. Native errors stay errors.

The adapter needs its optional platform package, SDK native addon and `msb`/firmware pair. `MSB_HOME` must be short
on macOS due to Unix socket limits. Server build and plugin bundling are included; packaged Electron signing,
notarization, library unpacking, Linux permissions and npm/compiled standalone delivery require separate evidence.
A missing module/runtime must produce unavailable rather than a host implementation. Keep the rollout off until
shipping-runtime validation. No first-use download, root privilege change or production flag is performed here.

## 9. External-sandbox pattern

[Prime Radiant](https://blog.primeradiant.com/external-sandboxes-for-coding-agents/),
[protocol revision 1](https://github.com/prime-radiant-inc/external-sandbox/blob/main/PROTOCOL.md), and
[Simon Willison](https://simonwillison.net/2026/Nov/17/) motivate explicit mounts, default-deny networking and
host-held secret substitution. Pi's `--no-builtin-tools` shape motivates same-name registry replacement in only mode.
There is no shell-prefix mechanism in OpenWork today.

Do not speak the wire protocol in v1: the in-process SDK and existing `SandboxProvider` already provide local
lifecycle/files/run/endpoints. Revision 1's unauthenticated loopback CLI callers and experimental Codex exec-server
format add no required capability. No server implementation planned. Secret swapping is future work: real values
persisted in host DB/WAL during experiments and an echoing trusted upstream returned them to the guest.

## 10. Verification plan

Follow `verify-openwork` and `write-a-spec`: pure mapping/server authorization rules get colocated tests; the
complete user-controlled mode needs a real product proof, before/after on dev and this branch, not just mocks.

Implemented tests:

- Adapter offline contract suite and opt-in real VM suite: lifecycle, ids, files, mounts, egress, preview, timeout.
- `sandbox-tools.vitest.test.ts`: schemas, guest effects, input/output bounds, no host fallback, same-name removal
  and registration, additive mode, stale-mode rejection, loopback envelopes. It deliberately proves that replacing
  six tools alone does not remove unrelated host rails.
- `sandbox-mounts.vitest.test.ts`: same absolute paths, current permission values, ro server mode, restricted
  subtrees, root/glob refusal, canonical aliases, protected runtime state and fingerprint changes.
- `local-sandbox-runtime.vitest.test.ts`: flag admission, registered workspace only, mount recreation and no
  dispatch after revocation, real bridge auth.

Before product sandbox-only enablement:

- Resolve local/org decisions as a truth table, including old desktop capability headers, identity changes, flag
  kill while only-mode is required and offline policy refresh. No stale grant may re-enable host tools.
- Drive Settings -> Permissions and Den member agent-permission editor through the real UI; show managed reason
  and stricter-wins. Proof lives at `evals/proofs/sandbox-only.proof.test.ts`; record evidence each step and
  screenshots for visible changes. Declare Apple Silicon/KVM needs; skips are Incomplete.
- Independent guest/host nonce witnesses show reads/writes only hit mounted paths. Remove a folder during an active
  session and prove the next guest cannot access it through any alias. Prove ro refuses writes from shell too.
- Plugin/engine test: instrument pinned Claude Agent's OpenCode MCP tool route, verify replacements execute and
  native CLI tools remain disabled. Do not block that provider based only on its name.
- Negative calls for desktop scripts/computer/browser/localhost MCP, `patch`, custom tools, late plugin transforms,
  Code Mode, child sessions, engine session-shell and file-fulfillment bridges. A hidden tool still needs host-side
  denial. Sandbox down never results in a host sentinel file or restored builtins.
- Run local bridge-to-real-microVM tests, then the shipping Electron/Node runtime and packaged macOS/Linux. Keep
  screenshots and exact commands/counts in the evidence report. `pnpm check` must pass; no production probes.

## 11. Follow-ups before full scope is complete

1. `host_execution` definition/harness key, Den editor integration, capability header/filter and old-client gate.
2. Editable local permission setting and Settings -> Permissions row; stricter-wins resolver in the host.
3. Host-side enforcement for computer/browser/local MCP and other rails; native engine direct-exec/child-session
   admission; policy-aware sandbox tool permissions. Only then allow the bridge to return `only`.
4. Claude Agent regression witness; engine catalog transform ordering/late replacement protection.
5. Safe required-only handling when flag/runtime/policy unavailable, plus active-command revocation and durable
   call receipts. No disable-switch path that restores the host primitives.
6. User-visible mount-restart notice, guest scratch retention and exhaustive overlap/symlink/readonly tests.
7. Packaged native-runtime distribution and real Settings/Den product proof. Preview/background jobs remain later.

These are follow-ups, not features claimed shipped by the first-slice plugin. No new agent-permission action,
editable local store or Settings row is introduced in this slice.

## 12. Future remote work only

Differently, Freestyle and Daytona are future scope. Their existing adapters and Workbot gateway rollout remain
untouched, and the local runtime/plugin imports none of them. Revisit selection, credential custody, remote mounts,
network enforcement and preview semantics in a separate design before admitting Remote. Microsandbox's embedded
runtime has no self-hosted server API for a gateway to call; that does not affect this local in-process design.

## 13. Evidence and review provenance

The primary agent is GPT-6.1 Sol. Earlier default explore agents were not verified as Fable. Independent Sol
research/reviews informed the adapter; a fresh source mapper verified the pinned Claude Agent registry path and
Authorized Folders semantics. The earlier assumption that the CLI necessarily bypassed the registry was corrected;
no provider block is introduced on that unsupported premise.

Previously measured adapter foundation: 23 offline and 18 live cases, zero failures/skips on Apple Silicon Node
24.22.2; server build and checks were rerun during this revision. Updated test evidence is in this PR's report.
No claim is made that the full permission-controlled sandbox-only journey or packaged native runtime is proven.
