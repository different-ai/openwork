---
name: principle-touch-only-what-you-own
description: "Apply when starting, reusing, killing, or deleting sessions, sandboxes, worlds, processes, profiles, or logins. Act only on resources you created, by exact ID; start fresh instead of typing into someone's state."
metadata:
  opencode/autoinvoke: "false"
  opencode/slash: "true"
---

# Touch Only What You Own

Every side effect targets something you made, named exactly.

**Why:** Shared machines and accounts hold other people's work. Broad patterns and reused state delete demos, send real messages, and break logins.

- Delete sandboxes and worlds by the exact IDs in your own outputs, never by name pattern.
- Use a unique stage per preview. Reopen a matching world, never silently reset one.
- Run `new-session` before sending. A world with `--allow-shared-state` uses real config; anything sent is real.
- Kill by port or process group, not by process name.
- Never overwrite a person's CLI profile or installed app. Clone release bundles before launching them.
- Ask before machine-wide actions such as cutting Wi-Fi.
