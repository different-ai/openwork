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

Customer-cloud managed installation architecture lives in
`infra/managed-deployments/README.md` and `docs/managed-deployments.md`. AWS
uses CloudFormation/CodeBuild; GCP uses customer-approved Cloud Shell and
impersonated Terraform behind `managedDeploymentsGcp` (cloud only, off).
Installer publication/configuration is an operator action, not CLI sign-in or a
feature rollout. Never fake readiness; local tests do not prove a live install.
Killing a rollout blocks launches without deleting customer resources or
interrupting authenticated enrollment/health reports.

## Confidentiality (hard rule — this repo is public)

Never let a branch name, commit, PR text, comment, fixture, or evidence identify
a customer, prospect, partner, or outside person; use internal ticket IDs, and
escalate any leak instead of rewriting history.

## Generated API contracts

After changing Den routes, their shared schemas, or the feature registry, run
`pnpm den:contract` (also run by `pnpm features:sync`) and
include `packages/docs/openapi.json` and `packages/sdk/src/gen/**` in the same
commit. The command builds once and generates both outputs from one snapshot. It
prepares and removes a disposable local MySQL database automatically; start
MySQL with `pnpm dev:den:mysql`. It never uses `DATABASE_URL`; use
`OPENWORK_CONTRACT_MYSQL_URL` only for alternate localhost credentials.
After merging/rebasing `dev`, regenerate rather than choosing ours/theirs for
conflicted generated files. Never hand-edit them or regenerate a Drizzle migration
snapshot to resolve an API conflict.

Optional: `pnpm hooks:install` enables a pre-commit hook that skips unrelated
commits and regenerates/stages only contract outputs for API changes. It refuses
unstaged/untracked contract inputs or outputs, so finish partial staging first.
Hooks never commit, push, or change CI/Warden policy; CI remains authoritative.

## Coding

* pnpm only, never npm/yarn. TypeScript: never `any`, typecasts, or `as` unless
  100% necessary or instructed.
* Prefer Tailwind, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod,
  Drizzle, Better-Auth. Reuse `@/components`; end users are non-technical.
* New feature or a change users would notice? Declare it, off, in
  `packages/features/src/registry.ts` before writing the code, make it safe
  to turn off, then roll it out from `/admin`. Follow
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
  printed `cdp` address.
* Use the desktop app (`seed.desktop`, `pnpm dev`, `preview-desktop`,
  `live-desktop`) only when the user asks or the change needs the desktop
  shell: titlebar and window controls, native menus and dialogs, `openwork://`
  links and OAuth hand-off, the built-in browser pane, updater, quit and
  relaunch, or packaged builds. Prefer `--daytona` for those so the window
  opens in a sandbox; Daytona builds a pushed commit, not your working tree.

## Principles

Short rules that the workflow skills in `.opencode/skills/` build on. Before
applying one, read it in full: load the `principle-<name>` skill, or open
`.opencode/skills/principle-<name>/SKILL.md`. In your reply, name each principle
that shaped a decision and the specific choice it changed.

* **Prove It on the Real Thing.** Before saying something works: a spec on the shipping runtime and bytes, not a proxy.
* **Honest Verdict.** Reporting results: Passed, Incomplete, or Failed, bound to a SHA; a skip is never a pass.
* **Clean Control.** Before calling a failure pre-existing, flaky, or fixed: rerun on a clean baseline.
* **Scope Secrets.** A command needs a key: load it inline for that one command, never print it.
* **Fix the Product, Not the Gate.** A check disagrees with the product: fix the product or change the claim on purpose.
* **Touch Only What You Own.** Sessions, sandboxes, worlds, processes, logins: act only on what you made, by exact ID.
* **Use the Maintained Lever.** A multi-step procedure: use the repo's script or helper; write one if you repeat it.
* **Thirty-Second Reader.** Anything a human reviews: who can now do what, in product words, then stop.
