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

To maximize merge speed, include evidence of the end-to-end flow:

* Ideally: attach a short video/screen recording showing the flow running successfully.
* Otherwise: screenshots are acceptable, but video is preferred.

If you cannot run tests or capture the video, say so explicitly and explain why, and include the exact commands/steps for the reviewer to reproduce.

## Validate Every Experience

Almost everything we change has an effect on the outside world — the
filesystem, the runtime DB, server API responses, provisioning, sessions,
or config. So the default is not "write code and hope"; it is **propose a
flow, then drive it as the end user and validate it against reality until
it actually holds.**

A change is an *experience*: it might be a persistent feature, a single new
button, or an entirely new screen. Every experience gets validated with the
same loop.

### When this applies

Run a user-driven eval whenever a change can alter behavior observable
outside the process: filesystem, SQLite/runtime DB, server endpoints,
sessions, config, provisioning, cloud sync, or network. **This also applies
to changes you expect to be inert** — refactors, storage swaps, renames,
dead-code removal. In that case the eval's job is to prove the core flow is
unchanged. Pure docs/comments and types-only changes with no runtime path
may skip — but say so explicitly.

### The loop (do not report success from a click or a return value alone)

1. **Frame the experience** as a one-line claim ("user can do X and sees Y").
2. **Express it as a flow** — reuse or add a coded flow in
   `evals/flows/*.flow.mjs`. The end user is the protagonist (driven via
   CDP). REST/DB/filesystem checks are *only* how you witness the expected
   side effects, never the thing being tested.
3. **Drive it for real** with `pnpm fraimz --flow <id>` (Daytona preferred,
   local Electron fallback). Observe → act → observe → assert.
4. **Validate, repair, repeat.** If a frame does not support the claim, fix
   the visible state or the code and rerun. Every claim needs an observable
   assertion via `ctx.prove("claim", { action, assert, screenshot })`.
5. **Output fraimz and give a verdict.** The deliverable is
   **fraimz** — `evals/results/<run-id>/fraimz.html`, the frame-by-frame proof
   where each frame binds a claim, the user action, the assertion, and a
   validated screenshot. It is the atomic artifact a human looks at to
   understand the experience at a glance. Report `Passed` only when fraimz
   exists and every claim is backed by an observable assertion; otherwise
   `Incomplete` / `Failed`, stated honestly with repro steps.

### Make fraimz

"Make fraimz for this flow" is the trigger for the whole loop: it creates or
picks the eval, drives it as the end user, validates and repairs, and outputs
`fraimz.html`. Run it via the `/fraimz` command or `pnpm fraimz --flow <id>`.
fraimz is what we look at; we can fine-tune what each frame captures over time.

### The core flow

When a change is expected to be inert, re-run the canonical core flow —
**open the app → write a message → get a response → close → reopen and
confirm the session survived** (`evals/flows/core-flow.flow.mjs`). If that
stays green, the inertness claim is backed by evidence.

### Where the mechanics live

Keep this section short on purpose. The rails are documented elsewhere and
are the source of truth:

- `evals/README.md` — runner, flags, conventions, `ctx.*` helpers.
- `evals/flows/` — existing coded flows to reuse or pattern-match.
- Skills: `run-evals` (launch + run) and `daytona-flow-validator` (the
  observe → act → assert → repair → verdict loop).

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
