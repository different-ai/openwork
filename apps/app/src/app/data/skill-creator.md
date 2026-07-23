---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create or update a skill that extends OpenCode with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill is a template + checklist for creating skills in a workspace.

## What is a skill?

A skill is a folder under `.opencode/skills/<skill-name>/` or `.claude/skills/<skill-name>/` anchored by `SKILL.md`.

## OpenWork authoring contract

Follow the runtime `Skill creation:` instruction for this workspace/model:

- In Cloud mode, search for a collision, create one validated `SKILL.md` through the exact returned plugin capability, and read back the saved skill.
- In local mode, inspect `.opencode/skills/` and `.claude/skills/`, then write or update exactly one `.opencode/skills/<skill-name>/SKILL.md` and re-read it.
- An explicit user request for a workspace-local skill overrides Cloud mode. Never create both copies.

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

1. Follow the runtime-selected Cloud or local destination and check it for a name or purpose collision.
2. Start with a clear purpose statement: when to use it + what it outputs.
3. Specify inputs/outputs and any required permissions.
4. Include “Setup” steps if the skill needs local tooling.
5. Add examples: at least 2 realistic user prompts.
6. Keep it safe: avoid destructive defaults; ask for confirmation.
7. Validate before creation and verify the result after creation.
