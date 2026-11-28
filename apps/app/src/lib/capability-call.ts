import type { DynamicToolUIPart } from "ai"

export type CapabilityCallSentence = {
  service: string | null
  present: string
  past: string
  failure?: string
}

const PAST_TENSE: Record<string, string> = {
  ask: "Asked",
  search: "Searched",
  find: "Found",
  get: "Fetched",
  fetch: "Fetched",
  list: "Listed",
  read: "Read",
  check: "Checked",
  create: "Created",
  add: "Added",
  send: "Sent",
  update: "Updated",
  delete: "Deleted",
  remove: "Removed",
  execute: "Ran",
  run: "Ran",
  open: "Opened",
  query: "Queried",
}

const PRESENT_TENSE: Record<string, string> = {
  ask: "Asking",
  search: "Searching",
  find: "Finding",
  get: "Fetching",
  fetch: "Fetching",
  list: "Listing",
  read: "Reading",
  check: "Checking",
  create: "Creating",
  add: "Adding",
  send: "Sending",
  update: "Updating",
  delete: "Deleting",
  remove: "Removing",
  execute: "Running",
  run: "Running",
  open: "Opening",
  query: "Querying",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== "string") return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const BRAND_WORDS: Record<string, string> = { openwork: "OpenWork", github: "GitHub", gitlab: "GitLab", hubspot: "HubSpot" }

function titleCase(slug: string): string {
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => BRAND_WORDS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export function serviceNameFromSlug(slug: string): string {
  const cleaned = slug.replace(/^openwork-direct-/i, "").replace(/-[0-9a-f]{6}$/i, "")
  return titleCase(cleaned || slug)
}

function normalizeAction(action: string, serviceSlug: string): string {
  const serviceWords = new Set(serviceSlug.toLowerCase().split(/[-_.\s]+/))
  const words = action.split(/[-_.\s]+/).filter(Boolean)
  const withoutService = words.filter((word) => !serviceWords.has(word.toLowerCase()))
  const kept = withoutService.length > 0 ? withoutService : words
  const verbIndex = kept.findIndex((word) => PAST_TENSE[word.toLowerCase()] !== undefined)
  if (verbIndex > 0) kept.unshift(...kept.splice(verbIndex, 1))
  return kept.join("_")
}

function baseVerbPhrase(action: string): string {
  return humanize(action).toLowerCase()
}

function humanize(slug: string): string {
  return slug.split(/[-_.\s]+/).filter(Boolean).join(" ")
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function extractQuery(input: unknown, max = 80): string | null {
  if (!isRecord(input)) return null
  const direct = input.query ?? input.q ?? input.search ?? input.prompt
  if (typeof direct === "string" && direct.trim()) return truncate(direct.trim(), max)
  const args = parseRecord(input.arguments)
  for (const body of [args, parseRecord(args?.body), parseRecord(input.body)]) {
    const nested = body?.query ?? body?.q ?? body?.search ?? body?.prompt ?? body?.question ?? body?.message ?? body?.text
    if (typeof nested === "string" && nested.trim()) return truncate(nested.trim(), max)
  }
  return null
}

export function getCapabilityCallQuote(part: DynamicToolUIPart): string | null {
  return extractQuery(part.input, 280)
}

function splitCapabilityName(name: string): { service: string; action: string } | null {
  const separator = name.includes(".") ? "." : name.includes("/") ? "/" : null
  if (!separator) return null
  const index = name.indexOf(separator)
  const service = name.slice(0, index)
  const action = name.slice(index + 1)
  if (!service || !action) return null
  return { service: serviceNameFromSlug(service), action }
}

function verbPhrase(action: string, tense: "present" | "past"): string {
  const words = action.split(/[-_.\s]+/).filter(Boolean)
  const first = words[0]?.toLowerCase()
  const mapped = first ? (tense === "past" ? PAST_TENSE[first] : PRESENT_TENSE[first]) : undefined
  if (mapped) {
    return [mapped, ...words.slice(1)].join(" ")
  }
  const prefix = tense === "past" ? "Used" : "Using"
  return `${prefix} ${humanize(action)}`
}

function skillReference(part: DynamicToolUIPart): string | null {
  const input = parseRecord(part.input)
  const asked = typeof input?.name === "string" ? input.name.trim() : ""
  if (asked && !asked.includes(":")) return asked
  const raw = "output" in part ? part.output : undefined
  const output = parseRecord(raw)
  if (typeof output?.name === "string" && output.name.trim()) return output.name.trim()
  const frontmatter = typeof raw === "string" ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] : undefined
  const name = frontmatter ? /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "" : ""
  return (asked.startsWith("plugin:") ? name.replace(/-[a-z0-9]{8}$/, "") : name) || null
}

function plainSkillName(name: string): string {
  return name.replace(/-(?=[a-z0-9]*\d)[a-z0-9]{8}$/, "")
}

function sentence(service: string | null, present: string, past: string, failure: string): CapabilityCallSentence {
  return { service, present, past, failure }
}

function engineToolSentence(action: string, input: Record<string, unknown> | null): CapabilityCallSentence {
  const server = typeof input?.server === "string" && input.server.trim() ? serviceNameFromSlug(input.server.trim()) : null
  if (action === "read_mcp_resource") {
    const uri = typeof input?.uri === "string" ? input.uri : ""
    if (uri === "skill://index.json") {
      return sentence(null, "Looking through your skills", "Looked through your skills", "Couldn't look through your skills")
    }
    const skill = /^skill:\/\/([^/]+)\/SKILL\.md$/.exec(uri)?.[1]
    if (skill) {
      const target = `your ${plainSkillName(skill)} skill`
      return sentence(null, `Using ${target}…`, `Used ${target}`, `Couldn't use ${target}`)
    }
    const from = server ? ` from ${server}` : ""
    return sentence(server, `Reading a document${from}`, `Read a document${from}`, `Couldn't read a document${from}`)
  }
  if (action === "list_mcp_resources") {
    const from = server ? ` from ${server}` : ""
    return sentence(server, `Listing available documents${from}`, `Listed available documents${from}`, `Couldn't list documents${from}`)
  }
  if (action === "models") return sentence(null, "Looking up models", "Looked up models", "Couldn't look up models")
  if (action === "session_rename") {
    const title = typeof input?.title === "string" && input.title.trim() ? ` to “${truncate(input.title.trim(), 60)}”` : ""
    return sentence(null, `Renaming this chat${title}`, `Renamed this chat${title}`, "Couldn't rename this chat")
  }
  if (action === "session_move") {
    const folder = typeof input?.directory === "string" ? input.directory.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) : undefined
    const to = folder ? ` to ${folder}` : ""
    return sentence(null, `Moving this chat${to}`, `Moved this chat${to}`, "Couldn't move this chat")
  }
  return sentence(null, verbPhrase(action, "present"), verbPhrase(action, "past"), `Couldn't ${baseVerbPhrase(action)}`)
}

const CONNECT_TOOL_PREFIX = "openwork-cloud_"

export const CONNECT_STATUS_TOOL = `${CONNECT_TOOL_PREFIX}connection_status`

const CONNECT_OWN_TOOLS = new Set([
  "search_capabilities",
  "execute_capability",
  "execute_capability_script",
  "list_skills",
  "get_skill",
  "create_skill",
  "update_skill",
  "prepare_app",
  "create_app",
  "update_app",
  "read_app",
  "connection_status",
  "connection_action",
  "render_workflow_artifact",
  "read_artifact_view",
  "save_artifact_view",
  "activate_artifact_view_revision",
  "retire_artifact_view",
])

export function connectActionToolName(toolName: string): string | null {
  if (!toolName.startsWith(CONNECT_TOOL_PREFIX)) return null
  const action = toolName.slice(CONNECT_TOOL_PREFIX.length)
  return !action || CONNECT_OWN_TOOLS.has(action) || action.startsWith("run_artifact_") ? null : action
}

export function connectToolNamespace(connectionName: string): string {
  const namespace = connectionName.toLowerCase().replace(/[^a-z0-9_]+/g, "_")
  if (!namespace) return "_"
  return /^[a-z_]/.test(namespace) ? namespace : `_${namespace}`
}

export function connectActionForConnection(action: string, connectionName: string): string | null {
  const namespace = connectToolNamespace(connectionName)
  if (!action.startsWith(`${namespace}_`)) return null
  return action.slice(namespace.length + 1).replace(/^\d+_(?=.)/, "") || null
}

export function connectRemoteSessionAction(toolName: string): string | null {
  return /^openwork-cloud_remote-session_([a-z]+)$/.exec(toolName)?.[1] ?? null
}

export function connectDenOperation(toolName: string): string | null {
  return /^openwork-cloud_den_([A-Za-z0-9]+)$/.exec(toolName)?.[1] ?? null
}

function operationParts(name: string): { verb: string | undefined; rest: string[]; service: string | null } {
  const words = name.split(/(?=[A-Z])|[-_.\s]+/).filter(Boolean)
  let rest = words.slice(1)
  if (/^capabilit(y|ies)$/i.test(rest[0] ?? "")) rest = rest.slice(1)
  const service = /^GoogleWorkspace/.test(rest.join("")) ? "Google Workspace"
    : /^Microsoft365/.test(rest.join("")) ? "Microsoft 365" : null
  if (service) rest = rest.slice(service === "Google Workspace" ? 2 : 1)
  return { verb: words[0]?.toLowerCase(), rest, service }
}

const HTTP_VERBS: Record<string, string> = { post: "create", put: "update", patch: "update" }

function operationAction(name: string): string {
  if (!/^[a-z]+[A-Z]/.test(name) || /[-_.\s]/.test(name)) return name
  const { verb, rest } = operationParts(name)
  return [verb ? HTTP_VERBS[verb] ?? verb : "", ...rest].filter(Boolean).join("_").toLowerCase() || name
}

function connectionActionSentence(rawAction: string, service: string | null, quoted: string): CapabilityCallSentence {
  const action = normalizeAction(rawAction, service ?? "")
  if (service && /^(?:search|find|query)(?:_|$)/i.test(action)) {
    const verb = action.split("_")[0]!.toLowerCase()
    return {
      service,
      present: `${PRESENT_TENSE[verb]} ${service}${quoted ? ` for${quoted}` : ""}`,
      past: `${PAST_TENSE[verb]} ${service}${quoted ? ` for${quoted}` : ""}`,
      failure: `Couldn't ${verb} ${service}`,
    }
  }
  const suffix = quoted ? `:${quoted}` : ""
  const tail = service ? ` · ${service}` : ""
  return {
    service,
    present: `${verbPhrase(action, "present")}${tail}${suffix}`,
    past: `${verbPhrase(action, "past")}${tail}${suffix}`,
    ...(service ? { failure: `Couldn't ${baseVerbPhrase(action)}${tail}` } : {}),
  }
}

export function getConnectionStatusProbeId(part: DynamicToolUIPart): string | null {
  if (part.toolName !== "openwork_execute_capability" && part.toolName !== "openwork-cloud_execute_capability") return null
  const input = parseRecord(part.input)
  return typeof input?.name === "string" ? /^mcp:([^:\s]+):\*$/.exec(input.name)?.[1] ?? null : null
}

export function getCapabilityCallSentence(
  part: DynamicToolUIPart,
  options?: { includeQuery?: boolean; connectionName?: string | null },
): CapabilityCallSentence {
  const toolName = part.toolName
  if (toolName === "openwork_drive_upload") {
    const input = parseRecord(part.input)
    const name = typeof input?.path === "string" ? input.path.split(/[\\/]/).filter(Boolean).at(-1) : null
    const file = name ? `“${name}”` : "a file"
    return {
      service: "Google Drive",
      present: `Uploading ${file} to Google Drive`,
      past: `Uploaded ${file} to Google Drive`,
      failure: `Couldn't upload ${file} to Google Drive`,
    }
  }
  if (getConnectionStatusProbeId(part) || toolName === CONNECT_STATUS_TOOL) {
    const service = options?.connectionName?.trim() || null
    const target = service ? `${service} connection` : "connection"
    return {
      service,
      present: `Checking ${target}…`,
      past: `Checked ${target}`,
      failure: `Couldn't check ${target}`,
    }
  }
  if (toolName.endsWith("_get_skill")) {
    const name = skillReference(part)
    const target = name ? `your ${name} skill` : "a skill"
    return {
      service: null,
      present: `Using ${target}…`,
      past: `Used ${target}`,
      failure: `Couldn't use ${target}`,
    }
  }

  if (toolName === "request_agent_connector_access") {
    return { service: null, present: "Asking you for access…", past: "Asked you for access", failure: "Couldn't ask you for access" }
  }

  if (toolName.endsWith("_list_skills")) {
    return { service: null, present: "Looking through your skills…", past: "Looked through your skills" }
  }

  if (toolName === "search") {
    return {
      service: null,
      present: "Checking which tools are available",
      past: "Checked which tools are available",
      failure: "Couldn't check which tools are available",
    }
  }

  const query = options?.includeQuery === false ? null : extractQuery(part.input)
  const quoted = query ? ` “${query}”` : ""

  if (toolName.endsWith("search_capabilities")) {
    return {
      service: null,
      present: `Searching your connections for${quoted || " capabilities"}`,
      past: `Searched your connections for${quoted || " capabilities"}`,
      failure: "Couldn't search your connections",
    }
  }

  if (toolName.endsWith("execute_capability_script")) {
    return {
      service: "OpenWork Cloud",
      present: "Running a script on OpenWork Cloud",
      past: "Ran a script on OpenWork Cloud",
      failure: "Script on OpenWork Cloud failed",
    }
  }

  const denOperation = connectDenOperation(toolName)
  if (toolName.endsWith("execute_capability") || denOperation) {
    const name = denOperation ?? (isRecord(part.input) && typeof part.input.name === "string" ? part.input.name : null)
    if (name && /(?:^|:)getOrg$/.test(name)) {
      return {
        service: null,
        present: "Looking up people in your organization",
        past: "Looked up people in your organization",
        failure: "Couldn't look up people in your organization",
      }
    }
    const split = name ? splitCapabilityName(name) : null
    if (split) {
      const suffix = quoted ? `:${quoted}` : ""
      return {
        service: split.service,
        present: `${verbPhrase(split.action, "present")} · ${split.service}${suffix}`,
        past: `${verbPhrase(split.action, "past")} · ${split.service}${suffix}`,
        failure: `Couldn't ${baseVerbPhrase(split.action)} · ${split.service}`,
      }
    }

    if (name?.startsWith("mcp:")) {
      const rawAction = name.split(":").filter(Boolean).at(-1)
      if (rawAction) return connectionActionSentence(rawAction, options?.connectionName?.trim() || null, quoted)
    }

    if (name?.startsWith("plugin:")) {
      const output = parseRecord("output" in part ? part.output : undefined)
      const kind = typeof output?.kind === "string" ? output.kind : "plugin"
      const pluginName = typeof output?.plugin === "string"
        ? output.plugin
        : typeof output?.name === "string"
          ? humanize(output.name)
          : null
      const label = pluginName ? `${kind} “${pluginName}”` : `a ${kind} capability`
      return {
        service: pluginName,
        present: `Using ${label}`,
        past: `Used ${label}`,
      }
    }

    if (name) {
      const { verb: first, rest, service: nativeService } = operationParts(name.replace(/^native:[^:]+:/, ""))
      const verbPast = first ? PAST_TENSE[first] : undefined
      const verbPresent = first ? PRESENT_TENSE[first] : undefined
      if (verbPast && verbPresent && rest.length > 0) {
        const phrase = rest.join(" ").toLowerCase()
        const suffix = nativeService ? ` · ${nativeService}` : ""
        return {
          service: nativeService,
          present: `${verbPresent} ${phrase}${suffix}`,
          past: `${verbPast} ${phrase}${suffix}`,
          failure: `Couldn't ${first} ${phrase}${suffix}`,
        }
      }
    }

    return {
      service: null,
      present: `Running a capability${quoted ? ` for${quoted}` : ""}`,
      past: `Ran a capability${quoted ? ` for${quoted}` : ""}`,
    }
  }

  const connectAction = connectActionToolName(toolName)
  const connection = options?.connectionName?.trim()
  const ownAction = connectAction && connection ? connectActionForConnection(connectAction, connection) : null
  if (ownAction) return connectionActionSentence(operationAction(ownAction), connection ?? null, quoted)

  if (toolName.startsWith("opencode_")) {
    return engineToolSentence(toolName.slice("opencode_".length), parseRecord(part.input))
  }

  const underscore = toolName.indexOf("_")
  if (underscore > 0) {
    const serviceSlug = toolName.slice(0, underscore)
    const service = serviceNameFromSlug(serviceSlug)
    const action = normalizeAction(toolName.slice(underscore + 1), serviceSlug)
    if (/^(?:search|find|query)(?:_|$)/i.test(action)) {
      const verb = action.split("_")[0]!.toLowerCase()
      const suffix = quoted ? ` for${quoted}` : ""
      return {
        service,
        present: `${PRESENT_TENSE[verb]} ${service}${suffix}`,
        past: `${PAST_TENSE[verb]} ${service}${suffix}`,
        failure: `Couldn't ${verb} ${service}`,
      }
    }
    const suffix = quoted ? `:${quoted}` : ""
    return {
      service,
      present: `${verbPhrase(action, "present")} · ${service}${suffix}`,
      past: `${verbPhrase(action, "past")} · ${service}${suffix}`,
      failure: `Couldn't ${baseVerbPhrase(action)} · ${service}`,
    }
  }

  const suffix = quoted ? `:${quoted}` : ""
  return {
    service: null,
    present: `${verbPhrase(toolName, "present")}${suffix}`,
    past: `${verbPhrase(toolName, "past")}${suffix}`,
  }
}

