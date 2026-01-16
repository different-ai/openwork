---
name: solidjs-patterns
description: SolidJS reactivity + UI state patterns for OpenWork
---

## Why this skill exists

OpenWork’s UI is SolidJS: it updates via **signals**, not React-style rerenders.
Most “UI stuck” bugs are actually **state coupling** bugs (e.g. one global `busy()` disabling an unrelated action), not rerender issues.

This skill captures the patterns we want to consistently use in OpenWork.

## Core rules

- Prefer **fine-grained signals** over shared global flags.
- Keep async actions **scoped** (each action gets its own `pending` state).
- Derive UI state via `createMemo()` instead of duplicating booleans.
- Avoid mutating arrays/objects stored in signals; always create new values.

## Scoped async actions (recommended)

When an operation can overlap with others (permissions, installs, background refresh), don’t reuse a global `busy()`.

Use a dedicated signal per action:

```ts
const [replying, setReplying] = createSignal(false);

async function respond() {
  if (replying()) return;
  setReplying(true);
  try {
    await doTheThing();
  } finally {
    setReplying(false);
  }
}
```

### Why

A single `busy()` boolean creates deadlocks:

- Long-running task sets `busy(true)`
- A permission prompt appears and its buttons are disabled by `busy()`
- The task can’t continue until permission is answered
- The user can’t answer because buttons are disabled

Fix: permission UI must be disabled only by a **permission-specific** pending state.

## Signal snapshots in async handlers

If you read signals inside an async function and you need stable values, snapshot early:

```ts
const request = activePermission();
if (!request) return;
const requestID = request.id;

await respondPermission(requestID, "always");
```

## Derived UI state

Prefer `createMemo()` for computed disabled states:

```ts
const canSend = createMemo(() => prompt().trim().length > 0 && !busy());
```

## Lists

- Use setter callbacks for derived updates:

```ts
setItems((current) => current.filter((x) => x.id !== id));
```

- Don’t mutate `current` in-place.

## Practical checklist (SolidJS UI changes)

- Does any button depend on a global flag that could be true during long-running work?
- Could two async actions overlap and fight over one boolean?
- Is any UI state duplicated (can be derived instead)?
- Do event handlers read signals after an `await` where values might have changed?

## References

- SolidJS: https://www.solidjs.com/docs/latest
- SolidJS signals: https://www.solidjs.com/docs/latest/api#createsignal
- SolidJS memos: https://www.solidjs.com/docs/latest/api#creatememo
