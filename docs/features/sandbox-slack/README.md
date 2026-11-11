# Sandboxes: sample Slack for Workbot (`sandboxSlack`)

- **Key:** `sandboxSlack`
- **Deployments:** cloud only (sandbox organizations are cloud only)
- **Default:** off
- **Author:** @reachjalil

## What changes

Sandbox organizations (`/admin/sandbox-orgs`) connect the hosted sample work apps. Workbot's Proactive Mode sends
each member's agent messages as a DM from the Workbot Slack app, so in a sandbox the switch stayed locked with
"Needs the Slack app first": nobody has a Slack workspace to install the app in.

With the feature on, a **new** sandbox gets a sample Slack that lives in the sample work apps, not Slack:

1. When the sandbox is created, Den registers a sample Slack app with the workplace
   (`POST <workplace>/_workshop/slack/apps`), adds a per-person **Slack** connector at `<workplace>/slack/mcp`, and
   stores the Workbot Slack app as installed on it with the sample bot token the workplace issued. Workbot's
   settings then show the Slack app as ready, so Proactive Mode can be turned on.
2. Each member presses **Connect** on the Slack connector once. The workplace's consent page opens in their browser
   and shows the private sample workspace that browser already has. Connecting links the member to their sample
   Slack user, the same way connecting real Slack does.
3. Messages Workbot sends that member (Proactive Mode, "send me" from an agent) arrive on that browser's
   `<workplace>/slack` page. What they answer there is read back as their side of the conversation.

![The sample Slack page: messages from Workbot and the member's reply](sample-slack-page.jpg)

Per-member isolation is the workplace's: one private workspace per browser profile, as with the other sample apps.

Not included yet: the sample Slack has no channels, and it doesn't tell Den when a member replies, so Workbot does
not answer in the sample Slack.

## Why real Slack is untouched

Where a Slack call goes is decided per installation, on every call, from things only Den sets
(`ee/apps/den-api/src/slack-assistant/sandbox-api.ts`):

- the installation's bot token is a sample token (`xoxb-open-workplace-…`). Only sandbox setup writes one; every
  other bot token comes from Slack's own install answer, and Slack never issues that prefix;
- the organization is an **open** sandbox, the address is the workplace address a platform admin gave it, and the
  Slack connector still points at that workplace;
- the feature is on for the organization.

Every other organization and connector keeps Slack's API. The Slack client itself refuses to send a sample token to
Slack. The Slack app setup and install routes still accept only Slack's own connector, so a real Slack app can't be
installed on the sample connector.

## Turning it off

The kill switch (or turning it off for an organization) makes the sample Slack **unavailable**: sending answers
`sandbox_slack_unavailable` and nothing is sent anywhere. Turning it back on restores it without reconnecting. When a
sandbox closes or expires, the same happens.

Sandboxes created while the feature was off have no sample Slack. To give an existing sandbox one, turn the feature
on for its organization, then use **Add Slack** on its row in `/admin/sandbox-orgs`
(`POST /v1/admin/sandbox-orgs/:id/slack`).

If the workplace has no sample Slack yet (an older deployment of the workshop), sandbox creation logs
`sandbox slack failed` and the sandbox is created without it.

## Requirements

- The workplace runs `evals/packages/open-workplace/src/workshop.mjs` with Open Slack (`GET /health` reports
  `slack: true`).
- Proactive Mode itself still needs its own feature and a headless runner, as in any organization.

## Try it

- API: `pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx --test test/api/sandbox-slack.api.test.ts`
- Workshop: `node --test evals/packages/open-workplace/src/workshop-slack.test.mjs`

## What to watch

- Den logs: `sandbox slack failed` (registration with the workplace failed; the sandbox has no sample Slack).
- `sandbox_slack_unavailable` from Workbot's Slack sends in sandbox organizations.
