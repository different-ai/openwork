# OpenWork

OpenWork is a free, open-source desktop app made for sharing AI workflows. It is an open-source alternative to Claude Cowork and Codex for macOS, Windows, and Linux.

Add one OpenWork MCP to Codex, Claude Code, Cursor, or another compatible agent and reuse the same skills, MCPs, and connected services across your tools, teammates, and machines. Create something once, share it with coworkers or friends, or keep it for yourself.

The desktop app is there when you want a dedicated workspace, but it is not required. You can use OpenWork from the agent you already have. For larger organizations, the admin interface lets you publish capabilities, manage access, and configure shared or per-user connections.

[**Download OpenWork**](https://openworklabs.com/download)

<img width="1481" height="842" alt="OpenWork desktop app" src="https://github.com/user-attachments/assets/66a8dd9b-5260-488c-957d-e54331e78c1c" />

## Install with your AI agent

Already use an AI agent? Copy this prompt and paste it into Claude Code, Cursor, Codex, ChatGPT, or any agent that can run commands on your computer.

```text
Install OpenWork on my computer, set up my first workspace, and open it ready to use. Follow the steps in https://openworklabs.com/start.md?v=hero
```

1. Installs OpenWork
2. Creates your workspace
3. Opens it ready to run

## Use OpenWork from any agent

The OpenWork MCP brings your assigned skills, plugins, MCP connections, Google Workspace, and Microsoft 365 capabilities into any compatible agent.

It exposes two tools: `search_capabilities` finds what you can use, and `execute_capability` runs it. After adding the MCP, your client opens a browser so you can sign in and choose your OpenWork organization.

### Codex

```bash
codex mcp add openwork --url https://api.openworklabs.com/mcp/agent
```

### Claude Code

```bash
claude mcp add --transport http openwork https://api.openworklabs.com/mcp/agent
```

### OpenCode

Add this to `opencode.json`:

```json
{
  "mcp": {
    "openwork": {
      "type": "remote",
      "enabled": true,
      "url": "https://api.openworklabs.com/mcp/agent",
      "oauth": {}
    }
  }
}
```

### Any MCP client

Use this remote MCP server URL:

```text
https://api.openworklabs.com/mcp/agent
```

## OpenWork Den

OpenWork Den is the control plane for managing OpenWork across a team or organization.

- Provision inference at scale and control which members and teams can use each model provider.
- Invite teammates, create teams, and manage access from one place.
- Set desktop policies, restrict local model access, and control which app versions your organization can use.
- Publish skills and plugins through marketplaces, then assign them to the organization, a team, or specific people.
- Import Agent Plugins or Anthropic-compatible plugins and make their supported skills and remote MCPs available through the OpenWork MCP.

<img width="1546" height="915" alt="OpenWork Den organization control plane" src="https://github.com/user-attachments/assets/033dbbfe-5661-4f7c-869c-46278406d6cc" />

## Licensing

This repository uses a directory-split license, similar to GitLab:

- **Everything outside `ee/` is MIT** — the desktop app and core platform are open source, free for any use.
- **Everything under `ee/` (OpenWork Den — the org control plane) is under the [OpenWork EE License](ee/LICENSE)**, a source-available license. The code is public so you can audit exactly what you deploy. Production use requires an [OpenWork subscription](https://openworklabs.com/pricing), except that it is **free for organizations with up to 5 users**, **free to evaluate for 30 days at any size**, and always free for development and testing. Each `ee/` release additionally converts to MIT two years after publication.

Versions released before this license was adopted remain under their original license (FSL-1.1-MIT). See [pricing](https://openworklabs.com/pricing) and the [subscription terms](https://openworklabs.com/terms/subscription).

## Documentation

[Read the OpenWork docs.](https://openworklabs.com/docs)

## Getting started (contributors)

The fastest path from a fresh clone to a running dev build.

### Prerequisites

- **Node 24** — pinned in [`.nvmrc`](./.nvmrc) (`nvm use` picks it up).
- **pnpm 11** — pinned in `package.json` (`packageManager`); run `corepack enable` to use the pinned version automatically. Never use npm or yarn.
- **Git with DCO sign-off** — every commit needs a `Signed-off-by` trailer (`git commit -s`). See [CONTRIBUTING.md](./CONTRIBUTING.md).

### First run

```bash
git clone https://github.com/different-ai/openwork.git
cd openwork
corepack enable
pnpm install
pnpm dev   # launches the Electron desktop app with hot reload
```

### Repository layout

| Path | What lives there |
| --- | --- |
| `apps/` | the desktop app: React UI (`apps/app`), Electron shell (`apps/desktop`), and `openwork-server` (`apps/server`) (MIT) |
| `packages/` | shared core packages (MIT) |
| `ee/` | OpenWork Den — the org control plane, MCP gateway, and inference (EE License, see [Licensing](#licensing)) |
| `evals/` | executable test specs built on `@openwork/testkit` — see [`evals/README.md`](./evals/README.md) |
| `worlds/` | declarative dev/test environment definitions for `pnpm world` |
| `docs/` | operator, feature, and release docs |
| `.opencode/skills/` | repository agent skills (testing, release, Daytona, and more) |

### Testing

All executable coverage lives in `evals/specs/**/*.test.ts`; app-driving journeys use `.e2e.test.ts`.

```bash
pnpm --dir evals install --frozen-lockfile   # once
pnpm evals:pr specs/<name>.test.ts           # app-less PR-lane spec
pnpm evals:e2e <name> --local                # app-driving E2E journey, run locally
```

Runtime-observable changes need test evidence on the PR. `AGENTS.md` and [`evals/README.md`](./evals/README.md) describe the verification contract and vocabulary.

### Sending a pull request

1. Branch from `dev` (the default branch) and open your PR against `dev`.
2. Sign off every commit: `git commit -s`.
3. Keep the diff as small as possible, and include or update test evidence for runtime-observable changes.
4. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the DCO and licensing rules — contributions under `ee/` additionally require a CLA.

## Local development

For one checkout, keep using `pnpm dev`; with no extra environment variables it reuses the existing shared dev profile.

To run multiple git worktrees at once, use:

```bash
pnpm dev:worktree
```

That sets `OPENWORK_DEV_PROFILE=auto`, derives a stable profile name from the worktree path, lets Electron choose a free CDP port, and asks Vite for a free dev-server port. You can also choose a named profile, for example `OPENWORK_DEV_PROFILE=my-feature OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=0 PORT=0 pnpm dev`.

`dev:worktree` also defaults `OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN=1`. A brand-new profile has no stored credentials, so on macOS the real keychain prompts as soon as Chromium persists an authenticated cookie, and that modal blocks Electron's main loop until it is dismissed. Set `OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN=0` if you specifically want the system keychain in an isolated profile.

Dev startup prints a banner like `[openwork] dev profile=... cdp=http://127.0.0.1:9823`; use it to find the profile directory and pass the CDP URL to local tooling.

If a second instance cannot get the profile lock it now says so and exits, instead of lingering with an open CDP port and no window.

### Headless web (no Electron)

To run the OpenWork UI in a browser against a local `openwork-server` (no desktop shell):

```bash
pnpm world up dev-headless --detach
```

`pnpm dev:headless-web` is a compatibility alias for the same script. The alias
remains foreground by default and accepts `--detach`; `world up` is foreground
unless `--detach` is explicit.

This is an isolated launcher:

- Writes `tmp/headless-server.json` and never reads `~/.config/openwork/server.json`
- Authorizes the chosen workspace root automatically, and merges (never rewrites) that config on relaunch, so workspaces you add through the UI survive `--replace`
- Starts Vite + `openwork-server` with a stable owner bearer forced into the UI. Crash-restarts keep open tabs working. The privileged host token stays on the server process and is never inlined into the Vite bundle.
- Proxies Den Cloud calls same-origin: Vite serves `/api/den` (forwarded to the Den control plane) and the app pins its Den API there via `VITE_DEN_API_BASE_URL`, so Cloud calls are never CORS-blocked and stale `localStorage` base URLs are cleared on load
- Publishes an owner-only runtime manifest at `tmp/dev-headless-web.json` (`0600`), and allows browser calls to the local server only from the web app's own origins — not every site you visit
- Uses stable ports by default (web `5178`, server `8778`; falls back to free ports when taken, override with `OPENWORK_WEB_PORT` / `OPENWORK_PORT`)
- Is single-instance as `dev-headless`; stop it with `pnpm world down dev-headless` before launching it again
- Keeps Vite and the backend under one script lifecycle, so either sibling exiting stops the other instead of leaving an orphan
- In detached mode, waits for health, prints non-secret outputs and receipt/log paths, and exits

Script-specific options must follow `--`:

```bash
pnpm world up dev-headless --detach -- --replace
pnpm world up dev-headless --detach -- --replace --keep-tokens
```

`--replace` restarts the headless runtime with fresh tokens; add
`--keep-tokens` to retain the previous tokens. `--rotate-tokens` is also
accepted by this script. These are not generic `world` options.

Open the printed Web URL. Cloud sign-in in headless web uses the **copy/paste** handoff (hosted Den cannot redirect session grants back to `http://127.0.0.1`):

1. Account → Sign in (opens Den; the paste field opens in Settings)
2. Sign in on Den
3. Copy the OpenWork link / one-time code Den shows
4. Paste it under **Paste sign-in code** → Finish sign-in

Point Den at a local stack with `OPENWORK_DEV_DEN_PROXY_TARGET=http://127.0.0.1:3005` while `pnpm dev:web-local` is running. Set `OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY=0` to disable the Den wiring.

The other checked-in scripts include `worlds/headless-prod-live.ts` and
`worlds/desktop-prod-live.ts`. Both intentionally share installed production
state and require their script-specific opt-in after `--`, for example
`pnpm world up desktop-prod-live -- --allow-shared-state`. List scripts and
running receipts with `pnpm world list`. The headless
production world is hard-limited to loopback; remote-access/public-host settings
are refused because its browser session uses production credentials.
