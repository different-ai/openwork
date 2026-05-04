# Orchestrator Audit

## Scope

This audit covers `apps/orchestrator/**`.

The goal is to explain what the orchestrator is, what its major functions do, where they are called from, what they ultimately affect, and which responsibilities should ideally move into the main server over time.

## What The Orchestrator Is

The orchestrator is the host-side runtime manager for OpenWork.

In plain English, it is the thing that turns:

- a workspace
- some binaries
- some ports and tokens
- an execution mode

into a running OpenWork worker stack.

Today it is responsible for things like:

- starting and supervising `opencode`
- starting and supervising `openwork-server`
- optionally starting `opencode-router`
- exposing a daemon API for desktop workspace activation and disposal
- managing detached and sandboxed runtime flows
- handling host-side sidecar/binary resolution and upgrade control

It is currently both:

- a bootstrap shell for host/runtime startup
- a mini runtime control plane

That split is important, because the control-plane responsibilities should move first, and the bootstrap shell responsibilities should also be reevaluated for collapse into the main server rather than preserved automatically.

## Disposition Labels

- `Stay`: should remain an orchestrator/host-shell concern.
- `Move`: should ideally move into the main server over time.
- `Split`: some boundary or trigger may stay in the orchestrator, but the core capability should move into the main server.

## High-Level Lifecycle

1. CLI or desktop launches the orchestrator.
2. The orchestrator resolves binaries, sidecars, ports, tokens, and state dirs.
3. It starts and supervises OpenCode, OpenWork server, and optional router.
4. In daemon mode, it persists workspace/runtime state and exposes a local daemon API.
5. In detached or sandboxed flows, it creates and manages those host/container runtimes.
6. It also exposes convenience CLI wrappers over some server APIs.

## Single-Workspace Host Startup And Shutdown

Disposition guidance:

- `main()` -> `Split`
- `runStart()` -> `Split`
- `shutdown()` inside `runStart()` -> `Split`

Reasoning: this is current-state bootstrap logic, but the large amount of runtime capability assembled by `runStart()` should ultimately be server-owned and folded into the main server.

### `main()`

- What it does: dispatches the top-level orchestrator CLI commands.
- Called from and when: process entrypoint for the `openwork` CLI.
- Ends up calling: `runStart()`, daemon commands, approvals/files/status helpers, and other CLI subcommands.

### `runStart()`

- What it does: main coordinator for host mode; resolves workspace, ports, tokens, binaries, sandbox mode, starts services, waits for health, and prints connect info.
- Called from and when: called by `main()` for `openwork start` and `openwork serve`; also used indirectly when desktop detached mode shells out to `openwork start --detach`.
- Ends up calling: OpenCode startup, OpenWork server startup, optional OpenCodeRouter startup, sandbox/container logic, health loops, owner token issuance, and runtime control server setup.

### `shutdown()` inside `runStart()`

- What it does: gracefully stops children, control server, timers, and optional sandbox container.
- Called from and when: called on SIGINT/SIGTERM, fatal child exits, failed startup, and check completion.
- Ends up calling: full host-stack shutdown.

## Runtime Process Supervision And Upgrade Control

Disposition guidance:

- `startOpencode()` -> `Split`
- `startOpenworkServer()` -> `Split`
- `startOpenCodeRouter()` -> `Split`
- child exit/spawn error handlers -> `Split`
- runtime control server in `runStart()` -> `Move`
- `performRuntimeUpgrade()` -> `Split`

Reasoning: native child supervision exists today in the orchestrator, but even that should be treated as transition-state behavior if the main server is going to absorb bootstrap and runtime supervision over time.

### `startOpencode()`

- What it does: spawns OpenCode with the chosen env, auth, reload, and logging settings.
- Called from and when: called from `runStart()` and daemon `ensureOpencode()`.
- Ends up calling: `opencode serve` and the OpenCode runtime itself.

### `startOpenworkServer()`

- What it does: launches `openwork-server` with the bootstrap information needed for host mode today.
- Called from and when: called from `runStart()` and restart paths.
- Ends up calling: the main OpenWork API/control layer process; over time this bootstrap contract should shrink toward the minimum needed to bring the server up.

### `startOpenCodeRouter()`

- What it does: launches `opencode-router` when messaging/router support is enabled.
- Called from and when: called from `runStart()` and restart paths.
- Ends up calling: the router sidecar process; launch may remain host-owned, but router product control should move into the server.

### child exit and spawn error handlers

- What they do: turn child process failures into orchestrator shutdown or degraded-mode handling.
- Called from and when: called during host mode whenever a managed child exits or fails to spawn.
- Ends up calling: shutdown or failure-state logic for the whole host stack.

### runtime control server in `runStart()`

- What it does: exposes host-local legacy `/runtime/versions` and `/runtime/upgrade` endpoints; in the Server V2 target these capabilities should land under `/system/runtime/*` on the main server.
- Called from and when: started during host startup.
- Ends up calling: runtime inspection and rolling restart/upgrade behavior.

### `performRuntimeUpgrade()`

- What it does: re-resolves binaries, optionally installs packages, and restarts services.
- Called from and when: called through the runtime control server when a client requests an upgrade.
- Ends up calling: rolling restart of OpenCode, OpenWork server, and OpenCodeRouter.

## Sidecar And Binary Resolution

Disposition guidance:

- all major functions in this section -> `Split`

Reasoning: in the current orchestrator these are host/bootstrap concerns, but the Server V2 target changes the default distribution model. When the canonical runtime is `openwork-server-v2` bundling and extracting its own sidecars, the equivalent resolution logic should move into the server for that path. A thinner host shell may still need fallback or external-runtime resolution in some modes, so this boundary is better treated as `Split` than `Stay`.

### `resolveOpenworkServerBin()`

- What it does: decides which `openwork-server` binary to run.
- Called from and when: called during startup and upgrade.
- Ends up calling: local sidecar selection or downloaded/external binary resolution.

### `resolveOpencodeBin()`

- What it does: decides which OpenCode binary to run.
- Called from and when: called during startup, daemon mode, and upgrade.
- Ends up calling: local sidecar or installed OpenCode resolution.

### `resolveOpenCodeRouterBin()`

- What it does: decides which OpenCodeRouter binary to run.
- Called from and when: called when router support is enabled.
- Ends up calling: router binary resolution.

### `resolveSidecarConfig()`

- What it does: computes sidecar directories, manifests, target triple, and download URLs.
- Called from and when: called by startup and daemon flows.
- Ends up calling: all sidecar download logic.

### `downloadSidecarBinary()`

- What it does: downloads and verifies sidecar binaries.
- Called from and when: called when sidecar source is downloaded or auto-resolved that way.
- Ends up calling: local sidecar cache population.

### version verification helpers

- What they do: verify that the runtime is actually using the intended binary/version/config.
- Called from and when: called after service health checks and during upgrade.
- Ends up calling: startup failure or diagnostic reporting if versions do not match expectations.

## Desktop Daemon And Workspace Activation

Disposition guidance:

- `runDaemonCommand()` -> `Split`
- `runRouterDaemon()` -> `Split`
- `ensureRouterDaemon()` -> `Split`
- `ensureOpencode()` inside daemon mode -> `Split`
- daemon HTTP API -> `Move`
- `runWorkspaceCommand()` -> `Move`
- `runInstanceCommand()` -> `Move`

Reasoning: a host-local daemon boundary may still exist, but workspace activation and instance disposal are product/runtime control capabilities that should move into the main server.

### `runDaemonCommand()`

- What it does: handles daemon subcommands like start, status, stop, and run.
- Called from and when: called by the CLI daemon entry.
- Ends up calling: daemon startup or daemon status/control requests.

### `runRouterDaemon()`

- What it does: runs the long-lived desktop daemon that keeps OpenCode alive, persists workspace state, and serves the daemon HTTP API.
- Called from and when: called by `openwork daemon run`; desktop also spawns it for desktop host mode.
- Ends up calling: daemon HTTP service, workspace registry persistence, and OpenCode lifecycle management; this should be treated as transitional control-plane behavior rather than an enduring ownership boundary.

### `ensureRouterDaemon()`

- What it does: auto-starts the daemon if it is not already running and waits for health.
- Called from and when: called by CLI workspace/instance helpers.
- Ends up calling: daemon process startup.

### `ensureOpencode()` in daemon mode

- What it does: reuses or starts the single OpenCode runtime used by the daemon.
- Called from and when: called on daemon boot and when workspace operations need OpenCode.
- Ends up calling: daemon-managed OpenCode lifecycle.

### daemon HTTP API

- What it does: exposes local endpoints for health, workspace listing, workspace activation, workspace path lookup, instance disposal, and shutdown.
- Called from and when: used by desktop and orchestrator CLI helpers.
- Ends up calling: daemon state mutation and workspace/runtime activation behavior.

### `runWorkspaceCommand()`

- What it does: thin CLI wrapper for workspace add/list/switch/info/path commands.
- Called from and when: called by `openwork workspace ...`.
- Ends up calling: daemon HTTP API.

### `runInstanceCommand()`

- What it does: thin CLI wrapper for instance disposal commands.
- Called from and when: called by `openwork instance dispose ...`.
- Ends up calling: daemon HTTP API.

## Auth, Tokens, And Local State Persistence

Disposition guidance:

- managed OpenCode credential resolution -> `Split`
- owner token issuance -> `Move`
- OpenCode state layout resolution/creation -> `Stay`
- router/orchestrator state persistence -> `Split`

Reasoning: local secret and filesystem layout for host relaunches is still host-owned, but token semantics and control-plane identity should move closer to the main server.

### managed OpenCode credential resolution

- What it does: generates or reads OpenCode basic-auth credentials used by the orchestrator-managed runtime.
- Called from and when: called during host startup and daemon startup.
- Ends up calling: OpenCode auth configuration used to protect direct OpenCode access.

### `issueOpenworkOwnerToken()`

- What it does: asks the server to mint an owner token from a host token.
- Called from and when: called after server health checks in host and sandbox mode.
- Ends up calling: the server `/tokens` API and elevated host-control access.

### OpenCode state layout helpers

- What they do: choose and create OpenCode config/data/cache locations, especially in dev and orchestrated modes.
- Called from and when: called before OpenCode launch in host and daemon modes.
- Ends up calling: local directory creation and optional auth/config import.

### orchestrator state persistence helpers

- What they do: read and write `openwork-orchestrator-state.json` and related state snapshots.
- Called from and when: called throughout daemon lifecycle and desktop reconnect flows.
- Ends up calling: daemon/workspace/binary state persistence on disk.

## Docker And Apple Container Sandbox Flows

Disposition guidance:

- all major sandbox/container functions in this section -> `Split`

Reasoning: the container substrate itself is still host-shell territory, but the runtime graph and product behavior being started inside that substrate should converge on the same Server V2 ownership model. In practice that means some container launch hooks may stay outside the server, while runtime boot config, child supervision policy, and product-facing control semantics should collapse inward.

### `resolveSandboxMode()`

- What it does: decides whether the runtime should be host, Docker, Apple container, or auto-selected.
- Called from and when: called during `runStart()`.
- Ends up calling: the runtime-mode selection path.

### `resolveSandboxExtraMounts()`

- What it does: validates extra host mounts for sandbox mode.
- Called from and when: called when sandbox mounts are requested.
- Ends up calling: host-filesystem exposure policy into the sandbox.

### `stageSandboxRuntime()`

- What it does: stages sidecars into a persist area for sandbox execution.
- Called from and when: called before Docker or Apple sandbox launch.
- Ends up calling: local staged runtime payload creation.

### `writeSandboxEntrypoint()`

- What it does: writes the in-container boot script that starts OpenCode, optional router, then OpenWork server.
- Called from and when: called before container launch.
- Ends up calling: the actual sandbox boot sequence.

### `startDockerSandbox()`

- What it does: starts the whole host stack inside Docker.
- Called from and when: called from `runStart()` when Docker sandboxing is selected.
- Ends up calling: `docker run` with mounts, env, and ports.

### `startAppleContainerSandbox()`

- What it does: starts the same stack inside the Apple container backend.
- Called from and when: called from `runStart()` on supported macOS setups.
- Ends up calling: Apple container runtime launch.

## HTTP Surfaces And Control-Plane Bridging

Disposition guidance:

- daemon HTTP API -> `Move`
- runtime control API -> `Move`
- generic router request client -> `Move`

Reasoning: these are useful product capabilities, but they should ideally be owned by `apps/server`, not by a separate orchestrator control API forever.

### daemon HTTP API

- What it does: local control API for health, workspaces, activation, path lookup, disposal, and shutdown.
- Called from and when: used by desktop and CLI.
- Ends up calling: daemon state and workspace activation behavior.

### runtime control API

- What it does: local legacy `/runtime/versions` and `/runtime/upgrade` surface; the target normalized namespace is `/system/runtime/*` once this moves into the main server.
- Called from and when: started in host mode and later accessed through server proxy routes or clients.
- Ends up calling: runtime inspection and controlled restart/upgrade behavior.

### `requestRouter()`

- What it does: thin generic CLI client for the daemon API.
- Called from and when: used by workspace and instance commands.
- Ends up calling: daemon HTTP API requests.

## Health, Diagnostics, Checks, And Detached Mode

Disposition guidance:

- local health polling helpers -> `Split`
- `runChecks()` / `runSandboxChecks()` -> `Split`
- `runStatus()` -> `Move`
- `handleDetach()` -> `Stay`

Reasoning: host-local polling and detach UX are shell concerns, but canonical health/readiness/status surfaces should move into the main server.

### health polling helpers

- What they do: wait for OpenCode, server, and router health.
- Called from and when: called throughout startup, daemon, and check flows.
- Ends up calling: localhost health probes and startup gating.

### `runChecks()` / `runSandboxChecks()`

- What they do: run host-mode smoke tests for runtime correctness, sessions, router auth, workspaces, and optional event streams.
- Called from and when: called by `openwork start --check` and related flags.
- Ends up calling: broad end-to-end runtime verification.

### `runStatus()`

- What it does: reports current OpenWork/OpenCode URLs and related status in human-readable form.
- Called from and when: called by `openwork status`.
- Ends up calling: health endpoints and status rendering.

### `handleDetach()`

- What it does: detaches the orchestrator shell from the running child stack and leaves the runtime alive.
- Called from and when: called when detached mode is requested.
- Ends up calling: stdio unref/cleanup and detached runtime summary output.

## Messaging Enablement And Managed Tool Injection

Disposition guidance:

- router enablement decision -> `Split`
- managed OpenCode tool injection -> `Move`
- generated router tool sources -> `Move`

Reasoning: startup hooks may stay host-owned, but mutating OpenCode tool/config surfaces is the kind of capability that should belong to the main server/runtime layer.

### router enablement decision helpers

- What they do: determine whether OpenCodeRouter should run from flags, env, workspace config, or inferred defaults.
- Called from and when: called during host startup.
- Ends up calling: router startup decisions and sometimes persisted messaging defaults.

### `ensureOpencodeManagedTools()`

- What it does: writes managed router send/status tools into OpenCode config directories.
- Called from and when: called before OpenCode startup in host and daemon mode.
- Ends up calling: OpenCode tool-surface mutation.

### generated router tool sources

- What they do: generate tool implementations that send through or inspect OpenCodeRouter.
- Called from and when: called by the managed-tool injection path.
- Ends up calling: the OpenCodeRouter health/config/send surface.

## Thin CLI Wrappers Over Server APIs

Disposition guidance:

- file CLI wrappers -> `Move`
- approvals CLI wrappers -> `Move`
- simple status wrapper -> `Move`

Reasoning: these are not orchestrator responsibilities. They are convenience clients over `openwork-server` APIs.

### `runFiles()`

- What it does: exposes CLI wrappers for file session creation, read/write, catalog, events, mkdir, delete, and rename.
- Called from and when: called by `openwork files ...`.
- Ends up calling: OpenWork server file-session APIs.

### `runApprovals()`

- What it does: exposes CLI wrappers for approvals listing and replies.
- Called from and when: called by `openwork approvals ...`.
- Ends up calling: OpenWork server approvals APIs.

### `runStatus()`

- What it does: provides a convenience status CLI.
- Called from and when: called by `openwork status`.
- Ends up calling: health/status APIs.

## Summary: What Should Stay Vs Move

### Should stay in the orchestrator only temporarily

- native process supervision
- sidecar and binary resolution
- host-local port/bootstrap/env setup
- Docker and Apple container lifecycle
- detach/TUI/log-multiplexing shell behavior

### Should move into the main server

- workspace/runtime control APIs as product capabilities
- daemon HTTP control surfaces
- file and approvals CLI wrappers over server APIs
- managed OpenCode tool/config mutation
- status/health/product control semantics that should be canonical server surfaces

### Should be split during migration

- host launch triggers can stay in the orchestrator while runtime capability ownership moves into the server
- local auth/state persistence for relaunch can stay host-owned while token semantics move into the server
- health polling can stay local while official health/control surfaces move into the server

## Bottom Line

The orchestrator is currently doing two jobs:

1. host bootstrap shell
2. mini runtime control plane

The mini runtime control plane should be progressively absorbed into the main server first.

After that, the remaining bootstrap shell should also be questioned and collapsed into the main server wherever practical.

## Can Orchestrator Disappear?

Mostly yes, if by "orchestrator" we mean a separate control-plane product layer.

### Full-collapse idea

The strongest form of the target architecture is:

```text
desktop app or CLI
-> one OpenWork server process
-> server owns workspace/runtime/product behavior
-> server supervises the local runtime pieces it needs
```

In that model, clients do not need to understand or talk to a separate orchestrator API surface.

### What should ideally be folded into the server too

Even the bootstrap shell responsibilities should be treated as collapse candidates:

- launching local child processes
- resolving sidecars and binaries
- choosing ports and env vars
- Docker and Apple container startup
- detach and local process supervision

The strongest target is:

- no separate orchestrator control plane
- no enduring separate orchestrator bootstrap layer
- one main server as the canonical runtime and product API

### Recommended target architecture

```text
desktop app
-> launches or connects to OpenWork server
-> calls one main server API surface

OpenWork server
-> starts and supervises local OpenCode/router/container/runtime pieces as needed
```

### Migration implication

As Server V2 grows, the priority should be:

1. move orchestrator-owned workspace/runtime APIs into the server
2. move orchestrator-owned config/tool/control semantics into the server
3. move bootstrap and supervision responsibilities into the server as the final collapse step

That is the path to "doing away with the orchestrator" in practice.
