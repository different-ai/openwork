## What changed

- Tightened the composer shell when the task/steps strip is present so the strip docks directly above the composer instead of floating with a large gap.
- Scoped the spacing change to the task/steps state only; normal composer spacing stays unchanged.

## Files

- `packages/app/src/app/components/session/composer.tsx`
- `packages/app/src/app/pages/session.tsx`

## Verification

- `pnpm --filter @different-ai/openwork-ui build`
- `pnpm --filter @different-ai/openwork-ui typecheck` -> fails on pre-existing `packages/app/src/app/components/model-picker-modal.tsx` union typing errors.
- `pnpm --filter @different-ai/openwork-ui test:todos` -> fails with `Timed out waiting for /global/health: Unauthorized`.
- `packaging/docker/dev-up.sh` -> Docker orchestrator exits with code `137` during dependency install in this environment.

## Screenshot

- `packages/app/pr/screenshots/steps-composer-docked.png`

## Proof prompt

- Prompt used in the proof capture: `Use the todo list to track these 5 steps and then do them: 1. say alpha 2. say beta 3. say gamma 4. say delta 5. say epsilon.`
- Result: OpenWork rendered the task/steps strip (`5 out of 5 tasks completed`) directly above the composer with no floating gap.

## Proof setup

- Started `opencode serve` with explicit basic auth.
- Started `packages/server/dist/bin/openwork-server` directly against that OpenCode instance.
- Started Vite with `VITE_OPENWORK_URL` + `VITE_OPENWORK_TOKEN` so the web app could connect to the proof server and capture a real session screenshot.
