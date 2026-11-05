# Steady chat while a reply runs

Feature: `steadyLiveTurn`. Cloud and self-hosted. Author: `benjaminshafii`.
Off by default.

While a reply runs, its steps and messages stay in the order they arrive and
the chat keeps its place. No empty gap opens between steps, and the list does
not jump up when a step finishes. Once the reply finishes, the steps fold into
"Worked for…" as before.

## What changes

Before, two things in the live turn could leave an empty gap between the
steps and the text below them for the rest of the run:

- The turn was split into "steps" and "answer" at its latest text. Each new
  text moved that split point, so rows moved from the steps area to the answer.
- The steps area kept the tallest height it had reached, so anything that
  moved out or folded away left blank space in the middle of the turn.

With the feature on:

- A running turn renders its parts in arrival order. The split into steps and
  answer happens once, when the turn ends (the App panel keeps its own fold).
- The steps area no longer holds its height. Instead, room a running turn
  gives up is kept at the very end of the chat, below the Working line, and
  the next row or text fills it before anything moves. Collapsing a row
  yourself is not held. The room is released when the turn ends.

## Try it

Turn it on for an organization or member in `/admin` › Features, then send a
prompt that mixes tool calls, a short message and more tool calls. No gap
appears between the steps and the message, and the Working line does not jump
up while it runs. The `measure-chat-flicker` skill counts upward jumps.

## Turning it off

Takes effect on the next render: the live turn again splits at its latest text.
The steps area no longer retains its tallest height with either setting, so
folded tool details cannot leave an empty panel between steps and the answer.
Only the feature-on path reserves released room below the Working line.
Nothing is stored; history is unaffected.
