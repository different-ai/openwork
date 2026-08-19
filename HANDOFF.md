# Handoff — Library + composer + menu (Den inventory)

**Branch:** `feat/library-composer-connections`  
**Remote:** `origin/feat/library-composer-connections`  
**Feature commit:** `80f494408` — `feat(app): unify Library with composer Connections (MCPs)`  
**This file:** latest commit on the same branch.  
**Base:** `dev` (`9f4425725`)  
**PR:** none yet. Open from https://github.com/different-ai/openwork/pull/new/feat/library-composer-connections

```bash
git fetch origin feat/library-composer-connections
git checkout feat/library-composer-connections
# or: git worktree add ../openwork-library-composer origin/feat/library-composer-connections
```

Do not push `dev`. Do not force-push this branch.

Conversation: [Library composer inventory](4b6e113a-57ad-4615-aec9-f2aeac776d78)

## Goal

Library is the inventory for composer capabilities (aligned with Den My Library).
Composer **+** should show what you have on Den, with easy sign-in. Connections and
MCPs are one thing: **Connections (MCPs)**.

## What is on the branch

- Library lists, Den-only Add (signed-in modal → `POST /v1/plugins`; signed-out Add hidden).
- Plugin/connection detail; Den My Library row links (`/dashboard/library/plugins/[pluginId]`).
- Create-skill empty-state flash fix (wait for library + optimistic plugin).
- Composer **+**:
  - One pane **Connections (MCPs)** (MCPs + Connections merged).
  - Lists Den org connections (`useOrgMcpConnections`) plus leftover local / Connect MCP rows.
  - Dedupe: plugin MCP that maps to an org connection id is not listed twice.
  - **Connect your account / Reconnect** on the row when member OAuth needs it.
  - Configure from that pane opens Library `connections`.
  - **Scroll:** + panel has a definite `height` (was `maxHeight` only + `overflow-hidden`, so lists clipped with no scroll). Left nav and right list are `overflow-y-auto`. Cap raised 352 → 520.
- Model select and model picker no longer show the OpenWork Models subscribe promo (composer Configure still goes to `/settings/ai` for providers).

Helpers: `apps/app/src/react-app/domains/session/surface/composer/composer-connections.ts`  
Tests: `apps/app/tests/composer-connections.test.ts`, `apps/app/tests/library-destination.test.ts` (17 unit tests passed locally). **No test evidence.** Verdict for UI claims is Incomplete until an `.e2e.test.ts` exists.

## Not on this branch (left dirty on the checkout)

Unrelated leftovers; do not treat as Library work:

- `.opencode/skills/test/`
- `scripts/release/alpha-downloads.html`

## Honest gaps (why it still feels split)

These are **not** fully unified. Do not claim they are.

1. **Agents and commands:** Add is Den (`POST /v1/plugins` with agent/command files). The Library **Agents / Commands tabs and the + panes** are still the **local OpenCode** lists (`app.agents()`, slash `source: command` on this device). Creating on Den does not write `.opencode/agents` / commands on disk.
2. **MCPs: three surfaces remain in the product, even if + is one list:**
   - local workspace MCP (`listMcp` / OpenCode config)
   - Den plugin remote MCP (Connect inventory)
   - org connection records (`listMcpConnections`, native Gmail / M365 / remote MCP)
   Library still has separate **MCPs** vs **Connections** filters. + Configure goes to **connections** only.
3. **Skills:** mixed list (local disk + Connect), Add is Den-only.
4. **Connectors:** Library cards are org connection records. Composer **+** now prefers those same records, then leftover MCP servers. Local MCP **needs_auth** still has **no Sign in** in + (settings / `mcp auth` modal only).
5. **No testkit tape** for the + menu UI. Unit tests only.

## Next (in order)

1. Work from this branch (or a worktree of it), not from `dev`.
2. Prove + scroll with a long skills/connections list (clipped before).
3. Sign in from + for a Den connection with `needs_signin`; confirm browser OAuth + row flips to connected.
4. Decide whether Library filters should also merge MCPs + Connections (user asked for +; Library still split).
5. If unifying agents/commands: either list Den plugin agents/commands in those tabs, or stop advertising Add as creating the thing the tab shows.
6. Re-run unit tests, then a testkit spec if shipping. Do not call the PR Passed without a tape.

```bash
cd apps/app && bun test tests/composer-connections.test.ts tests/library-destination.test.ts
```

## Key files

| Area | Path |
|---|---|
| + menu | `apps/app/src/react-app/domains/session/surface/composer/composer.tsx` |
| Merge / sign-in | `apps/app/src/react-app/domains/session/surface/composer/composer-connections.ts` |
| Org OAuth | `apps/app/src/react-app/domains/connections/use-org-mcp-connections.ts` |
| Library routing | `apps/app/src/react-app/domains/settings/library.ts` |
| Connect MCP → connection id | `apps/app/src/react-app/domains/session/surface/connect-capability-inventory.ts` (`toMcpEntries`) |
| Library UI | `apps/app/src/react-app/domains/settings/pages/mcp-view.tsx`, `add-library-item-modal.tsx` |
| Den plugin detail | `ee/apps/den-web/app/(den)/dashboard/library/plugins/[pluginId]/page.tsx` |
| Model select | `apps/app/src/components/model-select.tsx` |
| Model picker | `apps/app/src/react-app/domains/session/modals/model-picker-modal.tsx` |
