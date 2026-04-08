> OpenWork is the open source alternative to Claude Cowork/Codex (desktop app).


## Core Philosophy

- Local-first, cloud-ready: OpenWork runs on your machine in one click. Send a message instantly.
- Composable: desktop app, WhatsApp/Slack/Telegram connector, or server. Use what fits, no lock-in.
- Ejectable: OpenWork is powered by OpenCode, so everything OpenCode can do works in OpenWork, even without a UI yet.
- Sharing is caring: start solo on localhost, then explicitly opt into remote sharing when you need it.

<p align="center">
  <img src="./app-demo.gif" alt="OpenWork demo" width="800" />
</p>

OpenWork is designed around the idea that you can easily ship your agentic workflows as a repeatable, productized process.

## Alternate UIs
- **OpenWork Orchestrator (CLI host)**: run OpenCode + OpenWork server without the desktop UI.
  - install: `npm install -g openwork-orchestrator`
  - run: `openwork start --workspace /path/to/workspace --approval auto`
  - docs: [apps/orchestrator/README.md](./apps/orchestrator/README.md)

## Quick start

Download the desktop app from [openworklabs.com/download](https://openworklabs.com/download), grab the latest [GitHub release](https://github.com/different-ai/openwork/releases), or install from source below.

- macOS and Linux downloads are available directly.
- Windows access is currently handled through the paid support plan on [openworklabs.com/pricing#windows-support](https://openworklabs.com/pricing#windows-support).
- Hosted OpenWork Cloud workers are launched from the web app after checkout, then connected from the desktop app via `Add a worker` -> `Connect remote`.

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
- **Debug exports**: copy or export the runtime debug report and developer log stream from Settings -> Debug when you need to file a bug.
- **Skills manager**:
  - list installed `.opencode/skills` folders
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

### Local Dev Prerequisites (Desktop)

Before running `pnpm dev`, ensure these are installed and active in your shell:

- Node + pnpm (repo uses `pnpm@10.27.0`)
- **Bun 1.3.9+** (`bun --version`)
- Rust toolchain (for Tauri), with Cargo from current `rustup` stable (supports `Cargo.lock` v4)
- Xcode Command Line Tools (macOS)
- On Linux, WebKitGTK 4.1 development packages so `pkg-config` can resolve `webkit2gtk-4.1` and `javascriptcoregtk-4.1`

### One-minute sanity check

Run from repo root:

```bash
git checkout dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile

which bun
bun --version
pnpm --filter @openwork/desktop exec tauri --version
```

### Install

```bash
pnpm install
```

OpenWork now lives in `apps/app` (UI) and `apps/desktop` (desktop shell).

### Run (Desktop)

```bash
pnpm dev
```

`pnpm dev` now enables `OPENWORK_DEV_MODE=1` automatically, so desktop dev uses an isolated OpenCode state instead of your personal global config/auth/data.

### Run (Web UI only)

```bash
pnpm dev:ui
```

All repo `dev` entrypoints now opt into the same dev-mode isolation so local testing uses the OpenWork-managed OpenCode state consistently.

### Arch Users:

```bash
sudo pacman -S --needed webkit2gtk-4.1
curl -fsSL https://opencode.ai/install | bash -s -- --version "$(node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync('constants.json','utf8')); process.stdout.write(String(parsed.opencodeVersion||'').trim().replace(/^v/,''));")" --no-modify-path
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

- `apps/desktop/src-tauri/capabilities/default.json`

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

If you need to report a desktop or session bug, open Settings -> Debug and export both the runtime debug report and developer logs before filing an issue.

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
- Use `.github/pull_request_template.md` when opening PRs and include exact commands, outcomes, manual verification steps, and evidence.
- If CI fails, classify failures in the PR body as either code-related regressions or external/environment/auth blockers.
- Add new PRDs to `apps/app/pr/<name>.md` following the `.opencode/skills/prd-conventions/SKILL.md` conventions described in `AGENTS.md`.

Community docs:

- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `SUPPORT.md`
- `TRIAGE.md`

First contribution checklist:

- [ ] Run `pnpm install` and baseline verification commands.
- [ ] Confirm your change has a clear issue link and scope.
- [ ] Add/update tests for behavioral changes.
- [ ] Include commands run and outcomes in your PR.
- [ ] Add screenshots/video for user-facing flow changes.

## For Teams & Businesses

Interested in using OpenWork in your organization? We'd love to hear from you — reach out at [ben@openworklabs.com](mailto:ben@openworklabs.com) to chat about your use case.

## License

MIT — see `LICENSE`.

## Supported Languages

Translated READMEs: [`translated_readmes/`](./translated_readmes/README.md). README languages: English, 简体中文, 繁體中文, 日本語.

App i18n languages: English (`en`), Japanese (`ja`), Simplified Chinese (`zh`), Vietnamese (`vi`), Brazilian Portuguese (`pt-BR`).
