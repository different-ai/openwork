# Orbita Layout UI Refresh

Branch: `task/orbita-layout-ui`

## Scope

- Restyled the session surface to the new Orbita three-pane layout.
- Updated left rail worker/session treatment, center timeline canvas, and right rail capability + file panels.
- Updated floating composer visual hierarchy (workspace label, chip menus, blue send affordance).
- Added docs style reference for this UI language.

## Files

- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/components/session/workspace-session-list.tsx`
- `packages/app/src/app/components/session/message-list.tsx`
- `packages/app/src/app/components/session/composer.tsx`
- `packages/app/src/app/components/session/inbox-panel.tsx`
- `packages/app/src/app/components/session/artifacts-panel.tsx`
- `packages/app/src/app/index.css`
- `packages/docs/orbita-layout-style.mdx`
- `packages/docs/docs.json`
- `packages/docs/index.mdx`

## Screenshot evidence

- Session flow in Docker stack + Chrome MCP:
  - `packages/app/pr/screenshots/orbita-layout-ui-session.png`

## Verification

- `pnpm --filter @different-ai/openwork-ui typecheck`
- `pnpm --filter @different-ai/openwork-ui build`
- `pnpm --filter @different-ai/openwork-ui test:health` (fails in this environment: `Unauthorized` waiting for `/global/health`)
- `packaging/docker/dev-up.sh`
- Chrome MCP: open printed Docker URL `http://localhost:57465/session`, send `smoke: hello from chrome mcp`, verify response rendered (`Hello! How can I help you today?`).
