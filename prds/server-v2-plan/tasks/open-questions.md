# Open Questions

Agents should use this file when something needs human clarification but work can continue with a reasonable best guess.

## How To Use This File

- Prepend new entries under `## Open Items` so the newest item stays at the top.
- Record the uncertainty, the best guess, and the expected impact.
- Continue working based on the best guess instead of blocking the phase.
- When a human answers, update the existing entry with the resolution instead of creating a duplicate.

## Suggested Entry Format

```md
### Q-YYYYMMDD-XX - Short title
- Phase:
- Problem:
- Best guess used now:
- Impact if guess is wrong:
- Requested human input:
- Status: open
- Resolution:
```

## Open Items

### Q-20260414-01 - Cloud signin state still lives in browser localStorage
- Phase: 2
- Problem: The current desktop app persists OpenWork Cloud signin state in browser localStorage (`apps/app/src/app/lib/den.ts`), which the standalone/server bootstrap path cannot read directly on disk in a portable way.
- Best guess used now: Server V2 owns the new `cloud_signin` table and can import cloud metadata from an explicit JSON handoff (`OPENWORK_SERVER_V2_CLOUD_SIGNIN_JSON`, `OPENWORK_SERVER_V2_CLOUD_SIGNIN_PATH`, or a future `openwork-cloud-signin.json` snapshot) when one is available; otherwise bootstrap records the source as unavailable and continues.
- Impact if guess is wrong: Later desktop migration work may need a different handoff shape or a direct server-side bridge from the app before existing cloud auth can move fully out of app-owned storage.
- Requested human input: Confirm the preferred Phase 4+ handoff path for current cloud signin state: explicit JSON snapshot, Tauri-to-server handoff command, or a different migration mechanism.
- Status: open
- Resolution:
