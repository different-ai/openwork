# Workbot: cost in Analytics

Feature key: `workbotUsageAnalytics` · Deployments: cloud and self-hosted · Default: off · Author: @reachjalil

## What changes

With the feature on, Den › Analytics has a **Workbot** tab for members who can
view usage analytics (owners and admins by default), in organizations where
Workbot is available. It shows what Workbot spent on models over the last 30
UTC days:

- **Model cost**, cost per person, people who used Workbot, model requests and
  tokens.
- **Cost per day**.
- **Where it ran**: Chats (a person's Workbot chats), Members' agents (their
  background agents), and Slack and automations (everything else on the
  runner).
- **Models** and **People**, most expensive first (20 models, 50 people; the
  totals cover everyone).

Cost is what the AI Gateway recorded: the provider's reported cost when it
sends one, list prices otherwise. It includes use covered by an included
allowance. A finished request with no known price is counted and called out,
and adds nothing to the cost.

## How it works

- The headless runner sends `x-openwork-headless-session` with the
  conversation's id on model calls it makes through Den-issued access. A
  deployment's direct provider key never gets the header.
- The gateway keeps the id on the request log (`metadata.headless_session`) and
  never forwards it to the model provider.
- The hourly rollup (`ee/apps/gateway/src/rollups.ts`) adds those requests to
  `workbot_usage_day`, one row per UTC day, member, surface and model, in the
  transaction that deletes the logs. The conversation id is not kept; the
  surface is read from its prefix (`foldWorkbotUsage` in `ee/packages/den-db/src/workbot-usage.ts`).
- `GET /v1/workbot-usage` adds the folded days and the request logs that are
  not folded yet (about the last two days).

Recording is not gated: it starts when the runner and gateway with this change
are deployed, so the numbers are there when the feature is turned on. Use from
before that cannot be recovered; the page says "Counting since" while the
30 days are not fully covered.

## Try it

Turn `workbotUsageAnalytics` on for a test organization in `/admin` ›
organization › Features. Send Workbot a message, then open Analytics › Workbot:
the request appears within a minute under Chats, with its model and the person
who sent it.

## Turning it off

The tab goes away and `GET /v1/workbot-usage` answers 404. Recording continues
and nothing stored is removed, so turning it on again shows the same numbers.
Deleting an organization deletes its rows.
