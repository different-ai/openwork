---
name: forge-preflight
description: Use when starting work on a new change to ensure the forge directory structure exists and change paths are valid.
---

# Forge Preflight

## Overview

Forge preflight makes sure the workspace has the required Forge directories before any artifacts or code are created.

**Core principle:** No artifacts without a valid Forge skeleton.

## When to Use

- Starting any new change in the Forge workflow
- Moving work into a repository that does not yet have `forge/`
- Onboarding a new repo to the Forge process

**Do not use when:** The Forge structure already exists and is validated.

## Checklist

1. Verify `forge/` exists
2. Verify `forge/tracks/` exists
3. Verify `forge/contracts/` exists
4. If missing, create the directory structure

## Forge Skeleton

```
forge/
  tracks/
  contracts/
  archives/
```

## Quick Reference

| Condition | Action |
|----------|--------|
| `forge/` missing | Create Forge skeleton |
| `forge/tracks/` missing | Create `forge/tracks/` |
| `forge/contracts/` missing | Create `forge/contracts/` |
| `forge/archives/` missing | Create `forge/archives/` |

## Common Mistakes

- Creating artifacts outside `forge/`
- Starting tasks without `forge/tracks/<change>/` in place
- Treating `forge/` as optional
