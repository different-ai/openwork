# OpenWork

OpenWork is an **extensible, open-source “Claude Work” style system for knowledge workers**.


<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 19 02 PM" src="https://github.com/user-attachments/assets/7a1b8662-19a0-4327-87c9-c0295a0d54f1" />



It’s a native desktop app that runs **OpenCode** under the hood, but presents it as a clean, guided workflow:
- pick a workspace
- start a run
- watch progress + plan updates
- approve permissions when needed
- reuse what works (templates + skills)

The goal: make “agentic work” feel like a product, not a terminal.


## Quick start

Download the installer for your platform from [GitHub Releases](https://github.com/different-ai/openwork/releases):

| Platform | Download | Notes |
|----------|----------|-------|
| **Windows** | `OpenWork_{version}_x64-setup.exe` or `OpenWork_{version}_x64_en-US.msi` | Run the installer, then launch OpenWork |
| **macOS (Apple Silicon)** | `OpenWork_{version}_aarch64.dmg` | Drag to Applications, then open |
| **macOS (Intel)** | `OpenWork_{version}_x64.dmg` | Drag to Applications, then open |

> **Prerequisite**: You need [OpenCode CLI](https://opencode.ai) installed on your system. OpenWork will detect it automatically or guide you through installation on first launch.

### Windows Installation (1-Click)

1. Download `OpenWork_{version}_x64-setup.exe` from [Releases](https://github.com/different-ai/openwork/releases)
2. Run the installer
3. Launch **OpenWork** from Start Menu
4. If OpenCode CLI is not installed, OpenWork will show instructions (install via [Scoop](https://scoop.sh), [Chocolatey](https://chocolatey.org), or from https://opencode.ai/install)

### macOS Installation

1. Download the `.dmg` for your architecture from [Releases](https://github.com/different-ai/openwork/releases)
2. Open the DMG and drag **OpenWork** to `/Applications`
3. Launch from `/Applications`

If macOS blocks the app:
- **Finder**: Control-click → **Open** → **Open**
- **System Settings**: Privacy & Security → **Open Anyway**

## Why

Knowledge workers don’t want to learn a CLI, fight config sprawl, or rebuild the same workflows in every repo.
OpenWork is designed to be:
- **Extensible**: skill and opencode plugins are installable modules.
- **Auditable**: show what happened, when, and why.
- **Permissioned**: access to privileged flows.
- **Local/Remote**: OpenWork works locally as well as can connect to remote servers.

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
 

## Skill Manager    
<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />


## Works on local computer or servers
<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />


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
pnpm typecheck
pnpm build:web
pnpm test:e2e
```

## Security Notes

- OpenWork hides model reasoning and sensitive tool metadata by default.
- Host mode binds to `127.0.0.1` by default.

## License

MIT — see `LICENSE`.
