# Configuring org connections from the agent — two paths

An org admin should be able to say, in chat, "add the Notion MCP for my
team" and have it happen — then teammates get a proper handoff to connect
their own account. Two delivery paths, one shipped now, one mapped for next.

## Path A — classical (this PR)

The agent creates the connection and **hands members a link** to the place
they already connect things (den-web Your Connections / desktop Extensions).

Mechanics, all server-side:

1. **Retag two routes** from `Authentication` to `Capability Sources` so the
   agent catalog includes them (`mcp/policy.ts` allowlist):
   - `POST /v1/mcp-connections` — create (admin-enforced in-route).
   - `PUT /v1/mcp-connections/:id/access` — grants (admin-enforced in-route).
   Everything else stays deliberately human-only: connect/start + callbacks
   (browser consent), `POST /v1/oauth-providers/:id/client` (client secret),
   disconnect + delete (destructive, and disconnect is in
   `BLOCKED_OPERATION_IDS`).
2. **No secrets through chat**: when the caller is the internal MCP
   principal (`session.id === "mcp_internal"`), reject `authType: "apikey"`
   bodies with a message pointing at the dashboard.
3. **The handoff is in the response**: the create response gains
   `links.yourConnections` (den-web origin + `/dashboard/your-connections`),
   and the route description tells the agent to share it. Members also see
   the connection in desktop Extensions and get `needs_connection` hints —
   the entire member half is the shipped #2451/#2455 machinery.
4. Invoke-time safety is unchanged: the agent's ceiling is the signed-in
   human's real org role (a member's agent gets a clean 403), the desktop
   Cloud Control token is already `mcp:read mcp:write`, and the org-level
   kill switch + ops/revert tooling apply because it is the same table.

## Path B — new wave (mapped, next PR)

Instead of a link, the **desktop chat renders the real connect component
inline**: the agent's "created it" reply carries a card with the live
connection state and a working `Connect your account` button; a member whose
tool call returns `needs_connection` gets the same card in-chat.

Mechanics, building on precedent that already exists:

1. **Marker in tool results** (server): `POST /v1/mcp-connections` responses
   and `needs_connection` error payloads include a well-known envelope,
   e.g. `"openwork": { "component": "org-connection", "connectionId": ... }`.
2. **Rich tool-part mapping** (desktop): the session tool-part mapper
   already special-cases certain tools for rich chat rendering (see the
   env-var request mapping and its tests in
   `apps/app/tests/session-sync-tool-parts.test.ts`). Add one case: results
   carrying the envelope map to an `org-connection` part.
3. **Render the shipped components** (desktop): the chat renderer mounts the
   existing extension card + connect modal wired to
   `use-org-mcp-connections`'s `connect()` — the exact card/browser-OAuth/
   poll loop proven in #2451/#2455, now mounted inside a chat bubble. No new
   connect logic; the component is fed, not rebuilt.
4. Same governance: the card renders from the member's own `scope=usable`
   view, so grants and the org-level kill switch hold automatically.

Path B risk notes: keep the envelope out of model-visible text (structured
result metadata, not prose) so prompts cannot forge it; the renderer must
treat `connectionId` as untrusted input and re-fetch state via the usual
hook rather than trusting envelope fields.
