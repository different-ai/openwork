import { z } from "zod"
import { connectorIconCandidates, connectorDisplayName } from "@openwork/types/connector-brand"

/**
 * Every connector the member can use from Workbot, for the Apps list on Workbot's profile (`workbotProfileSheet`):
 * what their organization set up and shared with them (org-wide, their teams, or them), what the plugins and skills
 * they have access to bring with them, the native ones (Google Workspace, Microsoft 365), and their own sign-ins.
 * Not the marketplace catalog. Built only from what Den already stored (credential health and the last readiness
 * check), so opening the list never calls a provider.
 *
 * Only names, status, how the app signs in and who manages it leave Den: never a URL, header, key or token.
 */
export const workbotAppStatusSchema = z.enum(["connected", "needs_sign_in", "not_connected", "needs_attention"])
export type WorkbotAppStatus = z.infer<typeof workbotAppStatusSchema>

export const workbotAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Brand assets or sized favicon-proxy URLs derived server-side; never the MCP URL itself. */
  iconCandidates: z.array(z.string()).optional(),
  /** Which native service it is ("google-workspace"), or null for an MCP connector. */
  nativeProviderKey: z.string().nullable(),
  authType: z.enum(["oauth", "apikey", "none"]),
  status: workbotAppStatusSchema,
  /** "you": the member signs in with their own account. "organization": an admin set it up and keeps it working. */
  managedBy: z.enum(["you", "organization"]),
  /**
   * What the member can do about it now: "connect" (the existing Workbot connect flow), "ask_admin" (only an admin
   * can fix it), "admin_settings" (the caller can fix it themselves in OpenWork's connection settings), or null.
   */
  action: z.enum(["connect", "ask_admin", "admin_settings"]).nullable(),
  /** As for the everyday connections: in a consent popup, in Den's connections page, or not by the member at all. */
  connectMode: z.enum(["inline", "external", "admin"]),
  /** Den's own page for this connection, only while the member could connect it there. */
  connectUrl: z.string().nullable(),
  ready: z.boolean(),
})
export type WorkbotApp = z.infer<typeof workbotAppSchema>

/** The stored facts Den already reads for "Your connections"; extra fields are ignored and never copied. */
export type WorkbotAppFact = {
  id: string
  name: string
  /** Server-side only: used to identify the brand, never copied to the response. */
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

/** Readiness failures the member fixes by signing in again; any other failed check needs whoever set it up. */
const SIGN_IN_FAILURES = new Set(["sign_in_required", "sign_in_rejected"])

const ORDER: Record<WorkbotAppStatus, number> = { connected: 0, needs_sign_in: 1, not_connected: 2, needs_attention: 3 }

export function workbotApps(facts: readonly WorkbotAppFact[], input: {
  /** Workbot can run the consent flow itself (DEN_WORKBOT_URL is set). */
  inline: boolean
  /** The caller may change the organization's connections (`connections.manage`). */
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
      // An admin added it for a plugin but hasn't finished setting it up: nobody can sign in yet.
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
      // A shared account only an admin can connect.
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
