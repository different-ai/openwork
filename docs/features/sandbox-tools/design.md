# Sandbox tools: design

Status: draft for review, 2026-11-17. Feature `sandboxTools`, off by default. Author: `benjaminshafii`.

This designs "sandbox as a tool" for OpenWork: the agent keeps its usual shell on this computer and gets extra tools
that run commands, read and write files and preview a web app inside a sandbox. The sandbox is a local microVM
(microsandbox) or a cloud sandbox (Freestyle VM or Daytona), chosen by setup.

Section 12 says what was measured, what was read and what is unverified. Section 14 records where the two models
that worked on this design disagreed and how each point was settled.

## 1. Decisions

| Question | Decision |
| --- | --- |
| Shape | Extra tools: `sandbox_bash`, `sandbox_job`, `sandbox_read`, `sandbox_write`, `sandbox_preview`, `sandbox_status`. The agent's usual tools stay on this computer. |
| Contract | The existing `@openwork/sandbox` provider contract, unchanged. microsandbox is one more adapter, `packages/sandbox-microsandbox`. |
| Where the tools run | In the OpenWork server process, behind the loopback bridge the v2 engine already uses for browser and computer tools. Never inside the engine or a plugin bundle. |
| Engine | OpenCode v2 only. The v1 engine does not list the tools (section 4.1). |
| Flag | `sandboxTools`, category `computerUse`, cloud and self-hosted, off. |
| Provider choice | An organization setting in Den is the upper bound. A per-workspace setting on this computer can only narrow it. Nothing is read from files in the workspace. Checked on every tool call. |
| Provider keys | Held by the server in its encrypted vault, or by Den. Never in the environment, the workspace or the sandbox. |
| Secrets used inside the sandbox | Not in v1, for any provider. The later design is a host-side swap of a placeholder, and section 6.4 lists what must be true first. |
| Failure | The tool returns an error that names the reason and says whether the command started. No command runs on this computer in its place and no other sandbox is tried. |
| External sandbox protocol | Adopt its security model now. Do not speak its wire protocol in v1. A client adapter can come later behind the same contract. No server is planned. |

## 2. Scope

In scope for v1:

- The six tools, on the v2 engine, behind `sandboxTools`.
- Local microVM through microsandbox on Apple Silicon macOS and Linux with KVM.
- Freestyle and Daytona through the adapters that exist, with a member-held key.
- One organization setting and one per-workspace setting.

Not in v1:

- Replacing the agent's own tools with sandbox versions (the "sandbox-only" posture). Section 8.3 says how close an
  organization gets with what exists.
- Windows. microsandbox's Windows support is a preview.
- Speaking or serving the external sandbox protocol.
- Secrets injected into a sandbox.
- Mounting folders other than the workspace folder, and copying folders to or from a cloud sandbox.

## 3. What exists today

- **`@openwork/sandbox`** (`packages/sandbox/src/provider.ts`, `blocks.ts`): one provider contract with `create`,
  `find`, `get`, `inspect`, `start`, `stop`, `destroy`, `exec`, `endpoint`, and optional blocks `run`, `files`,
  `pause`, `activity`, `snapshots`. `SandboxPlatform.isolation` already includes `microvm`. `lifecycle.ts` has
  `ensureRunning`, `withBlocks`, `sandboxName` and `destroyScope`. `testing/` has conformance cases and a fake provider.
- **Adapters**: `packages/sandbox-daytona` (signed preview URLs, containers unless a VM class is configured),
  `packages/sandbox-freestyle` (stop is a pause, no detached exec, firewall must be given),
  `packages/sandbox-differently` (a gateway that holds provider keys itself).
- **A sandbox bash tool already exists for Workbot**: `ee/packages/headless-computer/src/computer.ts` gives each
  conversation a Linux computer with `bash` and `look` on top of `@openwork/sandbox`. It is under the EE licence, so
  `apps/server` reuses its patterns (long commands as guest jobs, a call key so a repeated call is not run twice)
  and not its code.
- **Engine tools**: on v2, tools reach the engine through `openwork-context-v2.ts`, which calls a loopback bridge in
  the server (`opencode-v2-browser-bridge.ts`). On v1, plugins are files listed in `openwork-runtime-config.ts`;
  that file is the same for every workspace on purpose.
- **Den to server settings**: `/v1/me/desktop-config` (`desktopConfigSchema` in
  `packages/types/src/den/desktop-policies.ts`) already carries non-boolean organization settings. The server reads
  it with the member's session in `apps/server/src/managed-desktop-policy.ts`. The boolean policy catalog in the same
  file has enforcement off and is not the carrier for this.
- **Per-workspace settings**: typed tables in the server's `runtime.sqlite` (`workspace-kv-store.ts`;
  `workspace-default-model.ts` is the model to copy). `.opencode/openwork.json` in the workspace is legacy: read once
  to seed the database, never written.
- **Secrets**: the server's encrypted vault (`local-managed-mcp.ts`, key wrapped by Electron `safeStorage`, or
  `OPENWORK_ENCRYPTION_KEY` where there is no desktop). The v2 inference proxy (`opencode-v2-inference-proxy.ts`)
  already gives the engine a placeholder key and swaps in the real one on the host. The v1 engine inherits the
  server's whole environment (`managed-opencode.ts:236-244`).
- **Earlier microsandbox work** (`examples/microsandbox-openwork-rust`, `packaging/docker/Dockerfile.microsandbox`)
  ran the whole OpenWork server inside a microVM with the Rust crate at 0.6.8. It is the other direction and is not
  reused. `sandboxBackend`, `sandboxRunId` and `sandboxContainerName` in `packages/types/src/workspace.ts` come from
  it. This design does not set them: any value but `none` makes the app treat every file of the workspace as remote
  (`resolve-open-target.ts:131-137`), which is wrong when only some tools are sandboxed.

## 4. Tools and where they run

### 4.1 Placement

```
agent (v2 engine)
  └─ openwork.context plugin ── loopback, bearer token ──▶ sandbox bridge (server process)
                                                            ├─ check flag and settings (Den, then workspace)
                                                            ├─ @openwork/sandbox provider
                                                            │    ├─ microsandbox adapter ─▶ msb child process ─▶ microVM
                                                            │    ├─ freestyle adapter ───▶ Freestyle API
                                                            │    └─ daytona adapter ─────▶ Daytona API
                                                            └─ vault (provider keys)
```

- The tool definitions live in `apps/server/src/opencode-plugins/openwork-sandbox.ts`, in the same plain-object shape
  as `openwork-computer-use.ts`. Their `execute` calls the tool host through a bridge, as the browser and computer
  tools do.
- The tool host (`apps/server/src/sandbox-tools.ts`) runs in the server process. It is the only place that holds a
  provider, a key or a resolved setting.
- The microsandbox SDK is a native addon. A plugin bundle cannot carry one (bundles are single ESM files and the
  packaged resource filter keeps only `*.js` and `*.wasm`), so the addon loads in the server, on first use.
- **v2 only.** The v1 engine inherits the server's environment and its config must be the same for every workspace.
  Offering sandbox tools there would need a second registration path and would put any key that reaches the
  environment within reach of the agent's shell. v2 is the default engine. On v1 the Settings entry says the sandbox
  needs the current engine.
- **Listed or not** is decided per prompt with the mechanism the retired `computerUse` gate used
  (`session.hook("prompt")`, then `tool.reload()`): the tools are listed when the flag is on and the resolved
  provider for the workspace is not `off`.
- **Allowed or not is decided again in the server on every call**, including `sandbox_read` and `sandbox_preview`.
  Listing is a convenience for the model. A tool that is still listed after the flag or a setting changed returns
  the error.

### 4.2 The tools

All take the calling conversation and the engine's call id from the engine context, never from arguments. Arguments
are flat Zod shapes without `$ref` or unions, as `provider-safe-tool-schema.ts` requires.

| Tool | Arguments | Result |
| --- | --- | --- |
| `sandbox_bash` | `command`, `description`, `cwd?`, `timeout_seconds?` (1 to 300, default 120), `background?` | `exit_code`, `stdout`, `stderr`, each capped at 64 KB with a marker when cut. With `background`, a job id. |
| `sandbox_job` | `job`, `stop?` | Whether the background job is running, its exit code when it ended, and the end of its log. With `stop`, ends it first. |
| `sandbox_read` | `path`, `offset?`, `limit?` (lines, from 1) | Text of a file inside the sandbox, at most 256 KB a call. Says so when the file is binary or absent. |
| `sandbox_write` | `path`, `content` (at most 1 MB) | Writes a text file inside the sandbox, creating parent folders. |
| `sandbox_preview` | `port` | `url`, `expires_at`, `kind`. Only for the ports the sandbox was created with. |
| `sandbox_status` | none | Provider, isolation (`microvm`, `vm` or `container`), state, the folders the sandbox can see with read or write access, what it can reach on the network, the preview ports, running jobs. |

- **Bash is required in the image.** The adapters run commands through `sh`, which is what the contract's `run`
  block promises. The tool host wraps the command in `bash -c`, as `headless-computer` does. An image without Bash
  is reported once, when the sandbox is created, as unavailable.
- **Working folder**: `/workspace` when the workspace folder is mounted, else `/work`, a folder on the sandbox's own
  writable disk. With the default read-only mount, anything that writes (installing packages, building) is done on
  a copy: `cp -a /workspace /work/project`. The tool description says so, and `sandbox_status` shows which folders
  are writable. Results come back to this computer as text through `sandbox_read` and the agent's own edit tool,
  or directly when the person chose a read-write mount.
- **300 seconds** is Freestyle's limit for one command and the limit `headless-computer` uses. Longer work uses
  `background`: the command is started detached inside the guest with its output and exit code in files under
  `/work/.jobs/<job>`, the pattern `commandScript` in `headless-computer` uses. This works on every adapter because
  none needs `detachedExec`. Job ids are random and listed per sandbox, so two conversations do not collide.
- **A repeated call is not run twice.** The tool host keeps the result of each engine call id for a short time and
  returns it when the same call arrives again, as `headless-computer`'s call key does.
- **Preview ports are fixed at create** for microsandbox and Freestyle. v1 creates each sandbox with a short list
  from the settings (default 3000, 5173, 8000, 8080). Asking for another port is an error that lists the ones
  available.
- **Descriptions are static.** What this sandbox can see and reach differs per workspace, and the engine's tool list
  must not. `sandbox_status` carries the per-workspace facts.
- **No approval prompt** for sandbox commands. What the sandbox may touch is granted once, in the settings, by the
  person and the organization. A prompt per command would add nothing to that grant.
- **Output is untrusted.** Each description says that text coming back from the sandbox is data, not instructions.

### 4.3 One sandbox per workspace and identity

- **Name**: `sandboxName(scope, "tools", workspaceId)` from `lifecycle.ts`, where `scope` is a hash of the install
  id, the Den URL, the organization and the member (or `local` when signed out). A sandbox made under one sign-in is
  never reused under another. Labels carry the scope and a fingerprint of the resolved settings.
- Conversations in the same workspace share the sandbox, as they share the workspace folder today. A local microVM
  costs real memory (512 MB to 2 GB), so one per conversation is not the default.
- **Settings changed**: before each call the host compares the fingerprint. On a mismatch it stops the sandbox and
  returns `sandbox_needs_reset`. It does not delete anything on its own: the person resets the sandbox in Settings,
  where the screen says its files will be removed. A sandbox is never left running with a wider network or folder
  list than the settings now allow, and microsandbox keeps a sandbox's original configuration when it starts again.
- **One transition at a time**: create, start, stop and reset of a workspace's sandbox are serialized. Commands run
  concurrently; a reset waits for them or is refused while they run.
- **Idle stop** after 15 minutes (`lifecycle.autoStopMinutes`); the disk is kept. A stopped or crashed sandbox is
  started again on the next call and the result says that background jobs are gone. That is the same sandbox with
  the same isolation, not a fallback. `ensureRunning` does not start a sandbox in the `error` state, so the tool
  host calls `start` for it once and reports the failure if it does not come up.
- **Nothing outlives its permission**: sandboxes are stopped when the app quits, when the person signs out, and
  when a check of the settings fails. On start the server lists sandboxes by scope label and stops any that the
  current settings no longer allow. The idle timer is the backstop if the app is killed.
- Removed when the workspace is removed, when the person resets it, and by `destroyScope` on uninstall.

## 5. Adapters

### 5.1 `packages/sandbox-microsandbox` (started, see section 11)

`createMicrosandboxProvider(options, deps): SandboxProvider`, a plain object of closures like its siblings.

```ts
type MicrosandboxProviderOptions = {
  image: string                                   // OCI image
  network: { egress: "none" } | { egress: "allow-list"; domains: readonly string[] }   // required, no default
  mounts?: readonly { hostPath: string; guestPath: string; access: "ro" | "rw" }[]
}
```

- **Folders and network belong to the provider's options, not to `SandboxSpec`.** The host builds the provider from
  the settings; the job that asks for a sandbox cannot widen its own access. Freestyle's adapter does the same with
  `firewall`. The shared contract is unchanged.
- **Two layers.** `provider.ts` maps the contract onto a small plain-data `MicrosandboxDriver`. `native-driver.ts`
  maps the driver onto the `microsandbox` SDK and imports it on first use. Tests replace the driver, so the whole
  contract mapping runs in milliseconds without a VM, and the live test runs the same cases on real microVMs.
- **Local only.** The SDK can also drive microsandbox's hosted service and picks its backend from process-wide
  state. The driver pins the backend to this computer when it loads and refuses any handle that is not local.
- **Capabilities**: `platform: { os: "linux", isolation: "microvm" }`, `stopResume`, `endpointKind: "stable"`,
  blocks `run`, `files`, `pause`. No volumes, no detached exec, no snapshots, no memory restore on a cold start.
- **Identity**: the reference is `{ sandboxId, name }`. microsandbox changes the id when a name is removed and
  created again, so an old handle answers `not_found` and never reaches the replacement.
- **Network is always set.** microsandbox allows all outbound traffic when no policy is given (measured). The
  adapter sets deny-by-default egress every time. `egress: "none"` with no preview ports creates the VM with no
  network interface at all. An allow-list permits TCP 80 and 443 to exact host names, turns on TLS interception
  (microsandbox can only enforce a host name on HTTPS when it can read the request; measured), and turns on DNS
  rebinding protection so an allowed name cannot resolve into this computer's own network.
- **Previews**: guest ports are published on `127.0.0.1` at a free host port chosen at create and recorded in a
  label. A port taken in the meantime is chosen again, three times at most. `endpoint` returns
  `http://127.0.0.1:<port>`, kind `stable`.
- **A failed create leaves nothing behind.** Creation still running at the deadline is called off (measured: no
  sandbox remains). A sandbox that failed to start keeps its name in microsandbox (measured), so the driver removes
  it only when a per-attempt ownership label matches. A preflight name check alone would race another creator.
- **Refused, not ignored**: storage attachments, public endpoints, auto-pause, auto-archive, auto-delete, mount
  paths that are relative, not normalized or a root, wildcard hosts, IP addresses as hosts, an empty allow-list,
  PowerShell, detached exec, maintenance commands (microsandbox counts every command as activity).
- **Errors**: microsandbox error codes map to the contract's taxonomy in `errors.ts`. A missing runtime is
  `invalid_state` and not retryable. Other start failures (for example no access to the hypervisor) arrive from the
  SDK without a code of their own and surface as `unknown` with the SDK's message. The tool host reports both as
  unavailable.
- **No secrets option.** Section 6.4.

### 5.2 Freestyle and Daytona (work to do)

Both adapters exist. What sandbox tools need from them:

| Need | Freestyle | Daytona |
| --- | --- | --- |
| Network setting | `firewall` is already required. Map `none` to no rules. Mapping an allow-list of hosts needs checking against Freestyle's rule format. | The adapter passes no network options today. Add block-all and the host allow-list the current API offers. |
| Isolation shown to the person | `vm` | `container` unless the VM class is configured; `platform` is already explicit in the adapter's config. |
| Preview | A stable public URL at an unguessable host, fixed at create. Anyone holding the link can open it. | Signed preview URL with a short lifetime, which the adapter already uses. Never the standard preview token: it opens every port of the sandbox, including its command API. |
| One command | 5 minutes at most; `background` for longer. | No such limit; the same 300 second cap applies for consistency. |
| Workspace folder | Cannot be mounted. The sandbox starts empty; code arrives by `git clone` from an allowed host. | Same. |
| SDK | `freestyle` 0.2.13 is pinned; 0.2.23 is current. | `@daytonaio/sdk` ^0.214.0 is pinned; the docs now name `@daytona/sdk`, both at 0.232.0. The public repository is frozen since June 2026. |

A provider that cannot enforce the requested setting is a configuration error. The sandbox is not created with a
wider network, a weaker isolation or a more public preview than the settings allow.

SDK upgrades are separate changes with their own live conformance runs. They are not part of this feature.

## 6. Provider choice and credentials

This is the open question. The proposal: three layers for the choice, checked on every call, and a rule for each
kind of secret.

### 6.1 Who decides, in three situations

| Situation | Flag | Bound | Workspace setting |
| --- | --- | --- | --- |
| **Signed in to an organization** | `/v1/org` `features`, read with the member's session, as `remoteComputersEnabled()` does | The organization's `sandbox` setting. No setting means nothing is allowed. | Narrows the bound |
| **Signed out** | `/v1/features`, the deployment's view for people without an organization, as `add-a-feature` prescribes | None: the person is their own administrator | Stands alone; default `off` |
| **Cannot be verified** (Den unreachable, sign-in changed during the read) | Off | — | Not used |

### 6.2 The organization setting

One typed setting, `sandbox`, stored under `organization.metadata` and edited through
`GET/PUT /v1/org/sandbox-settings` (permission `organization.update`, `requireFeature("sandboxTools")`), following
`automation-settings.ts` end to end. Den projects it into `/v1/me/desktop-config`.

```ts
// packages/types/src/den/sandbox-settings.ts
{
  providers: ("microsandbox" | "freestyle" | "daytona")[]   // allowed; empty means none
  defaultProvider: "microsandbox" | "freestyle" | "daytona" | null
  isolation: ("container" | "vm" | "microvm")[]               // allowed kinds; no ordering is assumed
  workspaceAccess: "none" | "read" | "read-write"             // most the local sandbox may get of the workspace folder
  network: { egress: "none" } | { egress: "allow-list"; domains: string[] }   // most a workspace may open
  previews: "off" | "this-computer" | "links"                 // "links" allows Freestyle's public and Daytona's signed URLs
  image: string | null                                        // digest-pinned; null uses OpenWork's
}
```

Every field the workspace can set has a bound here. There is no way to mount a folder other than the workspace
folder, so there is nothing to bound for other folders. `workspaceAccess` applies to the local sandbox only; cloud
sandboxes never see the folder.

### 6.3 The workspace setting and how it is enforced

A typed table in the server's `runtime.sqlite`, `workspace_sandbox_settings`, keyed by workspace and by the same
identity scope as the sandbox name:

```ts
{ provider: "off" | "microsandbox" | "freestyle" | "daytona", workspaceAccess, network, previewPorts }
```

- **It can only narrow.** One of the allowed providers or `off`; less of the workspace; a subset of the allowed
  hosts; previews only where allowed. A value outside the bound is an error shown to the person, not a silent clamp.
- **Who writes it.** The Settings screen asks the Electron main process, which holds the host token and calls a
  host-token route on the server. The renderer and the engine do not hold that token. This is a boundary on the
  API, not on the file: see 6.5.
- **Checked on every tool call.** The tool host resolves flag, bound and workspace setting before each call. It
  uses a dedicated reader bound to the current sign-in, modelled on `fileSendPolicy()`, not the cached
  `current()` policy. To avoid a Den round trip per command the verified answer is reused for at most 60 seconds;
  after that a fresh read is required, and a failed read means unavailable. A revoked permission therefore stops
  the tools within a minute, and stops the sandbox (4.3).
- **Defaults** when a provider is on and nothing else is chosen: workspace folder read-only at `/workspace`, no
  network, previews on this computer only.
- **The mounted folder** is the workspace root the server has on record, as a real path. The server refuses to
  mount a path that is, contains or is inside its own data folder, microsandbox's home, the vault or the user's
  home folder itself. microsandbox refuses a host path that passes through a symlink (measured). A symlink inside
  the mounted folder resolves inside the guest's own filesystem, not on this computer.

### 6.4 Credentials

| Secret | Where it lives | Who can read it |
| --- | --- | --- |
| Freestyle or Daytona key, v1 | The server's encrypted vault, in entries scoped to the Den URL, organization and member. Typed through a secure field. | The tool host in the server. |
| Freestyle or Daytona key, organization-managed (later) | Den. For Freestyle, Den creates the VM and gives the desktop an identity token scoped to it. For Daytona, calls go through a Den-side broker; `sandbox-differently` is already an adapter of that shape. | Den. The desktop holds a short-lived, scoped token or none. |

- **The vault is shared code, not a copy.** The encryption, key handling and recovery in `local-managed-mcp.ts`
  move into a module both stores use. Where there is no desktop key store, `OPENWORK_ENCRYPTION_KEY` provides the
  key as it does today; without either, cloud providers are unavailable.
- **No provider key in the environment.** `computer-targets.mjs` reads `FREESTYLE_API_KEY` and `DAYTONA_API_KEY`
  from the Electron environment for remote computers today. Sandbox tools do not copy that.
- **No secret into a sandbox in v1**: not in `SandboxSpec.env`, not in `run` env, not in a file. The tool host
  refuses an environment variable whose value equals a vault entry, and keeps keys out of error text and logs.

**Secrets used inside the sandbox come later**, as a host-side swap: the sandbox holds a placeholder and the host
puts the real value on requests to named hosts. It was tried on the local microVM and it works (section 12). It is
not shipped, and the adapter has no option for it, because three things are not yet true:

1. **The value must not sit in plain text on this computer.** microsandbox wrote a secret given as a value into its
   database under `MSB_HOME`, and it was still in the write-ahead log after the sandbox was destroyed (measured).
   Owner-only permissions do not help against the agent's own shell. The adapter must use microsandbox's reference
   forms (a host environment variable or its secret store), and that must be checked the same way.
2. **A swap protects the value on the way out, not on the way back.** A host that echoes the header returns the
   real value to the sandbox; the trial did exactly that with an echo service. So: only hosts the organization
   lists for that secret, one named header, verified TLS identity, and narrowly scoped tokens. The external sandbox
   protocol adds method and path limits and redacts echoed values; microsandbox has neither today.
3. **The organization setting needs a grant for it**: which secret may go to which host.

For cloud sandboxes the swap needs a proxy outside the sandbox. The path is a Den-side egress proxy (the Gateway
already keeps provider keys and an egress allow-list), with the sandbox's firewall allowing only that proxy.

### 6.5 What "trusted" means here

There is no place on this computer the agent's own shell cannot reach: it runs as the same user.

- Settings are **never read from files in the workspace** (`.opencode/openwork.json`, `opencode.json`). The agent
  writes those.
- The organization's bound is **verified with Den for the current sign-in and held in memory**. That is the
  strongest tier this codebase has, and it is the one that decides what is allowed.
- The workspace setting is **in the server's database behind a host-token route**. That keeps it away from the
  agent's tools and from anything that only speaks the client API. It is not protection against a program run as
  the same user: a command in the host shell could open the database file. Because the workspace setting can only
  narrow the organization's bound, the worst such a command achieves in a managed organization is what the
  organization already allowed.
- Signed out, there is no bound, so the workspace setting is only as strong as the user's account on this computer.
  That is the same strength as everything else a signed-out person configures.

## 7. Should OpenWork speak the external sandbox protocol?

Source: Prime Radiant's
[External sandboxes for coding agents](https://blog.primeradiant.com/external-sandboxes-for-coding-agents/), its
[PROTOCOL.md](https://github.com/prime-radiant-inc/external-sandbox/blob/main/PROTOCOL.md) (revision 1), and Simon
Willison's write-up of it.

What the pattern is: the agent runs on the host and talks to a sandbox server on localhost. The guest sees only
mounted folders, read-only or read-write. The network is off unless an HTTP(S) allow-list proxy is on. The proxy
swaps a placeholder for a secret the host holds. A web page edits the proxy's policy. Pi replaces all its tools with
sandbox versions and fails closed; Claude Code only redirects Bash; Codex uses its exec-server.

What the protocol is: loopback HTTP with `GET /health`, `GET /mounts`, `POST /exec` (one Bash script, 30 seconds by
default and 300 at most), a streaming `/exec/ws`, and a `/codex` WebSocket that follows the experimental exec-server
format of Codex CLI 0.164.0 for processes and files. Mounts are fixed when the server starts. A credential rule
replaces a whole request header that equals the placeholder, on HTTPS only, never in a body.

**Decision: take the model, not the wire, in v1.**

| The pattern asks for | In this design | Gap |
| --- | --- | --- |
| Only mounted folders are visible, read-only or read-write | The workspace folder on the microsandbox provider; read-only by default | None for the local microVM. Cloud sandboxes have no mounts. |
| Network off by default, HTTP(S) allow-list | `network` is required; deny by default; exact host names on 80 and 443 with TLS interception | The protocol's rules can also limit methods and paths. Here a rule is a host. A plain TCP connection to an allowed host on port 80 was accepted (measured), so "HTTP only" is not established. |
| Resolved addresses checked and pinned | DNS rebinding protection on; other names do not resolve; direct IP connections refused (measured) | Pinning for the life of a connection is not verified. |
| Placeholder swapped for a host-held secret | Not in v1 (6.4) | Echo redaction and method and path limits do not exist in microsandbox. |
| A page to edit the policy | The workspace's sandbox settings in the app, bounded by the organization | No activity log of allowed and denied requests yet. |
| Resource limits | CPU, memory and disk from `SandboxSpec.resources`; idle stop | No cap on output held in memory beyond the tool's own 64 KB cut. |
| Fail closed | Section 8 | |

Why not the wire now:

- **It was published on 16 November 2026 as an experimental, unaudited prototype.** Revision 1 has no version
  negotiation, and its file and process endpoint copies an experimental Codex format.
- **It has no lifecycle.** There is no create, stop or destroy, no preview ports, no per-sandbox settings. OpenWork's
  contract has all of them, and Freestyle and Daytona need them.
- **Local callers are not authenticated.** Any process on the computer may run commands in the guest. That fits a
  sandbox one person starts by hand. It is weaker than the per-bridge bearer tokens OpenWork already uses.
- **The local microVM is driven in-process.** Speaking HTTP to a second local server would add a moving part
  without closing any of the gaps in the table.

What stays open:

- **As a client, later**: `packages/sandbox-external`, an adapter that maps `run` to `POST /exec` and `files` to the
  `/codex` file calls. Such a sandbox belongs to whoever started the server, and the adapter has to say so: it
  cannot create, stop, reset or size it, it has no stable identity beyond the URL, and its mounts and network are
  whatever `/health` and `/mounts` report. The organization setting would need a separate entry for it, since none
  of the bounds in 6.2 can be enforced on a server OpenWork does not own. Do it when the protocol has a second
  revision or people ask, pinned to a revision and run against the published conformance suite.
- **As a server: not planned.** The core profile could be served without the optional browser terminal. It would
  still mean owning the Codex endpoint and the origin rules so that other agents can use OpenWork's sandbox, and
  nobody has asked for that.

## 8. Failure behaviour and security

### 8.1 Nothing runs on this computer in the sandbox's place

What guarantees it:

1. **The tool host is given a `SandboxProvider` and nothing that can run a process.** Its dependencies are passed
   in: a provider factory, the settings reader, the vault. It has no route to the server's shell helpers. A test
   that reads the module's imports for `node:child_process` is a tripwire against a careless edit; it is not the
   guarantee.
2. **One provider per call.** The provider resolved from the settings is the only one used. A failure never selects
   another provider.
3. **Settings that cannot be verified mean unavailable** (6.1, 6.3).
4. **A command is dispatched once.** The host never retries a command. A repeated engine call id returns the first
   result (4.2).

Two kinds of failure, and the tool says which:

| Kind | When | The result says |
| --- | --- | --- |
| **Did not start** (`sandbox_unavailable`, `sandbox_needs_reset`, `invalid_arguments`) | Flag or setting does not allow it; settings could not be checked; this computer cannot run a microVM; the image cannot be pulled; a key is missing or refused; quota; the provider is down; the sandbox could not be created or started | The command did not run. Do not run it on this computer instead. Tell the person. |
| **Outcome unknown** (`sandbox_timeout`, `sandbox_interrupted`) | The command was sent and its time ran out, or the connection dropped | The command may have run, in part or fully, inside the sandbox. Check before running it again. Do not run it on this computer instead. |

On the local microVM a command past its time is ended (measured), and the result says so. The contract does not
promise that for every provider, so the wording stays "may have run".

Other cases: flag off or provider `off`, the tools are not listed; a stopped or crashed sandbox is started again and
the result says background jobs are gone; changed settings give `sandbox_needs_reset` (4.3).

What this cannot do: stop the agent from choosing its own host shell after an error. The host shell is a separate
tool that this design leaves in place.

### 8.2 What the sandbox protects, per provider

| | Local microVM | Freestyle | Daytona |
| --- | --- | --- | --- |
| Isolation | Hardware VM with its own kernel | VM | Container sharing a host kernel, unless the VM class is configured |
| Files of this computer | Only the workspace folder, if given | None | None |
| Network | None, or exact hosts | Provider firewall | Provider network rules |
| Preview | Loopback on this computer | Public link, unguessable | Signed link, short-lived, one port |
| Keys | None needed | Vault or Den | Vault or Den |

### 8.3 What it does not protect

- **The agent still has this computer.** Extra sandbox tools do not sandbox the agent. A prompt injection can ask it
  to read a file here and send it from the sandbox, or to run on this computer a file the sandbox produced. Text
  moves between the two through the model.
- **A read-write folder is a way back.** Whatever runs in the sandbox can change those files, and this computer may
  run them later. Read-only is the default for that reason.
- **Allowed hosts are an exit.** Anything the sandbox can read can be sent to a host on the allow-list.
- **TLS interception changes what the guest trusts.** With an allow-list the guest trusts a certificate authority
  made for that sandbox, whose key stays on this computer. Clients that pin certificates fail. Without an allow-list
  there is no network and no interception.
- **A preview runs in a browser on this computer.** The page comes from the sandbox, and its scripts run outside
  the sandbox's network rules, with whatever the browser can reach. Open previews in OpenWork's built-in browser,
  not the person's own profile; do not open them automatically; treat the page as untrusted. Freestyle links are
  public. Daytona links are signed and expire.
- **Other programs on this computer** can read the server's database and microsandbox's home folder (6.5).
- **Conversations in one workspace share the sandbox**, including its files and background jobs.

For an organization that wants commands to run only in the sandbox: turn `sandboxTools` on and add agent-permission
rules that deny or ask for the `shell` action. That narrows one route. App scripting, computer use and connected
MCP tools are others, each with its own permission. A true sandbox-only agent, where the file tools are replaced as
well, is the follow-up, and Pi's integration shows what it looks like.

## 9. Flag

`packages/features/src/flags/sandbox-tools.ts` declares `sandboxTools`: category `computerUse`, cloud and
self-hosted, default off, internal doc `docs/features/sandbox-tools/README.md`. `add-a-feature` asks for the flag to
be declared before any feature code, so it exists now and does nothing yet; the README says so.

- **Read** by the server as in 6.1. Den routes for the setting use `requireFeature("sandboxTools")`. The renderer
  adds the key to `DesktopFeatureKey` and shows the Settings entry locked with a plain reason when the flag is off
  (DESIGN.md P4).
- **Kill switch**: the tools stop being listed from the next prompt and are refused in the server within the
  60 second window of 6.3. A running command finishes in the sandbox. Sandboxes are stopped and keep their disks.
  Settings stay stored. Nothing moves to this computer.
- **Usage**: the tool host marks the feature used on a successful `sandbox_bash`, never on listing.
- **Not flags**: the provider choice and the network setting. They change how the feature works, not whether a
  person gets it, so they are settings.

## 10. Test plan

Following `verify-openwork`: a rule or pure logic gets a test next to the code; something a person does end to end
gets a proof; every proof fails on `dev` and passes on the branch.

| Layer | What it proves | How |
| --- | --- | --- |
| Adapter, offline (done) | The contract mapping: idempotent create, stale handles, refusals, state mapping, error codes, port retry, settings passed through unchanged | `pnpm --filter @openwork/sandbox-microsandbox test` (23 cases, including the provider conformance suite and the `files` and `pause` block cases on an in-memory guest) |
| Adapter, live (done locally) | Real microVMs: both conformance suites, mounts, no network, loopback preview, allow-list, called-off create, port conflict, timeout | `MICROSANDBOX_LIVE=1 MSB_HOME=<short path> pnpm --filter @openwork/sandbox-microsandbox test:live` (18 cases) |
| Adapter, races | Concurrent first calls share one connection; a stop during a connect does not leave a stale connection | A driver test with a controllable fake SDK; not written yet |
| Settings resolution | The three situations of 6.1; the workspace can only narrow; outside the bound is an error; a failed or stale read is unavailable; a sandbox of another sign-in is not reused | Unit tests next to the resolver, as tables |
| Tool host | 8.1: no provider substitution, did-not-start against outcome-unknown, call-id replay, `needs_reset` on a changed fingerprint, serialized reset against running commands, crash then restart, output caps, no key in any error | `apps/server/test/sandbox-tools.vitest.test.ts` with `createFakeProvider` from `@openwork/sandbox/testing` |
| Bridge | A wrong token is refused; a call for a workspace whose settings were revoked is refused even though the tool is still listed | Same file, against the real bridge on loopback |
| Tool schema | Flat arguments that every model provider accepts | Same shape as `computer-use-tools.vitest.test.ts` |
| Den | Only `organization.update` can change the setting; `feature_disabled` when off; the projection into `/v1/me/desktop-config`; the kill switch | `ee/apps/den-api/test/api/sandbox-settings.api.test.ts` |
| Runtime | The native addon loads where the server really runs | The live cases under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), as `run-tests` asks, and once in a packaged build on macOS and Linux |
| Freestyle and Daytona | The network mapping and previews | Their `test:live` suites, extended with a "no network" and a "preview" case |

The proof, `evals/proofs/sandbox-tools.proof.test.ts`, written with `write-a-spec`:

- **World**: `appWeb` and `den`, a scripted model that calls the tools, the flag turned on with
  `enableOrganizationCapabilities(seed, admin, { sandboxTools: true })`. It declares `needs()` for a machine that
  can run a microVM.
- **before**: with the flag off, the person asks the agent to run a command in the sandbox; the agent has no such
  tool. Screenshot.
- **when**: the administrator allows the local microVM for the organization; the person chooses it for the workspace
  in Settings.
- **then, with independent witnesses**: the seed writes a random value to a file on this computer outside the
  workspace and another inside it. Through `sandbox_bash` the person sees the value from inside the workspace and
  "No such file" for the one outside. The kernel boot id read in the sandbox differs from the host's. Neither
  relies on what `sandbox_status` reports or on the word "Linux".
- **boundary 1, no fallback**: the workspace is set to Daytona with no key. The person asks the agent to create a
  file named by the test. The tool shows `sandbox_unavailable`. Witness: the file does not exist on this computer.
- **boundary 2, no network**: a fetch of a public URL fails in the sandbox while the same fetch from the host works.
- **boundary 3, permissions**: a member without `organization.update` cannot change the organization setting.
- **boundary 4, revocation**: the administrator removes the provider while a sandbox is running; the next call is
  refused and the sandbox is stopped.
- Each step records `recordAssertionEvidence` with the observed text; one screenshot per visible beat. Before
  pushing: `pnpm --dir evals lint:specs` and `pnpm --dir evals design:review -- --test-run latest`.

Placement follows `run-tests`: the CLI decides and its `placement:` line goes in the report. A microVM needs KVM or
Apple Silicon. Where the placement has neither, the proof reports `skipped — needs: KVM`, and the overall verdict is
Incomplete, not Passed. Whether the Daytona and Freestyle eval hosts expose nested virtualization is not known
(section 13).

`pnpm check` before any push. New outbound hosts (image registry, Freestyle, Daytona, the runtime download if
chosen) are declared in `docs/enterprise/outbound-access.json`, which the `outbound-access` check enforces.

## 11. Code started in this branch

This PR contains the design and an unwired adapter foundation. The flag is off; no production configuration is changed.

- `packages/sandbox-microsandbox/`: the adapter (`provider.ts`, `driver.ts`, `native-driver.ts`, `errors.ts`,
  `index.ts`), its offline tests and its live tests. Depends on `microsandbox` 0.7.15, pinned exactly because the
  project is in beta.
- `packages/features/src/flags/sandbox-tools.ts` and the regenerated `all-flags.ts`.
- `docs/features/sandbox-tools/README.md` (the flag's internal doc) and this file.
- `pnpm-lock.yaml`: the new package and its dependency.

Not started: the tool host, the tool definitions, the bridge, the settings in Den and in the server, the Settings
screen, the Freestyle and Daytona network mapping, packaging of the runtime. No CI workflow runs the adapter's
tests yet; `quick-check.yml` runs package tests one by one and needs a line for this one.

Order of the next slices, each behind the flag:

1. The setting: types, the Den route and projection, the server's reader and resolver with the three situations of
   6.1. No tools yet.
2. Tool host, tool definitions and bridge on v2, local microVM only.
3. The Settings screen, reset, and the lifecycle of 4.3 (quit, sign-out, start-up reconciliation).
4. Runtime packaging for macOS and Linux, and OpenWork's own sandbox image.
5. Freestyle and Daytona with a member-held key in the vault, network mapping, previews.
6. Organization-managed keys through Den.
7. Secrets inside the sandbox, once 6.4 holds.

## 12. Evidence

Measured on this machine (Apple Silicon macOS, Node 24.22.2, `microsandbox` 0.7.15, image `alpine`):

- A microVM is created in about 0.3 s once the image is cached, and 6.5 s the first time including the pull.
- Before opening the PR, the live suite was rerun in a fresh temporary runtime home: 18 passed, 0 failed,
  0 skipped (about 9 s); the offline suite: 23 passed, 0 failed, 0 skipped. Test sandboxes remaining after the
  live run: 0; the temporary runtime home was removed.
- `pnpm --filter @openwork/sandbox-microsandbox... build` passed.
- `pnpm check` passed all eight checks, including `spec-lint` after installing the separate evals dependencies.
  This is adapter-level evidence, not a completed agent-tool journey; no agent tools are wired in this PR.
- A read-only mount refuses writes; a path outside the mounts does not exist in the guest.
- With no policy, the guest reaches the internet. With `disableNetwork`, published ports do not answer. With egress
  denied and ingress allowed, a port published on `127.0.0.1` answers and the guest reaches nothing.
- With a host allow-list and no TLS interception, HTTPS to an allowed host fails; with interception it works. Other
  names do not resolve. A direct IP connection and a query to a public DNS resolver both fail. DNS rebinding
  protection can be on at the same time. A plain TCP connection to an allowed host on port 80 is accepted; on
  port 22 it is refused.
- A secret given to microsandbox appeared in the guest as a placeholder and reached an allowed host as the real
  value, which the echo service then returned to the guest. The value was in plain text in microsandbox's database
  on the host, including after destroy.
- A command past its timeout is ended; no process is left in the guest.
- A creation that is cancelled leaves no sandbox. A sandbox whose preview port was already taken fails to start and
  stays under its name in the `stopped` state.
- `MSB_HOME` must be short: macOS limits the runtime's socket path to 104 bytes, and an 82-byte home was refused. A
  home under `~/Library/Application Support/...` will not fit; `~/.openwork/msb` will.
- A bind mount through a symlink is refused (`/var/...` on macOS must be given as `/private/var/...`).
- The `msb` helper in the npm package is signed with `com.apple.security.hypervisor`. The VM runs in that child
  process, so the app's own binary does not need the entitlement.
- The same SDK calls work under Bun 1.3.10.
- With `MSB_API_KEY` set and nothing else, the SDK still reported the local backend. The driver pins it regardless.

Read, not measured:

- The external sandbox protocol and blog post (section 7).
- microsandbox's networking documentation for strict host names and DNS.
- Freestyle and Daytona facts in 5.2, from their documentation.

Not verified:

- Electron's Node: the Electron binary is not installed in this checkout.
- A packaged, signed and notarized build keeping `msb`'s entitlement.
- Linux with KVM, and Windows.
- Which environment or profile settings make the SDK choose its hosted backend.
- How microsandbox's intercepting certificate authority key is stored, and whether resolved addresses stay pinned
  for a connection.
- The connection cache under real concurrency (section 10, "Adapter, races").

## 13. Open questions

1. **Shipping the runtime.** The macOS arm64 platform package is about 99 MB unpacked (`msb` 41, `libkrunfw` 25, the
   addon 32). Bundling it as a signed sidecar keeps installs predictable and works offline, and makes every download
   larger for a feature that is off. Installing it on first use with a pinned version and checksum (the SDK supports
   both) keeps the app small and adds an outbound host. Proposal: install on first use during the flagged pilot;
   decide on bundling before the feature is on for everyone. Either way `msb` must keep its hypervisor entitlement
   through OpenWork's signing and notarization.
2. **The image.** Pulling `alpine` from a public registry is fine for tests. The product needs an image OpenWork
   publishes and pins by digest, with Bash, Git, Node and Python, and an organization override.
3. **Proof placement.** Whether the eval hosts can run a microVM decides whether the proof runs in CI or only on a
   developer's machine.
4. **Freestyle and Daytona allow-lists.** Whether each provider can express "these exact hosts and nothing else",
   and what happens to DNS, needs a live check before the setting is offered for them.
5. **Linux access.** `/dev/kvm` usually needs group membership. The unavailable message should say so; whether
   OpenWork should help set it up is a product call.
6. **One sandbox per workspace or per conversation.** Per workspace is the proposal.
7. **Disk use.** Images and sandbox disks live under `MSB_HOME`. The Settings screen should show the size and offer
   a clean-up; microsandbox exposes both.
8. **Detached or attached microVMs.** The adapter starts them detached so they survive a server restart inside the
   app, and 4.3 stops them explicitly. Attached VMs would end with the process without any of that; how they behave
   with the SDK's handle lifetime has not been tried.
9. **A hard lifetime.** microsandbox has a maximum duration per sandbox; the contract's lifecycle policy has no
   field for it. Decide whether the idle timer is enough or the adapter takes one as an option.

## 14. How the two models' conclusions compared

The primary agent is GPT-6.1 Sol, not the requested Claude Fable 5.2; this session cannot change its own model.
Codebase mapping was delegated to default explore subagents, whose model identity was not verified as Fable.
Explicitly selected GPT-6.1 Sol subagents performed external research and an independent review of the draft and
code. Thus this is an independent-agent comparison, not a verified Fable-versus-Sol comparison. Research was
checked against the protocol text and live runs; the review disagreements and resolutions are recorded below.

Where the review changed the design or the code:

| Point | Draft | Review | Settled as |
| --- | --- | --- | --- |
| Error wording | Every error says the command did not run | Wrong after a timeout or a dropped connection | Two kinds of failure (8.1) |
| When settings are checked | When a sandbox is created | Revocation would miss a running sandbox | Every call, in the server (6.3) |
| Signed out | "Signed out means off", and also "works without an organization" | Contradictory; `add-a-feature` has `/v1/features` for this | Three situations (6.1) |
| Bounds | Workspace setting had extra mounts; isolation had a minimum | Extra mounts and previews had no bound; an ordering of isolation kinds is not a security fact | No extra mounts; `previews` bound; `isolation` is a list (6.2) |
| Identity | Sandbox named by install and workspace | A sandbox could carry over to another sign-in | Scope includes Den URL, organization and member (4.3) |
| Settings change | Destroy and recreate, and say so | Silent data loss; races with running commands | Stop, `needs_reset`, the person resets (4.3) |
| Secrets | Shipped for the local microVM | The value persists in plain text, and an echoing host returns it | Not in v1; removed from the adapter (6.4) |
| "Same guarantees as the protocol" | Claimed | Method and path limits, echo redaction and pinning are missing | Gaps listed (section 7) |
| Serving the protocol | "No" | The browser terminal is optional, so the cost is smaller than stated | "Not planned" (section 7) |
| Hosted backend | Not considered | The SDK's backend is process-wide | Pinned to local, non-local handles refused (5.1) |
| Create at the deadline | Reported as a timeout | A VM could appear afterwards with no handle | Creation is called off; a failed start is removed (5.1) |
| Port choice | Free port picked once | Could be taken before the VM binds it | Chosen again, three times at most (5.1) |
| Connection cache | One map of live connections | Concurrent misses and stale entries | One connection attempt per sandbox, dropped only by its owner (5.1) |
| Mount and resource checks | Absolute paths | Roots and unnormalized spellings passed; non-finite sizes passed | Refused (5.1) |
| Maintenance commands | Ignored | The contract says they must not extend the idle timer | Refused (5.1) |
| Proof witnesses | "Linux" and `sandbox_status` | Not independent of the thing under test | Host-side values and boot id (section 10) |
| Background jobs | A log path | No status, exit code or stop | `sandbox_job` (4.2) |

Where the two still differ, and what this document does:

- **A Den read on every call.** The review asks for one. This design enforces on every call but reuses a verified
  answer for up to 60 seconds, because a round trip per command would make the tools slow and would fail whole
  sessions on a brief network loss. The cost is that a revocation can take a minute.
- **Receipts for every operation.** The review asks for receipts and cancellation semantics across the board. This
  design uses the engine's call id for replay and leaves cancellation to the provider's timeout, which is what the
  contract offers today.
- **Preview origins.** The review asks to isolate them. Local previews already have one origin per port; the real
  exposure is the browser on this computer, which 8.3 states and mitigates without claiming to remove it.
- **Symlink races on the mounted folder.** The review asks for inode checks with adversarial tests. This design
  mounts only the recorded workspace root, relies on microsandbox refusing symlinked host paths, and excludes the
  server's own folders. The remaining race needs a program running as the user on this computer, which already has
  the folder.
