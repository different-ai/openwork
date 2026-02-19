# Soul Starter Observability + Steering

## What changed

- Updated the bundled `give-me-a-soul` starter template to seed memory from real workspace context (AGENTS + sessions + todos + transcript snippets) instead of empty placeholders.
- Expanded the starter to create explicit interaction/observability commands (`soul-status`, `steer-soul`) alongside `soul-heartbeat` and `take-my-soul-back`.
- Strengthened Soul dashboard steering prompts so they explicitly pull from `.opencode/soul.md`, AGENTS guidance, and OpenCode sqlite activity.
- Added an **Improvement sweep** action in the Soul dashboard.
- Changed **Enable soul mode** on the Soul dashboard to inject the full bundled starter template prompt.

## Why

- Soul mode check-ins were becoming stale/generic because the starter flow often left memory under-seeded.
- Users needed a clearer, built-in way to observe and steer Soul behavior without ad-hoc prompting.

## Evidence

- `pr/soul-starter-observability/evidence/soul-dashboard-steering.png`
- `pr/soul-starter-observability/evidence/session-enable-soul-prefilled.png`

## Validation

- `pnpm --filter @different-ai/openwork-ui typecheck`
- `pnpm --filter @different-ai/openwork-ui test:health`
- Brought up Docker stack for manual verification: `packaging/docker/dev-up.sh`
- Verified Soul dashboard renders new controls and state card in browser, then shut stack down.
