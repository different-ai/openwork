import { isAbsolute } from "node:path"
import type { SessionAccess } from "../../remote-sessions/src/index.ts"
import { isRecord } from "./den.ts"

/** Headless runners never expose sessions that were started locally. */
export type LocationSessionAccess = Exclude<SessionAccess, "all">
export type LocationSessionChoices = Readonly<Record<string, LocationSessionAccess>>

/** Exact absolute directories only: OpenCode config can be inherited by other Locations. */
export function readLocationSessionChoices(value: unknown): LocationSessionChoices {
  const choices: Record<string, LocationSessionAccess> = {}
  if (!isRecord(value)) return choices
  for (const [directory, access] of Object.entries(value)) {
    if (isAbsolute(directory) && (access === "created" || access === "off")) choices[directory] = access
  }
  return choices
}

export function isHeadlessSessionPolicy(value: unknown): value is { ceiling: SessionAccess; optIn: boolean } {
  return isRecord(value) && (value.ceiling === "off" || value.ceiling === "created" || value.ceiling === "all")
    && typeof value.optIn === "boolean"
}

/** A missing or unknown server policy never permits native work, even with local consent. */
export function headlessSessionAccess(choices: LocationSessionChoices, directory: string, policy: unknown): LocationSessionAccess {
  if (!Object.hasOwn(choices, directory) || choices[directory] !== "created" || !isHeadlessSessionPolicy(policy)
    || policy.ceiling === "off") return "off"
  return "created"
}
