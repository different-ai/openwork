import type { DynamicToolUIPart } from "ai"

/**
 * Paper rendering rules — "Capability calls → sentences":
 * never render raw JSON. Map connection name → service ("Granola"),
 * tool name → verb ("Asking about…"), body.query → quoted plain text.
 * IDs and schema digests live under "Technical details", collapsed.
 */

export type CapabilityCallSentence = {
  /** Human service name, e.g. "Granola" or "OpenWork Cloud". */
  service: string | null
  /** Present-tense line while the call runs. */
  present: string
  /** Past-tense line once the call completed. */
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

/** Tool outputs arrive as objects or JSON strings depending on transport. */
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

/** Brand names whose casing a plain title case would get wrong. */
const BRAND_WORDS: Record<string, string> = { openwork: "OpenWork", github: "GitHub", gitlab: "GitLab", hubspot: "HubSpot" }

function titleCase(slug: string): string {
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => BRAND_WORDS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Connection namespaces carry routing ids ("openwork-direct-slack-c1ca24").
 * People should see the service ("Slack"), never the plumbing around it.
 */
export function serviceNameFromSlug(slug: string): string {
  const cleaned = slug.replace(/^openwork-direct-/i, "").replace(/-[0-9a-f]{6}$/i, "")
  return titleCase(cleaned || slug)
}

/**
 * Tool actions often repeat their service and lead with a qualifier
 * ("web_search_exa"). Drop the repeated service word, and move a known verb
 * to the front so "web_search" reads as "search web".
 */
function normalizeAction(action: string, serviceSlug: string): string {
  const serviceWords = new Set(serviceSlug.toLowerCase().split(/[-_.\s]+/))
  const words = action.split(/[-_.\s]+/).filter(Boolean)
  const withoutService = words.filter((word) => !serviceWords.has(word.toLowerCase()))
  const kept = withoutService.length > 0 ? withoutService : words
  const verbIndex = kept.findIndex((word) => PAST_TENSE[word.toLowerCase()] !== undefined)
  if (verbIndex > 0) kept.unshift(...kept.splice(verbIndex, 1))
  return kept.join("_")
}

/** "list_files" → "list files", for "Couldn't list files". */
function baseVerbPhrase(action: string): string {
  return humanize(action).toLowerCase()
}

function humanize(slug: string): string {
  return slug.split(/[-_.\s]+/).filter(Boolean).join(" ")
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Pull a short human query out of a capability call input, if one exists. */
function extractQuery(input: unknown, max = 80): string | null {
  if (!isRecord(input)) return null
  const direct = input.query ?? input.q ?? input.search ?? input.prompt
  if (typeof direct === "string" && direct.trim()) return truncate(direct.trim(), max)
  // Bodies arrive as objects or as a JSON string, depending on how the
  // capability was invoked.
  const body = parseRecord(input.body)
  if (body) {
    const nested = body.query ?? body.q ?? body.search ?? body.prompt ?? body.question ?? body.message ?? body.text
    if (typeof nested === "string" && nested.trim()) return truncate(nested.trim(), max)
  }
  return null
}

/**
 * Full natural-language ask behind a capability call, for the failed-call
 * card's quote block (Paper "Failed Call Card" · Query Quote).
 */
export function getCapabilityCallQuote(part: DynamicToolUIPart): string | null {
  return extractQuery(part.input, 280)
}

/** "granola.ask-about-meetings" or "granola/ask_about_meetings" → parts. */
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

/** Skill slug from a get_skill call: the name asked for, else the one returned. */
function skillReference(part: DynamicToolUIPart): string | null {
  const input = parseRecord(part.input)
  const asked = typeof input?.name === "string" ? input.name.trim() : ""
  if (asked && !asked.includes(":")) return asked
  const raw = "output" in part ? part.output : undefined
  const output = parseRecord(raw)
  if (typeof output?.name === "string" && output.name.trim()) return output.name.trim()
  // The text result is the SKILL.md itself; its frontmatter carries the slug.
  const frontmatter = typeof raw === "string" ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] : undefined
  const name = frontmatter ? /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "" : ""
  // Den keeps marketplace skill names unique with an 8-character id suffix.
  return (asked.startsWith("plugin:") ? name.replace(/-[a-z0-9]{8}$/, "") : name) || null
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
  if (getConnectionStatusProbeId(part)) {
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

  if (toolName.endsWith("_list_skills")) {
    return { service: null, present: "Looking through your skills…", past: "Looked through your skills" }
  }

  // Code Mode's own catalog lookup is plumbing: say what it did, never echo
  // the internal tool name it searched for.
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

  // A Den Code Mode script: the work happens inside the script, so name the
  // place it ran rather than the plumbing tool ("execute capability script").
  if (toolName.endsWith("execute_capability_script")) {
    return {
      service: "OpenWork Cloud",
      present: "Running a script on OpenWork Cloud",
      past: "Ran a script on OpenWork Cloud",
      failure: "Script on OpenWork Cloud failed",
    }
  }

  if (toolName.endsWith("execute_capability")) {
    const name = isRecord(part.input) && typeof part.input.name === "string" ? part.input.name : null
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

    // Org MCP capabilities arrive as "mcp:<connection-id>:<tool_name>". The
    // connection id is opaque, so the trailing tool name carries the meaning
    // ("query_granola_meetings" → "Queried granola meetings").
    if (name?.startsWith("mcp:")) {
      const rawAction = name.split(":").filter(Boolean).at(-1)
      if (rawAction) {
        // The connection id is opaque; the resolved connector names the service.
        const service = options?.connectionName?.trim() || null
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
          // Without a known service there is nothing specific to say.
          ...(service ? { failure: `Couldn't ${baseVerbPhrase(action)}${tail}` } : {}),
        }
      }
    }

    // "plugin:plg_…:cob_…" refs are opaque; the human name only exists in
    // the output ({ kind: "skill", plugin: "Plan My Day", … }).
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

    // Native camelCase capabilities, e.g.
    // "native:<connection>:getCapabilitiesGoogleWorkspaceCalendarEvents".
    if (name) {
      const nativeName = name.replace(/^native:[^:]+:/, "")
      const words = nativeName.split(/(?=[A-Z])|[-_.\s]+/).filter(Boolean)
      const first = words[0]?.toLowerCase()
      const verbPast = first ? PAST_TENSE[first] : undefined
      const verbPresent = first ? PRESENT_TENSE[first] : undefined
      let rest = words.slice(1)
      if (/^capabilit(y|ies)$/i.test(rest[0] ?? "")) rest = rest.slice(1)
      // "GoogleWorkspaceCalendarEvents" → service "Google Workspace", "calendar events".
      const nativeService = /^GoogleWorkspace/.test(rest.join("")) ? "Google Workspace"
        : /^Microsoft365/.test(rest.join("")) ? "Microsoft 365" : null
      if (nativeService) rest = rest.slice(nativeService === "Google Workspace" ? 2 : 1)
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

  // Generic "{connection}_{tool}" MCP tools.
  const underscore = toolName.indexOf("_")
  if (underscore > 0) {
    const serviceSlug = toolName.slice(0, underscore)
    const service = serviceNameFromSlug(serviceSlug)
    const action = normalizeAction(toolName.slice(underscore + 1), serviceSlug)
    // A bare search reads as "Searched Exa", not "Searched · Exa".
    // Search qualifiers ("search_public_and_private", "web_search") add
    // nothing a person needs; the query says what was searched.
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

