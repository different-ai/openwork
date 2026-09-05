# AGENTS.md

OpenWork is a free, open-source desktop app (macOS, Windows, Linux) for doing
work with AI agents on your own files — an open-source alternative to Claude
Cowork and Codex, built on OpenCode, running any model from 50+ providers.
Desktop mode keeps files local; cloud is optional. Three surfaces live in this
repo:

- **Desktop app** (`apps/`, `packages/`) — local-first agent workspace: chat on
  files, skills, browser automation, scheduled automations, Anthropic-compatible
  plugins.
- **OpenWork MCP gateway** (`ee/apps/den-api`) — one URL
  (`api.openworklabs.com/mcp/agent`) that brings org-assigned skills, plugins,
  and connections (Google Workspace, Microsoft 365, MCPs) into Codex, Claude
  Code, Cursor, or any MCP client via `search_capabilities` /
  `execute_capability`.
- **OpenWork Den** (`ee/apps/den-*`) — the org control plane: provision
  inference, manage teams and access, set desktop policies, publish skills and
  plugins through marketplaces.

The app consumes OpenWork server surfaces (self-hosted or hosted) rather than
inventing parallel behavior. Anything OpenCode can do is available in OpenWork,
even before a dedicated UI exists.

## Confidentiality (hard rule — this repo is public)

Never let a branch name, commit, PR text, comment, fixture, or evidence identify
a customer, prospect, partner, or outside person; use internal ticket IDs, and
escalate any leak instead of rewriting history.

## Verification (every change)

- Proof is a journey spec in `evals/specs/**` (`*.e2e.test.ts` drives the app/Den; `*.test.ts` hits a server or gateway boundary). Unit tests are not proof and never live in `evals/specs`; the boundary ratchet rejects new ones that import product source, read the repo, or spawn test runners.
- Default is zero new test files: run the journey spec that covers the change; extend it for a gap; new file only for a new user journey.
- Run `pnpm evals:e2e <slug>` or `pnpm evals:pr specs/<name>.test.ts`; report the printed placement and verdict.
- `Passed` requires an observable assertion for every claim; skips are never passed.
- Docs/comments, types-only, and inert agent config may skip runtime proof — say so.
- Skill chain: `write-a-spec` → `run-tests` → `diagnose-a-red-run` when red → `publish-evidence`.

## Pull requests

- Do not default to draft PRs. A request to create or make a PR means a
  ready-for-review PR once the required proof is published. Use a draft only
  when the requester explicitly asks for one or the current verdict is
  `Incomplete` or `Failed`, and state exactly what proof is missing.
- Run tests and report commands + results. A runtime-observable change is not
  done until its test evidence is visible on the PR. If validation cannot run,
  say why and give exact repro steps.
## Local headless web (agents)

- `pnpm world up dev-headless --detach` launches an isolated browser UI +
 local `openwork-server` without Electron as a detached script world.
 `pnpm dev:headless-web` remains a compatibility alias with its prior foreground
 default (`--detach` still works). Read
 `tmp/dev-headless-web.json` for the owner-only runtime manifest.
 It does not use `~/.config/openwork/server.json`, and its engine keeps its own
 sessions database at `tmp/dev-headless-opencode.db` instead of the desktop
 app's `~/.local/share/opencode/opencode.db`. Stop a running script with
 `pnpm world down dev-headless`; pass script options after `--`, for example
 `pnpm world up dev-headless --detach -- --replace --keep-tokens`. Cloud sign-in
 is copy/paste handoff (Den cannot redirect grants to localhost): Account → Sign
 in → copy OpenWork link on Den → Paste sign-in code in Settings.

## Coding

- pnpm only, never npm/yarn. TypeScript: never `any`, typecasts, or `as` unless
  100% necessary or instructed.
- Prefer Tailwind, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod,
  Drizzle, Better-Auth. Reuse `@/components`; end users are non-technical.
- Smallest possible diff, then make it smaller. Propose the simpler solution. No
  fallback expressions when types or control flow already guarantee a value.
- If asked to do too much at once, stop and say so.

## Hands-on PR previews

For a preview the user can test inside Codex, use
[preview-my-work](.opencode/skills/preview-my-work/SKILL.md): named Daytona
worlds for Den or real Electron through noVNC, with isolated scenarios,
frontend updates, reset and teardown.
