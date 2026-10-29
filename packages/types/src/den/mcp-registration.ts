import { z } from "zod"

/**
 * Whether an MCP server's OAuth authorization server lets OpenWork sign people in without an admin first creating an
 * OAuth app, learned from real sign-ins and from the scheduled preset check. Tracked per authorization server issuer.
 *
 * - `client_metadata`: advertises Client ID Metadata Documents (CIMD); OpenWork's own client id works, no registration.
 * - `dynamic_open`: dynamic client registration (DCR) accepted OpenWork.
 * - `dynamic_refused`: DCR exists but refused OpenWork (for example 403): the provider only accepts approved apps.
 * - `requires_client`: neither CIMD nor DCR is offered; an admin must create an OAuth app and add its client id.
 * - `no_auth`: the server answered without asking anyone to sign in.
 * - `unknown`: not determined yet, or the last check could not reach the server.
 */
export const MCP_REGISTRATION_STATUSES = [
  "client_metadata",
  "dynamic_open",
  "dynamic_refused",
  "requires_client",
  "no_auth",
  "unknown",
] as const
export type McpRegistrationStatus = (typeof MCP_REGISTRATION_STATUSES)[number]

/** Where an observation came from: a member's real sign-in, or the scheduled preset check. */
export const MCP_REGISTRATION_SOURCES = ["sign_in", "probe"] as const
export type McpRegistrationSource = (typeof MCP_REGISTRATION_SOURCES)[number]

/** One observation, as stored in the event log for reports. */
export const MCP_REGISTRATION_OUTCOMES = [
  "registered_client_metadata",
  "registered_dynamic",
  "refused",
  "no_registration_method",
  "metadata_only",
  "no_auth",
  "unreachable",
] as const
export type McpRegistrationOutcome = (typeof MCP_REGISTRATION_OUTCOMES)[number]

export const mcpRegistrationStatusSchema = z.enum(MCP_REGISTRATION_STATUSES)

/** Statuses that mean a person cannot finish a one-click sign-in today. */
export function mcpRegistrationBlocked(status: McpRegistrationStatus | null | undefined): boolean {
  return status === "dynamic_refused" || status === "requires_client"
}
