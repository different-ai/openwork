# Skill Creator: Better Trigger Selection

**Branch:** `feat/skill-creator-triggers`
**Priority:** P2

---

## Problem

Skills don't auto-trigger reliably because the "when to use" descriptions in frontmatter are weak and vague.

From demo: "I should have triggered it earlier. So that's something I need to I guess."

---

## Root Cause

The skill creator doesn't emphasize writing strong, specific trigger phrases. Users write vague descriptions like "when adding content" instead of specific triggers like "when user mentions 'content pipeline' or 'add to my content database'".

---

## Location

**Primary file in OpenWork:** `packages/app/src/app/data/skill-creator.md`

**Also update:** `vendor/openwork-enterprise` skill-creator template (same guidance, different repo)

The skill creator needs to:
1. Explicitly ask for trigger phrases
2. Show examples of good vs bad triggers
3. Validate trigger specificity

### Code findings
- Template file: `packages/app/src/app/data/skill-creator.md:1`
- Used in skill creation flow: `packages/app/src/app/context/extensions.ts:600,660`
- Frontmatter parsing: `packages/server/src/frontmatter.ts:1`
- Frontmatter validation: `packages/server/src/skills.ts:83` and `packages/server/src/validators.ts:7`
- Example of strong trigger phrasing: `.opencode/skills/get-started/SKILL.md:6` ("Always load this skill when the user says …")

---

## Changes to Skill Creator

### Add trigger phrase guidance

In the skill creator flow, add explicit step:

```markdown
## Step: Define Trigger Phrases

The description field is HOW Claude decides when to use your skill. 
It must include specific trigger phrases.

**Bad example:**
> "Use when working with content"

**Good examples:**
> "Use when user mentions 'content pipeline', 'add to content database', or 'schedule a post'"
> "Triggers on: 'rotate PDF', 'flip PDF pages', 'change PDF orientation'"

Write 2-3 specific phrases that should trigger this skill:
```

### Update frontmatter template

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

### Add validation

When skill is created, warn if description lacks specific trigger phrases:
- Must contain at least one quoted phrase or specific keyword
- Should be >50 chars
- Should include "when" or "triggers" language

---

## UI Changes (Context Panel)

Also update context-panel.tsx to display trigger phrases prominently.

The skill subtitle should show the trigger phrase, not the generic description:
```tsx
// Extract trigger from description
const extractTrigger = (description: string): string | null => {
  // Look for "Triggers when" or "Use when" patterns
  const match = description.match(/(?:triggers?|use) when[:\s]+(.+?)(?:\.|$)/i);
  return match?.[1]?.trim() ?? null;
};

const subtitle = extractTrigger(skill.description) ?? skill.description?.slice(0, 60);
```

---

## Testing

1. Create a skill with vague description → verify warning shown
2. Create a skill with specific triggers → verify no warning
3. Check context panel → verify trigger phrase shown as subtitle
4. Use the skill → verify it triggers on the specified phrases
