# Guided Slack setup

Feature key: `guidedSlackSetup` · Deployments: cloud and self-hosted · Default: off · Author: @benjaminshafii

## What people get

Admins adding the Slack preset (Manage › Connectors › Add a connector › Slack)
get one checklist instead of the shared connector checks:

1. **Create the Slack app.** "Create app in Slack" opens Slack's
   create-from-manifest page (`https://api.slack.com/apps?new_app=1&manifest_json=…`)
   prefilled with this Den's OAuth redirect URL, the Slack preset's user scopes
   (the full set Slack's MCP server offers) and `settings.is_mcp_enabled: true`.
   "Use an existing Slack app" (collapsed) has the redirect URL, scopes and
   manifest to copy. Locked, with who can fix it, when the deployment has no
   public API address.
2. **Turn on Agents › MCP.** Says "Not checked yet" until the admin's test
   sign-in records a readiness check, then shows the result. Slack refusing
   MCP (`tools_unreadable`, see #6661) fails this step with Open Slack apps and
   Check again. The admin confirms the switch before sign-in unlocks.
3. **Add the client ID and secret.** The existing fields.
4. **Sign in with Slack to test.** Shows checking, ready, or the failure with
   its next action.
5. **Add @openwork to Slack (optional).** Only for an eligible connection;
   locked when this OpenWork has no Slack assistant runner. On the final screen,
   "Set up @openwork in Slack next" opens the connector page at its OpenWork in
   Slack section.

With the flag on, a connection created from a preset that declares
`defaultOAuthScopes` (only Slack) requests exactly that list, so the request
always matches the manifest. Off, setup requests what the server advertises,
as before (today the same 30 scopes for Slack).

Flag on, fresh setup:

![Add Slack, guidedSlackSetup on](./flag-on.png)

After the client ID is saved and MCP is confirmed:

![Ready to sign in](./ready-to-sign-in.png)

Flag off (as shipped), the shared checks:

![Add Slack, guidedSlackSetup off](./flag-off.png)

## How to try it

Turn it on for an organization in `/admin`, then open
`/dashboard/mcp-connections/new/slack` as an organization admin. The proof
`evals/proofs/den-slack-guided-setup.proof.test.ts` walks through it without
contacting Slack.

## Turning it off

The Slack preset goes back to the shared setup checks on the next page load.
Nothing is stored by the checklist itself (the MCP confirmation is page
state); connections it created stay as they are, with their requested scopes.

## What to watch

- `external_mcp_readiness_check_failed` logs with `category` and
  `http_status` for Slack connections created after turning it on.
- `/admin` › organization › Features usage: counted when an admin clicks
  Create app in Slack or Sign in with Slack from the checklist.

## Not behind the flag

- `GET /v1/mcp-connections/presets` returns `oauthCallbackUrl` for presets that
  need a pre-registered OAuth app (additive API field).
- The Slack preset's `defaultOAuthScopes` is the full 30-scope set. It is the
  server-side default only when a request omits `requestedScopes` (agent and
  API creation); Den web setup already requested this set from Slack's
  metadata. Stored connections are not changed.
