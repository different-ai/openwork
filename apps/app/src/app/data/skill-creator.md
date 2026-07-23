---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create or update a skill that extends OpenCode with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill is a template + checklist for creating skills in a workspace.

## What is a skill?

A skill is a folder under `.opencode/skills/<skill-name>/` or `.claude/skills/<skill-name>/` anchored by `SKILL.md`.

## OpenWork authoring contract

- A request to create a skill in OpenWork chat creates one workspace-local skill by default at `.opencode/skills/<skill-name>/SKILL.md`.
- Before writing, inspect `.opencode/skills/` and `.claude/skills/` for the same name or purpose. If the skill already exists locally, update its existing `SKILL.md` instead of creating a second copy in another root.
- When the system prompt includes `<available_skills>`, treat those OpenWork Connect skills as remote team capabilities, not as a second filesystem destination. If a matching remote skill exists, ask whether the user wants to use it, create a clearly named local fork, or explicitly replace/share it.
- Do not both write a local skill and publish an OpenWork Connect copy in one creation step. Sharing is a separate, explicit action from Settings > Skills after the local skill is complete.
- Use a file mutation tool (`write`, `edit`, or `apply_patch`) on the chosen real skill path instead of pasting the whole skill into chat.
- Re-read the final file after writing it. A single successful write lets OpenWork show the reload banner so the user can activate the skill immediately.

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

1. Choose one destination and check local plus available Connect skills for a name or purpose collision.
2. Start with a clear purpose statement: when to use it + what it outputs.
3. Specify inputs/outputs and any required permissions.
4. Include “Setup” steps if the skill needs local tooling.
5. Add examples: at least 2 realistic user prompts.
6. Keep it safe: avoid destructive defaults; ask for confirmation.
7. In OpenWork, finish by writing and re-reading exactly one `SKILL.md`. Use `.opencode/skills/<skill-name>/SKILL.md` for a new local skill or the existing path when updating one.
