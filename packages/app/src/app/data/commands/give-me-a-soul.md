---
name: give-me-a-soul
description: Enable optional Soul Mode with scheduler-backed memory and an easy revert path
---

Give me a soul.

Outcome: You remember my goals and preferences across sessions and can do lightweight check-ins on a schedule.
Tradeoff: extra autonomy means occasional background runs and occasional wrong assumptions.

Set this up in this workspace as optional Soul Mode using existing scheduler primitives.

Requirements:
1) Ask me for confirmation before creating any files or jobs.
2) Keep it simple and reversible.
3) Create `.opencode/soul.md` as human-editable memory.
4) Create one scheduler job named `soul-heartbeat` that runs on a reasonable default cadence (ask if I want a different cadence).
5) The job should read soul memory, run a concise check-in prompt, and append a timestamped record to `.opencode/soul/heartbeat.jsonl`.
6) Create a one-command revert path named `/take-my-soul-back` that removes the soul job and related files.

When done, summarize in two short bullets:
- What Soul Mode now does for me.
- Exactly how to revert.
