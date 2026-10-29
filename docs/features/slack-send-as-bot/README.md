# Slack messages from the OpenWork bot (`slack_send_as_bot`)

Feature `slackSendAsBot` (cloud and self-hosted, off by default). Author: `benjaminshafii`.
It needs the OpenWork app installed in Slack for the organization (the Slack assistant, see
`ee/apps/den-api/src/slack-assistant/README.md`) and the member's Slack account linked to OpenWork.

## What changes

The only Slack tool agents had was the Slack connection's own `slack_send_message`. Slack's MCP server only acts as
the member, so every message is posted *as them*, and "DM me when this is done" never notifies them: Slack doesn't
notify you about your own messages.

`slack_send_as_bot` is one Den-native capability on the OpenWork MCP gateway that sends from the OpenWork Slack app's
own bot instead. It shows up in capability search next to the Slack connection's tools (and as
`openwork-bot.slack_send_as_bot` in the full tool view).

| The person says | The agent uses |
| --- | --- |
| "Ping me when it's done", "DM me every morning with…", "tell me on Slack" | `slack_send_as_bot`, target `me` |
| "Post this in #team as OpenWork" | `slack_send_as_bot`, target `channel` |
| "Post this as me", "reply to my teammate for me" | the Slack connection's `slack_send_message` |

Capability search ranks it above the Slack connection's tools when the person wants something sent to themselves
("send me… on Slack", "notify me", "DM me", "remind me on Slack"), lists it below them otherwise, and leaves it out
when they ask to post "as me". While it is available, the gateway's instructions add the same rule in one sentence,
for chats and for writing and running Automations.

Arguments: `target` (`me` or `channel`), `text` (Slack mrkdwn, up to 4,000 characters), `channelId` (a channel ID such
as `C0123ABCD`, for `channel`) and an optional `threadTs` to reply in a thread.

- **`me`**: a DM to the calling member (the chat's member, or the Automation's owner in an Automation run) in the app's
  Messages tab, which notifies them. Same path as Your agent's DMs (`sendWorkbotDirectMessage`).
- **`channel`**: a post from the bot, only where the bot is a member, and only in a channel the member can read in
  Slack themselves (checked with their own Slack token first, so inviting the app to a private channel never lets
  someone outside it post there). Every post starts with `@member's agent`, added by Den; the agent can't remove it.
  `@here`, `@channel`, `@everyone` and group mentions in the text are neutralized. If the app isn't in the channel the
  agent is told to ask the person to invite it.
- No DMs to other people as the bot; any other target is refused with a sentence pointing at `slack_send_message`.

## Limits

Enforced in the tool, because nobody watches background runs. Every refusal is one sentence the agent relays.

- 20 messages a day per member (fixed 24-hour windows): "Not sent: daily limit reached (20/20)."
- 5 messages a minute per member.
- The same text to the same place (DM, channel or thread) at most once in 24 hours. Only a message that went out
  counts, so a send that failed (for example, the app wasn't in the channel) can be retried after the fix.

Counts live in the existing `rate_limit` table (`utils/rate-limit.ts`); expired same-message records are deleted after
each send. Refusals for a missing Slack app or an unlinked account spend nothing.

## Who can use it

It needs the `mcp:write` scope. Normal chats, Slack runs and Automation runs (write-scoped tokens) see it; read-only
tokens, such as Your agent's background turns, never list or run it. It is not available to Code Mode scripts,
Workflows or Apps in this version: each message is one explicit call. Calls are audited as
`slack_assistant.bot_message.send`.

## Turning it on and off

Turn `slackSendAsBot` on for an organization in `/admin` (Features, or the organization's row), then for everyone.
Off, the capability disappears from search, the full tool view and the agent instructions, and executing it answers
`unknown_capability`. Nothing is stored except the limit counters, so turning it off at any moment is safe; messages
already sent stay in Slack.

Code: `ee/apps/den-api/src/mcp/slack-send-as-bot.ts` (capability, limits),
`ee/apps/den-api/src/slack-assistant/bot-post.ts` (channel posts), source `slackSendAsBot` in
`ee/apps/den-api/src/mcp/capability-registry.ts`. Tests: `ee/apps/den-api/test/slack-send-as-bot.test.ts`.
