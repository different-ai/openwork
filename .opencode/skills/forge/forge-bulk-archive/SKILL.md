---
name: forge-bulk-archive
description: Use when archiving multiple Forge tracks at once and resolving contract conflicts safely.
---

# Forge Bulk Archive

## Overview

Archive multiple Forge tracks in one operation while resolving contract conflicts using implementation evidence.

**Core principle:** Archive in a way that keeps main contracts consistent with real code.

## When to Use

- Multiple tracks are complete
- Parallel changes touched the same domain contracts

**Do not use when:** Verification is missing or tracks are incomplete and the user does not confirm.

## Steps

1. **Select tracks**
   - List `forge/tracks/` and prompt for multi-select
   - Do not auto-select

2. **Gather status for each track**
   - Check tasks completion in `forge/tracks/<change>/tasks.md`
   - Identify delta contracts under `forge/tracks/<change>/contracts/`

3. **Detect contract conflicts**
   - Build map: `<domain> -> [changes]`
   - Conflict exists if 2+ changes touch same domain

4. **Resolve conflicts using evidence**
   - Read delta contracts for each conflicting change
   - Search codebase for implementation evidence
   - If only one implemented -> apply that change
   - If multiple implemented -> apply in chronological order (older first)
   - If none implemented -> warn and skip contract sync for that domain

5. **Show status table and confirm**
   - Include artifacts, task completion, conflicts, readiness
   - Confirm archive set and conflict resolution plan

6. **Archive each track**
   - Sync contracts (see forge-sync-contracts) in resolved order
   - Move `forge/tracks/<change>/` to `forge/archives/YYYY-MM-DD-<change>/`

7. **Display summary**
   - Archived, skipped, failed
   - Contract sync summary

## Output Format

```
## Bulk Archive Summary

Archived:
- <change> -> forge/archives/YYYY-MM-DD-<change>/

Skipped:
- <change> (reason)

Conflicts resolved:
- <domain>: <resolution>
```

## Guardrails

- Always prompt for selection
- Never auto-archive incomplete tracks without confirmation
- Preserve track contents when moving
- Use evidence from codebase to resolve conflicts

## Common Mistakes

- Skipping conflict analysis
- Archiving without contract sync
- Ignoring incomplete tasks
