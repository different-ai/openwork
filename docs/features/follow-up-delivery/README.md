# Follow-up delivery status (`followUpDelivery`)

- **Feature key:** `followUpDelivery`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

A message sent while the agent is working is not read at once: the agent
reads it when its current step ends. Without this feature the message shows in
the chat as soon as it is sent and nothing says it is still waiting.

With it on:

- **Under the sent message**, "Waiting for the current step to finish" shows
  until the agent reads the message. A message the agent reads within 600 ms
  never shows it. Cancelling the message, or the conversation going idle,
  clears it too.
- **In the message box**, while the agent works and a message is typed, a line
  shows the two keys and what each does, named as Settings › Follow-up
  messages names them: `↵` When the agent finishes, `⌘↵` (or `Ctrl+↵`) Right
  away. The two swap when the setting is "Right away". The line is hidden on
  touch screens, in a helper's conversation and while editing a sent message.

Sending, queueing and stopping work as before. Only OpenCode v2 chats report
delivery, so nothing changes in other chats.

## How it works

The engine keeps undelivered messages in a per-conversation inbox and reports
`session.inbox.enqueued`, `session.inbox.delivered` and
`session.inbox.cancelled`. The engine adapter turns these into a waiting event
and a settled event; session sync keeps the waiting message ids per
conversation in memory (`follow-up-delivery-store.ts`). Nothing is stored or
sent anywhere.

## Turning it off

The label and the key line stop rendering. No stored data, in-flight message
or shortcut depends on the feature.

## What to watch

- A label that never clears would mean a missed `session.inbox.delivered`
  event while the conversation stays busy.
- Usage is counted when the waiting label is shown.
