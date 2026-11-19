import { eq } from "@openwork-ee/den-db/drizzle"
import { SandboxOrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"

/**
 * Where a sandbox organization's sample Microsoft 365 connector signs in and reads Graph: the sandbox's own
 * fictional workplace (evals/packages/open-workplace/src/workshop-microsoft.mjs), never Microsoft. Decided per
 * organization from what only Den sets, so every other organization and connector keeps Microsoft's endpoints:
 *
 * - the OAuth client carries SANDBOX_MICROSOFT_CLIENT_MARKER, which only sandbox setup writes (admins can change a
 *   client's ID, secret, tenant and features, never its other settings);
 * - the organization is an open sandbox, and the address is the workplace address a platform admin gave it;
 * - this is a cloud deployment.
 *
 * When any of these stops being true the marked connector is unavailable: Den refuses to sign in or call Graph with
 * it rather than sending a sample client or token to Microsoft.
 */
export const SANDBOX_MICROSOFT_CLIENT_MARKER = "openWorkplaceSandbox"

export type SandboxMicrosoftEndpoints =
  | { status: "ready"; authorizeUrl: string; tokenUrl: string; userinfoUrl: string; graphBaseUrl: string }
  | { status: "unavailable"; message: string }

export function isSandboxMicrosoftClient(extra: Record<string, unknown> | null | undefined): boolean {
  return extra?.[SANDBOX_MICROSOFT_CLIENT_MARKER] === true
}

/** The sign-in and Graph addresses a sandbox's workplace serves, from its root address. */
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
