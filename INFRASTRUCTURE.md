# OpenWork Infrastructure Principles

OpenWork is an experience layer. OpenCode is the engine. This document defines how infrastructure is built so every component is usable on its own, composable as a sidecar, and easy to automate.

## Core Principles

1) CLI-first, always
- Every infrastructure component must be runnable via a single CLI command.
- The OpenWork UI may wrap these, but never replace or lock them out.

2) Unix-like interfaces
- Prefer simple, composable boundaries: JSON over stdout, flags, and env vars.
- Favor readable logs and predictable exit codes.

3) Sidecar-composable
- Any component must run as a sidecar without special casing.
- The UI should connect to the same surface area the CLI exposes.

4) Clear boundaries
- OpenCode remains the engine; OpenWork adds a thin config + UX layer.
- When OpenCode exposes a stable API, use it instead of re-implementing.

5) Local-first, graceful degradation
- Default to local execution.
- If a sidecar is missing or offline, the UI falls back to read-only or explicit user guidance.

6) Portable configuration
- Use config files + env vars; avoid hidden state.
- Keep credentials outside git and outside the repo.

7) Observability by default
- Provide health endpoints and structured logs.
- Record audit events for every config mutation.

8) Security + scoping
- All filesystem access is scoped to explicit workspace roots.
- Writes require explicit host approval when requested remotely.

## Applied to Current Components

### OpenCode Engine
- Always usable via `opencode` CLI.
- OpenWork never replaces the CLI; it only connects to the engine.

### OpenWork Server
- Runs standalone via `openwork-server` CLI.
- Provides filesystem-backed config surfaces (skills, plugins, MCP, commands).
- Sidecar lifecycle is described in `packages/app/pr/openwork-server.md`.

### Owpenbot
- Runs standalone via `owpenwork` CLI.
- Must be able to use OpenWork server for config and approvals.

## Non-goals

- Replacing OpenCode primitives with custom abstractions.
- Building multi-tenant or cloud-managed infrastructure.

## References

- `VISION.md`
- `PRINCIPLES.md`
- `ARCHITECTURE.md`
- `packages/app/pr/openwork-server.md`
