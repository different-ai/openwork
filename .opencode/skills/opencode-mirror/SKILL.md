---
name: opencode-mirror
description: Maintain the local OpenCode mirror for self-reference
---

## Quick Usage (Already Configured)

### Update mirror
```bash
git -C vendor/opencode pull --ff-only
```

## Common Gotchas

- Keep the mirror gitignored; never commit `vendor/opencode`.
- Use `--ff-only` to avoid merge commits in the mirror.

## First-Time Setup (If Not Configured)

### Clone mirror
```bash
git clone https://github.com/anomalyco/opencode vendor/opencode
```
