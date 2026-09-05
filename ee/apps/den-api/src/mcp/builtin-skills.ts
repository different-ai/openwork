import type { RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

export type BuiltinSkillDefinition = {
  descriptor: RemoteSkillDescriptor
  source: string
  searchExtraTokens: string
}

export const BUILTIN_CREATE_SKILL_CAPABILITY = "skill:create-skill"
export const BUILTIN_ADD_TO_MARKETPLACE_CAPABILITY = "skill:add-to-marketplace"
export const BUILTIN_ADD_USER_TO_MARKETPLACE_CAPABILITY = "skill:add-user-to-marketplace"
export const BUILTIN_SHARE_PLUGIN_CAPABILITY = "skill:share-plugin"

const CREATE_SKILL_SOURCE = `---
name: create-skill
description: |
  Create a new OpenWork Cloud skill as a plugin with one skill component.

  Triggers when user mentions:
  - "create a skill"
  - "make a skill"
  - "new skill"
---

# Create Skill

Create exactly one new Cloud skill. It is immediately usable by its creator. Do not attach it to a marketplace or grant org-wide access in this flow.

## Fast path

Call the direct MCP tool \`create_skill\` (projected as \`openwork-cloud_create_skill\` in OpenWork Desktop). Do not route this flow through \`execute_capability\` or \`postPlugins\`.

Optional pre-check only when a same-named skill may already exist: \`getConfigObjects\` with query \`{ "type": "skill", "q": "<skill-name>" }\`.

## Required skill format

Produce one complete \`SKILL.md\` with:

- opening and closing \`---\` frontmatter delimiters
- lowercase kebab-case \`name\` matching the intended skill name
- non-empty trigger-oriented \`description\`
- non-empty Markdown instruction body
- no secrets

## Workflow

1. Draft the complete \`SKILL.md\`.
2. Execute \`create_skill\` with:
   \`\`\`json
   {
     "pluginName": "<plugin title>",
     "skillMarkdown": "<complete SKILL.md>"
   }
   \`\`\`
3. Use the returned plugin id and skill id to report that the skill is ready to use now. Compatible clients render the skill-created App automatically; do not replace it with emoji confirmation Markdown.
4. On a \`duplicate_plugin\` response, report the existing plugin id from the message and offer to update that skill through the direct \`update_skill\` tool with \`{ "skillId": "<cob_…>", "skillMarkdown": "<complete SKILL.md>" }\` instead of creating a duplicate. It renders the same skill App with an updated state.
5. On authorization or validation errors, report them. Do not fall back to a workspace-local skill unless the user explicitly asks for one.
6. After reporting that the skill is ready, offer to share it with a person or team. If accepted, execute and follow the \`share-plugin\` skill.
`

const ADD_TO_MARKETPLACE_SOURCE = `---
name: add-to-marketplace
description: |
  Add an existing Cloud plugin (or the plugin that owns a skill) to a marketplace.

  Triggers when user mentions:
  - "add this to marketplace"
  - "publish to marketplace"
  - "put this skill on the marketplace"
---

# Add To Marketplace

Attach one existing plugin to one marketplace. Do not create a new skill or plugin in this flow.

## Fast path (prefer these exact MCP names)

Call \`openwork-cloud_execute_capability\` with these names. Skip broad search unless a call returns \`unknown_capability\`.

| Step | Capability | Call |
| --- | --- | --- |
| List marketplaces | \`getMarketplaces\` | no path/body |
| Attach plugin | \`postMarketplacesPlugins\` | path + body below |
| Verify | \`getMarketplacesResolved\` | path \`{ "marketplaceId": "<id>" }\` |

## Interpret the target

Treat "this" / "this skill" / "this plugin" as:

1. the plugin or skill just created in the conversation, otherwise
2. the plugin/skill the user names, otherwise
3. ask which plugin and marketplace to use

A skill always lives inside a plugin. Marketplace membership is on the plugin id.

## Workflow

1. If \`marketplaceId\` is unknown, execute \`getMarketplaces\` and pick the named marketplace (ask when ambiguous).
2. Resolve \`pluginId\` from conversation context or ask. Do not recreate the plugin.
3. Execute \`postMarketplacesPlugins\` with:
   - path: \`{ "marketplaceId": "<id>" }\`
   - body: \`{ "pluginId": "<plugin id>" }\`
4. Execute \`getMarketplacesResolved\` and confirm the plugin is listed.
5. A successful \`postMarketplacesPlugins\` result renders a confirmation card automatically in compatible clients; report the outcome in text as well.
6. Stop. Do not grant user access unless the user asks for that separately.
`

const ADD_USER_TO_MARKETPLACE_SOURCE = `---
name: add-user-to-marketplace
description: |
  Grant a person access to a marketplace.

  Triggers when user mentions:
  - "add this user to the marketplace"
  - "give them marketplace access"
  - "share the marketplace with"
---

# Add User To Marketplace

Grant marketplace access to one member. Do not create plugins or attach plugins in this flow.

## Fast path (prefer these exact MCP names)

Call \`openwork-cloud_execute_capability\` with these names. Skip broad search unless a call returns \`unknown_capability\`.

| Step | Capability | Call |
| --- | --- | --- |
| List marketplaces | \`getMarketplaces\` | no path/body |
| Grant access | \`postMarketplacesAccess\` | path + body below |
| Verify | \`getMarketplacesAccess\` | path \`{ "marketplaceId": "<id>" }\` |

## Interpret the target

Treat "this user" / "them" as:

1. an \`orgMembershipId\` (\`om_…\`) already present in the conversation, otherwise
2. the person the user identifies — ask for their \`orgMembershipId\` if you only have a name/email and cannot resolve it from prior tool results, otherwise
3. ask who to grant and which marketplace

## Workflow

1. If \`marketplaceId\` is unknown, execute \`getMarketplaces\` and pick the named marketplace (ask when ambiguous).
2. Resolve \`orgMembershipId\`. Do not invent one.
3. Execute \`postMarketplacesAccess\` with:
   - path: \`{ "marketplaceId": "<id>" }\`
   - body: \`{ "orgMembershipId": "<om_…>", "role": "viewer" }\`
   Use \`"role": "manager"\` only when the user explicitly asks for manage access.
4. Execute \`getMarketplacesAccess\` and confirm the member is listed.
5. A successful \`postMarketplacesAccess\` result renders a confirmation card automatically in compatible clients; report the outcome in text as well.
6. Stop. Do not change plugin membership unless asked.
`

const SHARE_PLUGIN_SOURCE = `---
name: share-plugin
description: |
  Share an OpenWork Cloud skill's plugin with a person, team, or organization.

  Triggers when user mentions:
  - "share this skill with"
  - "share this plugin with"
  - "give X access to this skill"
  - "let my team use this skill"
---

# Share Plugin

Grant access to the plugin that owns a skill. Skills live inside plugins, so access grants use the plugin id.

## Fast path (prefer these exact MCP names)

Call \`openwork-cloud_execute_capability\` with these names. Skip broad search unless a call returns \`unknown_capability\`.

| Step | Capability | Call |
| --- | --- | --- |
| Resolve recipient | \`getOrg\` | resolve a person \`om_…\` by name/email or a team \`tem_…\` by name |
| Grant access | \`postPluginsAccess\` | path \`{ "pluginId": "<id>" }\` and body below |
| Verify | \`getPluginsAccess\` | path \`{ "pluginId": "<id>" }\` |

## Interpret the target

Treat "this skill" / "this plugin" as the plugin or skill just created in the conversation, otherwise the named plugin or skill, otherwise ask which one. A skill always lives inside a plugin; grants are on the plugin id.

The recipient is the named person or team. NEVER invent ids. Resolve a person or team with \`getOrg\` and ask when the result is missing or ambiguous.

## Workflow

1. Resolve \`pluginId\` from conversation context or the named skill/plugin. Do not recreate it.
2. For a person or team, resolve exactly one of \`orgMembershipId\` or \`teamId\` with \`getOrg\`.
3. Execute \`postPluginsAccess\` with path \`{ "pluginId": "<id>" }\` and one body:
   - person: \`{ "orgMembershipId": "om_…", "role": "viewer" }\`
   - team: \`{ "teamId": "tem_…", "role": "viewer" }\`
   Use \`"role": "viewer"\` by default. Use \`"role": "editor"\` ONLY when the user explicitly asks for edit access.
4. Organization-wide sharing is admin-only and must be explicitly requested. For that request, use \`{ "orgWide": true, "role": "viewer" }\`; the server returns 403 otherwise, which you must relay.
5. Execute \`getPluginsAccess\` and confirm the intended grant is listed.
6. Report that the recipient can use the skill in chat immediately. A successful \`postPluginsAccess\` result renders a confirmation card automatically in compatible clients.
7. Stop. Do not attach marketplaces in this flow.
`

export const BUILTIN_SKILLS: BuiltinSkillDefinition[] = [
  {
    descriptor: {
      name: "create-skill",
      title: "Create Skill",
      description: "Create a new OpenWork Cloud skill that its creator can use immediately.",
      capability: BUILTIN_CREATE_SKILL_CAPABILITY,
      location: "skill://create-skill/SKILL.md",
    },
    source: CREATE_SKILL_SOURCE,
    searchExtraTokens: "create make new author authoring build skill skills SKILL.md plugin",
  },
  {
    descriptor: {
      name: "add-to-marketplace",
      title: "Add To Marketplace",
      description: "Add an existing Cloud plugin or skill's plugin to a marketplace.",
      capability: BUILTIN_ADD_TO_MARKETPLACE_CAPABILITY,
      location: "skill://add-to-marketplace/SKILL.md",
    },
    source: ADD_TO_MARKETPLACE_SOURCE,
    searchExtraTokens: "add publish attach marketplace marketplaces plugin skill",
  },
  {
    descriptor: {
      name: "add-user-to-marketplace",
      title: "Add User To Marketplace",
      description: "Grant a member access to a marketplace.",
      capability: BUILTIN_ADD_USER_TO_MARKETPLACE_CAPABILITY,
      location: "skill://add-user-to-marketplace/SKILL.md",
    },
    source: ADD_USER_TO_MARKETPLACE_SOURCE,
    searchExtraTokens: "add grant share user member access marketplace marketplaces",
  },
  {
    descriptor: {
      name: "share-plugin",
      title: "Share Plugin",
      description: "Share an OpenWork Cloud skill's plugin with a person, team, or organization.",
      capability: BUILTIN_SHARE_PLUGIN_CAPABILITY,
      location: "skill://share-plugin/SKILL.md",
    },
    source: SHARE_PLUGIN_SOURCE,
    searchExtraTokens: "share give grant access person member team plugin skill viewer editor",
  },
]

export const BUILTIN_SKILL_DESCRIPTORS: RemoteSkillDescriptor[] = BUILTIN_SKILLS.map((skill) => skill.descriptor)

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

function findBuiltinSkill(capability: string): BuiltinSkillDefinition | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.descriptor.capability === capability)
}

export function listBuiltinSkillDescriptors(): RemoteSkillDescriptor[] {
  return BUILTIN_SKILL_DESCRIPTORS
}

export function searchBuiltinSkillCapabilities(query: string, limit = 5): BuiltinSkillCapabilityMatch[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  const matches: BuiltinSkillCapabilityMatch[] = []
  for (const skill of BUILTIN_SKILLS) {
    const score = scoreText(
      tokenize(`${skill.descriptor.name} ${skill.descriptor.title}`),
      tokenize(skill.descriptor.description),
      queryTokens,
      tokenize(skill.searchExtraTokens),
    )
    if (score <= 0) continue
    matches.push({
      name: skill.descriptor.capability,
      method: "SKILL",
      path: skill.descriptor.location,
      score,
      summary: skill.descriptor.description,
      pathParams: [],
      queryParams: [],
      hasBody: false,
      kind: "skill",
    })
  }

  return matches
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(20, Math.trunc(limit) || 5)))
}

export function executeBuiltinSkillCapability(name: string): BuiltinSkillExecutePayload | null {
  const skill = findBuiltinSkill(name)
  if (!skill) return null
  return {
    kind: "skill",
    name: skill.descriptor.title,
    description: skill.descriptor.description,
    provenance: "Built into OpenWork Cloud.",
    content: skill.source,
  }
}
