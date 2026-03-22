# Model Behavior Picker UX

## What changed

- Replaced generic `thinking` labels with model-aware behavior copy.
- Moved behavior selection into the model picker so users see model + reasoning controls together.
- Added a story-book preview for the composer trigger and settings card.

## Story-book proof

### Composer preview

![Composer model button](./screenshots/model-behavior-composer-story-book.png)

Verified:
- The active model and its reasoning profile are clearly displayed right above the input.
- Added provider icons (OpenAI, Anthropic, or 2-letter fallbacks) for quick visual scanning.

### Settings preview

![Model behavior settings card](./screenshots/model-behavior-settings-story-book.png)

Verified:
- Settings preview shows the selected default model.
- The model behavior row explains the current reasoning style in plain language.
- `Open picker` routes to the same picker used from the composer.

### Picker preview

![Model behavior picker](./screenshots/model-behavior-picker-story-book.png)

Verified:
- The picker explains each model's reasoning pattern (`Reasoning effort`, `Extended thinking`, `Built-in reasoning`).
- The active model exposes inline behavior options on its card.
- Switching from Claude to GPT-5 updated the composer label from `Extended thinking · Maximum` to `Reasoning effort · Provider default`.

## Validation

- `pnpm --filter @openwork/app typecheck`
- `pnpm --filter @openwork/story-book typecheck`
- `pnpm --filter @openwork/app build`
- `pnpm --filter @openwork/story-book build`
- Chrome DevTools MCP against `pnpm --filter @openwork/story-book dev --host 127.0.0.1 --port 4174`

## Notes

- Chrome MCP console showed no runtime errors from this change.
- DevTools reported an existing accessibility issue in story-book about form fields missing `id`/`name`; this feature did not add that issue.
- Attempted `packaging/docker/dev-up.sh`, but the local dev stack did not become healthy in this worktree: the orchestrator install hit a pnpm file-copy ENOENT and the share build was later killed with exit `137`.
