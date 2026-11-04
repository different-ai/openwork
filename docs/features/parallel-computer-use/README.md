# Parallel computer use

Feature `parallelComputerUse` (cloud and self-hosted, off by default). Author: `reachjalil`.
Needs `computerUse`.

On a Mac, the agents a chat starts (OpenCode's `subagent` tool) work in their own apps at the
same time, as part of that chat. A task such as "make a deck whose first slide is a styled Maps
screenshot" can run Maps and PowerPoint at once, then Photoshop, then PowerPoint again.

## What the person gets

- One chat, one computer: Stop or Take over in the chat, or on any agent's app, stops or holds
  every agent of the chat until Continue. Stop holds for agents started later in that turn; the
  chat's next message turns them all back on.
- One output folder: every agent gets the chat's `save_folder`, so they pass work as files by
  path, and the chat's card lists what they saved.
- Questions to the person (macOS setup, an organization's Ask first) show in the chat, not only
  in the agent's own thread.
- Each agent's cursor shows its own name (its short description, such as "Maps") and color;
  the chat's own apps keep "OpenWork".
- While the person watches the chat, its agents work in view and take turns at the keyboard;
  out of view they work in the background at the same time.
- While the person watches the chat, the agents' windows share one stage on OpenWork's screen:
  OpenWork keeps its column and the agents' windows tile the rest, re-tiling as agents open
  and close apps. A window the person moved stays where they put it; closing puts each back.

## How it works

- The OpenWork server's engine plugin reads a subagent's root chat from the engine's session
  tree (`session.get` → `parentID`) and sends it to the desktop as `rootSessionId`, only while
  the desktop reports the feature on. Model input never names it.
- The desktop broker (`packages/computer-use/computer-control.mjs`) links the subagent's grant to
  its chat. The chat's computer choice, Stop, Take over and Continue, questions, clipboard key and
  output folder are shared; each agent keeps its own apps, `session_id`s, helpers, turns at the
  keyboard and per-file approvals.
- The app window reports the feature (`computerSetParallelAgents`), as it reports `computerUse`
  and `standardCodeMode`; the desktop answers the engine's `/computer` check with `parallel`.

## With the feature off

Nothing changes: every session, a subagent's included, is its own chat with its own Stop,
Take over and output folder, as before. The engine makes no extra session reads.

## Testing

Turn `parallelComputerUse` on for a test organization or member in platform admin, with
`computerUse` on. Ask for a task across two Mac apps and check that Stop in the chat ends both
agents' apps and that both save into the same `~/Downloads/OpenWork/<chat>` folder.

## Code

`packages/computer-use/computer-control.mjs` (`setParallelAgents`, `rootSessionId`),
`apps/server/src/opencode-plugins/openwork-context-v2.ts`, `apps/server/src/opencode-v2-browser-bridge.ts`,
`apps/desktop/electron/main.mjs`, `apps/app/src/react-app/domains/session/computer/computer-store.ts`.
