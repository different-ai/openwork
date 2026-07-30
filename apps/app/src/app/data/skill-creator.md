---
name: skill-creator
description: Create or update skills in OpenWork Cloud when available, or locally when requested.
---

# Skill Creator

This skill is a template + checklist for creating skills in a workspace.

## What is a skill?

A local skill is a folder under `.opencode/skills/<skill-name>/` or `.claude/skills/<skill-name>/` anchored by `SKILL.md`. A remote skill is stored in OpenWork Cloud as a plugin skill component.

## OpenWork authoring contract

Follow the runtime `Skill creation:` instruction for this workspace/model:

- `Cloud`: create or update the skill in OpenWork Cloud first when it is available, then follow the remote flow below.
- `Local`: inspect `.opencode/skills/` and `.claude/skills/`, then write or update exactly one `.opencode/skills/<skill-name>/SKILL.md` and re-read it.
- Use the local flow only when the user explicitly requests a workspace-local skill. Do not create both copies. Move an existing local skill to Cloud only when the user explicitly requests migration.

## Remote Cloud flow

Use this flow only when the runtime instruction says `Cloud`:

1. Search OpenWork Cloud with 2-4 variants for existing skills/config objects, plugins, marketplaces, plugin creation, config-object version creation, and read operations. Use only exact capability names returned by search.
2. Resolve exact-name matches before writing: create when none exists, update when one exists and the user requested changes, or ask the user to choose when matches are ambiguous.
3. Draft one complete replacement `SKILL.md` with frontmatter containing a matching `name`, a trigger-oriented `description`, and a non-empty instruction body. Do not include secrets.
4. To create, execute the returned plugin-create capability with one component: `{"type":"skill","input":{"rawSourceText":"<complete SKILL.md>"}}`. Set organization-wide access or a marketplace only when the user requested and confirmed it.
5. To update, execute the returned config-object-version creation capability with the existing `configObjectId` in `path` and `{"input":{"rawSourceText":"<complete SKILL.md>"},"reason":"<short change summary>"}` in `body`. Keep the existing name unless the user requested a rename. Never call plugin-create for an update.
6. Read back the config object or resolved plugin detail. Verify the latest stored name, description, content, IDs, marketplace, and access before reporting success.
7. If Cloud returns an authorization, validation, ambiguity, or persistence error, report it. Do not create a duplicate or silently create a local copy.

## Design goals

- Portable: safe to copy between machines
- Reconstructable: can recreate any required local state
- Self-building: can bootstrap its own config/state
- Credential-safe: no secrets committed; graceful first-time setup

## Recommended structure

```
.opencode/
  skills/
    my-skill/
      SKILL.md
      README.md
      templates/
      scripts/
```

## Trigger phrases (critical)

The description field is how Claude decides when to use your skill.
Include 2-3 specific phrases that should trigger it.

Bad example:
"Use when working with content"

Good examples:
"Use when user mentions 'content pipeline', 'add to content database', or 'schedule a post'"
"Triggers on: 'rotate PDF', 'flip PDF pages', 'change PDF orientation'"

Quick validation:
- Contains at least one quoted phrase
- Uses "when" or "triggers"
- Longer than ~50 characters

## Frontmatter template

```yaml
---
name: my-skill
description: |
  [What it does in one sentence]

  Triggers when user mentions:
  - "[specific phrase 1]"
  - "[specific phrase 2]"
  - "[specific phrase 3]"
---
```

## Authoring checklist

1. Follow the runtime-selected Cloud or local flow.
2. Start with a clear purpose statement: when to use it + what it outputs.
3. Specify inputs/outputs and any required permissions.
4. Include “Setup” steps if the skill needs local tooling.
5. Add examples: at least 2 realistic user prompts.
6. Keep it safe: avoid destructive defaults; ask for confirmation.
7. Validate before creation and verify the result after creation.
