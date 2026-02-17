---
name: take-my-soul-back
description: Disable Soul Mode and remove soul files + scheduler job
---

Take my soul back.

Disable Soul Mode in this workspace right now.

Execution rules:
- Use scheduler tool `delete_job` for removing `soul-heartbeat`.
- Use file tools for file deletion/editing. Do not use shell redirection.

Steps:
1) Delete scheduled job `soul-heartbeat` using `delete_job` (ignore if it does not exist).
2) Delete `.opencode/soul.md`.
3) Delete `.opencode/soul/state.json`.
4) Delete `.opencode/soul/heartbeat.jsonl`.
5) Delete `.opencode/commands/soul-heartbeat.md`.
6) If `.opencode/soul/` is empty afterward, remove that folder.

Reply with exactly two bullets:
- `Soul Mode disabled.`
- `Re-enable with /give-me-a-soul`.
