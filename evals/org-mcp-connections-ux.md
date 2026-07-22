# Org MCP Connections — desktop UX requirements

Spec for how Den-hosted External MCP Connections (PR #2406) surface in the
desktop app. Gathered from design sessions on 2026-07-02. This document is the
source of truth for what `evals/flows/desktop-org-mcp-*.flow.mjs` prove and
what the tutorial (`packages/docs/cloud/share-with-your-team/shared-mcp-connections.mdx`)
teaches.

## The mental model

> The desktop does not *have* remote MCP connections (except local-process
> ones). It has one live connection — OpenWork Cloud — and everything else it
> shows is a rendered view of Den state.

- Credentials live in Den (shared org credential, or one per member). The
  desktop never holds a third-party MCP token for org connections.
- Grants and credential resolution happen server-side, per request. A
  connect completed anywhere (desktop-initiated, browser-only, another
  device) is immediately live everywhere, with no client resync.
- Tools reach the agent through `search_capabilities` / `execute_capability`
  on the single OpenWork Cloud connection — not as per-provider live engine
  connections.

## Invariants (non-negotiable)

1. **The no-cloud escape hatch survives untouched.** No existing MCP path may
   depend on Den being reachable or the user being signed in. Signed out /
   no org / Den down ⇒ org-sourced items hidden, zero errors, everything
   else identical to a build without this feature. Local `opencode.jsonc`
   stays hand-editable (ejectability).
2. **Never remove or migrate an existing direct connection.** A user's
   locally-configured Notion/Linear (engine as MCP client, personal token on
   device) is grandfathered forever, or until the user removes it.
3. **Local-process entries stay engine-direct.** OpenWork Browser, UI
   Control, local-command custom MCPs: Den cannot spawn processes on a
   member's machine. Hard constraint, not a preference.
4. **The desktop never opens a URL supplied by tool output.** Connect flows
   only carry a `connectionId`; the authorize URL always comes from Den's
   `connect/start` under the member's own token (prompt-injection guard).

## Surface: one catalog, four doors

Org connections are **not a special section**. They are one more item source
merged into the existing Extensions catalog (`buildExtensionItems`), shown
"same as anything else the user has access to."

### Tab placement (`ExtensionItem` source: `org-connection`)

| Connection state | Tab | installState | Card action |
|---|---|---|---|
| `shared`, connected by admin | My Extensions | installed | "Managed by your organization" (no action) |
| `per_member`, caller connected | My Extensions | installed | "Connected" |
| `per_member`, not yet connected | Marketplace | available | **"Connect your account"** |
| `shared`, admin has not finished connecting | hidden (or Marketplace, disabled) | — | "Being set up by your admin" |

- Cards carry provenance ("Shared by your organization" / admin name in the
  detail modal), kind badge `MCP`, and participate in search/filter like any
  other item.
- "Install" is the wrong verb — connecting is a grant/credential act, nothing
  is copied locally. Labels say "Connect", never "Install".

### The four discovery doors (all converge on one connect flow)

1. **Marketplace tab** — browse what the org offers; connect from the card.
2. **My Extensions tab** — what's active for you, provenance visible.
3. **Chat, at the moment of need** — when a `search_capabilities` tool result
   contains `needs_connection: true` entries, the transcript renders an
   inline connect card directly below the tool-call block (outside the
   collapsed details). Passive rendering keyed off the tool result — does
   not depend on the model choosing to say anything.
4. **Notification center** — the existing org-marketplace diff pattern,
   extended: a new `per_member` grant that isn't connected raises a
   persistent notification + Extensions badge until connected (from any
   device) or dismissed. A new `shared` grant raises a one-time informational
   notice only (the member has no action; don't train people to ignore the
   bell).

### The one connect flow behind every door

1. Click Connect (card in Marketplace / chat / notification).
2. Desktop calls `GET /v1/mcp-connections/:id/connect/start` with the
   member's token; Den re-checks the grant server-side.
3. System browser opens the provider's consent page (embedded webviews are
   not acceptable to providers; the OAuth client is Den, so the redirect
   must land on Den's callback).
4. Den's callback page completes the exchange and renders an arrival page:
   "Connected ✓ — Open OpenWork" (`openwork://` deep link + auto-attempt).
5. The desktop's polling loop (2s interval, 90s cap — same pattern as local
   MCP OAuth) observes `connectedForMe: true` and flips the originating card
   in place. No page reload.
6. Chat cards additionally offer "[Ask agent to continue]" — inserts a
   canned user message. One click, never automatic.

### Chat card state machine

`Connect <name>` → `Waiting for you in the browser…` (reopen-link fallback)
→ `Connected ✓ [Ask agent to continue]`.

- One card per **connection**, not per matched tool; cap 2–3, "and N more in
  Settings".
- Dedupe by connectionId per session; a dismissed card collapses to one line
  and does not reappear that session.
- `shared` connections never produce cards (`needs_connection` cannot be
  true for them).

## Dedup rule (static Quick Connect vs org catalog)

Applies to **unconfigured suggestions only** — never to configured
connections:

- Provider already connected directly on this device ⇒ keep it, badge it
  "connected directly on this device". (Optional "switch to org-managed"
  migration is a later, explicitly user-initiated feature.)
- Provider not configured AND a live org equivalent is renderable right now
  ⇒ show the org card, hide the static suggestion.
- Org equivalent not renderable (signed out, Den down, not granted) ⇒ static
  card returns. Degrades, never disappears.

Preset duplication note: `EXTERNAL_MCP_PRESETS` (Den) and `MCP_QUICK_CONNECT`
(desktop) list the same providers (Notion, Linear, Stripe, Sentry, Context7)
and will drift. Direction: desktop treats Den as source of truth for the
remote catalog when signed in; static list is the offline fallback. (Not in
scope for the first PR.)

## Sync cadence

No push. Fold the usable-connections fetch into the existing Den sync
touchpoints (app boot + the periodic sync the marketplace/providers already
use), not just settings-mount. SSE exists as a later option
(`den-session-events`) if publish-to-connected latency ever matters.

Known state to surface honestly: previously-signed-in-but-expired token ⇒
show "sign back in to see your organization's apps", not an empty catalog.

## Out-of-app paths (no desktop coordination needed)

Because credentials live in Den, the browser path is complete, not degraded:

- Member not signed in on desktop / no app: email-on-grant (later) → den-web
  **Your Connections** → connect fully in browser → desktop finds everything
  already connected at next sign-in.
- Signed-out desktops show a single dismissible hint row in Extensions:
  "Sign in to OpenWork Cloud to see apps shared by your organization."

## Admin's half (later)

Adoption view in the Den dashboard: per connection, "connected 12/20
members" — tells the admin who to nudge. All data already exists.

## Build phases

**Phase 1 (current PRs #2406 + #2439 rework):**
- Assimilate org connections into the Extensions catalog tabs (replaces the
  interim "From your organization" section).
- Dedup rule with degradation guard.
- Connect flow with polling (built, fraimz-proven).
- Callback arrival page ("Connected ✓ — Open OpenWork").

**Phase 2 (fast follow):**
- Chat inline `needs_connection` connect card + "Ask agent to continue".
- New-grant notification + Extensions badge (marketplace-diff pattern).
- Signed-out hint row.

**Phase 3 (later, explicitly deferred):**
- Email on grant; SSE push; admin adoption view; "switch to org-managed"
  migration for grandfathered direct connections; solo "Add Custom App
  writes to your own Den org" (cloud-synced personal MCP config); per-tool
  permissions; `tools/list` caching; desktop "promote to direct connection"
  escape hatch if search/execute indirection ever hurts discovery.

## Eval / proof requirements

Every phase lands with a fraimz flow that follows the tutorial's steps
exactly (the tutorial is the script; the eval is the proof it isn't
fiction). Core demo sequence:

1. Admin publishes a per-member connection in den-web (real admin UI).
2. Member's desktop shows it in **Marketplace** with "Connect your account".
3. Real click → real `connect/start` → real OS browser OAuth round trip
   (witnessed via the IdP's own request log, not a client-side stub —
   Electron's contextBridge freezes exposed APIs, so nothing can be faked).
4. Same card flips to Connected without reload; item moves to My Extensions.
5. Real chat turn: agent `search_capabilities` → `execute_capability` → the
   external server's own log confirms a fresh call with the member's
   credential during the chat window.
6. Regression frames: static Quick Connect grid intact; a pre-existing
   direct connection survives untouched; signed-out state shows no org
   items and no errors.
