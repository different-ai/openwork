---
name: create-plugin
description: "Create an OpenCode plugin for OpenWork. Scaffolds the plugin file with the correct API shape, tool definitions, and hook registration. Use when the user asks to 'create a plugin', 'write a plugin', or 'make a plugin that does X'."
---

# Create an OpenCode Plugin

A plugin is a default-exported async factory that returns a hooks object.

## Steps

1. Write `.opencode/plugins/<name>.ts` (project, auto-discovered) or `~/.config/opencode/plugins/<name>.ts` (global).
2. Add it to the `plugin` array in `opencode.json` if missing. npm package names and `file:`/`https:` URLs also work there.
3. Tell the user to restart the session so it loads.

## Shape

```typescript
import { z } from "zod";

export default async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push("You can save notes with save_note.");
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
  },
  "tool.execute.before": async ({ tool, args }) => {},
  "tool.execute.after": async ({ tool, args, result }) => {},
  event: async ({ event }) => {},
});
```

## Rules

- `args` is a Zod raw shape (`z.object({...}).shape`), not the `ZodObject`.
- `execute` returns a string or `{ output: string; metadata?: Record<string, unknown> }`.
- Declare tools in the returned object. There is no imperative registration.
- Plugins run in-process: `fetch`, `fs`, `child_process` and `process.env` work. Read secrets from env.

## Porting an Anthropic plugin

Anthropic plugins are a JSON manifest with JSON Schema tools, run sandboxed, with auth in the manifest. To port one, rewrite the tools with Zod, move auth to env vars or `opencode.json` provider config, and export the factory. HTTP-based ones are often simpler as an MCP server.
