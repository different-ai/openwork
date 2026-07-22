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
button, or an entirely new screen. Every experience gets validated the same
way — by producing **fraimz**, the frame-by-frame proof
(`evals/results/<run-id>/fraimz.html`) where each frame binds a claim, the user
action, an observable assertion, and a validated screenshot.

The deliverable and the full loop (frame → coded flow → drive the real app via
CDP → validate/repair → verdict) live in the **`fraimz` skill** — load it
whenever a task asks you to "create a fraimz" / "prove it works", or whenever a
change touches anything observable outside the process. Run it via the
`/fraimz` command or `pnpm fraimz --flow <id>`.

Report `Passed` only when `fraimz.html` exists and every claim is backed by an
observable assertion; otherwise `Incomplete` / `Failed`, stated honestly with
repro steps. Pure docs/comments and types-only changes with no runtime path may
skip — but say so explicitly. For changes you expect to be inert, the `fraimz`
skill's canonical core flow proves the core experience is unchanged.

## Demo-Driven Development (the paved path)

Feature work starts with the demo, not a PRD:

1. `/voiceover <feature>` — align on the demo script; **no code until it is approved** (`voiceover` skill).
2. Build on a fresh worktree/branch (`git worktree add ...`), never on the user's checkout.
3. Prove it with fraimz until every frame holds (`fraimz` skill).
4. Open a PR against `dev` and post the proof on it: `pnpm fraimz --flow <id> --pr`.

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
