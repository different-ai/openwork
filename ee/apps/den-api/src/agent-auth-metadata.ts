import { JWT_BEARER_GRANT_TYPE } from "./workspace-preclaim.js"

export const OPENWORK_AUTH_MD_URL = "https://openworklabs.com/auth.md"

export function withAgentAuthMetadata(metadata: Record<string, unknown>, apiBaseUrl: string): Record<string, unknown> {
  const base = apiBaseUrl.replace(/\/+$/, "")
  const grants = Array.isArray(metadata.grant_types_supported)
    ? metadata.grant_types_supported.filter((grant): grant is string => typeof grant === "string")
    : []
  return {
    ...metadata,
    grant_types_supported: grants.includes(JWT_BEARER_GRANT_TYPE) ? grants : [...grants, JWT_BEARER_GRANT_TYPE],
    agent_auth: {
      skill: OPENWORK_AUTH_MD_URL,
      identity_endpoint: `${base}/v1/bootstrap/workspace`,
      claim_endpoint: `${base}/v1/bootstrap/workspace/{bootstrap_id}/claim`,
      identity_types_supported: ["anonymous"],
    },
  }
}
