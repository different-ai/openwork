# Workbot: Slack answers as their own reply

- Feature: `workbotSlackAnswerReply`
- Deployments: cloud and self-hosted; default **off**
- Owner: `benjaminshafii`

## What changes

Today a Slack reply is one streamed message: the agent's notes on the way
("Let me catch up on the thread first.", "Found it, I'll book it in that slot.")
and its answer are joined in it. Slack doesn't notify anyone when a streamed
message is added to, so a run longer than a minute gets a fixed follow-up,
"@person Done: <first sentence of the reply>". That sentence is usually the
agent's first note, so the ping reads like the task finished before it did
anything.

With the feature on, the reply works the way a colleague would answer:

- **Notes stream into one message.** Text the agent wrote and then went on to
  do work (a tool call other than a reaction) is shown in the first message as
  it is stored. Updating that message notifies no one.
- **The answer is its own reply.** The turn's last message, when it did no
  work after it, is posted as a new message in the thread when the run ends.
  That is the notification, and the Helpful / Needs work buttons sit under it.
  Long answers continue in more replies, split at paragraph breaks.
- **No fixed "Done:" ping.** It is still sent for a task that stopped without
  an answer ("This task needs your attention").
- **The words stay the model's own.** The session is told its last message
  lands as a new reply, so it writes it as coming back with the result
  ("Alright, booked it…") and doesn't open with "Done:". It still decides
  whether to say anything before working; a quick answer is a single reply.
- **One acknowledgment for background jobs.** Without the feature, a job handed
  to a background task often gets two: "I'll check your calendar…" before
  starting it, then "I'm on it…" after. With it, the sentence before the task
  is the acknowledgment ("I'll match your calendar with your meeting notes and
  post what I find here.") and the turn ends silently once the task starts.
- A last message that started work ("Sure, I've started on it, I'll update
  you here") stays in the notes message; the background task's report posts
  later as before.

Examples:

```
sam       when's the team sync this week?
openwork  Today at 9:30, same as usual.

sam       can you replace this week's sync with one for Alex and Priya?
openwork  On it, let me find the current sync.
openwork  Alright, booked it in the same slot: today 9:30–10:00 … 🔔
```

Code: `notesAndAnswer` and the finish phase in
`ee/apps/den-api/src/slack-assistant/run.ts`, the instruction
`SLACK_ANSWER_REPLY_INSTRUCTIONS` in `protocol.ts`, and the per-message choice
in `worker.ts`.

## Try it

1. Turn `workbotSlackAnswerReply` on for a test organization (or member) in
   `/admin` › Features. It applies from the next Slack message.
2. Ask something instant ("what's 2+2"): one reply.
3. Ask something that needs a lookup ("what's on my calendar tomorrow?"): a
   short note, then the answer as a separate reply that notifies you.

## Turning it off

The choice is made once per message, so a reply in progress finishes the way
it started. The next message streams in one message with the "Done:" ping
again. Nothing else is stored.

## What to watch

`slack_assistant_failed` and `slack_assistant_event_failed` warnings from
den-api, replies whose answer appears twice (in the notes and as a reply), and
threads with no answer reply after a run completed.
