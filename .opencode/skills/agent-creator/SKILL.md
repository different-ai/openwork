---
name: agent-creator
description: Create new OpenCode agents with a gpt-5.2-codex default.
---

## Quick Usage (Already Configured)

### Create a project agent
```bash
opencode agent create
```

### Agent file locations
- Project agents: `.opencode/agents/<name>.md`
- Global agents: `~/.config/opencode/agents/<name>.md`

## Default model

Use `gpt-5.2-codex` as the default model for new agents unless a workflow needs a different model.

## Minimal agent template

```markdown
---
description: One-line description of what the agent does
mode: subagent
model: gpt-5.2-codex
tools:
  write: false
  edit: false
  bash: false
---
You are a specialized agent. Describe your task, boundaries, and expected output.
```

## Notes from OpenCode docs

- Agent files are markdown with YAML frontmatter.
- The markdown filename becomes the agent name.
- Set `mode` to `primary`, `subagent`, or `all`.
- If no model is specified, subagents inherit the caller model.
- `tools` controls per-agent tool access.

## Reference

Follow the official OpenCode agent docs: https://opencode.ai/docs/agents/

## First-Time Setup (If Not Configured)

1. Run `opencode agent create` and choose project scope.
2. Paste in the default template above and adjust tools as needed.
