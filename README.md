# OpenWork

OpenWork is an **extensible, open-source “Claude Work” style system for knowledge workers**.

It’s a native desktop app (Tauri) that runs **OpenCode** under the hood, but presents it as a clean, guided workflow:
- pick a workspace
- start a run
- watch progress + plan updates
- approve permissions when needed
- reuse what works (templates + skills)

The goal: make “agentic work” feel like a product, not a terminal.

## Why

Knowledge workers don’t want to learn a CLI, fight config sprawl, or rebuild the same workflows in every repo.
OpenWork is designed to be:
- **Extensible**: skills and workflows are installable modules.
- **Auditable**: show what happened, when, and why.
- **Permissioned**: explicit user approval for risky actions.
- **Portable**: keep logic in prompts/skills, not bespoke code.

## What’s Included (v0.1)

- **Host mode**: start `opencode serve` locally in a chosen folder.
- **Client mode**: connect to an existing OpenCode server by URL.
- **Sessions**: create/select sessions and send prompts.
- **Live streaming**: SSE `/event` subscription for realtime updates.
- **Execution plan**: render OpenCode todos as a timeline.
- **Permissions**: surface permission requests and reply (allow once / always / deny).
- **Templates**: save and re-run common workflows (stored locally).
- **Skills manager**:
  - list installed `.opencode/skill` folders
  - install from OpenPackage (`opkg install ...`)
  - import a local skill folder into `.opencode/skill/<skill-name>`

## Quick Start

### Requirements

- Node.js + `pnpm`
- Rust toolchain (for Tauri): `cargo`, `rustc`
- OpenCode CLI installed and available on PATH: `opencode`

### Install

```bash
pnpm install
```

### Run (Desktop)

```bash
pnpm dev
```

### Run (Web UI only)

```bash
pnpm dev:web
```

## Architecture (high-level)

- In **Host mode**, OpenWork spawns:
  - `opencode serve --hostname 127.0.0.1 --port <free-port>`
  - with your selected project folder as the process working directory.
- The UI uses `@opencode-ai/sdk/v2/client` to:
  - connect to the server
  - list/create sessions
  - send prompts
  - subscribe to SSE events
  - read todos and permission requests

## Folder Picker

The folder picker uses the Tauri dialog plugin.
Capability permissions are defined in:
- `src-tauri/capabilities/default.json`

## OpenPackage Notes

If `opkg` is not installed globally, OpenWork falls back to:

```bash
pnpm dlx opkg install <package>
```

## Useful Commands

```bash
pnpm typecheck
pnpm build:web
pnpm test:e2e
```

## Security Notes

- OpenWork hides model reasoning and sensitive tool metadata by default.
- Host mode binds to `127.0.0.1` by default.

## License

TBD.
