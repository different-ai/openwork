# Run commands from the chat

Feature key: `chatRunCommands` · Deployments: cloud and self-hosted · Default: off · Author: `reachjalil`

## What a person gets

When the agent suggests a single command in a shell block (`bash`, `sh`,
`shell`, `zsh`, `console` or `terminal`), the block shows a **Run** button
next to Wrap and Copy. Clicking it runs that exact command in the
conversation's workspace, the way OpenCode's `!` shell input does. The
conversation shows it as a **Ran a command** step with its output, and the
agent then continues from the result. No message is sent on the person's
behalf.

Only one-line blocks get the button; a leading `$ ` prompt is dropped.
Scripts, several commands, or a command shown with its output stay copy-only.
The button never appears on a block that is still streaming, in archived
conversations, in artifacts, in tool output, or in tasks from another
computer.

## How it compares with Claude Code

Claude Code's desktop app types the command into its Terminal panel and its
next turn includes a short note (exit code and line count). OpenWork runs the
command through the engine (`session.shell`), so the command and its full
output are part of the conversation the agent reads. A hidden note then wakes
the agent to continue from the result without running the command again.

On an engine that cannot run a command for the person (OpenCode v1), Run
falls back to sending "Run this command, then continue from its output" with
the command, and the agent runs it with its shell tool.

## Trying it

Turn `chatRunCommands` on for your organization in `/admin` › Features, then
ask the agent for a command, for example "give me a curl command to check
example.com". Click **Run** on the block.

## Turning it off

The Run button disappears; blocks are copy-only again. Messages already sent
stay in the conversation as ordinary messages.

## What to watch

Feature usage in `/admin` › Features (`markFeatureUsed("chatRunCommands")` on
each click). The command runs on the person's click, so the agent's shell permission
prompt does not apply to it; on the v1 fallback it still does.
