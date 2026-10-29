# Automatic private workshop workspaces

Open the workshop link. A new browser automatically receives its own private fictional workplace, and returning in that browser restores it. **No password, account card or registration step is needed.**

Each person must use a separate browser profile. This is a private **browser workspace**, not a verified email/person identity: people sharing a browser profile share its workspace. Clearing cookies, closing an incognito profile or switching devices starts a new one. Do not use real company data.

## Start

From this package, with Node 22.23+ and no dependency install:

```sh
node src/workshop.mjs
```

Open `http://127.0.0.1:3990`. For durable business data and browser/OAuth sessions:

```sh
OPEN_WORKPLACE_DATA_DIR="$HOME/workshop-private-data" node src/workshop.mjs
```

The CLI defaults to `OPEN_WORKPLACE_JOIN_MODE=automatic`. Existing assigned-account fixtures remain available with `OPEN_WORKPLACE_JOIN_MODE=assigned` and a private roster for backwards-compatible tests; the public automatic entry point never displays or accepts their sign-in form. Existing connected accounts are not deleted by switching modes.

## Hosting

Publish **only** the gateway, not the raw fixture ports. Example:

```sh
HOST=0.0.0.0 PORT=3990 PUBLIC_URL=https://workshop.example.com OPEN_WORKPLACE_DATA_DIR=/var/data/workplace OPEN_WORKPLACE_JOIN_MODE=automatic node src/workshop.mjs
```

Use a real persistent disk at `/var/data`, not an ephemeral writable directory. Hosted origins require HTTPS. Backend servers bind private loopback ports in one process per active workspace. The gateway uses its configured origin, not caller-supplied forwarding headers.

SQLite snapshots use WAL, atomic writes, full synchronous commits and private file permissions. Business writes are committed before acknowledgment. Authentication storage contains guest identity fingerprints and hashed browser/OAuth capabilities, not user-entered passwords or raw session/access/refresh tokens. Invalid storage fails closed rather than silently reseeding.

`GET /health` reports `joinMode: "automatic"`, `storage: "sqlite"` or `"memory"`, isolation and a startup timestamp; unavailable auth storage refuses readiness. Backends restore lazily on the first service request.

The optional `Dockerfile.workshop` builds the same standalone package. Supply the configuration above, mount private persistent storage and publish the gateway only. Separate legacy public demo deployments are not secured by this entry point; do not use them as no-auth alternatives.

## Connect from OpenWork or another MCP client

Use OAuth with **per-member credentials**, not a shared organization connection. Everyone uses the same URLs:

| Connector | MCP URL |
|---|---|
| Outlook | `https://workshop.example.com/outlook/mcp` |
| Calendar | `https://workshop.example.com/calendar/mcp` |
| Drive | `https://workshop.example.com/drive/mcp` |
| Jira | `https://workshop.example.com/jira/mcp` |
| Confluence | `https://workshop.example.com/confluence/mcp` |

Transport: Streamable HTTP. On the first connection, the browser automatically joins a private workspace and shows the consent page. Check its guest label and permissions, then choose **Allow workplace access**. Later connectors in the same browser use that same workspace. Different browser profiles receive different workspaces.

OAuth consent is still explicit. Opening an authorization URL does **not** grant an app access automatically. Deny works. The service is clearly labeled **Acme Workplace / fictional workshop sandbox**, not Microsoft Entra or Atlassian sign-in.

The server supports discovery, dynamic public-client registration, mandatory S256 PKCE, rotating refresh tokens and `/oauth/revoke`. The exact MCP URL is required as the RFC 8707 `resource` at authorization, code exchange and refresh. Tokens cannot be widened to another connector, arbitrary REST, state inspection, reset or root. There is no combined `/mcp` endpoint.

Access tokens last one hour; refresh grants last at most eight hours from initial approval. Reusing a consumed refresh revokes its family. After grant expiry, approve again from the same remembered browser to retain the workspace. Automatic browser sessions last 30 days. Secure hosted cookies are HTTP-only, host-only and SameSite=Lax so legitimate top-level OAuth redirects reuse the workspace across client origins; unsafe mutations still require same-origin protection.

## Isolation and lifecycle

- Mail, drafts, folders, calendars, files, Jira issues, Confluence pages/comments/history and audits are private to the workspace.
- Identical seeded record IDs cannot select another workspace. A copied link opens the recipient browser's own data or returns not found; it is not a sharing link.
- Opening the link restores an existing browser workspace; a new browser gets a new one, without a registration quota.
- **Forget this browser’s workspace** explains the loss of browser access and asks for confirmation before clearing the session. It lands on a signed-out page without immediately creating another workspace or revoking independent OAuth app grants. There is no account/password recovery for a forgotten browser identity.
- **Reset my sample data** explicitly deletes only this workspace's business snapshots. It does not affect other attendees or silently erase data on a normal restart.
- Anonymous MCP/API/download/preview requests remain unauthorized. Automatic joining happens only on valid browser navigation, not arbitrary API calls, embedded frames or fetches.
- Drive upload URLs are narrow, expiring, single-use PUT capabilities; they cannot read files or select another identity. Pending gateway upload routes do not survive restart/worker eviction; retry interrupted uploads with a new session. Completed file bytes do survive.

This is not cross-device account synchronization or an OS sandbox for hostile code. Keep each attendee in their own browser profile. No real emails, invitations or password resets are delivered.

## Reset the demo

**One attendee:** open `/_workshop/reset`, then confirm **Reset my sample data**. All five services return to their starting data for that browser workspace. Other attendees, the browser identity and existing OAuth connections are retained.

**Whole workshop:** the facilitator can reset everyone's fictional business data without rebuilding desktops or reconnecting the five apps. Configure a private random `OPEN_WORKPLACE_RESET_TOKEN` on the gateway and in the facilitator's shell, together with `OPEN_WORKPLACE_RESET_URL` set to that workshop's origin. The command sends the key only to that configured origin. Never give that key to attendees or put it in a URL.

From this package, first preview the scope (no request or deletion occurs):

```sh
node src/workshop-reset.mjs --url https://workshop.example.com --all
```

Then deliberately confirm:

```sh
node src/workshop-reset.mjs --url https://workshop.example.com --all --confirm
```

This resets Outlook, Calendar, Drive, Jira and Confluence changes, files and their audits. It preserves guest identities, browser sessions, OAuth registrations and grants. It **does not** erase local VM files or OpenWork chat history. Normal service restart is not a reset. No reset runs automatically as part of deployment.

The facilitator route is unavailable unless the private key is configured. Attendee cookies and MCP OAuth tokens cannot invoke it. A reset blocks new business requests while stopping workers and replacing business snapshots, so an old worker cannot write deleted data back. If current work cannot finish safely, the command reports busy instead of claiming success. Interrupted requests are not automatically replayed.

## Demo lifecycle

There is no remembered-guest quota, fixed attendee/active-worker ceiling, or registration-rate quota. Legacy `OPEN_WORKPLACE_GUEST_LIMIT` and `OPEN_WORKPLACE_WORKER_LIMIT` settings no longer restrict the demo. Durable idle workers are unloaded and restored on demand; their saved work is retained until an explicit reset. In-memory work is not silently evicted.

Protocol validation, isolation, OAuth security, request parsing bounds and timeouts still apply. Removing attendance quotas is not a claim of unlimited RAM, disk or throughput: this is a fictional workshop on one host, not a production multitenant service.

## Suggested tasks

1. “Read the Northwind pilot email and shared pilot brief. Make one PowerPoint slide explaining what is verified and what still needs acceptance, save it to my Drive, and draft a reply in the existing thread with the link. Don't send it.”
2. “Create an engineering task for the aisle C Wi-Fi roaming test before the pilot readiness decision. Add a labeled follow-up to the relevant Northwind account page, linking the task and preserving existing content.”
3. “Move the existing Northwind / Blue Harbor customer review to tomorrow at 2pm Los Angeles time, keeping its attendees and duration.”
4. “Does our internal office guidance allow dogs? If you can't find a policy, say so rather than inventing one.”

Do not include the Windows login-lockout exercise. Office text previews are not a full editor; visually check generated PowerPoints separately.

## Verification

```sh
node --test --test-concurrency=1 src/*.test.mjs
```

Use Node 24+ for the testkit controller. `evals/proofs/workshop-oauth.proof.test.ts` runs actual automatic joining and consent through the real Den client with two browser profiles, executes OAuth-backed Drive work and checks separation without paid inference. It supports `OPEN_WORKPLACE_TEST_URL` for an explicitly selected owned hosted gateway; no attendee roster is needed in automatic mode.

Explicit paid scenarios under `scenarios/workshop-live` and `scenarios/workshop-calendar-trust` retain assigned-mode fixture setup for repeatable development. Their earlier hosted results predate automatic joining; do not present those as a new passwordless-model rehearsal. The automatic OAuth proof and browser/API restart tests validate the changed boundary. Never describe skipped cases or unjudged screenshots as passed visual claims.
