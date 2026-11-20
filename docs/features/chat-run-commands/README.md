# Run commands from the chat

Feature key: `chatRunCommands` · Deployments: cloud and self-hosted · Default: off · Author: `reachjalil`

## What a person gets

When the agent suggests a single command in a shell block (`bash`, `sh`,
`shell`, `zsh`, `console` or `terminal`), the block shows a **Run** button
next to Wrap and Copy. Clicking it sends this message in the conversation:

````text
Run this command, then continue from its output:

```bash
curl https://example.com/.well-known/apple-app-site-association
```
````

The agent runs that exact command with its shell tool in the conversation's
workspace. The command and its output appear as a normal step, and the agent
continues from the result in the same turn. If the agent is busy, the message
steers the running turn like any message sent mid-run.

Only one-line blocks get the button; a leading `$ ` prompt is dropped.
Scripts, several commands, or a command shown with its output stay copy-only.
The button never appears on a block that is still streaming, in archived
conversations, in artifacts, in tool output, or in tasks from another
computer.

## How it compares with Claude Code

Claude Code's desktop app types the command into its Terminal panel. When the
command finishes, its next turn includes a short note (exit code and line
count) and the agent reads the terminal if it needs the output. OpenWork's
agent cannot read the desktop terminal, and the OpenCode v2 engine client does
not support running a command for the person (`session.shell`), so OpenWork
hands the command to the agent on every engine:
the output is in the conversation and the agent continues without another
message.

## Trying it

Turn `chatRunCommands` on for your organization in `/admin` › Features, then
ask the agent for a command, for example "give me a curl command to check
example.com". Click **Run** on the block.

## Turning it off

The Run button disappears; blocks are copy-only again. Messages already sent
stay in the conversation as ordinary messages.

## What to watch

Feature usage in `/admin` › Features (`markFeatureUsed("chatRunCommands")` on
each click). Shell permission prompts still apply: if the agent's shell tool
asks for approval, the person sees that prompt after clicking Run.
