# Side chat answers from the conversation (`sideQuestions`)

- **Feature key:** `sideQuestions`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

A side chat for quick questions about the conversation on screen: "what did
that mean?", "which file was that in?". It opens in the pane beside the
conversation and each question is answered from what that conversation
already knows.

It is not a session. Nothing is added to the conversation, no tools run, and
nothing appears in the sidebar. A question can be asked while the agent is
still working, without interrupting it.

Three ways in:

- `/btw <question>` in the message box asks and opens the side chat. A bare
  `/btw` just opens it. The command is listed in the `/` menu.
- **Start a side chat** on text selected in a reply opens it with the text
  quoted in the side chat's message box.
- **Open side chat** in the command palette opens it.

Each question shows its answer with **Copy answer**, or a reason and
**Retry** when it could not be answered. Questions are one-shot: an answer
does not see earlier side questions.

## How it works

This is OpenCode's `/btw`, with the same name, the same engine call and the
same instructions, so both apps ask the model the same thing.

Each question is one `POST /api/session/:sessionID/generate` request with the
instructions and the question as the prompt. The engine answers from the
session's context without changing its history. It exposes the session's
tools but runs no tool loop, so a reply that is only a tool call arrives as
empty text and is shown as "The model replied without any text."

A request that takes longer than five minutes fails with Retry.

## With the feature off

**Open side chat** and **Start a side chat** open a new session beside the
conversation, as before, and `/btw` is not a command.

## Limits

- OpenCode v2 conversations only, and only the main conversation: not a
  sub-agent's conversation or one open in the side pane.
- Questions and answers are kept while the app stays open. They are not
  saved across a restart.
- The side chat takes the side pane while it is open; a session already
  beside the conversation comes back when the side chat is closed.
- Not shown at phone width.
- **Open as side chat** on an existing session is unchanged: it shows that
  session beside this one.
