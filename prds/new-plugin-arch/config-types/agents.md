# Agents Data Structure

## Source formats to support

Source: `https://opencode.ai/docs/agents/`

OpenCode agents can come from:

- markdown files in `.opencode/agents/`
- JSON config under `agent` in `opencode.json`

For markdown agents:

- filename becomes the agent name
- file body becomes the prompt
- frontmatter provides structured config

Recognized OpenCode agent fields from the config schema:

- `model`
- `variant`
- `temperature`
- `top_p`
- `prompt`
- `tools` deprecated
- `disable`
- `description`
- `mode` (`subagent`, `primary`, `all`)
- `hidden`
- `options`
- `color`
- `steps`
- `maxSteps` deprecated
- `permission`

Important schema behavior:

- unknown keys are allowed and moved into `options`
- legacy `tools` config is converted into permissions
- legacy `maxSteps` is normalized into `steps`

## Canonical storage recommendation

### Shared tables

- `config_object`
- `config_object_version`

### Current projection table

Add:

- `config_object_agent_current`

Suggested columns:

- `config_object_id`
- `agent_name`
- `description`
- `prompt_text`
- `mode`
- `hidden` nullable
- `disabled` nullable
- `model` nullable
- `variant` nullable
- `temperature` nullable
- `top_p` nullable
- `steps` nullable
- `color` nullable
- `permission_json` nullable
- `options_json` nullable
- `legacy_tools_json` nullable
- `source_format` (`markdown`, `json`, `connector`)

## Raw version storage

Each version should preserve:

- raw markdown or raw JSON source
- parsed frontmatter/config JSON
- raw prompt body if markdown-based
- normalized config JSON after alias/deprecation handling if we want auditability

## Search and title strategy

Friendly title strategy:

- use the agent name derived from filename or JSON key

Description strategy:

- use `description` as the primary searchable summary
- if needed, include prompt text in `search_text`, but not as the main title/description fields

Default current search should hit:

- `config_object.title`
- `config_object.description`
- optional `config_object_agent_current.mode`
- optional `config_object_agent_current.model`

## Why an agent-specific table helps

Agents have a configuration-heavy shape with many current-state filters that may matter in UI:

- mode
- model
- hidden/disabled state
- steps cap
- permission summary

Putting these on a type-specific projection table avoids repeated JSON scans.

## Table recommendation summary

- shared backbone: `config_object`, `config_object_version`
- type projection: `config_object_agent_current`
