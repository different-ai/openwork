---
name: skill-creator
description: Create new OpenCode skills with the standard scaffold.
---

Skill creator helps create other skills that are self-buildable.

The best way to use it is after a user already executed a flow and says: create a skill for this. Alternatively, if the user asks for a skill to be created, suggest they do the task first and ask for skill creation at the end.

This should trigger this scaffold:
- If the user needed to configure things, create a `.env.example` without credentials and include all required variables.
- Ask the user if they want to store credentials. If yes, write them to a `.env` file in the skill, and suggest rotating keys later.
- Always add a `.gitignore` in the skill that ignores `.env`, and verify `.env` is not tracked.
- If the user needed to interact with an API and you created scripts, add reusable scripts under `scripts/`.
- New skills should explain how to use the `scripts/` and that `.env.example` defines the minimum config.
- Skills should state that they infer what they can do from the available config.

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

## Quick Usage (Already Configured)

### Create a new skill folder
```bash
mkdir -p .opencode/skills/<skill-name>
```

### Minimum scaffold files
- `SKILL.md`
- `scripts/`
- `.env`
- `.env.example` (use this to guide the minimum config)
- `.gitignore` (ignore `.env`)

## .env (credentials + config)

- Use `.env.example` to document required credentials or external setup.
- Do not include any real credentials in `.env.example`.

## Minimal skill template

```markdown
---
name: skill-name
description: One-line description
---

## Quick Usage (Already Configured)

### Action 1
```bash
command here
```

## Common Gotchas

- Thing that doesn't work as expected

## First-Time Setup (If Not Configured)

1. ...
```

## Notes from OpenCode docs

- Skill folders live in `.opencode/skills/<name>/SKILL.md`.
- `name` must be lowercase and match the folder.
- Frontmatter requires `name` and `description`.

## Reference

Follow the official OpenCode skills docs: https://opencode.ai/docs/skills/
