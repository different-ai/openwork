# Text-first activity in chat

Feature key: `textActivityRail`. Deployments: cloud and self-hosted. Default:
off. Author: [@benjaminshafii](https://github.com/benjaminshafii).

## What changes

With the feature on, a turn's steps read as plain sentences instead of an
icon rail:

- Each step is "Verb object": `Ran List the notes folder`, `Read brief.md`,
  `Edited brief.md +2 −1`, `Searched for “pricing”`. The verb is darker than
  the object. Commands show their description, never the raw command line.
- Consecutive local steps fold into one summary: `Explored 1 file, 1 search,
  edited 2 files, ran 3 commands +6 −1`, with the chevron after the text.
- There is no icon column and no duration lane. Time shows only on
  `Thought 12s` / `Thought briefly` and `Worked for 1m 35s`.
- Opening a command shows one quiet card: `$`, the program tinted, the rest
  of the command, its output capped with Show more, and a `…` menu to copy
  the command or output. Opening an edit shows the change in the same card.
- A failed step's verb is red (`Couldn't run …`); other failures open a
  quiet Technical details box. Waiting on the person reads `Waiting for you`
  in amber. Only the running step shimmers.
- Every line (thoughts, summaries, steps, opened cards, sub-agent rows)
  starts on the reply text's left edge. There is no leading icon or chevron
  column; chevrons trail the text.
- OpenWork and connected services keep their real mark inline after the
  verb (`Looked up [mark] people in your organization`); no spinner. The
  OpenWork mark is drawn in the text's ink, so it is white on dark.
- The composer's Agents list (`composerSubagentTracker`) reads as text too:
  no status dot or check column, the status word carries the state, and
  `Review`, `Stop` and `Open` are words.
- GitHub pull request and issue links in replies show the GitHub glyph
  (neutral; the app does not fetch their state).

| Off | On |
| --- | --- |
| ![Flag off](off.png) | ![Flag on](on.png) |
| ![Flag off, finished turn](off-folded.png) | ![Flag on, finished turn](on-folded.png) |

Opened steps with the flag on: a command card, an edit's change and a failed
command.

![Flag on, opened steps](on-open.png)

Dark, with the composer's Agents list on (designed as if
`composerSubagentTracker` is on for everyone):

| Off | On |
| --- | --- |
| ![Flag off, dark, Agents list](off-dark-agents.png) | ![Flag on, dark, Agents list](on-dark-agents.png) |

Screenshots: the real `MessageList` in headless Chrome against this
checkout's Vite dev server, with a seeded turn (the same fixture as the
dev-only control action `eval.text_activity.seed`).

## How to try it

1. Turn `textActivityRail` on for your organization in `/admin`.
2. Reload the app; any chat with tool steps shows the new rail.
3. In a dev build, run the control action `eval.text_activity.seed` on an
   open session to render a fixed turn with every kind of step.

## Turning it off

Every row reads the flag from one store, so turning it off (or the kill
switch) returns the previous rail on the next features refresh, with no
reload and no data change. Nothing is stored differently: reasoning timing
and edit line counts are read from what the engine already reports.

## What to watch

Rendering only. Watch for layout reports on long command lines or very long
outputs in the command card, and for reasoning rows that say `Thought`
without a time (history from engines that report no timing).
