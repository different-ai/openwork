import { env } from "./env.js"

export type AgentErrorCode = "requires_admin" | "seat_required" | "requires_claim"

export type AgentErrorEnvelope = {
  code: AgentErrorCode
  message: string
  retryable: false
  action_url?: string
}

export const INSUFFICIENT_SCOPE_CHALLENGE = 'Bearer error="insufficient_scope"'

export function denWebUrl(path: string): string {
  return `${env.betterAuthUrl.replace(/\/+$/, "")}${path}`
}

export function requiresAdminError(message: string, actionPath = "/dashboard/members"): AgentErrorEnvelope {
  return { code: "requires_admin", message, retryable: false, action_url: denWebUrl(actionPath) }
}
