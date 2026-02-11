# Give Me a Soul Entry Point

## What changed

- Added an empty-session quick action card: **Give me a soul**.
- Added a bundled prompt template at `packages/app/src/app/data/commands/give-me-a-soul.md`.
- The quick action prefers `/<command>` execution when a workspace command named `give-me-a-soul` exists; otherwise it sends the bundled setup prompt directly.

## UX intent

- Keep Soul Mode optional and discoverable as one starter action.
- Explain value + tradeoff in plain language before any technical setup.
- Bake in an easy revert requirement (`/take-my-soul-back`) in the starter prompt.

## Evidence

- Screenshot: `packages/app/pr/screenshots/give-me-a-soul-empty-session.png`
