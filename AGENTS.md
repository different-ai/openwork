# AGENTS.md

OpenWork helps users run agents, skills, and MCP. It is an open-source alternative to Claude Cowork/Codex as a desktop app.

## What OpenWork Is

OpenWork is a practical control surface for agentic work:

* Run local and remote agent workflows from one place.
* Use OpenCode capabilities directly through OpenWork.
* Compose desktop app, server, and messaging connectors without lock-in.
* Treat the OpenWork app as a client of the OpenWork server API surface.
* Connect to hosted workers through a simple user flow: `Add a worker` -> `Connect remote`.

## Core Philosophy

* **Local-first, cloud-ready**: OpenWork runs on your machine in one click and can connect to cloud workflows when needed.
* **Server-consumption first**: the app should consume OpenWork server surfaces (self-hosted or hosted), not invent parallel behavior.
* **Composable**: use the desktop app, WhatsApp/Slack/Telegram connectors, or server mode based on the task.
* **Ejectable**: OpenWork is powered by OpenCode, so anything OpenCode can do is available in OpenWork, even before a dedicated UI exists.
* **Sharing is caring**: start solo, then share quickly; one CLI or desktop command can spin up an instantly shareable instance.


## Pull Request Expectations (Fast Merge)

If you open a PR, you must run tests and report what you ran (commands + result).

For runtime-observable changes, include the `@openwork/testkit` evidence tape.
Custom screenshots and recordings may supplement that tape, but never determine the
pass/fail verdict. If validation cannot run, say why and give exact repro steps.

## Validate Every Experience

Almost everything we change affects the filesystem, runtime DB, server API,
provisioning, sessions, config, or UI. New executable end-to-end coverage has
one path: `evals/specs/**/*.test.ts`, with `test` imported from
`@openwork/testkit`. Specs that drive the app use `.slow.test.ts`.

Use the skills in this order: `write-a-spec` → `run-tests` →
`diagnose-a-red-run` when failing → `publish-evidence` for an existing ambient
evidence tape. Evidence is ambient: do not create or pass roll handles. Report
`Passed` only when every claim has an observable assertion in the tape;
otherwise report `Incomplete` or `Failed` with repro steps. Pure docs/comments,
types-only changes, and inert agent config may skip runtime proof, but say so.

## Demo-Driven Development (the paved path)

Feature work starts with the demo, not a PRD:

1. `/voiceover <feature>` — align on the demo script; **no code until it is approved** (`voiceover` skill).
2. Build on a fresh worktree/branch (`git worktree add ...`), never on the user's checkout.
3. Translate the approved narration directly into `evals/specs/<slug>.slow.test.ts`, then build and run it until every claim holds.
4. Open a PR against `dev` and publish the existing testkit evidence tape (`publish-evidence` skill).

## Coding Guidelines

### TypeScript

- Never use `any`, typecasts, or `as`, unless 100% necessary or specifically instructed.

### Package Managers

- Use pnpm.
- Never use npm or yarn.

### UI and UX

- Use components from @/components when possible.
- When creating new components, we prefer using shadcn/ui with (Base UI).
- Assume most end users of OpenWork are non-technical.

### Tech Stack Preferences

When uncertain, prefer: Tailwind, TypeScript, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod, Drizzle, Better-Auth.

### Code Style

- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.
- Use the smallest possible diff to make a change. Then think of how to make it smaller and do that again.
- Avoid fallback expressions when types or control flow already guarantee a value.

### Workflow

- If asked to do too much work at once, stop and state that clearly.
