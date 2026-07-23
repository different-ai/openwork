import type { RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

export const BUILTIN_SKILL_CREATOR_CAPABILITY = "skill:skill-creator"

export const BUILTIN_SKILL_CREATOR_DESCRIPTOR: RemoteSkillDescriptor = {
  name: "skill-creator",
  title: "Skill Creator",
  description: "Create or update a validated skill in OpenWork Cloud.",
  capability: BUILTIN_SKILL_CREATOR_CAPABILITY,
  location: "skill://skill-creator/SKILL.md",
}

export const BUILTIN_SKILL_CREATOR_SOURCE = `---
name: skill-creator
description: Create or update a validated skill in OpenWork Cloud when the user asks to make, change, or improve a skill.
---

# Skill Creator

Use this skill when a user asks to create or update an OpenWork skill. Store the result in OpenWork Cloud. Do not create a workspace-local copy unless the user explicitly requests a local skill.

## Required skill format

Produce one complete \`SKILL.md\` containing:

- opening and closing \`---\` frontmatter delimiters;
- a lowercase kebab-case \`name\`;
- a non-empty, trigger-oriented \`description\`; and
- a non-empty Markdown instruction body.

The frontmatter name must match the intended skill name. Do not include secrets.

## Cloud authoring workflow

1. Search OpenWork Cloud with 2-4 keyword variants for existing skills/config objects, plugins, marketplaces, plugin creation, config-object version creation, and read operations. Use only exact capability names returned by search.
2. Resolve exact-name matches before writing: create when none exists, update when one exists and the user requested changes, or ask the user to choose when matches are ambiguous.
3. Draft the complete replacement \`SKILL.md\` and validate its frontmatter and body against the required format.
4. To create, execute the returned plugin-create capability with one component: \`{"type":"skill","input":{"rawSourceText":"<complete SKILL.md>"}}\`. Set organization-wide access or a marketplace only when the user requested and confirmed it.
5. To update, execute the returned config-object-version creation capability with the existing \`configObjectId\` in \`path\` and \`{"input":{"rawSourceText":"<complete SKILL.md>"},"reason":"<short change summary>"}\` in \`body\`. Keep the existing name unless the user requested a rename. Never call plugin-create for an update.
6. Read back the config object or resolved plugin detail. Verify the latest stored name, description, content, IDs, marketplace, and access before reporting success.
7. If Cloud returns an authorization, validation, ambiguity, or persistence error, report it. Do not create a duplicate or silently create a local copy.
`

export type BuiltinSkillCapabilityMatch = CapabilityMatch & {
  kind: "skill"
}

export type BuiltinSkillExecutePayload = {
  kind: "skill"
  name: string
  description: string
  provenance: string
  content: string
}

export function searchBuiltinSkillCapabilities(query: string, limit = 5): BuiltinSkillCapabilityMatch[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []
  const score = scoreText(
    tokenize(`${BUILTIN_SKILL_CREATOR_DESCRIPTOR.name} ${BUILTIN_SKILL_CREATOR_DESCRIPTOR.title}`),
    tokenize(BUILTIN_SKILL_CREATOR_DESCRIPTOR.description),
    queryTokens,
    tokenize("author authoring build change create creation edit improve make update skills SKILL.md"),
  )
  if (score <= 0) return []
  const match: BuiltinSkillCapabilityMatch = {
    name: BUILTIN_SKILL_CREATOR_CAPABILITY,
    method: "SKILL",
    path: BUILTIN_SKILL_CREATOR_DESCRIPTOR.location,
    score,
    summary: BUILTIN_SKILL_CREATOR_DESCRIPTOR.description,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    kind: "skill",
  }
  return [match].slice(0, Math.max(1, Math.min(20, Math.trunc(limit) || 5)))
}

export function executeBuiltinSkillCapability(name: string): BuiltinSkillExecutePayload | null {
  if (name !== BUILTIN_SKILL_CREATOR_CAPABILITY) return null
  return {
    kind: "skill",
    name: BUILTIN_SKILL_CREATOR_DESCRIPTOR.title,
    description: BUILTIN_SKILL_CREATOR_DESCRIPTOR.description,
    provenance: "Built into OpenWork Cloud.",
    content: BUILTIN_SKILL_CREATOR_SOURCE,
  }
}
