# AGENTS.md

OpenWork is a free, open-source desktop app (macOS, Windows, Linux) for doing
work with AI agents on your own files — an open-source alternative to Claude
Cowork and Codex, built on OpenCode, running any model from 50+ providers.
Desktop mode keeps files local; cloud is optional. Three surfaces live in this
repo:

* **Desktop app** (`apps/`, `packages/`) — local-first agent workspace: chat on
  files, skills, browser automation, scheduled automations, Anthropic-compatible
  plugins.
* **OpenWork MCP gateway** (`ee/apps/den-api`) — one URL
  (`api.openworklabs.com/mcp/agent`) that brings org-assigned skills, plugins,
  and connections (Google Workspace, Microsoft 365, MCPs) into Codex, Claude
  Code, Cursor, or any MCP client via `search_capabilities` /
  `execute_capability`.
* **OpenWork Den** (`ee/apps/den-*`) — the org control plane: provision
  inference, manage teams and access, set desktop policies, publish skills and
  plugins through marketplaces.

The app consumes OpenWork server surfaces (self-hosted or hosted) rather than
inventing parallel behavior. Anything OpenCode can do is available in OpenWork,
even before a dedicated UI exists.

OpenCode v2 is the default. Hosts automatically back up and migrate existing v1
history when idle, without a Den feature flag or Helm setting. Respect explicit
manual engine choices and local support/test overrides; never restore the retired
`engineV2ForceUpgrade` gate. See `docs/opencode-engine-migration.md`.

Customer-cloud managed installation architecture lives in
`infra/managed-deployments/README.md` and `docs/managed-deployments.md`. AWS
uses CloudFormation/CodeBuild; GCP uses customer-approved Cloud Shell and
impersonated Terraform behind `managedDeployments` (cloud only, off), the same
switch as AWS and the deployment agent tools.
Installer publication/configuration is an operator action, not CLI sign-in or a
feature rollout. Never fake readiness; local tests do not prove a live install.
Killing a rollout blocks launches without deleting customer resources or
interrupting authenticated enrollment/health reports.

## Confidentiality (hard rule — this repo is public)

Never let a branch name, commit, PR text, comment, fixture, or evidence identify
a customer, prospect, partner, or outside person; use internal ticket IDs, and
escalate any leak instead of rewriting history.

## Generated API contracts

Den route metadata and shared schemas are the source of truth. OpenAPI and
`packages/sdk/src/gen/**` are ignored build artifacts: never commit or hand-edit
them. CI generates, lints and typechecks them from the PR source and uploads
an artifact. Hosted docs read the normalized deployed contract at
`/openapi.json?public=1`; the raw `/openapi.json` remains available.

`pnpm sdk:build` and SDK typechecks generate missing or stale artifacts first.
`pnpm den:contract` forces a clean generation and prepares/removes a disposable
local MySQL database. Start MySQL with `pnpm dev:den:mysql`; only
`OPENWORK_CONTRACT_MYSQL_URL` can select alternate localhost credentials.
`DATABASE_URL` is never used for generation. After a merge/rebase regenerate
locally when needed; generated files do not enter the merge. Never regenerate
a Drizzle migration snapshot to resolve an API conflict.

Optional: `pnpm hooks:install` enables source validation before commits. It
refuses unstaged/untracked contract inputs and never stages generated outputs.
Hooks never commit, push, or change CI/Warden policy; CI remains authoritative.

## Coding

* pnpm only, never npm/yarn. TypeScript: never `any`, typecasts, or `as` unless
  100% necessary or instructed.
* Prefer Tailwind, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod,
  Drizzle, Better-Auth. Reuse `@/components`; end users are non-technical.
* Put any change to product behavior that users can see behind a feature
  flag, so it can be turned off without a deploy: new or changed flows,
  screens, options and defaults. Ship directly only what users won't notice
  as a behavior change: fixes that restore intended behavior, polish,
  refactors, tests and `/admin` tooling. When unsure, flag. Follow
  `.opencode/skills/add-a-feature`.
* Any user-facing UI (desktop app, Den web, MCP Apps, artifact views) follows
  `DESIGN.md`: read it before designing, cite its rule ids in PRs, and attach
  screenshots of new UI. The optional
  `.warden/skills/design-spec-review` skill can review these rules locally.

## Verify changes headless

Launching the desktop app on a developer's computer opens a window that takes
focus. Check app UI in headless Chrome instead:

* Specs: `seed.appWeb` (`write-a-spec`); `run-tests` explains which placement
  tests your working tree.
* By hand: `pnpm world up dev-app-web --detach -- --browser`, then drive the
  printed `cdp` address (`drive-desktop-cdp`).
* Use the desktop app (`seed.desktop`, `pnpm dev`, `preview-desktop`,
  `live-desktop`) only when the user asks or the change needs the desktop
  shell: titlebar and window controls, native menus and dialogs, `openwork://`
  links and OAuth hand-off, the built-in browser pane, updater, quit and
  relaunch, or packaged builds. Prefer `--daytona` for those so the window
  opens in a sandbox; Daytona builds a pushed commit, not your working tree.

