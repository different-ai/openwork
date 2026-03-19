# Browser Entry Button

**Branch:** `feat/browser-entry-button`
**Priority:** P1

---

## Goal

Add a single entry button in the empty chat state that triggers browser automation setup via OpenCode command.

---

## Implementation

### Location
`packages/app/src/app/pages/session.tsx` L1025-1037

### Code references
- Empty state render: `packages/app/src/app/pages/session.tsx:1039-1049`
- Command runner used by slash commands: `packages/app/src/app/pages/session.tsx:645-663` (`runOpenCodeCommand`)
- Command registry wiring: `packages/app/src/app/pages/session.tsx:881-892`
- Programmatic command execution: `packages/app/src/app/command-state.ts:293-313`
- `.opencode/commands` loader: `packages/app/src/app/command-state.ts:334`
- Existing button pattern: `packages/app/src/app/pages/dashboard.tsx:557` (`onClick={() => props.runCommand(command)}`)
- Command write API (desktop): `packages/app/src/app/lib/tauri.ts:223` (`opencodeCommandWrite`)
- Frontmatter parser: `packages/app/src/app/utils/index.ts:271` (`parseTemplateFrontmatter`)

### Current empty state
```tsx
<Show when={props.messages.length === 0}>
  <div class="text-center py-16 px-6 space-y-6">
    <h3 class="text-xl font-medium">Start a conversation</h3>
    <p class="text-gray-10 text-sm">Describe what you want to do...</p>
  </div>
</Show>
```

### Add button
```tsx
<Show when={props.messages.length === 0}>
  <div class="text-center py-16 px-6 space-y-6">
    <div class="w-16 h-16 bg-gray-2 rounded-3xl mx-auto flex items-center justify-center border border-gray-6">
      <Zap class="text-gray-7" />
    </div>
    <div class="space-y-2">
      <h3 class="text-xl font-medium">What do you want to do?</h3>
      <p class="text-gray-10 text-sm max-w-sm mx-auto">
        Pick a starting point or just type below.
      </p>
    </div>
    <div class="flex justify-center">
      <button
        type="button"
        class="px-4 py-2.5 rounded-xl border border-gray-6 bg-gray-2 text-sm text-gray-12 hover:bg-gray-3 hover:border-gray-7 transition-all"
        onClick={() => {
          void (async () => {
            const command = await ensureBrowserSetupCommand();
            if (command) {
              runOpenCodeCommand(command);
            }
          })();
        }}
      >
        Automate your browser
      </button>
    </div>
  </div>
</Show>
```

**Why `runOpenCodeCommand`**
- It handles `$ARGUMENTS` and opens the command run modal when needed (`session.tsx:645-663`)
- Keeps behavior identical to slash commands

### Create OpenCode command
File: `.opencode/commands/browser-setup.md`

**App template source:** `packages/app/src/app/data/commands/browser-setup.md`

If the command is missing in the active workspace, the button auto-writes it via `opencodeCommandWrite` (desktop only) before running.

```markdown
---
name: browser-setup
description: Guide user through Chrome browser automation setup
---

Help the user set up browser automation.

1. Ask: "Do you have Chrome installed on this computer?"
2. If they say no or are unsure, guide them to install Chrome
3. If yes, check if browser MCP/plugin is available
4. If not available, guide them to install the OpenCode browser extension
5. Once setup is complete, offer to run a simple first task (e.g., "Let's try opening a webpage")
```

---

## Flow (handled by LLM)

1. User clicks "Automate your browser"
2. Command triggers, LLM asks: "Do you have Chrome installed?"
3. User answers Yes/No
4. LLM guides through extension install if needed
5. LLM offers first browser task

---

## NOT doing

- Custom guided prompts in the UI
- Multiple entry buttons (start with one)
- Hardcoded installation scripts
