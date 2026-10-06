import type { AuditChangeEventInput } from "../request-capture.js"
import { auditResourceId } from "../request-capture.js"
import { auditChangeEvent, auditText, organizationParent, relatedResource, targetResource } from "./snapshot.js"

// oauth_token.issued / oauth_token.revoked (change) for MCP OAuth tokens bound
// to an organization (the consent referenceId, carried as the token's org
// claim). Recorded in that organization with the token's user as actor. The
// snapshot holds the client id, scope list, grant type and MCP resource only:
// never access/refresh token values, authorization codes, client secrets or
// any hash of them. Target: the MCP grant (oauth_consent id) when known, else
// the client.

export type OAuthTokenAuditFacts = Readonly<{
  organizationId: string
  memberId: string
  clientId: string
  scopes: readonly string[]
  grantType: string | null
  resource: string | null
  /** oauth_consent id (the MCP grant claim), when found. */
  grantId: string | null
  tokenType?: "access_token" | "refresh_token"
}>

const SCOPE = /^[A-Za-z0-9_.:/-]{1,64}$/
const GRANT_TYPE = /^[A-Za-z0-9_.:-]{1,64}$/

function snapshot(facts: OAuthTokenAuditFacts) {
  const grantType = facts.grantType && GRANT_TYPE.test(facts.grantType) ? facts.grantType : null
  const resource = auditText(facts.resource)
  return {
    clientId: auditText(facts.clientId),
    scopes: [...new Set(facts.scopes.filter((scope) => SCOPE.test(scope)))].sort(),
    ...(grantType ? { grantType } : {}),
    ...(resource ? { resource } : {}),
    ...(facts.tokenType ? { tokenType: facts.tokenType } : {}),
  }
}

function resources(facts: OAuthTokenAuditFacts) {
  const target = facts.grantId ? targetResource("oauth_consent", auditResourceId(facts.grantId)) : targetResource("oauth_client", auditResourceId(facts.clientId))
  return [target, relatedResource("member", facts.memberId), organizationParent(facts.organizationId)]
}

export function oauthTokenIssuedEvent(facts: OAuthTokenAuditFacts): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "oauth_token.issued", resources: resources(facts), before: null, after: snapshot(facts) })
}

export function oauthTokenRevokedEvent(facts: OAuthTokenAuditFacts): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "oauth_token.revoked", resources: resources(facts), before: snapshot(facts), after: null })
}
