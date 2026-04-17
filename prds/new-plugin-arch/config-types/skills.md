# Skills Data Structure

## Source formats to support

We should support both OpenCode-native and Claude-compatible skill formats.

### OpenCode skill shape

Source: `https://opencode.ai/docs/skills/`

Expected file layout:

- directory name is the skill name
- entry file is always `SKILL.md`

Recognized frontmatter fields in OpenCode:

- `name` required
- `description` required
- `license` optional
- `compatibility` optional
- `metadata` optional string-to-string map

Important OpenCode constraints:

- `name` must match the containing directory name
- `name` is lowercase alphanumeric with single hyphen separators
- `description` is 1-1024 chars

### Claude-compatible skill shape

Sources:

- `https://code.claude.com/docs/en/skills`
- OpenCode also discovers `.claude/skills/*/SKILL.md`

Claude-compatible frontmatter can additionally include:

- `when_to_use`
- `argument-hint`
- `disable-model-invocation`
- `user-invocable`
- `allowed-tools`
- `model`
- `effort`
- `context`
- `agent`
- `hooks`
- `paths`
- `shell`

Claude also supports supporting files alongside `SKILL.md` inside the skill directory.

## Canonical storage recommendation

### Shared tables

Use the shared tables from `prds/new-plugin-arch/datastructure.md`:

- `config_object`
- `config_object_version`

### Current projection table

Add a skill-specific current projection table:

- `config_object_skill_current`

This lets us query current skill-specific metadata without hitting historical versions.

Suggested columns:

- `config_object_id`
- `dialect` (`opencode`, `claude`, `hybrid`)
- `skill_name`
- `description`
- `license` nullable
- `compatibility` nullable
- `metadata_json` nullable
- `when_to_use` nullable
- `argument_hint` nullable
- `disable_model_invocation` nullable
- `user_invocable` nullable
- `allowed_tools_json` nullable
- `model` nullable
- `effort` nullable
- `context_mode` nullable
- `subagent` nullable
- `hooks_json` nullable
- `paths_json` nullable
- `shell` nullable
- `has_supporting_files` boolean
- `body_markdown` optional if we want a denormalized current copy for fast preview

## Raw version storage

Each `config_object_version` for a skill should preserve:

- raw `SKILL.md` content
- parsed frontmatter JSON
- parsed body markdown
- parser dialect used
- extraction status / warnings if parsing was partial

If the source came from a connector-backed skill directory, keep path data so we can recreate:

- `SKILL.md` relative path
- skill directory path
- any supporting file paths via connector source records

## Search and title strategy

For skills, current search should hit:

- `config_object.title`
- `config_object.description`
- optionally `config_object.search_text`
- optionally `config_object_skill_current.when_to_use`

Friendly title strategy:

- prefer frontmatter `name`
- if missing in Claude-compatible input, fall back to directory name

Description strategy:

- prefer frontmatter `description`
- optionally append `when_to_use` into `search_text`, but do not necessarily surface it as the main dashboard description

## Why a skill-specific table helps

Skills have the richest frontmatter of any planned type.

A dedicated table helps with:

- filtering skills by invocation mode
- showing whether a skill is user-invocable vs model-invocable
- showing bound model / effort / subagent behavior
- preserving compatible subsets across OpenCode and Claude skill formats

## Table recommendation summary

- shared backbone: `config_object`, `config_object_version`
- type projection: `config_object_skill_current`
- connector path history: `connector_source_binding`, `connector_source_tombstone`
