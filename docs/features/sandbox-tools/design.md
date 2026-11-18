# Sandbox tools: local microsandbox and remote through Differently

Status: draft, revised 2026-11-17. Tool feature `sandboxTools`, off by default; remote availability reuses
`sandboxGateway`, also off by default. Author: `benjaminshafii`.

OpenWork's agent keeps its normal shell on the host and gets extra sandbox command, file and preview tools.
Setup chooses **This computer** (in-process microsandbox) or **Remote** (the existing Differently gateway).
Differently, not OpenWork, selects the remote pool and holds the OpenSandbox, Daytona and Freestyle credentials.

This PR adds only a local adapter foundation and the design. No agent tools or gateway routing are wired yet.
Nothing here changes production settings or the existing Workbot routing behavior.

## 1. Decisions

| Question | Decision |
| --- | --- |
| Shape | Extra `sandbox_bash`, `sandbox_job`, `sandbox_read`, `sandbox_write`, `sandbox_preview`, `sandbox_status` tools. Normal shell and file tools remain on the host. |
| Contract | Reuse `@openwork/sandbox` unchanged. Local: `@openwork/sandbox-microsandbox`. Remote: the existing `@openwork/sandbox-differently`. |
| Selection | A trusted workspace setting chooses `off`, `microsandbox` or `differently`, within the organization's bound. Never infer the mode from available keys or current health. |
| Remote placement | Differently project policy and template/pool configuration select Freestyle or Daytona. OpenWork may pass approved narrowing constraints, not separate provider settings. |
| Credentials | Provider keys stay in Differently. OpenWork needs only the gateway connection: URL and a project-scoped gateway credential or a Den-held connection. Local microsandbox needs no key. |
| Rollout | `sandboxTools` controls the new tools. Reuse `sandboxGateway` for permission to use Remote; do not add another remote-provider flag. |
| Failures | No automatic switch from gateway to a direct adapter, local microsandbox or host shell. No automatic command replay. |
| External sandbox protocol | Borrow the security pattern, not its wire protocol in v1. No server planned; a client adapter remains future work. |
| Direct adapters | Keep existing packages for their current consumers. Do not expose them as fallback routes for these tools. |

## 2. Existing architecture and why the gateway is the default

- `packages/sandbox/src/provider.ts` and `blocks.ts` already define lifecycle, opaque references, `run`, `files`,
  optional pause/snapshots, preview endpoints and `platform.isolation` including `microvm`. Reuse their `withBlocks`,
  `ensureRunning`, `sandboxName`, scope labels and conformance cases.
- `packages/sandbox-differently/src/index.ts` is already a `SandboxProvider`. It authenticates with a project-scoped
  gateway key and accepts `template`, `placement`, `classification` and resource options. Differently holds the
  upstream provider keys and decides placement. This is the remote adapter for the new tools, not a later option.
- `ee/packages/headless-computer/src/providers.ts` already loads that adapter in `createGatewayProvider`.
  `docs/computer-use/workbot.md` documents `SANDBOX_GATEWAY=differently` with URL, project key and template.
- `packages/features/src/flags/sandbox-gateway.ts` declares the existing `sandboxGateway` rollout.
- **Existing Workbot fallback is not the new tool contract.** `ee/apps/headless-runner/src/computer-route.ts`
  intentionally makes a new computer on the runner's direct provider when the gateway has infrastructure trouble.
  It does not bypass policy refusals and it pins an existing computer to its side. Reuse the adapter, credential
  model and flag, **not `routeComputers` or its fallback logic**. This PR does not change Workbot's behavior.
- `packages/sandbox-freestyle` and `packages/sandbox-daytona` remain required by existing headless computers,
  remote-computer targets and cloud-runtime consumers. Removing them would be unrelated breakage. Their existence
  does not justify another credential store, setup path or automatic fallback for sandbox tools.

### microsandbox is deliberately separate

Differently's [provider note](https://github.com/different-ai/differently/blob/main/docs/providers/microsandbox.md)
explicitly marks microsandbox unsupported. The 2026 rewrite removed the old self-hosted server API; its SDK embeds
the runtime and spawns local `msb` processes. There is no server for Differently's control plane to call.

Therefore `packages/sandbox-microsandbox` stays a local, in-process OpenWork adapter. Do not add a fake microsandbox
pool to Differently, depend on an obsolete `msb server` endpoint, or treat the separate hosted microsandbox service
as this local backend. A future per-host remote plugin would be a separate project, not a v1 prerequisite.

Earlier Rust examples and `Dockerfile.microsandbox` run the entire OpenWork server in a VM, which is the opposite
of this tool-only shape. Do not reuse their workspace `sandboxBackend` fields: those make the whole workspace's
files remote in the UI, whereas this design leaves normal host tools unchanged.

## 3. Scope and execution path

```
v2 engine: normal shell/file tools --------------------------> host (unchanged)
          sandbox tools
                |
                v
     authenticated loopback bridge in OpenWork server
       | verify rollout, identity, organization bound, workspace setting
       | resolve exactly one backend; record execution outcome
       |
       +-- mode=microsandbox --> @openwork/sandbox-microsandbox
       |                         --> native SDK --> local msb child --> microVM
       |
       +-- mode=differently --> @openwork/sandbox-differently
                                 --> Differently project/template/placement policy
                                      +--> Freestyle VM
                                      +--> Daytona sandbox (approved isolation class)
```

Differently can also manage OpenSandbox. It is not implicitly included in this v1 Remote offer: restrict the
project/allowed pools to approved Freestyle/Daytona pools until another pool meets the required network, preview,
isolation and lifecycle contract. Do not assume all pools expose the same capabilities.

Tool definitions belong in `apps/server/src/opencode-plugins/openwork-sandbox.ts`, in the plain-object shape of
`openwork-computer-use.ts`. The server-side host owns provider construction and settings resolution. The v2 engine's
context plugin registers the definitions and calls a scoped loopback bridge, like the browser/computer bridge.
Neither native modules nor gateway credentials belong in the engine/plugin bundle.

**v2 only** for this feature. v1 inherits the server's environment and has a separate plugin registration path;
its Settings entry says the tools require the current engine. A tool-only sandbox is not a promise to confine
all of v1 or v2's ordinary host operations.

Not included yet: Windows, extra host-folder mounts, host-folder sync to remote, sandbox-only agent mode, secrets
injected into guest requests, or a new Differently adapter for microsandbox.

## 4. How setup selects local versus remote

### 4.1 Rollouts: reuse instead of duplicate

| Tools rollout | Gateway rollout | Workspace mode | Result |
| --- | --- | --- | --- |
| `sandboxTools=false` | either | any | New tools unavailable. Existing Workbot unaffected. |
| `sandboxTools=true` | either | `off` | No sandbox tools offered. |
| `sandboxTools=true` | either | `microsandbox` | Local tools, subject to settings and platform support. |
| `sandboxTools=true` | `sandboxGateway=false` | `differently` | Remote locked; no fallback to local/direct. |
| `sandboxTools=true` | `sandboxGateway=true` | `differently` | Tools use the configured Differently connection and approved remote profile. |

`sandboxTools` is a distinct rollout for a genuinely new tool surface. `sandboxGateway` is reused for the existing
remote-gateway route; there is no `remoteSandboxTools`, per-provider flag or env enable switch. The gateway flag's
label/docs are broadened to include this planned use while explicitly retaining Workbot's current fallback rules.
Both flags resolve through the central registry, including kill switches and member/organization overrides.

List/reload tools at a prompt boundary, and enforce again inside the server for **every** call, including files,
status and previews. A still-listed tool after revocation must fail closed. Killing `sandboxGateway` removes only
Remote access for these tools; it must not turn a Remote workspace into a Local workspace. Killing `sandboxTools`
stops admission for both. Bounded in-flight work may finish; revoke preview transports and stop owned sandboxes.

### 4.2 Organization bound in Den

Use a typed org setting, projected into `/v1/me/desktop-config`, following the existing automation-settings pattern.
Do **not** add enum fields to the boolean desktop-policy catalog: its general enforcement is off.

Proposed shape (not an API implemented in this PR):

```ts
{
  backends: ("microsandbox" | "differently")[]
  defaultBackend: "microsandbox" | "differently" | null
  isolation: ("container" | "vm" | "microvm")[]
  local: {
    workspaceAccess: "none" | "read" | "read-write"
    network: { egress: "none" } | { egress: "allow-list"; domains: string[] }
    previews: boolean
    image: string | null  // approved OCI digest, or OpenWork's image
  }
  remote: {
    connectionRef: string  // one configured Differently connection, not an upstream key
    profiles: string[]     // approved connection-local profiles: template + narrowing pool constraints
    defaultProfile: string | null
    previews: "off" | "authenticated-link"
  }
}
```

There are no `freestyle.apiKey`, `daytona.apiKey`, provider API URLs or upstream snapshot IDs here. Remote profiles
refer to approved mappings in the gateway setup, not to arbitrary request fields. The Differently project/pool
policy remains authoritative even if OpenWork passes a narrowing `allowedPools`, `classification` or placement
constraint. If a remote profile allows both Freestyle and Daytona, choosing between them is Differently's policy.
If the administrator needs one vendor, restrict that profile to its pools there.

OpenWork must verify actual granted isolation and network/preview guarantees rather than asserting all returned
sandboxes are VMs. `vm` and `microvm` are explicit allowed values, not a presumed total security ordering.
An unsatisfiable profile returns unavailable; it never widens into another pool.

### 4.3 Per-workspace choice

Store a typed row in `runtime.sqlite`, keyed by workspace and identity scope, written through the desktop's trusted
Settings path (renderer -> Electron main -> host-token server route). Never import this row from
`.opencode/openwork.json`, `opencode.json` or another agent-writable workspace file.

```ts
{
  backend: "off" | "microsandbox" | "differently"
  remoteProfile: string | null
  workspaceAccess: "none" | "read" | "read-write"  // local only
  localNetwork: { egress: "none" } | { egress: "allow-list"; domains: string[] }
  previewPorts: number[]
}
```

- Setup asks **This computer** or **Remote**, and explains the different file access. Unless the organization
  specifies a different default, preselect **Remote via Differently** when setup is enabled. If Remote cannot be
  admitted, show it locked with the reason; do not silently preselect Local instead. Default execution remains
  `off` until setup is accepted. Do not select from machine health, missing credentials or probe results.
- Local means only the recorded workspace root may be mounted, read-only by default at `/workspace`, with writable
  scratch space at `/work`. Other folders, server data, the vault and `MSB_HOME` are excluded.
- Remote means an empty remote filesystem or an approved template; it does not mount this computer's workspace.
  Clone from an allowed origin or write files using the sandbox tools. No implicit upload/sync.
- Local access/network can only narrow the org bound. A remote profile must be in the allowed profile list, and
  ports must satisfy the connection/profile's preview policy. Refuse invalid combinations rather than clamp them.
- A missing local runtime reports how to install/enable it. A missing or unhealthy gateway reports the gateway
  problem. Neither condition changes the saved choice.

### 4.4 Verification and identity

Signed-in members use `/v1/org` feature resolution and the org bound. Missing org settings grant nothing. Signed-out
people use `/v1/features`, as `add-a-feature` prescribes, plus an operator-configured gateway connection for Remote
if allowed there. An unreachable Den, or identity changing during a read, is **unverifiable**, not signed-out mode.

Check on every call; reuse an identity-bound verified answer for at most 60 seconds. After that a failed refresh
refuses dispatch and stops the sandbox. Revocation can therefore take up to one minute; the rollout UI and tests
must state that. No stale cross-sign-in policy reuse.

Name with `sandboxName(scope, "tools", workspaceId)`, where scope hashes install id, Den origin, organization,
member and (for Remote) the gateway connection/project reference. Persist the **adapter's opaque `SandboxRef`**;
remote pool choice is not a reason for OpenWork to change providerId from `differently` to `freestyle` or `daytona`.
Fingerprint all effective grants, backend/connection/profile, image/template revision and ports. A change stops the
old sandbox and returns `sandbox_needs_reset`. Reset explicitly warns about data loss. Never silently migrate a
sandbox or reattach one under a different identity.

The host shell runs as the same OS user and can read local databases. Host-token routes are an API boundary, not
an OS security boundary. The strongest managed bound is Den-verified memory. This feature does not make local
storage inaccessible to the agent's ordinary host tools.

## 5. Credentials and network policy

### 5.1 Existing gateway connection model

Reuse `SANDBOX_GATEWAY=differently`, URL, project-scoped key and template from the runner model. These are
connection settings, not new feature flags. For desktop setup, store the gateway credential in host-managed
encrypted storage or keep it in Den and mediate gateway calls there. Expose a connection reference to the renderer,
settings row and engine, never the key. Existing encrypted-store infrastructure should be shared, not copied.
The runner may continue its existing operator-env path, but new desktop tools must not place the gateway key in
engine/guest env, command arguments, workspace files, transcripts, logs or preview URLs.

Provider keys stay in Differently's deployment configuration. They do not get copied to a second OpenWork vault.
A Den-mediated connection should retain Differently as the placement and provider-credential authority; it is not
a second provider broker implemented by OpenWork. Gateway project credentials still need least privilege,
identity scoping, rotation and revocation; they are not harmless merely because they are not provider keys.

### 5.2 Default-deny is a requirement, not inferred gateway behavior

The existing adapter sends template, placement, classification, resource, env and labels when creating a sandbox.
It does **not** send a portable network policy or `exposePorts`. Its capability reader only derives common
pause/stop support. It cannot currently prove the new security contract from `describe()` alone.

For Remote, bind the org-approved profile to a Differently project/template/pool configuration that enforces
no egress by default (or its explicit origin allow-list), approved isolation, preview constraints and lifetime.
An arbitrary template name or label is not proof of enforcement. Until these guarantees can be verified and
negotiated, Remote remains unavailable for sandbox tools on that connection, even if exec/files work.

Changing guest proxy environment variables is not an enforcement boundary. Egress must be enforced by the gateway's
provider configuration or infrastructure outside the guest. A guest cannot be allowed to bypass a host-name proxy
using direct IP, alternate DNS, IPv6, UDP, redirects, private ranges or metadata endpoints. Section 9 lists the gaps
that need confirming/closing on Differently's side.

### 5.3 Secrets used by commands

No injected guest secrets in v1. Do not confuse this with the upstream provider keys, which already stay in
Differently. An application token for a Git host or package registry is a separate problem.

Later: a proxy outside the guest swaps scoped placeholders for real tokens, bound to trusted destination,
method/path/header and verified TLS identity. Den or Differently can hold those application secrets; the guest sees
only placeholders. Follow the external-sandbox pattern, with response redaction and explicit secret grants.

A local experiment showed microsandbox's raw-value secret API writes the value into host DB/WAL, including after
destroy. An echoing allowed host returns it to the guest. The new adapter deliberately exposes no secrets option.
Reference-based secret storage and a hostile/echoing upstream need separate verification before this is added.

## 6. Tool surface

The engine supplies conversation and call id, never model-controlled identity arguments. Use flat Zod tool schemas
and `provider-safe-tool-schema.ts` rules. All results are untrusted data.

| Tool | Input | Output |
| --- | --- | --- |
| `sandbox_bash` | command, description, cwd?, timeout_seconds? (1–300, default 120), background? | exit code, separate stdout/stderr, bounded to 64 KB each with explicit truncation; or background job id |
| `sandbox_job` | job, stop? | running/exited state, exit code, bounded log tail; optionally cancel first |
| `sandbox_read` | guest path, line offset/limit? | text, at most 256 KB, explicit binary/missing errors |
| `sandbox_write` | guest path, content (at most 1 MB) | write result, creating parent directories |
| `sandbox_preview` | guest port | approved endpoint, kind, expiry/auth requirements; never a raw upstream command-API token |
| `sandbox_status` | none | Local or Differently, actual verified isolation/placement when available, guest state, mounts, network/preview grants and jobs; no keys |

Call `withBlocks(provider, ["run", "files"])` before allocating compute. Bash must exist in the approved image or
gateway template; adapters promise `sh`, so the host wraps tool commands with `bash -c`. Default cwd is the mounted
`/workspace` or writable `/work`. For local read-only source, build/install into `/work/project` after copying it.

Use the existing Workbot pattern of guest-resident background jobs and logs; it works with synchronous adapters,
including Differently's `detachedExec: false`. Freestyle's five-minute exec limit still matters behind the gateway.
Do not copy EE implementation into the public server; reuse patterns or extract shared licensed primitives.

Deduplicate by engine call id so a repeated transport request returns the original receipt rather than executing
again. Dispatch is once, and timeout/disconnect may mean side effects already happened. No per-command approval
inside the explicit setup grant, but existing authorization must not be bypassed through a new tool name.

Previews are opt-in, never opened automatically. A page's JavaScript runs in a host browser outside the guest's
egress rules. Open in the isolated built-in browser, not the person's external profile. Remote previews must pass
the profile's authentication/expiry policy; an unguessable stable public hostname is not authentication.

## 7. Local adapter foundation in this PR

`createMicrosandboxProvider(options, deps): SandboxProvider`, pinned to `microsandbox` 0.7.15:

```ts
{
  image: string
  network: { egress: "none" } | { egress: "allow-list"; domains: readonly string[] }
  mounts?: readonly { hostPath: string; guestPath: string; access: "ro" | "rw" }[]
}
```

- `provider.ts` implements the existing contract. `native-driver.ts` is SDK glue with lazy native loading and an
  injectable test seam, not a competing application-facing provider interface.
- `platform: { os: "linux", isolation: "microvm" }`; `run`, `files`, `pause`, stop/start; no volumes, snapshots,
  detached exec or cold-start memory restore claimed.
- Pin the SDK's process-wide backend to local and refuse non-local handles. No microsandbox cloud backend.
- Mount/network grants are fixed by host-constructed options, not widened by job-controlled `SandboxSpec` fields.
  Reject roots, non-normalized paths, wildcard hosts and IPs masquerading as host names.
- Explicit no-network or host allow-list on TCP 80/443, with TLS inspection for host-name enforcement and DNS
  rebinding protection. Do not claim this is a complete HTTP-only proxy: a raw TCP connection on allowed port 80
  was accepted in a live probe.
- Previews bind only `127.0.0.1`, at ports chosen during create. Retry a port collision up to three times, never a
  dispatched command. Cancel slow create; cleanup requires the per-attempt ownership label, not just the name.
- Ref includes SDK id and name; stale references cannot adopt a later sandbox with the same name. Shared connection
  attempts are cached, with owner-conditional eviction. Adversarial concurrency testing remains work to do.
- Map native errors to `SandboxError`; missing runtime is non-retryable. A timeout never means success or licenses
  rerunning on the host. Refuse unsupported maintenance semantics rather than silently renewing idle activity.

`MSB_HOME` must be short on macOS (Unix sockets are limited to 104 bytes). Resolve approved real mount paths;
the SDK rejects symlinked host paths. Same-user races, hardlink aliases, writable mounts and resource exhaustion
still need adversarial testing before claiming a hardened sandbox-only mode.

## 8. Lifecycle, failure and direct adapters

One sandbox per workspace **and identity/connection scope**, not per conversation; conversations share its files
and jobs. Serialize create/start/stop/reset and protect active commands from concurrent destructive reset.
Backend/profile changes require explicit reset, not silent destruction or migration.

| Failure | Behavior |
| --- | --- |
| Local mode, unsupported host/runtime | Local unavailable; keep saved mode; no remote/host substitution |
| Remote mode, gateway disabled/missing/down | Remote unavailable; no direct Freestyle/Daytona, local or host substitution |
| Gateway auth, quota, classification or placement refusal | Surface refusal unchanged; do not relax constraints or change accounts |
| Remote create times out | Outcome unknown; use gateway idempotency key and lookup to reconcile before another create; never replay an exec |
| Setting/profile revision no longer permitted | Refuse new calls, stop sandbox, require reset where configuration differs |
| Command dispatched then timeout/disconnect | May have run inside selected sandbox; preserve receipt and inspect job before retry |

Pre-dispatch failures say the command did not start. Post-dispatch failures say it may have run. Both explicitly
forbid running it on the host instead. Tool descriptions are not an enforcement mechanism against the separate
normal host-shell tool; this is isolation of selected operations, not confinement of the whole agent.

Stop on sign-out, shutdown and permission loss; reconcile owned instances at startup. Local uses its idle timer
as a crash backstop. **Differently currently has no adapter-level idle-stop backstop**: `autoStopMinutes` is not
sent as provider enforcement. Remote must have host-owned idle scheduling plus a gateway-enforced finite TTL and
renewal policy that survives desktop crashes. TTL expiry means possible remote data loss; show that in setup.
Do not promise indefinite persistence via `autoDeleteMinutes: -1`: the gateway adapter maps it to a long finite TTL.

### Why keep direct adapters at all?

They serve existing callers and tests; they are not a default or fallback for the new tools. This design adds no
direct-provider setup/credential UI and no automatic fallback. A future direct route would need a demonstrated
requirement (for example an installation explicitly operating without a gateway), a separate reviewed policy and
visible operator choice made before execution, not outage-based selection. None is justified for v1.

Differently itself may select or fail over among pools **within the authorized project/profile constraints before
an operation is dispatched**. That is gateway-owned placement, not permission for OpenWork to bypass the gateway
or replay a command on another sandbox.

## 9. Differently-side prerequisites and OpenWork adapter work

These are requirements to confirm against the gateway's contract, not APIs claimed to exist. This PR does not edit
or deploy Differently. Existing create/exec/files/lifecycle APIs and project keys can already support a basic
remote prototype; production-safe Remote admission additionally needs the guarantees below.

| Requirement | Current OpenWork integration | Needed work / owner |
| --- | --- | --- |
| Project-scoped auth and placement narrowing | Existing gateway key, template, classification, allowed pools/strategy options | Reuse. Configure approved Freestyle/Daytona pools in Differently; do not add upstream keys to OpenWork. |
| Enforced network policy/profile | No per-request network policy in Differently's current create schema; OpenWork's adapter does not send/verify one. OpenSandbox has pool-level none/allow-list enforcement, Freestyle deny-all/public, and the Daytona adapter advertises no egress control. | Configure narrowly approved pools for fixed policies; workspace-specific narrowing needs gateway API/enforcement work. Differently must expose the granted policy/revision, not merely a capability bit. Never admit a Daytona pool as default-deny without verifying/adding enforcement. |
| Actual placement/isolation | Differently already exposes tenant-visible `/v1/capabilities` and create-time required capabilities; this adapter does not send them and defaults to `isolation: "unknown"` | Extend the OpenWork adapter to pass required capabilities (e.g. `isolation.microvm`, `network.egress-control`, `ports.expose`) and read actual placement. Declared capability names are operator claims, not independent isolation verification or proof of a specific network policy. Add returned metadata only where the current gateway contract lacks it. |
| Authenticated previews | Differently returns `{port,url}`; upstreams differ (Daytona signed, Freestyle public, other pools gateway/scope links). The OpenWork adapter flattens every link to `stable` without expiry. | Extend Differently's port metadata for effective auth scope/expiry and provide an authenticated proxy where required, or disable previews on unsuitable pools. Map endpoint semantics accurately in OpenWork; never relay a sandbox-wide command token. |
| Port restrictions | Adapter's create body omits `spec.exposePorts`; endpoint accepts a requested port | Profile or gateway must restrict permitted preview ports. Enforce in OpenWork too; if gateway API cannot carry/enforce the restriction, extend it rather than claim create-time port enforcement. |
| Stable security-profile revision | Template/placement settings supplied, no verified security fingerprint | Return/version grants so changed gateway configuration invalidates reuse. Define the server's revision and revocation semantics. |
| Idle/TTL cleanup | Finite TTL supported; auto-stop not a gateway backstop | Configure safe finite TTL and limits; extend Differently only if durable idle stop is required beyond current TTL, and document pause vs stop and data retention. |
| Guest application-secret proxy | Not part of the adapter contract | Future only: external proxy with scoped substitution/redaction. No microsandbox backend work required in Differently. |

Source checks in [Differently](https://github.com/different-ai/differently): `pkg/api/types.go` and
`api/openapi.yaml` (create/placement/port schemas), `internal/server/tenancy.go` (tenant-visible capabilities),
`docs/guides/keys-and-providers.md`, `docs/guides/opensandbox-pools.md`, `docs/providers/freestyle.md` and
`docs/adapters/specification.md`. No live provider or production gateway was queried.

Keep these extensions in `packages/sandbox-differently` options and mappings; reuse the existing shared blocks and
endpoint shape. If required security metadata cannot be expressed, propose a backward-compatible extension to the
shared contract with conformance tests, not a parallel remote interface. Don't upgrade SDKs or alter legacy Workbot
routing as part of this design revision.

## 10. External sandbox protocol decision

Grounding: [Prime Radiant's write-up](https://blog.primeradiant.com/external-sandboxes-for-coding-agents/),
[protocol revision 1](https://github.com/prime-radiant-inc/external-sandbox/blob/main/PROTOCOL.md), and
[Simon Willison's discussion](https://simonwillison.net/2026/Nov/17/).

Agent on host, only declared ro/rw mounts visible, network off unless an HTTP(S) allow-list proxy is enabled,
placeholders swapped for host-held secrets, trusted web UI edits proxy policy. Pi replaces all tools with
`--no-builtin-tools`; Claude Code redirects Bash via `CLAUDE_CODE_SHELL_PREFIX` but leaves native file tools on host;
Codex uses exec-server. Our v1 deliberately keeps normal host tools, so it does not claim Pi-style confinement.

Wire: loopback HTTP discovery and buffered exec, `/exec/ws`, `/codex` process/file RPC based on experimental Codex
0.164.0. Mounts are configured at launch. Proxy credential substitution matches a whole header over HTTPS, with
method/path/origin restrictions, resolved-address checks, upstream TLS verification and redaction.

**No wire implementation in v1.** Published 16 November as experimental, no wire-version negotiation, no lifecycle
or preview contract, and local CLI callers are not authenticated. OpenWork already has its authenticated engine
bridge, the local native SDK and the Differently remote API. Wrapping either in a second protocol adds no needed
capability. Differently is the control plane for remote placement and keys, not an external-sandbox server.

Adopt the security principles without claiming equivalence: local SDK host allow-lists lack method/path limits and
echo redaction; gateway guarantees need the explicit work in section 9. Future `sandbox-external` client support
would need to describe externally owned lifecycle/mounts honestly, pin revision and pass its conformance suite.
No server implementation is planned.

## 11. Test plan: verify-openwork / write-a-spec

- **Local adapter:** colocated unit/contract tests and opt-in real microVM conformance. Keep unsupported capability
  cases explicit; existing conformance cases can return early for unclaimed storage, which is not evidence of volume
  support. Test mounts, egress, previews, timeout cancellation, port conflict and stale references.
- **Selector/resolver:** table tests for both flags, all three workspace modes, missing/unhealthy gateway,
  policy/classification/auth refusals, signed-out vs unverifiable identity, profile changes and sign-out. Assert
  exactly one factory is constructed, zero direct factories or host commands, and no switch on any failure.
- **Gateway adapter:** mock-HTTP tests verify project auth stays in headers, approved template/placement narrowing,
  denied network/preview constraints, pool metadata, TTL/expiry mapping and no retries of `/exec`. Never use fixture
  production keys. If a gateway prerequisite is absent, assert Remote unavailable before allocation/dispatch.
- **Tool host/bridge:** existing fake provider, scoped token/auth checks, call-id replay, outcome-unknown receipts,
  output limits, revoked settings even while listed, serialized reset. Test background status/stop and no env/key
  leakage. API tests for org setting edits and feature-disabled cases.
- **Flag regression:** `sandboxTools` off leaves Workbot unchanged; `sandboxGateway` off leaves Local available
  but refuses Remote; gateway outage does not invoke `routeComputers`' direct-provider fallback for the new tools.
- **Differently integration:** a disposable test project with approved Freestyle/Daytona pools verifies real
  placement, egress deny/allow, scoped previews and TTL cleanup. Do not use production or claim mock responses prove
  provider network enforcement. Exact required gateway-side versions/capabilities go in the test report.
- **Product proof:** `evals/proofs/sandbox-tools.proof.test.ts`, using `appWeb`, scripted model and disposable Den.
  At least before/action/after/boundary steps with `recordAssertionEvidence` and screenshots for each visual beat.
  Before: tools off. After: select Local, observe a mounted random nonce and inability to read a host-only nonce.
  Then select approved Remote with both flags on, witness gateway allocation/actual placement independently.
  Boundary: gateway unavailable/refused, a sandbox command errors and creates no host sentinel; verify no direct
  account allocation. Revoke `sandboxGateway`: Remote refuses, Local does not change choice automatically.
- **Placement/runtime:** real local microVM needs Apple Silicon or KVM. Declare needs; follow `run-tests` placement
  and report its line. Skips are Incomplete. Match packaged Electron Node, macOS signing and Linux KVM, not just Bun.
- Run the proof against dev and branch; don't claim a green result before tool wiring exists. Run spec lint,
  report/design review and `pnpm check` on the exact head. No production probes.

## 12. Code and measured evidence

This PR contains `packages/sandbox-microsandbox`, the off `sandboxTools` declaration/generated list, and these docs.
The existing `sandboxGateway` entry is documented as reused for Remote; it retains its key/default/ownership and
existing Workbot semantics. No new runtime routing or production flag settings are changed.

Before the gateway design correction, on Apple Silicon macOS with Node 24.22.2 and microsandbox 0.7.15:

- Offline: 23 passed, 0 failed, 0 skipped. Live: 18 passed, 0 failed, 0 skipped in a fresh short runtime home.
  No test sandboxes remained; the runtime home was removed. These prove the local adapter only, not Remote.
- `pnpm --filter @openwork/sandbox-microsandbox... build` and all eight `pnpm check` checks passed.
- Measured default SDK egress was unrestricted without policy. Explicit policy denied egress while loopback preview
  worked. Allowed HTTPS needed TLS interception. Symlinked host bind paths were refused.
- Slow create could be cancelled; a failed bind left a stopped instance until cleaned up. SDK secret values were
  found in host WAL after destroy; no secret option ships. Basic native calls also worked under Bun 1.3.10.

Not verified: packaged Electron, signing/notarization, Linux KVM, DNS pinning under attack, connection-cache races,
Differently security profiles/remote network enforcement/restricted previews, or a complete agent-tool journey.
The gateway provider note and the existing integration were inspected read-only; no provider/deployment was touched.
After this design/flag-metadata revision, `pnpm --filter @openwork/features test` passed 15/15 and `pnpm check`
passed all eight checks. The local adapter implementation is unchanged by this revision; no remote behavior is
claimed tested.

## 13. Implementation order and remaining questions

1. Agree and test the two-mode resolver and gateway guarantees, before exposing Remote.
2. Reuse the Differently adapter; add verified security-profile/endpoint metadata support alongside its conformance
   tests. Track any required gateway changes separately as section 9 lists.
3. Implement org bound, identity-scoped workspace settings, v2 tool host/bridge and lifecycle without any direct
   fallback. Reuse `sandboxGateway`; keep `sandboxTools` as only the new-surface flag.
4. Setup UI, explicit reset and local runtime/image packaging. Microsandbox optional platform package is about
   99 MB on macOS arm64; first-use install vs signed bundling needs packaging evidence.
5. Product proof and disposable gateway integration test, then a flagged pilot. Guest secrets are later work.

Questions: gateway connection delivered by Den or operator-configured locally; short-lived project credentials
versus a host-held project key; exact immutable remote-profile/capability contract; authenticated preview transport;
idle/TTL retention; per-workspace shared sandbox versus per-conversation memory cost. None requires collecting
Freestyle/Daytona keys in OpenWork or implementing microsandbox inside Differently.

## 14. Review conclusions and correction history

The primary agent is GPT-6.1 Sol, not the requested Fable; codebase mapping used default explore agents whose model
identity was not verified. Explicit GPT-6.1 Sol agents performed external research and independent review. This is
an independent-agent comparison, not a verified Fable/Sol comparison.

The initial review agreed on the shared contract, local adapter and deferred external wire protocol. It corrected
false claims about timeout non-execution, create-only policy checks, signed-out behavior, isolation ordering,
reset data loss, hosted-SDK selection, create cleanup, port races, raw secret persistence and proof witnesses.
Those corrections remain in this revision. Reviewed compromises remain explicit: authorization enforced on each
call with at most 60-second verified-policy reuse; provider timeout/call-id receipts rather than a universal cancel
protocol; a host-browser preview is not governed by guest egress restrictions; same-user host shell is not confined.

The user's correction supersedes the earlier remote-provider recommendation: **Differently is the default and
only v1 Remote route**, not a future alternative to direct provider keys in OpenWork. The earlier proposed direct
provider vault/UI, SDK upgrade slices and extra provider selection fields are removed. Keep existing direct adapters
only for their existing consumers; no outage fallback is justified for the new tools. Local microsandbox is separate
because Differently explicitly does not support it. A fresh independent Sol review checked the gateway schemas,
provider notes and existing router and agreed with this correction. It confirmed that required-capability admission
already exists upstream but is not sent by OpenWork's adapter; per-request network policy and uniform preview
metadata do not exist. Section 9 distinguishes configuration reuse, OpenWork adapter work and actual gateway-side
prerequisites rather than treating all of them as a new gateway implementation.
