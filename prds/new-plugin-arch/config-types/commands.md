# Commands Data Structure

## Source formats to support

Source: `https://opencode.ai/docs/commands/`

OpenCode commands can come from:

- markdown files in `.opencode/commands/`
- JSON config under `command` in `opencode.json`

For markdown commands:

- filename becomes the command name
- file body becomes the template

Recognized command fields from the config schema:

- `template` required
- `description` optional
- `agent` optional
- `model` optional
- `subtask` optional

Runtime template features are part of the content rather than top-level fields:

- `$ARGUMENTS`, `$1`, `$2`, etc.
- shell injection like `!\`command\``
- file references like `@path/to/file`

## Canonical storage recommendation

### Shared tables

- `config_object`
- `config_object_version`

### Current projection table

Add:

- `config_object_command_current`

Suggested columns:

- `config_object_id`
- `command_name`
- `description` nullable
- `template_text`
- `default_agent` nullable
- `model` nullable
- `subtask` nullable
- `source_format` (`markdown`, `json`, `connector`)
- `uses_arguments` boolean
- `uses_shell_injection` boolean
- `uses_file_references` boolean

## Raw version storage

Each version should preserve:

- raw markdown or raw JSON source
- parsed command config JSON
- raw template text

## Search and title strategy

Friendly title strategy:

- use the command name derived from filename or JSON key

Description strategy:

- use explicit `description` when present
- if missing, optionally derive a short summary from the first sentence of `template_text` for dashboard display only

Search should hit current command rows, not version history.

## Why a command-specific table helps

Commands are structurally simple, but users will likely want to filter by:

- target agent
- whether the command runs as a subtask
- whether the template uses arguments or shell injection

These are current-state concerns, so a small projection table is enough.

## Table recommendation summary

- shared backbone: `config_object`, `config_object_version`
- type projection: `config_object_command_current`
