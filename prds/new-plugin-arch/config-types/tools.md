# Tools Data Structure

## Scope

In this doc, `tool` means a custom OpenCode tool definition, not a built-in native tool like `read` or `bash`.

Source: `https://opencode.ai/docs/tools/` plus `https://opencode.ai/docs/custom-tools/`

## Source formats to support

Custom tools are code modules, usually TypeScript or JavaScript files, placed in:

- `.opencode/tools/`
- `~/.config/opencode/tools/`

Observed tool definition shape from the plugin helper:

- `description` required
- `args` required
- `execute(args, context)` required

The helper type is effectively:

```ts
tool({
  description: string,
  args: ZodRawShape,
  execute(args, context): Promise<string>
})
```

Naming behavior:

- default export -> tool name comes from filename
- multiple named exports -> tool names become `<filename>_<exportname>`

## Canonical storage recommendation

### Shared tables

- `config_object`
- `config_object_version`

### Current projection table

Add:

- `config_object_tool_current`

Suggested columns:

- `config_object_id`
- `tool_name`
- `module_file_name`
- `module_relative_path` nullable
- `export_name` nullable
- `definition_style` (`default_export`, `named_export`)
- `description`
- `args_schema_json` nullable
- `args_schema_text` nullable
- `runtime_language` nullable
- `static_analysis_status`
- `is_multi_tool_module` boolean

## Raw version storage

Each version should preserve:

- raw module source code
- parsed metadata from static analysis if available
- extraction warnings if analysis is partial or failed

## Important design note

Tools are harder to normalize than skills, agents, or commands because the source of truth is executable code.

That means:

- raw code must remain authoritative for reconstruction;
- description and args metadata should be treated as extracted projections;
- extraction may need AST parsing or other static analysis;
- if static analysis fails, the object should still be storable, but may show degraded metadata in the UI.

## Search and title strategy

Friendly title strategy:

- use the final resolved tool name

Description strategy:

- use extracted `description`
- if extraction fails, fall back to file name and a generic label like `Custom tool definition`

## Why a tool-specific table helps

Tools are code-backed and may need UI around:

- resolved tool names
- export style
- argument schema preview
- static analysis health

These are not good candidates for repeated JSON scanning of version history.

## Table recommendation summary

- shared backbone: `config_object`, `config_object_version`
- type projection: `config_object_tool_current`

## Open questions specific to tools

- Do we require successful static analysis before a tool can be published?
- Do we support only JS/TS source at first, or arbitrary-language wrappers as first-class tool objects?
- Do we want to store a JSON Schema projection of args, or only a human-readable summary?
