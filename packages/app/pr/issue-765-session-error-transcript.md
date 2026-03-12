## What changed

- Session send failures now render as compact synthetic assistant turns inside the transcript instead of a large separate warning banner.
- Later successful replies stay normal and do not inherit the previous failure warning below the composer.

## Files

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/components/session/message-list.tsx`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/types.ts`

## Verification

- `pnpm --filter @different-ai/openwork-ui typecheck`
- `pnpm --filter @different-ai/openwork-ui build`
- `pnpm dev:headless-web` on this branch
- `pnpm dev:headless-web` on clean `origin/dev`

## Screenshots

- Before: `packages/app/pr/screenshots/openwork-issue-765-before-settings.png`
- After: `packages/app/pr/screenshots/openwork-issue-765-after-chat.png`

## Proof notes

- Before screenshot: clean `origin/dev`, failed send surfaced on the Settings page instead of the chat transcript.
- After screenshot: failed send renders inline in chat, then a later Big Pickle reply renders normally without leaving a warning under the composer.
- The live repro in this environment used a forced invalid session model override to hit the failure path because a bad Abacus key did not promote Abacus into the enabled-provider picker set.
