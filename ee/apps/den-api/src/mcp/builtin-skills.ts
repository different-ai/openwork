import { env } from "../env.js"
import { SLACK_ASSISTANT_INSTRUCTIONS } from "../slack-assistant/protocol.js"
import { BUILD_AN_APP_SKILL_SOURCE, BUILTIN_BUILD_AN_APP_CAPABILITY } from "./build-an-app-skill.js"
import type { RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

export type BuiltinSkillDefinition = {
  descriptor: RemoteSkillDescriptor
  source: string
  searchExtraTokens: string
  /** Listed only while the tools it teaches exist on this deployment. */
  available?: () => boolean
}

export const BUILTIN_CREATE_SKILL_CAPABILITY = "skill:create-skill"
export const BUILTIN_ADD_TO_MARKETPLACE_CAPABILITY = "skill:add-to-marketplace"
export const BUILTIN_ADD_USER_TO_MARKETPLACE_CAPABILITY = "skill:add-user-to-marketplace"
export const BUILTIN_SHARE_PLUGIN_CAPABILITY = "skill:share-plugin"
export const BUILTIN_DRIVE_FILES_CAPABILITY = "skill:drive-files"

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
3. Use the returned plugin id and skill id to report that the skill is ready to use now. The result contains text and structured skill details; report the saved result in text.
4. On a \`duplicate_plugin\` response, report the existing plugin id from the message and offer to update that skill through the direct \`update_skill\` tool with \`{ "skillId": "<cob_…>", "skillMarkdown": "<complete SKILL.md>" }\` instead of creating a duplicate. It returns the updated skill details and a text confirmation.
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
5. A successful \`postMarketplacesPlugins\` result contains the ordinary operation response; report the verified outcome in text.
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
5. A successful \`postMarketplacesAccess\` result contains the ordinary operation response; report the verified outcome in text.
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
6. Report that the recipient can use the skill in chat immediately. A successful \`postPluginsAccess\` result contains the ordinary operation response, without a confirmation App.
7. Stop. Do not attach marketplaces in this flow.
`

const DRIVE_FILES_SOURCE = `---
name: drive-files
description: |
  Read, analyze or edit whole Google Drive files (Excel, Word, PowerPoint, PDF, CSV, images,
  and Docs, Sheets or Slides as Office files) without loading them into the conversation.

  Triggers when the user wants to:
  - open, analyze or summarize a Drive file that is not short plain text
  - change an .xlsx, .docx, .pptx, .csv or other Drive file and save it back
---

# Drive files

Work on a local copy with shell tools; never paste file bytes or base64 into a tool call or reply.

## Pick the tool

| Need | Use |
|---|---|
| Summarize a short Google Doc or text file | The Drive file read capability (small inline text) |
| Analyze or edit Office, PDF, CSV, images, or any large file | Pull it, then work on it with bash |
| Change a few cells in a native Google Sheet | The Sheets values capabilities (keeps formulas, comments, history) |
| Create a new file | Make it locally, then upload it |

## In OpenWork (the drive_pull_file, drive_file_status and drive_push_file tools)

1. \`drive_pull_file\` with the Drive file ID or link. Docs, Sheets and Slides arrive as docx, xlsx and pptx unless you choose a format (csv holds only a Sheet's first tab; md, txt, pdf...). The result is a workspace path plus metadata, never content.
2. Inspect and edit the file with bash (recipes below). Load only the part you need.
3. \`drive_file_status\` shows what changed locally and in Drive.
4. Only when the user asked to save to Drive: \`drive_push_file\`, which the person approves. A stored file is replaced in place: same link and sharing, with the previous version in Drive's version history for 30 days. A Google Docs, Sheets or Slides file is saved as a new Google file next to the original unless the user asked for something else.
5. On \`drive_conflict\`, someone changed the file in Drive. Pull it again (\`overwrite: true\` replaces only your local copy) and reapply your edits, or save as a copy. Newer Drive changes are never overwritten.

## Bash recipes

- What is it: \`file <f>; ls -l <f>\`
- Spreadsheet overview: \`python3 -c "import openpyxl,sys; wb=openpyxl.load_workbook(sys.argv[1], read_only=True); [print(ws.title, ws.max_row, ws.max_column) for ws in wb]" <f>\`
- Read a sheet: pandas \`read_excel(f, sheet_name=..., nrows=20)\`; print only what you need.
- Edit cells and keep formatting: openpyxl \`load_workbook(f)\`, set cells, \`save(f)\`. openpyxl drops charts, images and pivot tables from files it saves: check first, and use LibreOffice (\`soffice --headless --convert-to\`) or the Sheets values capabilities for those files.
- CSV: \`head\`, \`wc -l\`, csvkit or pandas.
- Word: \`python-docx\`, or \`pandoc <f> -t markdown\` to read.
- PDF: \`pdftotext -layout <f> - | head -100\`, \`pdfinfo <f>\`.
- Install a missing tool with pip or apt when the computer allows it.

Tell the user what changed and where it was saved, with the Drive link from the push result.
`

export const BUILTIN_SKILLS: BuiltinSkillDefinition[] = [
  {
    descriptor: { name: "slack-assistant", title: "Slack assistant", description: "Respond to Slack requests as the invoking member, with audience and thread isolation.", capability: "skill:slack-assistant", location: "skill://slack-assistant/SKILL.md" },
    source: `---\nname: slack-assistant\ndescription: Respond safely to Slack-originated requests.\n---\n\n${SLACK_ASSISTANT_INSTRUCTIONS}`,
    searchExtraTokens: "slack assistant mention thread audience identity",
  },
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
  {
    descriptor: {
      name: "build-an-app",
      title: "Build an App",
      description: "Build or change an App, such as a dashboard, tracker, lookup, form, or calculator, that opens beside the chat.",
      capability: BUILTIN_BUILD_AN_APP_CAPABILITY,
      location: "skill://build-an-app/SKILL.md",
    },
    source: BUILD_AN_APP_SKILL_SOURCE,
    searchExtraTokens: "app apps build make create edit update dashboard tracker calculator form lookup interactive view mcp artifact",
    available: () => env.appMcpServersEnabled,
  },
  {
    descriptor: {
      name: "drive-files",
      title: "Drive Files",
      description: "Pull Google Drive files into a local copy, edit them with shell tools, and save them back without loading them into context.",
      capability: BUILTIN_DRIVE_FILES_CAPABILITY,
      location: "skill://drive-files/SKILL.md",
    },
    source: DRIVE_FILES_SOURCE,
    searchExtraTokens: "google drive file files download pull push sync edit excel xlsx docx pptx pdf csv spreadsheet bash shell workspace",
  },
]

function availableBuiltinSkills(): BuiltinSkillDefinition[] {
  return BUILTIN_SKILLS.filter((skill) => skill.available?.() ?? true)
}

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
  return availableBuiltinSkills().find((skill) => skill.descriptor.capability === capability)
}

export function listBuiltinSkillDescriptors(): RemoteSkillDescriptor[] {
  return availableBuiltinSkills().map((skill) => skill.descriptor)
}

export function searchBuiltinSkillCapabilities(query: string, limit = 5): BuiltinSkillCapabilityMatch[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  const matches: BuiltinSkillCapabilityMatch[] = []
  for (const skill of availableBuiltinSkills()) {
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
