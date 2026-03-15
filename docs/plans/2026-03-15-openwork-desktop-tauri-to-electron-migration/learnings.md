# Learnings

Before any agent starts a step in `steps.json`, it must read this file from top to bottom.

After an agent finishes a step:

- If it discovered any durable, non-obvious, migration-relevant information, prepend a new entry to the top of this file.
- If there are no meaningful new learnings, leave this file unchanged.

Entry format:

```md
## YYYY-MM-DD HH:MM - Step XXX - Short title

- Learning 1
- Learning 2
- Any important constraint, gotcha, or follow-up note
```

Guidance:

- Keep newest entries at the top, directly under this instruction block.
- Record only things that will help later agents avoid mistakes or duplicate investigation.
- Do not log routine status updates here; only reusable learnings.

---

## 2026-03-15 10:20 - Step 001 - Freeze canonical migration docs

- Treat the migration bundle as four linked artifacts: the program plan, the Electron contract, the execution queue, and the shared learnings log.
- When a later step changes migration scope or desktop contract semantics, update both canonical plan docs and keep the execution folder README pointing at them so subagents can find the right source of truth quickly.

No learnings recorded yet.
