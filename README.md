[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/VEhNQXxYMB)

# OpenWork

OpenWork is an **extensible, open-source “Claude Work” style system for knowledge workers**.

It’s built on top of opencode and lets you turn your opencode workflows into usable experiences for non-technical users.

<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 19 02 PM" src="https://github.com/user-attachments/assets/7a1b8662-19a0-4327-87c9-c0295a0d54f1" />


Openwork is desgined around the idea that you can easily ship your

It’s a native desktop app that runs **OpenCode** under the hood, but presents it as a clean, guided workflow:
- pick a workspace
- start a run
- watch progress + plan updates
- approve permissions when needed
- reuse what works (templates + skills)

The goal: make “agentic work” feel like a product, not a terminal.


## Quick start
Download the dmg here https://github.com/different-ai/openwork/releases (or install from source below)

## Why

Current CLI and GUIs for opencode are anchored around developers. That means a focus on file diffs, tool names, and hard to extend capabilities without relying on exposing some form of cli.

OpenWork is designed to be:
- **Extensible**: skill and opencode plugins are installable modules.
- **Auditable**: show what happened, when, and why.
- **Permissioned**: access to privileged flows.
- **Local/Remote**: OpenWork works locally as well as can connect to remote servers.

## What’s Included 

- **Host mode**: runs opencode locally on your computer
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
 

## Skill Manager    
<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />


## Works on local computer or servers
<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />


## Quick Start

### Requirements

- Node.js + `pnpm`
- Rust toolchain (for Tauri): install via `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Tauri CLI: `cargo install tauri-cli`
- OpenCode CLI installed and available on PATH: `opencode`

### Install

```bash
pnpm install
```

OpenWork now lives in `packages/app` (UI) and `packages/desktop` (desktop shell).

### Run (Desktop)

```bash
pnpm dev
```

### Run (Web UI only)

```bash
pnpm dev:ui
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
- `packages/desktop/src-tauri/capabilities/default.json`

## OpenPackage Notes

If `opkg` is not installed globally, OpenWork falls back to:

```bash
pnpm dlx opkg install <package>
```

## OpenCode Plugins

Plugins are the **native** way to extend OpenCode. OpenWork now manages them from the Skills tab by
reading and writing `opencode.json`.

- **Project scope**: `<workspace>/opencode.json`
- **Global scope**: `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/opencode.json`)

You can still edit `opencode.json` manually; OpenWork uses the same format as the OpenCode CLI:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## Useful Commands

```bash
pnpm dev
pnpm dev:ui
pnpm typecheck
pnpm build
pnpm build:ui
pnpm test:e2e
```

## Security Notes

- OpenWork hides model reasoning and sensitive tool metadata by default.
- Host mode binds to `127.0.0.1` by default.

## Contributing

- Review `AGENTS.md` and `MOTIVATIONS-PHILOSOPHY.md` to understand the product goals before making changes.
- Ensure Node.js, `pnpm`, the Rust toolchain, and `opencode` are installed before working inside the repo.
- Run `pnpm install` once per checkout, then verify your change with `pnpm typecheck` plus `pnpm test:e2e` (or the targeted subset of scripts) before opening a PR.
- Add new PRDs to `packages/app/pr/<name>.md` following the `.opencode/skill/prd-conventions/SKILL.md` conventions described in `AGENTS.md`.

## License

MIT — see `LICENSE`.
