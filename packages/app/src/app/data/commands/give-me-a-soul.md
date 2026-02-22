---
name: give-me-a-soul
description: Enable optional Soul Mode (persistent memory + heartbeat + steering commands + easy revert)
---

Give me a soul.

Outcome: you remember my goals and preferences across sessions, run lightweight check-ins, and surface concrete self-improvements I can observe.
Tradeoff: extra autonomy means occasional background runs and occasional wrong assumptions.

Set this up in this workspace as optional Soul Mode using OpenCode primitives only (commands, agents, scheduler, workspace files).

Requirements:
1) Ask me for confirmation (explicit "yes") before creating files or scheduling jobs.
2) Keep it simple, safe, and reversible.
3) Persist in workspace-local files under `.opencode/`.
4) Scheduled runs must be non-interactive (no waiting for permission prompts).
5) Keep user-facing explanations focused on outcomes and controls; keep session/sql internals in agent logic unless I ask for debugging details.

After I confirm, implement Soul Mode by doing ALL of the following in THIS workspace:

## A) Bootstrap from real context first (do this before writing memory)

Collect context from:
- `pwd` (workspace path)
- existing `.opencode/soul.md` (if present)
- `AGENTS.md` (and `_repos/openwork/AGENTS.md` if it exists)
- OpenCode sqlite db via `sqlite3` for this workspace directory:
  - recent sessions
  - open todos
  - recent transcript text snippets (from `part` + `message` tables)

Use this context to seed memory with non-empty, actionable bullets (do not leave everything blank).

If sqlite lookup fails, continue with file context and mention degraded mode.

## B) Persistent memory

Create or refresh `.opencode/soul.md` as human-editable memory.

- Keep it short, structured, and concrete.
- Include a `Last updated` line (ISO-8601 timestamp).
- Include sections:
  - Goals
  - Preferences (tone, format, boundaries)
  - Current focus
  - Loose ends
  - Recurring chores / automations to consider
- Seed at least one bullet in `Current focus` and `Loose ends` using the bootstrap context.

Suggested structure:

```markdown
# Soul Memory

Last updated: <ISO-8601 timestamp>

## Goals
- <1-3 concrete goals>

## Preferences
- <tone/format/boundary preference>

## Current focus
- <current initiative>

## Loose ends
- <unfinished thread>

## Recurring chores / automations to consider
- <repeatable task worth automating>
```

## C) Heartbeat log (observability)

Create `.opencode/soul/heartbeat.jsonl` (create directory/file if missing).

- Append exactly ONE JSON object per heartbeat run (one line per run).
- Minimum keys: `ts`, `workspace`, `summary`, `loose_ends`, `next_action`.
- Prefer adding these extra keys for observability when available: `session_titles`, `open_todo_count`, `signals`, `improvements`.

## D) Dedicated Soul agent (for unattended runs)

Create `.opencode/agents/soul.md` (primary agent).

Goals:
1) Behavior: close loops from unfinished work, keep check-ins concise, prioritize reversible improvements.
2) Permissions: allow only what heartbeat/steering needs; avoid broad write access.

Important: do NOT read `opencode.db` via `read`; query it via `sqlite3`.

Use narrow permissions like:
- `bash` allow patterns:
  - `pwd`
  - `pwd *`
  - `sqlite3 *opencode.db*`
  - `mkdir *opencode/soul*`
  - `cat *heartbeat.jsonl*`
- `read` allow patterns:
  - `.opencode/soul.md`
  - `.opencode/soul/heartbeat.jsonl`
  - `AGENTS.md`
  - `_repos/openwork/AGENTS.md`
- `edit` allow patterns:
  - `.opencode/soul.md`
- `glob` allow patterns:
  - `.opencode/skills/*/SKILL.md`
  - `.opencode/commands/*.md`

Do NOT grant broad edit permissions.

Suggested agent file:

```markdown
---
description: Soul Mode heartbeat + steering (non-interactive heartbeat)
mode: primary
permission:
  bash:
    "*": deny
    "pwd": allow
    "pwd *": allow
    "sqlite3 *opencode.db*": allow
    "mkdir *opencode/soul*": allow
    "cat *heartbeat.jsonl*": allow
  read:
    "*": deny
    ".opencode/soul.md": allow
    ".opencode/soul/heartbeat.jsonl": allow
    "AGENTS.md": allow
    "_repos/openwork/AGENTS.md": allow
  edit:
    "*": deny
    ".opencode/soul.md": allow
  glob:
    "*": deny
    ".opencode/skills/*/SKILL.md": allow
    ".opencode/commands/*.md": allow
---

You are Soul Mode for this workspace.

- Keep durable memory in `.opencode/soul.md`.
- Use heartbeats to surface loose ends and concrete next actions.
- Use recent sessions/todos/transcripts + AGENTS guidance to suggest improvements.
- Stay safe and reversible; no destructive actions unless explicitly requested.
```

## E) Load memory automatically

Update `opencode.json` or `opencode.jsonc` in the workspace root:

- Ensure `instructions` includes `.opencode/soul.md` (without breaking existing entries).
- Ensure scheduler plugin is available (add `opencode-scheduler` only if missing).

## F) Commands

Create FOUR workspace commands:

1) `.opencode/commands/soul-heartbeat.md`
   - Purpose: non-interactive check-in + JSONL append.
   - Must read `.opencode/soul.md`, AGENTS guidance, and query sqlite for this workspace.
   - Must look at:
     - recent sessions (`session`)
     - open todos (`todo` + `session`)
     - recent text transcript snippets (`part` + `message` + `session` where part type is text)
   - Output:
     - one-sentence summary
     - 1-3 loose ends
     - one next action
     - 2-3 improvement suggestions (process/skills/agents)
   - Append one JSON line to `.opencode/soul/heartbeat.jsonl` using one heredoc `cat >>` command.

   Suggested command file:

   ```markdown
   ---
   description: Soul Mode heartbeat (non-interactive)
   agent: soul
   ---

   You are running Soul Mode heartbeat.

   Constraints:
   - Non-interactive: do not ask questions.
   - Safe: no destructive actions.

   Steps:
   1) Read `.opencode/soul.md`.
   2) Read `AGENTS.md` (and `_repos/openwork/AGENTS.md` if present).
   3) Get workspace path via `pwd`.
   4) Query OpenCode sqlite db for this workspace directory (if available):
      - Recent sessions:
        `SELECT id, title, time_updated FROM session WHERE directory = '<pwd>' ORDER BY time_updated DESC LIMIT 8;`
      - Open todos:
        `SELECT s.title, t.content, t.status, t.priority, t.time_updated FROM todo t JOIN session s ON s.id = t.session_id WHERE s.directory = '<pwd>' AND t.status != 'completed' ORDER BY t.time_updated DESC LIMIT 20;`
      - Recent transcript text:
        `SELECT s.title, p.time_updated, json_extract(p.data, '$.text') AS text FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = m.session_id WHERE s.directory = '<pwd>' AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_updated DESC LIMIT 60;`
      - If db lookup fails, continue in degraded mode.
   5) Optionally refresh `.opencode/soul.md` with small, deduped updates to Loose ends / Recurring chores when justified by evidence.
   6) Output concise check-in:
      - Summary (1 sentence)
      - Loose ends (1-3 bullets)
      - Next action (1 bullet)
      - Improvements (2-3 bullets)
   7) Append one JSON line with keys: `ts`, `workspace`, `summary`, `loose_ends`, `next_action` (and optional observability keys).

   Append using one heredoc command:

       cat <<'EOF' >> .opencode/soul/heartbeat.jsonl
       {"ts":"...","workspace":"...","summary":"...","loose_ends":["..."],"next_action":"..."}
       EOF

   ```

2) `.opencode/commands/soul-status.md`
   - Purpose: read-only status report for observability.
   - Read `.opencode/soul.md` + latest heartbeat entries + scheduler job state.
   - Output: current focus, latest heartbeat age, top loose ends, next action.

3) `.opencode/commands/steer-soul.md`
   - Purpose: interactive steering.
   - Can update current focus, boundaries/preferences, and heartbeat cadence.
   - If user gives explicit values in the prompt, apply directly.
   - If cadence changes, update the `soul-heartbeat` scheduler job.
   - Always summarize exactly what changed.

4) `.opencode/commands/take-my-soul-back.md`
   - Purpose: full revert.
   - Delete scheduler job `soul-heartbeat`.
   - Remove files created for Soul Mode:
     - `.opencode/soul.md`
     - `.opencode/soul/`
     - `.opencode/agents/soul.md`
     - `.opencode/commands/soul-heartbeat.md`
     - `.opencode/commands/soul-status.md`
     - `.opencode/commands/steer-soul.md`
     - `.opencode/commands/take-my-soul-back.md`
   - Revert `opencode.json*` changes you made:
     - remove `.opencode/soul.md` from `instructions`
     - remove `opencode-scheduler` only if added solely for Soul Mode

## G) Schedule the heartbeat

Create one scheduler job named `soul-heartbeat`.

- Default cadence: every 12 hours (`0 */12 * * *`). Ask me if I want a different cadence.
- Workdir: workspace root.
- Run as command: `command=soul-heartbeat`.
- Run with dedicated agent: `agent=soul`.
- Use stable title like `Soul heartbeat`.
- Use timeout around 120s.

Use scheduler tools if available (`schedule_job`, `run_job`, `delete_job`).

If scheduler tools are unavailable:
- still create files + commands,
- tell me exact `opencode.json*` changes needed,
- tell me to reload/restart engine and rerun this setup.

After scheduling, test once:
- run the job immediately,
- verify `.opencode/soul/heartbeat.jsonl` got a new entry,
- if blocked by permissions, tighten/fix agent permissions and rerun until unattended.

## H) Final response format

When done, respond with:

1) Two short bullets:
   - what Soul Mode now does,
   - exactly how to revert.
2) One short "How to interact" list including:
   - `/soul-status`
   - `/steer-soul`
   - `run soul-heartbeat now`
3) 2-3 curiosity paths:
   - Curious about work
   - Curious about topics
   - Curious about improvements
