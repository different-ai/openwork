[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/VEhNQXxYMB)

# OpenWork
> OpenWork helps you run your agents, skills, and MCP. It's an open-source alternative to Claude Cowork/Codex (desktop app).


  
## Core Philosophy
- Local-first, cloud-ready: OpenWork runs on your machine in one click. Send a message instantly.
- Composable: desktop app, WhatsApp/Slack/Telegram connector, or server. Use what fits, no lock-in.
- Ejectable: OpenWork is powered by OpenCode, so everything OpenCode can do works in OpenWork, even without a UI yet.
- Sharing is caring: start solo, then share. One CLI or desktop command spins up an instantly shareable instance.

<p align="center">
  <img src="./app-demo.gif" alt="OpenWork demo" width="800" />
</p>


OpenWork is designed around the idea that you can easily ship your agentic workflows as a repeatable, productized process.


## Alternate UIs

- **OpenCode Router (WhatsApp bot)**: a lightweight WhatsApp bridge for a running OpenCode server. Install with:
  - `curl -fsSL https://raw.githubusercontent.com/different-ai/opencode-router/dev/install.sh | bash`
  - run `opencode-router setup`, then `opencode-router whatsapp login`, then `opencode-router start`
  - full setup: https://github.com/different-ai/opencode-router/blob/dev/README.md
- **OpenWork Orchestrator (CLI host)**: run OpenCode + OpenWork server without the desktop UI.
  - install: `npm install -g openwork-orchestrator`
  - run: `openwork start --workspace /path/to/workspace --approval auto`
  - docs: [packages/orchestrator/README.md](./packages/orchestrator/README.md)


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
  - list installed `.opencode/skills` folders
  - install from OpenPackage (`opkg install ...`)
  - import a local skill folder into `.opencode/skills/<skill-name>`
 

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

### Arch Users:

```bash
yay -s opencode # Releases version
```

## Architecture (high-level)

- In **Host mode**, OpenWork runs a local host stack and connects the UI to it.
  - Default runtime: `openwork` (installed from `openwork-orchestrator`), which orchestrates `opencode`, `openwork-server`, and optionally `opencode-router`.
  - Fallback runtime: `direct`, where the desktop app spawns `opencode serve --hostname 127.0.0.1 --port <free-port>` directly.

When you select a project folder, OpenWork runs the host stack locally using that folder and connects the desktop UI.
This lets you run agentic workflows, send prompts, and see progress entirely on your machine without a remote server.

- The UI uses `@opencode-ai/sdk/v2/client` to:
  - connect to the server
  - list/create sessions
  - send prompts
  - subscribe to SSE events(Server-Sent Events are used to stream real-time updates from the server to the UI.)
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

## Troubleshooting

### Linux / Wayland (Hyprland)

If OpenWork crashes on launch with WebKitGTK errors like `Failed to create GBM buffer`, disable dmabuf or compositing before launch. Try one of the following environment flags.

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 openwork
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 openwork
```

## Security Notes

- OpenWork hides model reasoning and sensitive tool metadata by default.
- Host mode binds to `127.0.0.1` by default.

## Contributing

- Review `AGENTS.md` plus `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, and `ARCHITECTURE.md` to understand the product goals before making changes.
- Ensure Node.js, `pnpm`, the Rust toolchain, and `opencode` are installed before working inside the repo.
- Run `pnpm install` once per checkout, then verify your change with `pnpm typecheck` plus `pnpm test:e2e` (or the targeted subset of scripts) before opening a PR.
- Add new PRDs to `packages/app/pr/<name>.md` following the `.opencode/skills/prd-conventions/SKILL.md` conventions described in `AGENTS.md`.

## For Teams & Businesses

Interested in using OpenWork in your organization? We'd love to hear from you — reach out at [benjamin.shafii@gmail.com](mailto:benjamin.shafii@gmail.com) to chat about your use case.

## License

MIT — see `LICENSE`.
