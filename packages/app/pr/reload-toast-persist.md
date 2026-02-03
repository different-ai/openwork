# Reload Toast: Persist + Show What Changed

**Branch:** `feat/reload-toast-persist`
**Priority:** P0

---

## Problems

1. Toast disappears before user can click
2. Toast is vague - just says "Reload required" without specifics

---

## Current Code

**File:** `packages/app/src/app/app.tsx` L1799-1834

```tsx
const [reloadToastDismissedAt, setReloadToastDismissedAt] = createSignal<number | null>(null);

const reloadToastVisible = createMemo(() => {
  if (!reloadRequired()) return false;  // <-- Hides when reload not required
  const lastTriggeredAt = reloadLastTriggeredAt();
  const dismissedAt = reloadToastDismissedAt();
  if (!lastTriggeredAt) return true;
  if (!dismissedAt) return true;
  return dismissedAt < lastTriggeredAt;
});
```

### Code findings
- Reload state + reasons live in `packages/app/src/app/system-state.ts:40-45` (`reloadRequired`, `reloadReasons`, `reloadLastTriggeredAt`)
- `markReloadRequired(reason)` only stores the reason string: `packages/app/src/app/system-state.ts:135-139`
- `ReloadReason` is a fixed union: `packages/app/src/app/types.ts:202` (`"plugins" | "skills" | "mcp" | "config"`)
- Tauri watcher emits `openwork://reload-required` with `{ reason, path }`: `packages/desktop/src-tauri/src/workspace/watch.rs:99-124`
- UI listener drops `path` and only maps `reason`: `packages/app/src/app/app.tsx:1870-1902`
- Explicit triggers:
  - Skills/plugins: `packages/app/src/app/context/extensions.ts:526,549,588,669,750`
  - MCP: `packages/app/src/app/app.tsx:2557`
  - Config/model change: `packages/app/src/app/app.tsx:3020,3034`
  - Tool-driven file writes: `packages/app/src/app/context/session.ts:141-193`

---

## Changes Required

### 1. Investigate why toast disappears

Add logging to track state changes:
```tsx
createEffect(() => {
  console.log('[ReloadToast] reloadRequired:', reloadRequired());
  console.log('[ReloadToast] lastTriggeredAt:', reloadLastTriggeredAt());
  console.log('[ReloadToast] dismissedAt:', reloadToastDismissedAt());
});
```

Possible causes:
- `reloadRequired()` becomes false prematurely (auto-reload?)
- Page navigation clears state
- Effect at L1830-1834 clears state

**Other auto-clear sites:**
- `clearReloadRequired()` in `packages/app/src/app/system-state.ts:141-145`
- Successful reload clears state in `packages/app/src/app/system-state.ts:281-282`
- Workspace change clears reload state in `packages/app/src/app/app.tsx:1928-1933`

### 2. Track what triggered the reload

**Update `markReloadRequired` to accept details:**

```tsx
type ReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp";
  name?: string;
};

const [reloadTrigger, setReloadTrigger] = createSignal<ReloadTrigger | null>(null);

const markReloadRequired = (reason: ReloadReason, trigger?: ReloadTrigger) => {
  markReloadRequiredRaw(reason);
  if (trigger) {
    setReloadTrigger(trigger);
  }
};
```

**Note:** There is already a `path` in the Tauri event payload (`workspace/watch.rs:119-121`). We can parse it to a name (skill/plugin) and pass it as `trigger.name`.

### 3. Update toast to show specific change

**File:** `packages/app/src/app/components/reload-workspace-toast.tsx`

Add `trigger` prop:
```tsx
export type ReloadWorkspaceToastProps = {
  // ... existing props
  trigger?: { type: string; name?: string } | null;
};
```

Update description display:
```tsx
const getDescription = () => {
  if (!props.trigger) return props.description;
  const { type, name } = props.trigger;
  switch (type) {
    case "skill":
      return `Skill '${name}' was added. Reload to use it.`;
    case "plugin":
      return `Plugin '${name}' was added. Reload to activate.`;
    case "mcp":
      return `MCP '${name}' was added. Reload to connect.`;
    default:
      return "Config changed. Reload to apply.";
  }
};
```

### 4. Update callers to pass trigger info

Find all places that call `markReloadRequired` and add trigger details:
- When skill is created: `markReloadRequired("skills", { type: "skill", name: skillName })`
- When plugin is added: `markReloadRequired("plugins", { type: "plugin", name: pluginName })`
- When MCP is added: `markReloadRequired("mcp", { type: "mcp", name: mcpName })`

**Concrete hook points:**
- Skills: `packages/app/src/app/context/extensions.ts:588,669,750`
- Plugins: `packages/app/src/app/context/extensions.ts:526,549`
- MCP: `packages/app/src/app/app.tsx:2557`
- Config/model changes: `packages/app/src/app/app.tsx:3020,3034`
- File watcher: `packages/app/src/app/app.tsx:1870-1902` (parse `event.payload.path`)

---

## Toast behavior rules

Toast should ONLY hide when:
1. User clicks "Dismiss"
2. User clicks "Reload" AND reload completes successfully

Toast should NOT auto-hide on:
- Timeout
- Navigation
- Any automatic state change

---

## Testing

1. Create a skill → verify toast shows "Skill 'X' was added"
2. Add a plugin → verify toast shows "Plugin 'X' was added"
3. Change config → verify toast shows "Config changed"
4. Wait 30 seconds → verify toast still visible
5. Click Dismiss → verify toast hides
6. Trigger again → verify toast reappears
