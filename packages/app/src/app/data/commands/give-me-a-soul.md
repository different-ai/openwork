---
name: give-me-a-soul
description: Enable persistent Soul Mode (memory + 12h heartbeat + easy undo)
---

Give me a soul.

Set up Soul Mode in this workspace now, end to end, with no follow-up questions.

Requirements:
1) Persistent memory files:
   - `.opencode/soul.md`
   - `.opencode/soul/state.json`
   - `.opencode/soul/heartbeat.jsonl`
2) Heartbeat command:
   - Ensure `.opencode/commands/soul-heartbeat.md` exists.
   - Heartbeat must be session-aware: review recent sessions, unfinished todos, and stale loose ends.
   - It must propose one practical follow-up and perform only safe, reversible housekeeping.
3) Revert command:
   - Ensure `.opencode/commands/take-my-soul-back.md` exists.
4) Scheduler:
   - Create/update job `soul-heartbeat`.
   - Default cadence: `0 */12 * * *` (about every 12 hours).
   - Run as a command (`command=soul-heartbeat`) in this workspace.
5) Validation:
   - Run the job once immediately.
   - Confirm heartbeat log was appended.

Heartbeat behavior details:
- Read `.opencode/soul.md` and `.opencode/soul/state.json`.
- Discover OpenCode sqlite db path from common locations.
- Query recent sessions and unfinished todos for this workspace.
- Produce:
  - one-sentence heartbeat summary,
  - 1-3 loose ends,
  - one recommended next action,
  - 2-3 curiosity paths.
- Append exactly one JSON line to `.opencode/soul/heartbeat.jsonl` with at least:
  - `ts`, `workspace`, `summary`, `loose_ends`, `next_action`.
- Update `.opencode/soul/state.json` with durable context (last heartbeat, recent sessions, loose ends, next action).

When finished, respond with:
- what Soul Mode now does,
- the exact revert command: `/take-my-soul-back`.
