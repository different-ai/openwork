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

function titleCase(slug: string): string {
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
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
  return { service: titleCase(service), action }
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

/**
 * Build the human sentence for a dynamic (MCP / capability) tool call.
 * Tool names follow "{connection}_{tool}", e.g.
 * "openwork-cloud_search_capabilities".
 */
export function getCapabilityCallSentence(
  part: DynamicToolUIPart,
  options?: { includeQuery?: boolean },
): CapabilityCallSentence {
  const toolName = part.toolName
  const query = options?.includeQuery === false ? null : extractQuery(part.input)
  const quoted = query ? ` “${query}”` : ""

  if (toolName.endsWith("search_capabilities")) {
    return {
      service: null,
      present: `Searching your connections for${quoted || " capabilities"}`,
      past: `Searched your connections for${quoted || " capabilities"}`,
    }
  }

  if (toolName.endsWith("execute_capability")) {
    const name = isRecord(part.input) && typeof part.input.name === "string" ? part.input.name : null
    const split = name ? splitCapabilityName(name) : null
    if (split) {
      const suffix = quoted ? ` —${quoted}` : ""
      return {
        service: split.service,
        present: `${verbPhrase(split.action, "present")} · ${split.service}${suffix}`,
        past: `${verbPhrase(split.action, "past")} · ${split.service}${suffix}`,
      }
    }

    // Org MCP capabilities arrive as "mcp:<connection-id>:<tool_name>". The
    // connection id is opaque, so the trailing tool name carries the meaning
    // ("query_granola_meetings" → "Queried granola meetings").
    if (name?.startsWith("mcp:")) {
      const action = name.split(":").filter(Boolean).at(-1)
      if (action) {
        const suffix = quoted ? ` —${quoted}` : ""
        return {
          service: null,
          present: `${verbPhrase(action, "present")}${suffix}`,
          past: `${verbPhrase(action, "past")}${suffix}`,
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
    // "getCapabilitiesGoogleWorkspaceCalendarEvents".
    if (name) {
      const words = name.split(/(?=[A-Z])|[-_.\s]+/).filter(Boolean)
      const first = words[0]?.toLowerCase()
      const verbPast = first ? PAST_TENSE[first] : undefined
      const verbPresent = first ? PRESENT_TENSE[first] : undefined
      let rest = words.slice(1)
      if (/^capabilit(y|ies)$/i.test(rest[0] ?? "")) rest = rest.slice(1)
      if (verbPast && verbPresent && rest.length > 0) {
        const phrase = rest.join(" ")
        return {
          service: null,
          present: `${verbPresent} ${phrase}`,
          past: `${verbPast} ${phrase}`,
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
    const service = titleCase(toolName.slice(0, underscore))
    const action = toolName.slice(underscore + 1)
    const suffix = quoted ? ` —${quoted}` : ""
    return {
      service,
      present: `${verbPhrase(action, "present")} · ${service}${suffix}`,
      past: `${verbPhrase(action, "past")} · ${service}${suffix}`,
    }
  }

  const suffix = quoted ? ` —${quoted}` : ""
  return {
    service: null,
    present: `${verbPhrase(toolName, "present")}${suffix}`,
    past: `${verbPhrase(toolName, "past")}${suffix}`,
  }
}

