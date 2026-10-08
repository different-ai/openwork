---
name: set-up-openwork-slack
description: Configure and verify the OpenWork Slack assistant for an approved private-alpha organization, using its existing Slack app and individual-account connector. Use when a user wants @openwork in Slack or needs help installing or linking it.
---

# OpenWork in Slack — private alpha

Guides: https://openworklabs.com/docs/slack/set-up-the-slack-app.md (administrator setup) and https://openworklabs.com/docs/slack/connect-your-account.md (member linking and verification)

Use browser/computer tools for the existing signed-in OpenWork and Slack administration sessions. Prefer supported setup tools if available. This skill does not grant alpha access or authorize actions beyond the user's request and your tools' permissions.

## Establish the target

Identify the OpenWork organization, Slack workspace, existing Slack app, and connector. Do not create duplicates. In Connectors → Slack → OpenWork in Slack, check eligibility, platform rollout access, runtime access, installation, enabled state, signing-secret presence, and channel/reply settings. If alpha or runtime access is missing, report the exact missing prerequisite; do not change deployment settings unless requested.

Ask for the user's channel scope if unspecified: selected channel IDs or all channels. Blank channel IDs allows all channels but does not invite the bot. Private replies are a useful rollout default; honor the user's choice.

## Configure the existing app

Read the generated manifest from this connector, then read the current manifest in that same Slack app. Merge without removing existing user scopes, optional user scopes, redirects, MCP configuration, or unrelated features. Keep a before/after comparison in memory. Never replace the entire manifest with only the generated fragment.

Required bot scopes: app_mentions:read, chat:write, im:history, im:read, im:write, assistant:write, commands. Required events: app_mention, message.im, app_home_opened, app_context_changed, agent_session_stopped, agent_session_title_changed, app_uninstalled, tokens_revoked.

Use the deployment's generated URLs, not guessed connector IDs: events, interactions, and commands under /v1/integrations/slack/<connectionId>/; bot redirect /v1/integrations/slack/oauth/callback. Bot display name is openwork. App Home Messages must permit messages and slash commands. Agent experience must be on.

If Slack rejects agent_view.enabled, preserve Slack's supported exported agent_view structure and confirm the Agents toggle. Fix validation errors before saving; do not drop required scopes or events.

Transfer the signing secret directly from Basic Information to the connector's signing-secret field. Never print it, put it in chat, save it in files, or rotate it merely to complete setup. If secure transfer is unavailable, let the user paste it directly.

Save the secret, start Add to Slack from OpenWork, and complete authorization within ten minutes in the intended workspace. Follow your tools' approval requirements. Reinstall in Slack confirms installation. Verify the Events URL challenge and save its Verified state. Turn on the connector assistant and requested reply/channel settings.

## Link the invoking member

Installation does not link members. Each member must finish their own Slack OAuth flow in Your Connections. If an existing connection predates installation, explain the temporary interruption and obtain authorization to disconnect only that member's Slack connection, then reconnect it. Never use Sign everyone out. The human may need to complete login or authorization; do not impersonate another member.

The bot's /openwork command returns a link to Your Connections. Opening that link or seeing Connected as you on an older connection is not proof that the assistant identity binding exists. A real completed bot answer is the acceptance check.

## Verify and report

Send a short DM test and wait for a finished answer, not just On it. In an authorized allowed test channel, invite @openwork, check mention autocomplete, and test a mention. Confirm delivery respects private/channel reply settings. Check setup metrics for completed, active, need-connection, and failed requests.

Do not test by exposing private data in a shared channel. Do not mark channel behavior verified from a DM-only test. If a step fails, inspect its concrete error, make a targeted correction, and retry; stop repeating an unchanged failing installation or authorization.

Report configuration saved, installation, event verification, member linking, DM result, channel result, reply mode, and remaining blockers without credentials. Do not claim success from manifest validation, installation, or an acknowledgement alone.
