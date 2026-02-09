---
name: forge-continue
description: Use when continuing a Forge track by creating the next ready artifact in sequence.
---

# Forge Continue

## Overview

Create exactly one next artifact for a Forge track based on readiness and dependencies.

**Core principle:** One artifact per invocation, in dependency order.

## When to Use

- User asks to continue a Forge change
- Artifacts are incomplete and need the next one created

**Do not use when:** All artifacts are complete.

## Artifact Order and Dependencies

1. `intent.md` (root)
2. `contracts/<domain>/contract.md` (requires intent)
3. `design.md` (requires intent + contracts)
4. `tasks.md` (requires design + contracts)

## Steps

1. **Select the track**
   - If unspecified, list `forge/tracks/` and prompt for selection

2. **Determine readiness**
   - If `intent.md` missing -> create it
   - Else if no delta contracts exist -> create delta contract(s)
   - Else if `design.md` missing -> create it
   - Else if `tasks.md` missing -> create it
   - Else -> stop (all artifacts complete)

3. **Create only the next artifact**
   - Read dependency artifacts first
   - Ask for clarification if required content is unclear

4. **Show progress**
   - What was created
   - What is now unblocked

## Output Format

```
Created: <artifact>
Track: forge/tracks/<change>/
Next: <next artifact or "all complete">
```

## Guardrails

- Create ONE artifact per invocation
- Never skip dependencies
- Do not create artifacts out of order
- If user intent is unclear, ask before writing
