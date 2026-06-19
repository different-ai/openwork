---
name: create-plugin
description: "Create an OpenCode plugin for OpenWork. Scaffolds the plugin file with the correct API shape, tool definitions, and hook registration. Use when the user asks to 'create a plugin', 'write a plugin', or 'make a plugin that does X'."
---

# Skill: Create an OpenCode Plugin

Scaffold a working OpenCode plugin for use in OpenWork.

## When to use

- User asks "create a plugin that does X"
- User asks "write a plugin" or "make a plugin"
- User wants to extend OpenWork/OpenCode with custom tools

## Plugin API

An OpenCode plugin is an **async factory function** that returns a **hooks object**.

### File location

Plugins can live in:
- **Project**: `.opencode/plugins/my-plugin.ts` (auto-discovered)
- **Global**: `~/.config/opencode/plugins/my-plugin.ts`
- **npm**: published as a package, referenced in `opencode.json` `plugin` array
- **URL**: `file:` or `https:` path in the `plugin` array

### Minimal shape

```typescript
import { z } from "zod";

export default async () => ({
  tool: {
    my_tool_name: {
      description: "What this tool does.",
      args: z.object({
        input: z.string().describe("The input parameter."),
      }).shape,   // NOTE: .shape, not the ZodObject itself
      async execute(args: { input: string }) {
        // Your logic here. Can use fetch(), fs, child_process, etc.
        return `Result: ${args.input}`;
      },
    },
  },
});
```

### Key rules

1. **Export default an async function** that returns the hooks object.
2. **Tool args use `zodSchema.shape`** (a `ZodRawShape`), not the `ZodObject`.
3. **`execute` returns a `string`** or `{ output: string; metadata?: Record<string, unknown> }`.
4. **Tools are declared, not registered imperatively** — return them in the hooks object.
5. **`fetch()` works** — plugins run in-process inside the OpenCode runtime.
6. **`process.env` is accessible** — use env vars for secrets/config.

### Available hooks

```typescript
{
  // Modify the system prompt
  "experimental.chat.system.transform": async (input, output: { system: string[] }) => {
    output.system.push("Extra instruction for the agent.");
  },

  // Define tools the agent can call
  tool: {
    tool_name: { description, args, execute },
  },

  // Run code before/after a tool executes
  "tool.execute.before": async ({ tool, args }) => { /* ... */ },
  "tool.execute.after": async ({ tool, args, result }) => { /* ... */ },

  // React to lifecycle events
  event: async ({ event }) => { /* ... */ },
}
```

### Registering the plugin

Add to `opencode.json`:
```json
{
  "plugin": [
    ".opencode/plugins/my-plugin.ts"
  ]
}
```

Or install from npm:
```json
{
  "plugin": [
    "my-published-plugin"
  ]
}
```

## Anthropic / Claude plugin compatibility

OpenCode plugins are **NOT** the same as Anthropic's plugin format. Key differences:

| Aspect | OpenCode Plugin | Anthropic Plugin |
|--------|----------------|-----------------|
| Entry point | Async factory function | Manifest JSON |
| Tool args | Zod schema `.shape` | JSON Schema |
| Runtime | In-process (Bun/Node) | Sandboxed container |
| Auth | `process.env` | OAuth/API key in manifest |
| Distribution | npm / file path / URL | Anthropic marketplace |

To adapt an Anthropic plugin for OpenCode:
1. Rewrite the tool definitions using Zod instead of JSON Schema.
2. Move any auth from the manifest to env vars or `opencode.json` provider config.
3. Export the async factory function instead of the manifest.
4. HTTP-based Anthropic plugins can often be wrapped as MCP servers instead.

## Example: plugin with multiple tools

```typescript
import { z } from "zod";

export default async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push("You have access to a note-taking system. Use save_note and list_notes.");
  },
  tool: {
    save_note: {
      description: "Save a note with a title and body.",
      args: z.object({
        title: z.string().describe("Note title"),
        body: z.string().describe("Note content"),
      }).shape,
      async execute(args: { title: string; body: string }) {
        const fs = await import("node:fs/promises");
        const path = `.opencode/notes/${args.title.replace(/[^a-zA-Z0-9-_]/g, "_")}.md`;
        await fs.mkdir(".opencode/notes", { recursive: true });
        await fs.writeFile(path, `# ${args.title}\n\n${args.body}\n`);
        return `Saved note: ${path}`;
      },
    },
    list_notes: {
      description: "List all saved notes.",
      args: {},
      async execute() {
        const fs = await import("node:fs/promises");
        try {
          const files = await fs.readdir(".opencode/notes");
          return files.filter(f => f.endsWith(".md")).join("\n") || "No notes yet.";
        } catch {
          return "No notes yet.";
        }
      },
    },
  },
});
```

## Scaffold workflow

When the user describes what they want the plugin to do:

1. Create `.opencode/plugins/<name>.ts` with the plugin code.
2. Add it to `opencode.json` `plugin` array if not already present.
3. Tell the user to restart their session for the plugin to load.
