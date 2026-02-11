# OpenWork Agent Lab (toy)

This package is a CLI-first instance manager for the Agent Lab concept.

It is intentionally small and experimental.

Agent Lab reuses existing OpenWork infrastructure:

- `openwrk` orchestrator (sandboxing + sidecars)
- `openwork-server` edge API + Toy UI
- `opencode` engine

## Local development

From the repo root:

```bash
pnpm -C packages/agent-lab dev -- --help
```

## Commands (MVP)

```bash
# Create an instance directory + workspace
pnpm -C packages/agent-lab dev -- create --name Scout

# Start services (sandbox) for that instance
pnpm -C packages/agent-lab dev -- start <instanceId>

# Open the Toy UI for that instance
pnpm -C packages/agent-lab dev -- open <instanceId>

# Stop the sandbox container
pnpm -C packages/agent-lab dev -- stop <instanceId>
```

Notes:

- This is macOS-first and assumes Bun is available.
- Multi-instance is achieved by per-instance ports + per-instance directories.
