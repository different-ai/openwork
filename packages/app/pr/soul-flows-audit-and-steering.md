# Soul Flows: Enable + Audit + Steering

## What changed

- Fixed **Give me a soul** from the empty-session starter so it now falls back to the bundled setup prompt body when the slash command is unavailable.
- Fixed Soul page enable flow so **Enable soul mode** also uses the bundled setup prompt body (instead of assuming `/<command>` exists).
- Updated `runSoulPrompt` to create a session and immediately send the steering/setup prompt (instead of only prefilling composer text).
- Refreshed Soul UI layout to emphasize observability and steering:
  - activation audit checklist (memory, instructions wiring, command, scheduler, log, heartbeat proof)
  - clearer heartbeat proof panel
  - steering checklist state + action triggers mapped to existing Soul actions only

## Verified flows

1. Empty session -> **Give me a soul** sends full setup prompt and starts the flow.
2. Soul tab -> **Enable soul mode** sends full setup prompt and starts the flow.
3. Soul setup completion updates Soul tab audit to passing checks and visible heartbeat proof.
4. Soul tab -> **Run heartbeat now** steering trigger opens a new task and sends the scheduler/heartbeat prompt.

## Validation

- `pnpm --filter @different-ai/openwork-ui typecheck` ✅
- `pnpm --filter @different-ai/openwork-ui build` ✅
- `pnpm --filter @different-ai/openwork-ui test:health` ⚠️ fails in this environment (`/global/health: Unauthorized`)
- Docker + Chrome MCP style verification via browser automation:
  - started stack with `packaging/docker/dev-up.sh`
  - validated both enable flows and steering trigger end-to-end in the running UI
  - validated Soul audit reflects successful setup and heartbeat evidence

## Evidence

- `packages/app/pr/screenshots/soul-flow-a-empty-session.png`
- `packages/app/pr/screenshots/soul-flow-b-audit.png`
- `packages/app/pr/screenshots/soul-flow-c-steering-trigger.png`
