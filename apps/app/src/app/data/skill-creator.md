---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create or update a skill that extends OpenCode with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill is a template + checklist for creating skills in a workspace.

## What is a skill?

A local skill is a folder under `.opencode/skills/<skill-name>/` or `.claude/skills/<skill-name>/` anchored by `SKILL.md`. A remote skill is stored in OpenWork Cloud as a plugin skill component.

## OpenWork authoring contract

Follow the runtime `Skill creation:` instruction for this workspace/model:

- `Cloud`: use the remote flow below. Do not write `.opencode/skills`.
- `Local`: inspect `.opencode/skills/` and `.claude/skills/`, then write or update exactly one `.opencode/skills/<skill-name>/SKILL.md` and re-read it.
- An explicit request for a workspace-local skill overrides Cloud mode. Never create both copies.

## Remote Cloud flow

Use this flow only when the runtime instruction says `Cloud`:

1. Search OpenWork Cloud with 2-4 variants for existing skills/plugins, marketplaces, and the plugin create/read operations. Use only exact capability names returned by search.
2. If the same name or purpose already exists, stop and ask whether to use it, update it, or choose a distinct name.
3. Draft one complete `SKILL.md` with YAML frontmatter containing a matching `name`, a trigger-oriented `description`, and a non-empty instruction body. Do not include secrets.
4. Execute the returned plugin-create capability with one component: `{"type":"skill","input":{"rawSourceText":"<complete SKILL.md>"}}`. Set organization-wide access or a marketplace only when the user requested and confirmed it.
5. Read back the created plugin or resolved marketplace detail. Verify the stored skill name, plugin/config-object IDs, marketplace, and access before reporting success.
6. If Cloud returns an authorization, validation, or persistence error, report it. Do not silently create a local copy.

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
