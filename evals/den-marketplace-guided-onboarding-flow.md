# Den Marketplace Guided Onboarding Flow

## Goal

Validate the first-run Den-to-desktop Marketplace onboarding journey for a new
organization.

The flow must teach a new org owner what Marketplaces and extensions are, show
the default marketplaces that were created for them, and make the desktop
handoff explicit: install OpenWork Desktop, sign in, then access organization
marketplaces from the app.

## Preconditions

- Run Den Web and Den API from a fresh Daytona server sandbox or a clean local DB.
- Use `OPENWORK_DEV_MODE=1` for local/Daytona email-password sign-up without email delivery.
- If Den Web runs behind a Daytona preview URL in `next dev`, set
  `DEN_WEB_ALLOWED_DEV_ORIGINS` to the preview host before starting Den Web.
- Use a fresh browser profile so no previous Den session or org state is reused.

## Demo Standard

- The primary eval artifact must be a full human-visible recording, not a final-state clip.
- Drive Den Web through Chrome CDP and desktop through Electron CDP using `browser_snapshot`, `browser_click`, and `browser_fill` wherever possible.
- Show the journey click by click: sign-up, org creation, onboarding, marketplace explanation, desktop handoff, desktop sign-in, Marketplace sync, plugin install, and chat response.
- Use API calls only for setup that the product UI cannot perform yet, such as creating a deterministic test plugin. Immediately show the resulting plugin in the desktop UI.
- Use filesystem checks and direct OpenCode CLI runs only as supporting proof; they cannot replace a visible desktop install/chat demo.
- If an auth bridge, direct navigation, localStorage write, or API shortcut is used, label that segment as a gap and do not claim the whole recording is a founder-ready demo.

## Server Expectations

After a signed-in user can list active marketplaces with
`GET /v1/marketplaces?status=active&limit=100`, Den lazily provisions:

- `OpenWork Marketplace`
  - Description explains built-in OpenWork AI capabilities available in desktop after sign-in.
  - Contains first-party built-ins such as Browser, Computer Use, OpenAI Image Gen, Google Workspace, and Ollama.
  - Has org-wide viewer access.
- `Anthropic-Compatible Plugins`
  - Description references `https://github.com/anthropics/knowledge-work-plugins`.
  - Has org-wide viewer access.

## Browser Flow

1. Open Den Web in Chrome.
2. Create a new account with email/password.
3. Confirm sign-up does not stop on a verification-code screen when verification is disabled.
4. Create a new organization.
5. Confirm the browser lands on `/dashboard/onboarding`.
6. Confirm the onboarding screen includes:
   - `Your team extension hub is ready.`
   - A plain-language explanation that Marketplaces share extensions with the team.
   - Extension examples: skills, agents, MCP servers, commands/hooks, and Anthropic-compatible plugins.
   - Desktop guidance: download OpenWork Desktop, sign in with the same account, then open Marketplace.
   - A visible `OpenWork Marketplace` card.
   - A visible `Anthropic-Compatible Plugins` card.
   - A link or visible reference to `anthropics/knowledge-work-plugins`.
   - OpenWork MCP install config using `npx -y openwork-ui-mcp`.
   - Example prompt: `Package this skill as a plugin, put it on a marketplace, and assign it to my team.`
7. Open `View marketplaces` and confirm both default marketplaces are listed.

Recording requirement: capture this through visible Chrome clicks and fills. Do
not skip directly to `/dashboard/onboarding` unless the report marks the skipped
steps as setup or a product gap.

## Desktop Flow

1. Start OpenWork Desktop in dev mode pointed at the fresh Den Web/API URLs.
2. Open Settings -> Extensions -> Marketplace while signed out.
3. Confirm signed-out copy says OpenWork is usable without an account and sign-in unlocks Marketplace/built-ins/org marketplaces.
4. Sign in to OpenWork Cloud with the same Den account.
5. Return to Marketplace and refresh if needed.
6. Confirm:
   - `OpenWork Marketplace` appears as a marketplace source/filter.
   - Built-ins render as `Built-in` with no install/remove action.
   - `Anthropic-Compatible Plugins` appears as an assigned org marketplace, even if empty.
7. Create a small test plugin in `Anthropic-Compatible Plugins` with one skill resource.
8. Add the plugin from desktop Marketplace into an active workspace.
9. Confirm the skill materializes under `.opencode/skills/.../SKILL.md`.
10. Send a desktop chat prompt that asks the imported skill for a deterministic answer.
11. Confirm the chat response uses the imported skill output.

Recording requirement: capture this through visible Electron clicks and fills.
The final demo should show the Marketplace list, the install action, and the chat
response, not only a filesystem or CLI proof.

## Pass Criteria

- New org creation routes to `/dashboard/onboarding`.
- The onboarding page explains the Marketplace model without requiring docs.
- The two default marketplaces exist server-side for the org.
- The desktop Marketplace requires no manual server setup beyond sign-in to see assigned marketplaces.
- A live org plugin can be installed from Marketplace, materialized into the workspace, and used from desktop chat.
- Evidence clearly separates any Daytona-specific proxy/auth bridge from product behavior.
- The recording is understandable as a user journey without relying on terminal-only context.

## Latest Daytona Validation

- Den sandbox: `openwork-server-onboarding-20260603-2108`.
- Electron sandbox: `openwork-test-20260603-211949`.
- New Den user created an org and landed on `/dashboard/onboarding`.
- Den API returned both default marketplaces for the fresh org.
- Desktop Cloud sign-in completed through the Den handoff flow.
- Desktop Marketplace showed `OpenWork Marketplace` and `Anthropic-Compatible Plugins`.
- Built-in Marketplace rows rendered as `Built-in` with no install/remove action.
- Live plugin `Marketplace Runtime Probe` was added to `Anthropic-Compatible Plugins`.
- Desktop imported the plugin and materialized `marketplace-runtime-probe-skill/SKILL.md` into the workspace.
- Direct OpenCode runtime proof returned `MARKETPLACE_RUNTIME_PROBE_OK`.
- Desktop chat proof also returned `MARKETPLACE_RUNTIME_PROBE_OK` in workspace `Marketplace Runtime Chat`.
- Recording: `https://8090-7xhivksbzfwmpqc9.daytonaproxy01.net/recordings/marketplace-guided-onboarding-desktop.mp4`.

## Failure Modes To Watch

- Den Web form is not interactive behind Daytona preview URL.
  - Check Den Web logs for `Blocked cross-origin request to Next.js dev resource`.
  - Fix by setting `DEN_WEB_ALLOWED_DEV_ORIGINS=<3005 preview host>` and restarting Den Web.
- Sign-up returns `token: null` while verification is disabled.
  - Den Web should immediately attempt email/password sign-in before showing verification UI.
- Marketplace list shows only `OpenWork Marketplace`.
  - Confirm the active org requested `/v1/marketplaces` after this change and that default provisioning ran.
- Desktop shows no org marketplaces after sign-in.
  - Confirm desktop Den base/API URLs match the fresh server sandbox and the user has an active org.
