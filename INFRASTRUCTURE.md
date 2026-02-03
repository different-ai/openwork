# OpenWork Infrastructure Principles

OpenWork is an experience layer. OpenCode is the engine. This document defines how infrastructure is built so every component is usable on its own, composable as a sidecar, and easy to automate.

## Core Principles

1.  CLI-first, always

* Every infrastructure component must be runnable via a single CLI command.
* The OpenWork UI may wrap these, but never replace or lock them out.

2.  Unix-like interfaces

* Prefer simple, composable boundaries: JSON over stdout, flags, and env vars.
* Favor readable logs and predictable exit codes.

3.  Sidecar-composable

* Any component must run as a sidecar without special casing.
* The UI should connect to the same surface area the CLI exposes.

4.  Clear boundaries

* OpenCode remains the engine; OpenWork adds a thin config + UX layer.
* When OpenCode exposes a stable API, use it instead of re-implementing.

5.  Local-first, graceful degradation

* Default to local execution.
* If a sidecar is missing or offline, the UI falls back to read-only or explicit user guidance.

6.  Portable configuration

* Use config files + env vars; avoid hidden state.
* Keep credentials outside git and outside the repo.

7.  Observability by default

* Provide health endpoints and structured logs.
* Record audit events for every config mutation.

8.  Security + scoping

* All filesystem access is scoped to explicit workspace roots.
* Writes require explicit host approval when requested remotely.

9.  Debuggable by agents
    Agents like (you?) make tool calls tool calls can do a variety of things form using chrome
    to calling curl, using the cli, using bun, making scripts.

You're not afraid to run the program on your OS but to benefit from it you need to design the arch
so these things are callable.

E.g. it is very hard to call a things from the desktop app (you have not a lot of control).

But what you can do is:

* run the undelrying clis (since they are implented as sidecar)
* run against real opencode value
* use bash to test endpionts of these various servers/etc
* if needed don't hestiate to ask for credentialse.g. to test telegram or other similar flow
  -you should be able to test 99% of the flow on your own

## Applied to Current Components

### OpenCode Engine

* Always usable via `opencode` CLI.
* OpenWork never replaces the CLI; it only connects to the engine.

### OpenWork Server

* Runs standalone via `openwork-server` CLI.
* Provides filesystem-backed config surfaces (skills, plugins, MCP, commands).
* Sidecar lifecycle is described in `packages/app/pr/openwork-server.md`.

### Owpenbot

* Runs standalone via `owpenwork` CLI.
* Must be able to use OpenWork server for config and approvals.

## Non-goals

* Replacing OpenCode primitives with custom abstractions.
* Building multi-tenant or cloud-managed infrastructure.

## References

* `VISION.md`
* `PRINCIPLES.md`
* `ARCHITECTURE.md`
* `packages/app/pr/openwork-server.md`
