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

Note: the screenshot was captured from the running web shell after the Docker + local headless startup paths both hit existing environment/auth blockers, so it demonstrates the corrected docked placement rather than a full server-backed session run.
