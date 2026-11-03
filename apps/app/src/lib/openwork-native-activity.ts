import type { DynamicToolUIPart } from "ai"

import { parseRecord, type CapabilityCallSentence } from "./capability-call"

/**
 * OpenWork's own app tools (`openwork_context`, `openwork_query`,
 * `openwork_execute`) as sentences a person reads: what was looked at or
 * changed, named by what they see in the sidebar. Affordance ids, session ids
 * and group ids never show.
 */

export const OPENWORK_NATIVE_TOOL = /^openwork_(context|query|execute)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown, max = 60): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** Ids such as `grp_8f2k…` or `ses_…` are plumbing; a label like "Done" is not. */
function label(value: unknown): string | null {
  const candidate = text(value)
  return candidate && !/^[a-z]{2,8}_[A-Za-z0-9-]{6,}$/.test(candidate) ? candidate : null
}

function resultRecord(part: DynamicToolUIPart): Record<string, unknown> | null {
  if (part.state !== "output-available") return null
  const output: unknown = part.output
  if (Array.isArray(output)) {
    return parseRecord(output.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join(""))
  }
  const record = parseRecord(output)
  if (record && isRecord(record.result)) return record.result
  return record
}

/** A command that returned `{ ok: false, error }` did not happen, whatever the engine state says. */
export function openWorkNativeFailure(part: DynamicToolUIPart): string | null {
  if (!OPENWORK_NATIVE_TOOL.test(part.toolName)) return null
  const result = resultRecord(part)
  if (result?.ok !== false) return null
  return text(result.error, 140) ?? "OpenWork could not complete this."
}

function quoted(value: string | null, prefix = " ") {
  return value ? `${prefix}“${value}”` : ""
}

function sentence(present: string, past: string, failure: string): CapabilityCallSentence {
  return { service: null, present, past, failure }
}

export function openWorkNativeSentence(part: DynamicToolUIPart): CapabilityCallSentence | null {
  const tool = OPENWORK_NATIVE_TOOL.exec(part.toolName)?.[1]
  if (!tool) return null
  if (tool === "context") return sentence("Checking what OpenWork can do here", "Checked what OpenWork can do here", "Couldn't check what OpenWork can do here")

  const input = parseRecord(part.input)
  const id = text(input?.id) ?? ""
  const args = parseRecord(input?.args) ?? {}
  const result = resultRecord(part)

  if (id === "session.search") {
    const query = quoted(text(args.query))
    return sentence(`Searching your chats${query ? ` for${query}` : ""}`, `Searched your chats${query ? ` for${query}` : ""}`, "Couldn't search your chats")
  }
  if (id === "session.read") {
    const title = label(result?.title) ?? (isRecord(result?.session) ? label(result.session.title) : null)
    return sentence("Reading another chat", title ? `Read${quoted(title)}` : "Read another chat", "Couldn't read that chat")
  }
  if (id === "session.group.list") return sentence("Checking your chat groups", "Checked your chat groups", "Couldn't check your chat groups")
  if (id === "session.group.create") {
    const name = label(result?.label) ?? label(args.label)
    const found = result?.created === false
    return sentence(`Creating the${quoted(name)} group`.replace("the group", "a group"),
      found ? `Found the${quoted(name)} group` : `Created the${quoted(name)} group`.replace("the group", "a group"),
      "Couldn't create the group")
  }
  if (id === "session.group.move") {
    const title = label(result?.title)
    const target = result ? label(result.label) : label(args.groupId)
    const ungroup = result ? result.label === null : args.groupId === null || args.groupId === undefined
    const chat = title ? `“${title}”` : "a chat"
    return ungroup
      ? sentence(`Removing ${chat} from its group`, `Removed ${chat} from its group`, "Couldn't move the chat")
      : sentence(`Moving ${chat}${target ? ` to${quoted(target)}` : " to another group"}`, `Moved ${chat}${target ? ` to${quoted(target)}` : " to another group"}`, "Couldn't move the chat")
  }
  if (id === "session.group.remove") {
    const name = label(result?.label) ?? label(args.groupId)
    return sentence(`Removing the${quoted(name)} group`.replace("the group", "a group"), `Removed the${quoted(name)} group`.replace("the group", "a group"), "Couldn't remove the group")
  }
  if (id === "session.create") {
    const sessions = Array.isArray(args.sessions) ? args.sessions.filter(isRecord) : []
    const only = sessions.length === 1 ? label(sessions[0]?.title) : null
    const what = only ? `“${only}”` : sessions.length > 1 ? `${sessions.length} new chats` : "a new chat"
    return sentence(`Starting ${what}`, `Started ${what}`, "Couldn't start a new chat")
  }
  if (id === "session.send") return sentence("Sending a message to another chat", "Sent a message to another chat", "Couldn't send the message")
  if (id === "models.list") return sentence("Looking up available models", "Looked up available models", "Couldn't look up models")
  if (id === "automation.propose") return sentence("Proposing an automation", "Proposed an automation", "Couldn't propose the automation")

  // Unknown affordances still read as plain words: "workspace.list" → "workspace list".
  const words = id.split(/[._-]+/).filter(Boolean).join(" ")
  return tool === "query"
    ? sentence(`Looking up ${words || "OpenWork"}`, `Looked up ${words || "OpenWork"}`, `Couldn't look up ${words || "OpenWork"}`)
    : sentence(`Updating ${words || "OpenWork"}`, `Updated ${words || "OpenWork"}`, `Couldn't update ${words || "OpenWork"}`)
}
