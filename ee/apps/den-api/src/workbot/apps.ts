import { z } from "zod"
import { connectorIconCandidates, connectorDisplayName } from "@openwork/types/connector-brand"

export const workbotAppStatusSchema = z.enum(["connected", "needs_sign_in", "not_connected", "needs_attention"])
export type WorkbotAppStatus = z.infer<typeof workbotAppStatusSchema>

export const workbotAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  iconCandidates: z.array(z.string()).optional(),
  nativeProviderKey: z.string().nullable(),
  authType: z.enum(["oauth", "apikey", "none"]),
  status: workbotAppStatusSchema,
  managedBy: z.enum(["you", "organization"]),
  action: z.enum(["connect", "ask_admin", "admin_settings"]).nullable(),
  connectMode: z.enum(["inline", "external", "admin"]),
  connectUrl: z.string().nullable(),
  ready: z.boolean(),
})
export type WorkbotApp = z.infer<typeof workbotAppSchema>

export type WorkbotAppFact = {
  id: string
  name: string
  url?: string
  nativeProviderKey: string | null
  authType?: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  connectedForMe: boolean
  needsReconnect: boolean
  setupRequired?: boolean
  issuerReviewRequired?: boolean
  reconnectActionOwner?: string | null
  readiness?: { status: "ready" | "could_not_verify"; failure?: string | null } | null
}

const SIGN_IN_FAILURES = new Set(["sign_in_required", "sign_in_rejected"])

const ORDER: Record<WorkbotAppStatus, number> = { connected: 0, needs_sign_in: 1, not_connected: 2, needs_attention: 3 }

export function workbotApps(facts: readonly WorkbotAppFact[], input: {
  inline: boolean
  canManage: boolean
  connectUrl: (connectionId: string) => string
}): WorkbotApp[] {
  const seen = new Set<string>()
  const apps: WorkbotApp[] = []
  for (const fact of facts) {
    if (seen.has(fact.id)) continue
    seen.add(fact.id)
    const authType = fact.authType ?? "oauth"
    const perMember = fact.credentialMode === "per_member"
    const failedCheck = fact.connectedForMe && fact.readiness?.status === "could_not_verify"
    let status: WorkbotAppStatus
    let memberFixes: boolean
    if (fact.setupRequired === true) {
      status = "not_connected"
      memberFixes = false
    } else if (fact.needsReconnect || failedCheck) {
      status = "needs_attention"
      memberFixes = perMember && fact.issuerReviewRequired !== true && (
        fact.reconnectActionOwner === "member"
        || (fact.needsReconnect && fact.reconnectActionOwner == null)
        || (!fact.needsReconnect && SIGN_IN_FAILURES.has(fact.readiness?.failure ?? ""))
      )
    } else if (fact.connectedForMe) {
      status = "connected"
      memberFixes = false
    } else if (perMember) {
      status = "needs_sign_in"
      memberFixes = true
    } else {
      status = "not_connected"
      memberFixes = false
    }
    const action = status === "connected" ? null : memberFixes ? "connect" : input.canManage ? "admin_settings" : "ask_admin"
    const connectMode = action === "connect" ? (input.inline && authType === "oauth" ? "inline" : "external") : "admin"
    apps.push({
      id: fact.id,
      name: connectorDisplayName(fact.name),
      iconCandidates: connectorIconCandidates({ name: fact.name, url: fact.url, nativeProviderKey: fact.nativeProviderKey }),
      nativeProviderKey: fact.nativeProviderKey,
      authType,
      status,
      managedBy: perMember && fact.setupRequired !== true ? "you" : "organization",
      action,
      connectMode,
      connectUrl: action === "connect" ? input.connectUrl(fact.id) : null,
      ready: status === "connected",
    })
  }
  return apps.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name, "en", { sensitivity: "base" }))
}
