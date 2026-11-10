# Workbot: step limit

Feature key: `workbotStepLimit` · Deployments: cloud and self-hosted · Default: off · Author: @reachjalil

## What changes

Workbot can stop a request after a set number of steps (one step is one call to
the model, with the tools it asks for); it then says "That needed more steps
than I can take at once. Try a smaller piece of it." By default there is no
limit. Until now only the operator could set one, with `HEADLESS_MAX_STEPS` on
the headless runner.

With the feature on, Den › Manage › Workbot has a **Step limit** row under the
default model. An admin with Manage OpenWork Models chooses:

- **Default**: the deployment's own setting (`HEADLESS_MAX_STEPS`; no limit
  unless the operator set one).
- **100, 250, 500, 1,000, 2,500 or 5,000 steps**.
- **No limit**: a request ends only with its answer, Stop, the stuck check or
  the turn timeout.

The choice is one value for the organization. It applies to every member's
Workbot chats, main and side chats and the background tasks they start, from
each chat's next message. It does not change the Slack assistant or Automations.

With Workbot settings per team on as well (`workbotTeamSettings`), a team can
have its own step limit: the same choices, on Members › Teams › a team ›
Workbot, with the organization's limit on Everyone's page. A member gets their
team's limit, or the organization's when none of their teams sets one or their
teams differ. Turning either feature off keeps the teams' limits but ignores
them: chats go back to the organization's limit (team settings off) or the
deployment's default (step limit off) on their next message.

## How it works

- Den keeps the value in the organization's metadata as `workbot.maxSteps`
  (absent for Default). `GET` and `PUT /v1/org/workbot-settings` carry
  `maxSteps`: `null` is Default, `0` is no limit, and any whole number up to
  100,000 is accepted, so a value outside the list can be set through the API.
- `GET /v1/workbot/session` gives the value to Workbot, which writes it to each
  chat's session on the runner with the chat's other settings. The runner uses
  the session's value in place of `HEADLESS_MAX_STEPS` for that chat's turns.
- A runner from before this setting refuses it; Workbot then saves the chat
  without it and the chat keeps the runner's own limit.

## Try it

Turn `workbotStepLimit` on for a test organization in `/admin` › organization ›
Features. Open Manage › Workbot, set Step limit to 100 steps, and send Workbot
a message. The chat's session on the runner (`GET /v1/sessions/:id`) shows
`maxSteps: 100`. Set it back to Default and send another message: the session
shows `maxSteps: null`.

## Turning it off

The Step limit row goes away and `PUT /v1/org/workbot-settings` refuses
`maxSteps` (400). The saved value is kept but ignored: while a value is saved
and the feature is off, Den tells Workbot to clear it, so each chat goes back
to the deployment's default on its next message. Turning the feature on again
brings the saved value back the same way.

## What to watch

- Turns that end with `max_steps_exceeded` on the runner. A low limit makes
  them more common; people see the "smaller piece" message above.
- With No limit, or a high one, long requests use more model calls. The turn
  timeout and the stuck check still apply.
