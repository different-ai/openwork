# Workbot: command palette

- Availability: cloud and self-hosted, on by default wherever Workbot is available
- Author: @benjaminshafii

Members press **Cmd+K** (macOS) or **Ctrl+K** (Windows, Linux), or the search
button in Workbot's header, to search and run what Workbot already does from
its visible controls:

| Group | Entries | Enter | Cmd/Ctrl+Enter |
| --- | --- | --- | --- |
| Actions | Message Workbot, Stop the reply (while answering), New side chat, Switch chat ›, Show background tasks ›, Show files | Run | |
| Chats | Main chat and side chats (four most recent; all when searched) | Open | Open in a new tab |
| Background tasks | Running tasks of this chat (finished ones when searched) | Show the task card | Stop it |
| Go to | Home, Calendar, Documents, Computer (the ones this person has) | Open | |
| Settings | Your dashboard, Your connections (Den pages the header links to) | Open | Open in a new tab |

Recently used entries come first. Tab opens a nested list (Switch chat,
Show background tasks); Backspace on an empty search, Shift+Tab or Esc goes
back. Ctrl+N / Ctrl+P move like the arrow keys. Esc closes and focus returns
where it was (usually the message box).

![The palette open over the conversation](./workbot-command-palette.png)

## How it works

- The palette and header button are always mounted for an available Workbot
  page. Neither needs a feature flag or a host opt-in. Den's
  `GET /v1/workbot/session` and Workbot's `GET /v1/workbot/me` retain a true
  `commandPalette` field for older clients; current clients do not gate on it.
- `ee/packages/workbot-ui/src/command-palette.tsx` renders it with Base UI
  `Dialog` and inline `Autocomplete` (combobox, listbox, active descendant,
  live result count). Ranking and recents are in `command-palette-search.ts`
  (fuzzysort, the desktop palette's approach), tested in
  `ee/apps/workbot/scripts/command-palette.test.ts`.
- No new server routes. Chats come from `GET /v1/workbot/chats` (already used
  by the Chats drawer), tasks from the conversation already on screen; Stop
  calls the task card's existing stop route.
- Existing Workbot access, host capabilities and action availability still
  apply. Making search available does not grant access to pages, files,
  chats or task actions the person cannot otherwise use.
- Recents are kept in this browser's local storage
  (`workbot.command-palette.recents`, entry ids only).

## Proof

`evals/proofs/workbot-command-palette.proof.test.ts` (`pnpm evals:e2e
workbot-command-palette --local`) drives the real Workbot page headless:
default availability without a rollout field, Cmd+K from the composer,
loading, search with highlights, nested Chats list, no results, Cmd+Enter
stopping a task, Enter opening Calendar, recents, and a 390px phone.
