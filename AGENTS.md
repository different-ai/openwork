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

## Verification (every change)

- The only proof path is `evals/specs/**/*.test.ts` with `test` from
  `@openwork/testkit`; app-driving E2E tests use `.e2e.test.ts`. Prose,
  screenshots, and recordings never decide pass/fail — test evidence does.
- Skills own the mechanics: `prove-a-pr` → `write-a-spec` → `run-tests` →
  `diagnose-a-red-run` when red → `publish-evidence`. Evidence is ambient; never
  create or pass test-evidence recorder handles.
- Verdicts: `Passed` only when every claim has an observable assertion in the
  test run; otherwise `Incomplete` or `Failed` with repro steps. Skips are never
  passed.
- Prefer Daytona when credentials are available; local fallback is an expected
  OSS path, not a failure. Report which lane ran.
- Docs/comments, types-only, and inert agent config may skip runtime proof — say so.

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
 It does not use `~/.config/openwork/server.json`. Stop a running script with
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
