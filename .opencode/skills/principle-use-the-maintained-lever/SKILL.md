---
name: principle-use-the-maintained-lever
description: "Apply before hand-running a multi-step procedure. Use the repo's script, CLI, or helper (pnpm world, evals CLI, .devcontainer helpers, skill scripts, release:cut); if none exists and you repeat it, write one."
metadata:
  opencode/autoinvoke: "false"
  opencode/slash: "true"
---

# Use the Maintained Lever

Scripts do the repeatable steps. Agents make the judgment calls.

**Why:** Hand-reproduced provisioning drifts from the helper and fails in ways nobody else can rerun. A script is evidence a reviewer can replay.

- Prefer `pnpm world help|plan|up`, `pnpm evals:e2e`, `.devcontainer/*.sh`, `pnpm release:cut`, and `.opencode/skills/*/scripts`.
- Read the CLI's own output (`placement:`, `source`, `hint:`) and act on it instead of retrying unchanged.
- Keep large data out of context through scripts (for example the models extractor, not `base.json`).
- Doing the same thing by hand a second time means a script or skill is missing. Write it.
