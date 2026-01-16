---
name: openwork-core
description: Core context and guardrails for OpenWork native app
---

## Quick Usage (Already Configured)

### Orientation
- Read `AGENTS.md` and `design-prd.md` before changing behavior.
- Ensure `vendor/opencode` exists for self-reference.
- Use the `tauri-solidjs` skill for stack-specific guidance.

### Update the OpenCode mirror
```bash
git -C vendor/opencode pull --ff-only
```

### Development workflow
```bash
pnpm tauri dev          # Desktop development
pnpm tauri ios dev      # iOS development
pnpm tauri android dev  # Android development
```

## OpenCode Integration

### Spawn OpenCode CLI
```bash
opencode -p "your prompt" -f json -q
```

### Read OpenCode database
```
~/.opencode/opencode.db  # SQLite database
```

### Key tables
- `sessions` — Task runs
- `messages` — Chat messages and tool calls
- `history` — File change tracking

## Common Gotchas

- OpenWork must stay within OpenCode's tool surface; avoid inventing new capabilities.
- Always expose plans, permissions, and progress for non-technical users.
- Use Tauri commands for all system access (file, shell, database).
- Keep UI at 60fps; avoid blocking the main thread.
- Mobile builds require platform-specific setup (Xcode, Android Studio).

## UI Principles

- **Slick and fluid**: animations, transitions, micro-interactions.
- **Mobile-first**: touch targets, gestures, adaptive layouts.
- **Transparency**: show plans, steps, and tool calls.
- **Progressive disclosure**: hide advanced controls until needed.

## First-Time Setup (If Not Configured)

### Clone the OpenCode mirror
```bash
git clone https://github.com/anomalyco/opencode vendor/opencode
```

### Initialize Tauri project
```bash
pnpm create tauri-app . --template solid-ts
```

### Add mobile targets
```bash
pnpm tauri ios init
pnpm tauri android init
```

## Common Gotchas

- OpenWork must stay within OpenCode’s tool surface; avoid inventing new capabilities.
- Always expose plans, permissions, and progress for non-technical users.

## First-Time Setup (If Not Configured)

### Clone the OpenCode mirror
```bash
git clone https://github.com/anomalyco/opencode vendor/opencode
```
