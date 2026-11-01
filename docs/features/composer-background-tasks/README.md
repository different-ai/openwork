# Background tasks on the composer (`composerBackgroundTasks`)

- **Feature key:** `composerBackgroundTasks`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @benjaminshafii

## What people get

When the agent leaves a command running in the background (the shell tool's
`background: true`, OpenCode v2), the command is listed on top of the
composer, under the **Agents** list, until it exits:

- A **Background tasks · N running** header with the same chevron as Agents.
  Up to three commands start expanded; more start collapsed.
- One row per command, in the Agents rows' shape and height, set apart as a
  command: the command itself in monospace (full command on hover) and how
  long it has run, shimmering while it runs. An empty action lane keeps the
  times in line with the agent rows above; commands have no Stop or Open yet.
- While the connection cannot confirm the commands, rows stay and say
  **Reconnecting**, without shimmer or ticking time.

The chat no longer shows its own count of them ("Working 12s · 2 running
background tasks", or the count line after the turn). The row the chat adds
when a command ends ("Background task finished …") is unchanged.

## Off

Turning it off brings back today's count in the chat and removes the list
from the composer. Nothing is stored; it is safe to turn off at any moment.

## Try it

Ask the agent to start something long-running in the background (for example
`sleep 120 && echo done` with background on), then watch the composer.
`evals/proofs/background-tasks-composer-list.proof.test.ts` drives it with a
mock agent.

## Code

- `apps/app/src/react-app/domains/session/surface/composer/composer-background-tasks.tsx`
- Gated in `apps/app/src/react-app/domains/session/surface/session-surface.tsx`;
  `MessageList`'s `backgroundTasksInComposer` drops the chat's count.
