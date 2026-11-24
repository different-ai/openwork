# OpenWork Sandbox: Use and Force

Feature `sandboxTools` (cloud and self-hosted, off by default). This page is the contract for the two sandbox
modes that replace the single "Run tools on this computer" switch. [design.md](design.md) still describes the
security boundary of Force (formerly "sandbox only"); nothing here loosens it.

## The two settings

| Setting (exact label) | Sentence shown under it | Effect |
| --- | --- | --- |
| **Use OpenWork Sandbox** | Gives the agent a separate, safe space on this computer for risky work. Your usual tools keep working. | Adds `sandbox_shell/read/write/edit/glob/grep` next to the normal tools. Nothing is removed. |
| **Force OpenWork Sandbox** | Everything the agent runs stays inside the sandbox. It can only reach this project and your authorized folders. | Today's sandbox-only: the six tools are replaced by guest versions under the same names, nothing falls back to the computer, and computer use, the built-in browser and MCP are blocked as in design.md section 4. |

- Force implies Use. Turning Force on turns Use on; turning Use off turns Force off.
- Both off is the default, and is exactly the behavior without the feature. Unlike the first release, having the
  rollout on no longer adds sandbox tools by itself: Use is opt-in.
- The organization can require Use and/or Force. A requirement locks that switch on the desktop with
  "Managed by your organization". The stricter of the local and organization choice wins.
- No jargon in the product: never "microVM", "bridge", "host", "fallback", "engine", "guest" in user-facing copy.
- Each switch shows its label and the one sentence above, on the desktop and in Den. This is a product decision for
  these two rows: people must be able to tell the two modes apart without opening help. It is the one place this
  feature departs from DESIGN.md P2 ("title or description, never both").

## Local storage (server-owned, engine-global)

`runtime_sandbox_settings` / `runtime_sandbox_applied_settings` hold `{ useSandbox: boolean, forceSandbox: boolean }`.

- A row written by the first release, `{ allowHostExecution }`, reads as
  `{ useSandbox: !allowHostExecution, forceSandbox: !allowHostExecution }`.
- A corrupt row reads as `{ useSandbox: true, forceSandbox: true }` (never grants more).
- Writes normalize: `forceSandbox` implies `useSandbox`.
- Force keeps the desired/applied split and the idle-boundary process restart from design.md section 6.
  Use needs no restart: it applies on the next message (tool catalog reload).

## Organization policy (Den)

| Requirement | Stored permission key | Delivered rule | Capability header the desktop sends |
| --- | --- | --- | --- |
| Force | `hostExecution: deny` (unchanged) | `host_execution` deny | `X-OpenWork-Sandbox-Only: 1` (unchanged) |
| Use | `sandboxOptOut: deny` (new) | `sandbox_opt_out` deny | `X-OpenWork-Sandbox-Modes: 1` (new) |

`resolveSandboxRequirement(rules)` in `@openwork/types/den/agent-permissions` returns `{ use, force, useSource, forceSource }`.

Older desktops:

- No header: `host_execution` keeps its existing conservative blocks. `sandbox_opt_out` is dropped: requiring Use
  restricts nothing, so a desktop that cannot run the sandbox keeps working.
- `X-OpenWork-Sandbox-Only` only (0.18.69 alphas): `sandbox_opt_out` is dropped (those builds reject unknown
  actions) and they already add the sandbox tools whenever the rollout is on, which is what Use requires.

## Effective mode

```
force = localApplied.forceSandbox || org.force || (signedIn && !orgPolicyVerified)
use   = force || local.useSandbox || org.use
mode  = force ? "only" : use && rolloutVerifiedOn ? "tools" : "off"
```

A Force requirement survives rollout loss (calls fail, the computer's tools do not come back). Use does not: with
the rollout off and only Use chosen, the mode is `off`.

## Server API (embedded OpenWork server)

### `GET /workspace/:id/sandbox-settings`

Answers from local state. It never waits for the network and never starts or probes the sandbox.

```ts
type SandboxSettingsResponse = {
  featureEnabled: boolean;        // last verified rollout state (false until first verification)
  useSandbox: boolean;            // saved local choice
  forceSandbox: boolean;          // saved local choice
  effectiveUseSandbox: boolean;   // what applies to new messages now
  effectiveForceSandbox: boolean; // what applies to current work now
  managedUse: boolean;            // organization requires Use (or Force)
  managedForce: boolean;          // organization requires Force
  pending: boolean;               // a Force change is saved and waits for current tasks
  // Organization/rollout check, refreshed in the background. "checking": no answer yet (or retrying after a
  // failure); "refreshing": a verified answer is being checked again, shown without any notice.
  verification: "verified" | "refreshing" | "checking" | "unavailable";
  // Compatibility with the first release:
  allowHostExecution: boolean;            // !forceSandbox
  effectiveAllowHostExecution: boolean;   // !effectiveForceSandbox
  managed: boolean;                       // managedForce
};
```

### `PUT /workspace/:id/sandbox-settings`

Body `{ useSandbox?: boolean; forceSandbox?: boolean }` (at least one), or the first release's
`{ allowHostExecution: boolean }`. Same approval and audit as before. Returns the same shape. Turning either
setting on starts preparing the sandbox in the background (prewarm).

### `GET /workspace/:id/sandbox-status`

In-memory, instant, read-only. It never starts the sandbox.

```ts
type SandboxStepId = "download" | "start" | "folders";
type SandboxStatusResponse = {
  mode: "off" | "use" | "force";
  state: "off" | "idle" | "preparing" | "ready" | "failed" | "unsupported";
  steps: { id: SandboxStepId; state: "waiting" | "active" | "done"; completedBytes?: number; totalBytes?: number }[];
  imageBytes: number | null;             // for "about X MB"
  imageSource: "bundled" | "download";  // packaged apps ship the image; source builds download it
  estimatedRemainingMs: number | null;
  startedAt: number | null;              // epoch ms of the current/last preparation
  readyAt: number | null;
  lastPrepareMs: number | null;
  folders: { path: string; access: "rw" | "ro"; kind: "workspace" | "folder" }[];
  error: { code: SandboxFailureCode; message: string; action: string | null; retryable: boolean } | null;
};
type SandboxFailureCode = "unsupported_platform" | "virtualization_unavailable" | "image_failed" | "start_failed"
  | "folders_failed" | "timed_out" | "unavailable";
```

`error.message` and `error.action` are plain sentences safe to show as-is (for example "This Mac can't run the
sandbox." / "It needs a Mac with Apple silicon.").

### `POST /workspace/:id/sandbox-status/prepare`

Starts (or restarts after a failure) preparation in the background and returns the status. Used by Retry.
Idempotent while a preparation is running. Collaborator scope; refuses when the mode is off.

## Lifecycle

- **Prewarm.** Preparation starts when a setting is turned on, when the app starts with a setting on, and when a
  message is about to run in a project whose sandbox is not ready. Opening Settings never starts it.
- **Warm across chats and restarts.** One sandbox per project is kept by the server for all chats and across the
  process restart that a Force change needs. The image is cached on disk after first use.
- **Folders.** When the authorized-folder list changes, the sandbox is replaced after the running command finishes
  and prepared again right away, so the next command does not pay for it. The same paths are used inside.
- **First command.** A sandbox command that arrives before Ready waits for it (bounded) instead of failing.
- **Failure.** Plain message plus Retry. In Force nothing runs on the computer instead.
- **Mid-chat changes.** Use applies on the next message; calls already made keep working. Force applies when
  current tasks finish; until then the saved choice and the still-active mode are both shown. No red errors.

## Chat

- Tool results that ran in the sandbox carry `metadata.sandbox === true`; the chat marks them with a quiet
  "Sandbox" tag.
- While a sandbox command waits for the sandbox to become ready, the chat shows the current step
  ("Starting the sandbox…") instead of an error.
