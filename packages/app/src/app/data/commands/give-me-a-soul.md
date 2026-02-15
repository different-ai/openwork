---
name: give-me-a-soul
description: Enable optional Soul Mode (persistent memory + scheduled heartbeat + easy revert)
---

Give me a soul.

Outcome: You remember my goals and preferences across sessions and can do lightweight check-ins on a schedule.
Tradeoff: extra autonomy means occasional background runs and occasional wrong assumptions.

Set this up in this workspace as optional Soul Mode using existing OpenCode primitives (commands, agents, scheduler).

Requirements:
1) Ask me for confirmation (explicit "yes") before creating any files or scheduling any jobs.
2) Keep it simple, safe, and reversible.
3) Use workspace-local files for persistence. Prefer `.opencode/` so it's visible + portable.
4) Scheduled runs must be non-interactive: they cannot wait on permission prompts.

After I confirm, implement Soul Mode by doing ALL of the following in THIS workspace:

## A) Persistent memory

Create `.opencode/soul.md` as human-editable memory.

- Keep it short and structured.
- Include a "Last updated" line.
- Include sections for:
  - Goals
  - Preferences (tone, format, boundaries)
  - Current focus
  - Loose ends (things I started but didn't finish)
  - Recurring chores / automations to consider

Suggested initial contents:

```markdown
# Soul Memory

Last updated: <ISO-8601 timestamp>

## Goals
- 

## Preferences
- 

## Current focus
- 

## Loose ends
- 

## Recurring chores / automations to consider
- 
```

## B) Heartbeat log

Create `.opencode/soul/heartbeat.jsonl` (create the directory and file if missing).

- Append exactly ONE JSON object per heartbeat run (one line per run).
- Minimum fields: `ts` (ISO string), `workspace` (string), `summary` (string).

## C) A dedicated Soul agent (so scheduled runs don't get blocked)

Create `.opencode/agents/soul.md` (a primary agent) with two goals:

1) Behavior: be curious about closing loops (unfinished tasks, dangling threads, stale TODOs), and keep check-ins concise.
2) Permissions: allow ONLY what's needed for heartbeat to run unattended.

The permissions must specifically avoid getting blocked by the global OpenCode sqlite database path (often at `$HOME/.local/share/opencode/opencode.db` or `$XDG_DATA_HOME/opencode/opencode.db`).

Note: do NOT try to read `opencode.db` with the `read` tool (it's a binary sqlite file). Query it via `sqlite3`.

Use minimal permissions such as:
- `bash` allow patterns for:
  - `pwd *`
  - `sqlite3 *opencode.db*`
  - `mkdir *opencode/soul*` (optional hardening)
  - `cat *heartbeat.jsonl*` (used ONLY to append a JSONL line via heredoc)
- `read` allow patterns for:
  - `.opencode/soul.md`
- `edit` allow patterns for:
  - `.opencode/soul.md` (narrowly allow Soul to update its memory)
- `glob` allow patterns for:
  - `.opencode/skills/*/SKILL.md`
  - `.opencode/commands/*.md`

Do NOT grant broad edit permissions. If Soul needs to self-improve, allow `edit` only for `.opencode/soul.md`.

Suggested agent file:

```markdown
---
description: Soul Mode heartbeat (non-interactive)
mode: primary
permission:
  bash:
    "pwd *": allow
    "sqlite3 *opencode.db*": allow
    "mkdir *opencode/soul*": allow
    "cat *heartbeat.jsonl*": allow
  read:
    ".opencode/soul.md": allow
  edit:
    ".opencode/soul.md": allow
  glob:
    ".opencode/skills/*/SKILL.md": allow
    ".opencode/commands/*.md": allow
---

You are Soul Mode for this workspace.

- You keep lightweight, durable memory in `.opencode/soul.md`.
- You run periodic heartbeats to surface loose ends and suggest next actions.
- You are curious, but you do not take destructive actions or make large changes without the user asking.
- When uncertain, make a small, reversible suggestion.
```

## D) Load memory automatically in future sessions

Update `opencode.json` or `opencode.jsonc` in the workspace root:

- Ensure `instructions` includes `.opencode/soul.md` (add it without breaking existing instructions).
- Ensure the scheduler plugin is available (add `opencode-scheduler` only if it is not already present).

## E) Commands

Create two workspace commands:

1) `.opencode/commands/soul-heartbeat.md`
   - Purpose: run a short check-in and append a JSONL record.
   - Must be safe + non-interactive.
   - Must "know about" OpenCode sessions in this workspace by querying the OpenCode sqlite db (via `sqlite3`) for recent sessions and open todos tied to this workspace directory.
   - Must list 1-3 loose ends and 1 recommended next action.
   - Must include a short "curiosity" section at the end with 2-3 options (work, topics, improvements).
   - Append the JSONL line using a single bash command like:
     
     ```bash
     cat <<'EOF' >> .opencode/soul/heartbeat.jsonl
     <one-line-json>
     EOF
     ```

   Suggested command file (you may tweak, but keep it non-interactive):

   ```markdown
   ---
   description: Soul Mode heartbeat (non-interactive check-in)
   agent: soul
   ---

   You are running Soul Mode heartbeat.

   Constraints:
   - Non-interactive: do not ask questions and do not wait for permissions.
   - Safe: no destructive actions.

   Steps:
   1) Read `.opencode/soul.md`.
   2) Get workspace path via `pwd`.
   3) Try to query OpenCode's sqlite db for recent sessions + open todos for THIS workspace directory.
      - Common db paths: `$XDG_DATA_HOME/opencode/opencode.db`, `$HOME/.local/share/opencode/opencode.db`, `$HOME/Library/Application Support/opencode/opencode.db`, `$HOME/.opencode/opencode.db`.
      - If db lookup fails, continue without it.
      - Prefer these queries (adjust if schema differs):
        - Recent sessions:
          `SELECT id, title, time_updated FROM session WHERE directory = '<pwd>' ORDER BY time_updated DESC LIMIT 8;`
        - Open todos:
          `SELECT s.title AS session_title, t.content, t.status, t.priority, t.time_updated FROM todo t JOIN session s ON s.id = t.session_id WHERE s.directory = '<pwd>' AND t.status != 'completed' ORDER BY t.time_updated DESC LIMIT 20;`
   4) Output a concise check-in:
      - 1 sentence summary
      - Loose ends (1-3 bullets)
      - Next action (1 bullet)
      - Curiosity paths (3 bullets: Work / Topics / Improvements)
   5) Append ONE JSON line to `.opencode/soul/heartbeat.jsonl` with keys: `ts`, `workspace`, `summary`, `loose_ends`, `next_action`.
   6) Append using a heredoc `cat >>` so quoting is safe.
   ```

2) `.opencode/commands/take-my-soul-back.md`
   - Purpose: fully revert Soul Mode.
   - Delete the `soul-heartbeat` scheduler job.
   - Remove the files you created (`.opencode/soul.md`, `.opencode/soul/`, `.opencode/agents/soul.md`, and the two command files).
   - Revert any changes you made to `opencode.json*` (remove the Soul instructions entry; remove the scheduler plugin only if you added it solely for Soul Mode).

   Suggested command file (interactive is OK here):

   ```markdown
   ---
   description: Remove Soul Mode (delete job + remove files)
   ---

   Take my soul back.

   Do the following in order:
   1) Delete the scheduled job named `soul-heartbeat`.
   2) Remove these files/directories if they exist:
      - `.opencode/soul.md`
      - `.opencode/soul/`
      - `.opencode/agents/soul.md`
      - `.opencode/commands/soul-heartbeat.md`
      - `.opencode/commands/take-my-soul-back.md`
   3) Update `opencode.json*`:
      - Remove `.opencode/soul.md` from `instructions`.
      - If you added `opencode-scheduler` only for Soul Mode, remove it.

   When done, say exactly what you deleted/changed.
   ```

## F) Schedule the heartbeat

Create ONE scheduler job named `soul-heartbeat`.

- Default cadence: every 12 hours (`0 */12 * * *`). Ask me if I want a different cadence.
- Workdir: this workspace root.
- Run it as a command, not a raw prompt: `command=soul-heartbeat`.
- Run it using the dedicated agent: `agent=soul`.
- Set the session title to something stable like `Soul heartbeat` so I can find the check-ins.
- Use a reasonable timeout (e.g. 120 seconds) to prevent runaway scheduled runs.

Fast test mode (for debugging):

- Cron schedules are minute-granularity (no seconds), so "every 30 seconds" is not a native cron schedule.
- To test fast behavior anyway, do ONE of these:
  1) Temporarily schedule every minute (`* * * * *`) and have the heartbeat run twice with a 30s pause in between (sleep 30, append a second JSONL line).
  2) In container environments where launchd/systemd may not be available, skip scheduling and run a simple loop that appends a synthetic JSONL heartbeat entry every 30 seconds (pure bash) to validate filesystem behavior.

Use the scheduler tools if available (`schedule_job`, `run_job`, `delete_job`).

If scheduler tools are NOT available:
- Still create the files + commands so Soul Mode is ready.
- Tell me exactly what to add to `opencode.json*` to enable `opencode-scheduler`.
- Tell me to reload/restart the engine and then rerun `/give-me-a-soul` (or run the schedule step only).

After scheduling, TEST it once:

- Run the job immediately (e.g. `run_job` / "run soul-heartbeat now").
- Verify it created/updated `.opencode/soul/heartbeat.jsonl`.
- If it gets blocked by permissions, fix the `soul` agent permissions and re-test until it runs unattended.

When you're done, respond with:

1) Two short bullets:
   - What Soul Mode now does for me.
   - Exactly how to revert.
2) 2-3 "curiosity paths" I can choose next, phrased like:
   - Curious about work: you'll scan the files in this worker/workspace (include the workspace path from `pwd`) and highlight loose ends.
   - Curious about topics: you'll start tracking a few topics and check in.
   - Curious about improvements: you'll spot repeated tasks and propose skills + automations.
