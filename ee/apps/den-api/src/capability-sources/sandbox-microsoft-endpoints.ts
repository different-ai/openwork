import { eq } from "@openwork-ee/den-db/drizzle"
import { SandboxOrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"

export const SANDBOX_MICROSOFT_CLIENT_MARKER = "openWorkplaceSandbox"

export type SandboxMicrosoftEndpoints =
  | { status: "ready"; authorizeUrl: string; tokenUrl: string; userinfoUrl: string; graphBaseUrl: string }
  | { status: "unavailable"; message: string }

export function isSandboxMicrosoftClient(extra: Record<string, unknown> | null | undefined): boolean {
  return extra?.[SANDBOX_MICROSOFT_CLIENT_MARKER] === true
}

export function sandboxMicrosoftAddresses(workplaceUrl: string) {
  const root = workplaceUrl.replace(/\/+$/, "")
  return {
    authorizeUrl: `${root}/{tenantId}/oauth2/v2.0/authorize`,
    tokenUrl: `${root}/{tenantId}/oauth2/v2.0/token`,
    userinfoUrl: `${root}/oidc/userinfo`,
    graphBaseUrl: `${root}/v1.0`,
    clientsUrl: `${root}/_workshop/microsoft/clients`,
  }
}

export const SANDBOX_MICROSOFT_ENDED_MESSAGE = "This sandbox has ended, so its sample Microsoft 365 is no longer available."
export const SANDBOX_MICROSOFT_OFF_MESSAGE = "Sample Microsoft 365 is available only on cloud deployments."

export async function resolveSandboxMicrosoftEndpoints(organizationId: string, now = new Date()): Promise<SandboxMicrosoftEndpoints> {
  let orgId
  try { orgId = normalizeDenTypeId("organization", organizationId) } catch { return { status: "unavailable", message: SANDBOX_MICROSOFT_ENDED_MESSAGE } }
  const [row] = await db
    .select({ connectorBaseUrl: SandboxOrganizationTable.connectorBaseUrl, closedAt: SandboxOrganizationTable.closedAt, expiresAt: SandboxOrganizationTable.expiresAt })
    .from(SandboxOrganizationTable)
    .where(eq(SandboxOrganizationTable.organizationId, orgId))
    .limit(1)
  if (!row?.connectorBaseUrl || row.closedAt || row.expiresAt <= now) return { status: "unavailable", message: SANDBOX_MICROSOFT_ENDED_MESSAGE }
  if (env.features.deployment !== "cloud") return { status: "unavailable", message: SANDBOX_MICROSOFT_OFF_MESSAGE }
  const { authorizeUrl, tokenUrl, userinfoUrl, graphBaseUrl } = sandboxMicrosoftAddresses(row.connectorBaseUrl)
  return { status: "ready", authorizeUrl, tokenUrl, userinfoUrl, graphBaseUrl }
}
