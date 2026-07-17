# Demo: shared MCP connections, tutorial-driven fraimz

One fraimz run that walks the tutorial
(`packages/docs/cloud/share-with-your-team/shared-mcp-connections.mdx`)
step by step, as the two personas it describes. The run has three jobs:

1. **Prove** the experience works end to end (fraimz verdict).
2. **Produce the tutorial's screenshots** (each starred frame below is saved
   under the image name the tutorial references).
3. **Feed the PR comment** — frames + claims posted to #2439 for review.

Requirements source: `evals/org-mcp-connections-ux.md`.
Flow file: `evals/flows/desktop-org-mcp-demo.flow.mjs` (to be written).

## Cast and stage

- **Alex** (`alex@acme.test`) — org admin, works in den-web.
- **Jordan** (`jordan.demo@acme.test`) — member, works only in the desktop app.
- **"Team Knowledge Base"** — a per-member connection pointing at the mock
  OAuth+MCP server (`scripts/mock-oauth-mcp-server.mjs`, auto-approve on).
  Protocol-identical stand-in for Notion/Linear; its own request log is the
  external witness.
- Local stack: den-api + den-web (this branch), MySQL seed org, desktop app
  from this worktree via CDP.

## Frames

Each frame = claim + user action + observable assertion + validated
screenshot. ★ = also saved as a tutorial image.

**1. ★ Admin publishes once** (`cloud-mcp-connections-admin.png`)
Alex, in den-web `MCP Connections`, creates "Team Knowledge Base":
per-member credentials, org-wide access.
*Assert:* connection listed in the admin screen with credential mode and
access visible; API `scope=manageable` contains it.

**2. ★ Member discovers it in OpenWork Connect** (`desktop-org-mcp-connect.png`)
Jordan's desktop, `Settings -> Connect`: the connection appears under
Needs your sign-in with action `Connect your account`.
*Assert:* card text present; `My Extensions` does NOT list it yet.

**3. Real click, real OAuth**
Jordan clicks `Connect your account`. The OS browser opens the provider
consent page (auto-approving mock IdP completes the round trip).
*Assert:* the mock IdP's own request log shows a fresh `GET /authorize`
after the click, carrying a signed `state`, a dynamically-registered
`client_id`, and a `redirect_uri` scoped to this connection. No client-side
stubs — Electron's contextBridge freezes exposed APIs, so nothing is faked.

**4. ★ Connect row flips, no reload** (`desktop-org-mcp-connected.png`)
Without navigation, the same Connect row flips to `Ready` (the app's own
polling loop).
*Assert:* "Connect your account" gone; "Ready" present; server-side
`connectedForMe: true` for Jordan.

**5. ★ The agent uses it in real chat** (`desktop-org-mcp-chat.png`)
Jordan asks the agent to run the connection's echo tool with a run-tagged
string. Agent: `search_capabilities` → `execute_capability` → exact text
renders in the reply.
*Assert:* Stop button gone (turn finished); run-tag appears ≥2× (prompt and
result); external server's log shows a fresh `POST /mcp` inside the chat
window — the call really traveled desktop → Den → external server with
Jordan's own credential.

**6. Regression: the escape hatch is intact**
Same screen, one frame down: the static Quick Connect grid (Notion, Linear,
Stripe, Sentry, Context7) and local entries (OpenWork Browser, UI Control)
render exactly as before.
*Assert:* static card names present; a pre-seeded direct MCP entry in
`opencode.jsonc` is still listed and untouched (byte-identical config).

**7. Regression: signed-out desktop shows nothing org-flavored**
A signed-out state (second userdata dir or post-sign-out) renders
Extensions with zero org items and zero errors.
*Assert:* no org card, no error text, static grid present.

## Delivery

- fraimz verdict + `fraimz.html` path reported.
- Starred PNGs copied to `packages/docs/images/` under the tutorial's names.
- PR comment on #2439: one section per frame — claim, image, what was
  asserted — plus exact repro commands.

## Build prerequisites for this demo (the "code whatever is missing")

From `evals/org-mcp-connections-ux.md` Phase 1, on top of what #2439 already
has:

1. Rework: org connections render in OpenWork Connect as organization rows.
   Frames 2 and 4 depend on this.
2. Dedup-with-degradation-guard for static suggestions. Frame 6 asserts the
   static grid — with the mock connection there's no name collision, so the
   rule is exercised by a unit test rather than this demo.
3. Callback arrival page copy ("Connected — return to OpenWork"). The
   auto-approving IdP blows past it too fast to screenshot reliably; assert
   its HTML via HTTP instead.

Explicitly NOT in this demo (Phase 2, next PR): chat `needs_connection`
inline card, notifications/badge, signed-out hint row.
