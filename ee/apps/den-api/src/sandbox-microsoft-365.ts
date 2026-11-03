import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { createExternalMcpConnection, getExternalMcpConnectionByExternalKey } from "./capability-sources/external-mcp-connections.js"
import { upsertOrgOAuthClient } from "./capability-sources/oauth-credentials.js"
import { SANDBOX_MICROSOFT_CLIENT_MARKER, sandboxMicrosoftAddresses } from "./capability-sources/sandbox-microsoft-endpoints.js"
import { assertPublicUrl } from "./capability-sources/url-guard.js"
import { env } from "./env.js"

/** The sample apps one Microsoft 365 connector replaces when `sandboxMicrosoft365` is on. */
export const SANDBOX_MICROSOFT_APP_KEYS: ReadonlySet<string> = new Set(["outlook", "calendar", "drive"])
export const SANDBOX_MICROSOFT_EXTERNAL_KEY = "sandbox-microsoft-365"
/** What Workbot and agents may do with the sample mail, calendar and files: read, save drafts, change events and files. Never send mail. */
export const SANDBOX_MICROSOFT_FEATURES = ["mailRead", "mailDraft", "calendarRead", "calendarWrite", "filesRead", "filesWrite"] as const

export class SandboxMicrosoftUnavailableError extends Error {}

const registeredClientSchema = z.object({
  client_id: z.string().min(1).max(200),
  client_secret: z.string().min(16).max(500),
  tenant_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
})

/** Den's callback for Microsoft 365, the exact address the workplace must send people back to. */
export function sandboxMicrosoftCallbackUrl(apiBaseUrl: string) {
  return `${apiBaseUrl.replace(/\/+$/, "")}/v1/oauth-providers/microsoft-365/connect/callback`
}

/**
 * Registers Den with the sandbox's workplace sign-in (an ordinary confidential OAuth client, no shared secret
 * configured anywhere) and adds one per-person Microsoft 365 connector backed by it. Each member approves once in
 * their own browser; the connector then reads that browser's private sample workspace. Throws
 * SandboxMicrosoftUnavailableError when the workplace has no Microsoft 365 sign-in (an older workshop), so the caller
 * can fall back to the separate sample connectors.
 */
export async function addSandboxMicrosoft365(input: {
  organizationId: DenTypeId<"organization">
  ownerMemberId: DenTypeId<"member">
  workplaceUrl: string
  callbackBaseUrl: string
}) {
  const existing = await getExternalMcpConnectionByExternalKey({ organizationId: input.organizationId, externalKey: SANDBOX_MICROSOFT_EXTERNAL_KEY })
  if (existing) return existing
  const addresses = sandboxMicrosoftAddresses(input.workplaceUrl)
  if (!env.allowPrivateMcpUrls) await assertPublicUrl(addresses.clientsUrl)
  let response: Response
  try {
    response = await fetch(addresses.clientsUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: "OpenWork", redirect_uris: [sandboxMicrosoftCallbackUrl(input.callbackBaseUrl)] }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new SandboxMicrosoftUnavailableError(`The sample work apps could not be reached to set up Microsoft 365 (${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : "unknown"}).`)
  }
  if (response.status === 404) throw new SandboxMicrosoftUnavailableError("The sample work apps at this address don't offer Microsoft 365 sign-in yet.")
  const registered = registeredClientSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !registered.success) throw new SandboxMicrosoftUnavailableError(`The sample work apps refused the Microsoft 365 setup (HTTP ${response.status}).`)

  const connection = await createExternalMcpConnection({
    organizationId: input.organizationId,
    name: "Microsoft 365",
    externalKey: SANDBOX_MICROSOFT_EXTERNAL_KEY,
    url: input.workplaceUrl,
    authType: "oauth",
    kind: "native_provider",
    nativeProviderKey: "microsoft-365",
    credentialMode: "per_member",
    createdByOrgMembershipId: input.ownerMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await upsertOrgOAuthClient({
    organizationId: input.organizationId,
    providerId: connection.id,
    clientId: registered.data.client_id,
    clientSecret: registered.data.client_secret,
    extra: { features: [...SANDBOX_MICROSOFT_FEATURES], tenantId: registered.data.tenant_id, [SANDBOX_MICROSOFT_CLIENT_MARKER]: true },
    createdByOrgMembershipId: input.ownerMemberId,
  })
  return connection
}
