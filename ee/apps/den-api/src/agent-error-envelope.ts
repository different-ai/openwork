import { env } from "./env.js"

/**
 * One error shape for operations agents reach through the MCP gateway or the
 * API: `code` says what kind of person must act, `retryable` says whether
 * retrying the same call can help, and `action_url` points at the page
 * where that person fixes it. Existing `error` fields stay for older clients.
 */
export type AgentErrorCode = "requires_admin" | "seat_required" | "requires_claim"

export type AgentErrorEnvelope = {
  code: AgentErrorCode
  message: string
  retryable: false
  action_url?: string
}

/** RFC 6750 step-up hint that the MCP authorization spec asks for on 403s. */
export const INSUFFICIENT_SCOPE_CHALLENGE = 'Bearer error="insufficient_scope"'

export function denWebUrl(path: string): string {
  return `${env.betterAuthUrl.replace(/\/+$/, "")}${path}`
}

export function requiresAdminError(message: string, actionPath = "/dashboard/members"): AgentErrorEnvelope {
  return { code: "requires_admin", message, retryable: false, action_url: denWebUrl(actionPath) }
}
