---
name: measure-chat-flicker
description: Measure whether the chat jumps while a turn runs by sampling the Working line's position over CDP and counting upward moves. Use when changing step rows, live status lines, folding, or anything that can shrink content during a run.
---

# Measure chat flicker

Content growing below is normal. Content shrinking during a run (a live line removed, a group closing) moves everything up, and that reads as flicker. This counts those upward moves.

```bash
export CDP_URL=http://127.0.0.1:<cdp port>
M=.opencode/skills/measure-chat-flicker/scripts/flicker.mjs
node .opencode/skills/drive-desktop-cdp/scripts/cdp.mjs new-session
node $M arm
node .opencode/skills/reproduce-chat-states/scripts/repro.mjs sequential-commands
node .opencode/skills/drive-desktop-cdp/scripts/cdp.mjs wait-idle
node $M report      # { upwardJumps, downwardMoves, samples }
```

Note: `repro.mjs` opens its own new session, so arm after it if you need the arm to survive the navigation, or run `send` directly.

## Reading the result

- `upwardJumps` during the run should be 0. One at the very start (the first step replacing "Starting…") is acceptable.
- Reference: before the live step moved onto the group's own line, five sequential commands gave 6 upward jumps of about 22px in 27s; after, 1.
- Run the same prompt before and after a change and compare. Keep the window size fixed between runs.
