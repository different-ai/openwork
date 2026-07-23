---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create or update a skill that extends OpenCode with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill is a template + checklist for creating skills in a workspace.

## What is a skill?

A skill is a folder under `.opencode/skills/<skill-name>/` or `.claude/skills/<skill-name>/` anchored by `SKILL.md`.

## OpenWork authoring contract

1. Read the runtime Connect instruction before choosing a destination.
2. If it says OpenWork Cloud is verified ready, Cloud is the default and authoritative destination. Do not write the skill to `.opencode/skills/`.
3. Search OpenWork Cloud capabilities with 2-4 variants for existing plugins/skills, available marketplaces, the create-plugin operation, and the resolved plugin or marketplace detail operation. Use only exact capability names returned by search.
4. If a remote skill with the same name or purpose exists, do not create a duplicate. Ask whether to use or update it, or choose a distinct name.
5. Draft the complete `SKILL.md` in memory. Validate its frontmatter, matching name, trigger-oriented description, instructions, examples, permissions, and absence of secrets before sending it.
6. Create one Cloud plugin with one skill component whose `input.rawSourceText` is the complete validated `SKILL.md`. Set `orgWide` and `marketplaceId` only after confirming the user's requested visibility and target marketplace.
7. Read back the created plugin or resolved marketplace detail. Verify the plugin and skill config-object IDs, stored skill name, marketplace, and access visibility before reporting success.
8. If Cloud returns a validation, authorization, or persistence error, report that error and the required action. Do not silently fall back to a local file.
9. Use `.opencode/skills/<skill-name>/SKILL.md` only when Cloud is not verified ready or the user explicitly requests a workspace-local skill. Before writing locally, inspect `.opencode/skills/` and `.claude/skills/`, update an existing path instead of duplicating it, and re-read the final file.
10. Never create both Cloud and local copies in one flow.

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

1. Choose one destination from the verified runtime state: OpenWork Cloud first, local only as the explicit or unavailable-Cloud fallback.
2. Start with a clear purpose statement: when to use it + what it outputs.
3. Specify inputs/outputs and any required permissions.
4. Include “Setup” steps if the skill needs local tooling.
5. Add examples: at least 2 realistic user prompts.
6. Keep it safe: avoid destructive defaults; ask for confirmation.
7. For Cloud creation, validate before execution and verify the persisted plugin/config object after execution. For an explicitly local skill, finish by writing and re-reading exactly one `SKILL.md`.
