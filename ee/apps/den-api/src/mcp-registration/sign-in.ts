import { and, eq } from "@openwork-ee/den-db/drizzle"
import { OrgOAuthClientTable } from "@openwork-ee/den-db/schema"
import type { McpRegistrationOutcome } from "@openwork/types/den/mcp-registration"
import { matchExternalMcpPresetForUrl } from "../capability-sources/external-mcp-auth-policy.js"
import type { ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import { db } from "../db.js"
import { recordMcpRegistrationObservation } from "./status.js"
import { isRegistrationRefusal } from "./status-rules.js"

type Diagnostic = { phase?: string | null; code?: string | null; httpStatus?: number | null; referenceId?: string | null }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null
}

/** What the connection's cached discovery says about the authorization server. */
export function authorizationServerFacts(connection: Pick<ExternalMcpConnectionRow, "oauthConfiguration">) {
  const configuration = connection.oauthConfiguration
  const metadata = record(record(configuration?.discovery)?.authorizationServerMetadata)
  const issuer = (typeof metadata?.issuer === "string" ? metadata.issuer : null) ?? configuration?.authorizationServerIssuer ?? null
  const registrationEndpoint = typeof metadata?.registration_endpoint === "string" ? metadata.registration_endpoint : null
  return {
    issuer,
    registrationEndpoint,
    clientMetadataSupported: metadata ? metadata.client_id_metadata_document_supported === true : null,
    dynamicRegistrationSupported: metadata ? registrationEndpoint !== null : null,
  }
}

/**
 * The outcome a member's sign-in start says about client registration, or null when it says nothing (an admin's own
 * OAuth app, or a failure at another step).
 */
export function signInRegistrationOutcome(input: {
  registrationSource?: string | null
  diagnostic?: Diagnostic
}): McpRegistrationOutcome | null {
  if (input.diagnostic) {
    if (isRegistrationRefusal(input.diagnostic)) return "refused"
    if (input.diagnostic.code === "MCP_OAUTH_CONFIGURATION_REQUIRED") return "no_registration_method"
    return null
  }
  if (input.registrationSource === "client-metadata") return "registered_client_metadata"
  if (input.registrationSource === "dynamic") return "registered_dynamic"
  return null
}

async function registrationSource(connection: Pick<ExternalMcpConnectionRow, "id" | "organizationId">): Promise<string | null> {
  const [row] = await db.select({ extra: OrgOAuthClientTable.extra }).from(OrgOAuthClientTable)
    .where(and(eq(OrgOAuthClientTable.organizationId, connection.organizationId), eq(OrgOAuthClientTable.providerId, connection.id)))
    .limit(1)
  const source = row?.extra?.enterpriseMcpRegistrationSource
  return typeof source === "string" ? source : null
}

/**
 * Records what a member's real sign-in start showed about OpenWork's client registration with this provider. Runs in
 * the background and never throws: reporting must not fail or slow a sign-in.
 */
export function observeSignInRegistration(input: {
  connection: ExternalMcpConnectionRow
  diagnostic?: Diagnostic
  reference: string
  /** Re-reads the connection, whose saved discovery can be newer than the request's copy. */
  reload?: () => Promise<ExternalMcpConnectionRow | null>
}): void {
  void (async () => {
    try {
      const { diagnostic } = input
      const connection = (input.reload ? await input.reload().catch(() => null) : null) ?? input.connection
      const outcome = signInRegistrationOutcome({
        diagnostic,
        registrationSource: diagnostic ? null : await registrationSource(connection),
      })
      if (!outcome) return
      const facts = authorizationServerFacts(connection)
      if (!facts.issuer) return
      await recordMcpRegistrationObservation({
        ...facts,
        issuer: facts.issuer,
        source: "sign_in",
        outcome,
        presetId: matchExternalMcpPresetForUrl(connection.url)?.presetId ?? null,
        serverUrl: connection.url,
        organizationId: connection.organizationId,
        connectionId: connection.id,
        httpStatus: diagnostic?.httpStatus ?? null,
        diagnosticCode: diagnostic?.code ?? null,
        reference: diagnostic?.referenceId ?? input.reference,
      })
    } catch {
      // Best effort by design.
    }
  })()
}
