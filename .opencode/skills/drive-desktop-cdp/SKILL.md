---
name: drive-desktop-cdp
description: Drive a running OpenWork desktop window over CDP from the shell. Evaluate JS, take screenshots, open a new session, send a prompt with a chosen model, wait for the run to finish. Use when checking a UI change by hand in a world or pnpm dev, or when reproducing a chat state.
---

# Drive the desktop window over CDP

For verdicts, write or run an `evals/specs` test (`write-a-spec`, `run-tests`). This skill is for checking changes by hand and reproducing states quickly.

## Find the window

- `pnpm dev`: CDP on `http://127.0.0.1:9823` (the default).
- A world: `node evals/bin/world.mjs up live-desktop -- --allow-shared-state` prints `cdp http://127.0.0.1:<port>`. Vite edits hot-reload into it.

Set `CDP_URL` to that address for every command.

## Commands

```bash
S=.opencode/skills/drive-desktop-cdp/scripts/cdp.mjs
export CDP_URL=http://127.0.0.1:55322

node $S new-session                                 # always start a fresh session first
node $S send "Claude Opus 5.5" "Say hello"          # pick the model by its picker name, then send
node $S wait-idle 180                               # until the Run task button is back
node $S shot /tmp/after.png                         # screenshot of the whole window
node $S eval 'document.querySelector("main")?.innerText.slice(-500)'
```

## Rules

- Never type into an existing session: run `new-session` first. The app can switch sessions on its own between commands.
- A world started with `--allow-shared-state` uses your real config and history. Anything you send is real.
- Reload after state-heavy changes: `node $S eval 'location.reload(); 1'`.
- Read stored v2 history when the UI hides something: `sqlite3 ~/.config/openwork/opencode-v2/state/opencode.db "select type, substr(data,1,300) from session_message where session_id='<id>' order by seq"`.
