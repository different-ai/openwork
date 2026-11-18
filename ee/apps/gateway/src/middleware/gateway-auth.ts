import { gatewayBearerKey } from "@openwork-ee/utils/gateway-bearer-key"
import { createMiddleware } from "hono/factory"
import type { ActiveGatewayKey, findActiveGatewayKey } from "../keys.js"
import { buildRequestId } from "../relay.js"
import { readOpenWorkKey, type InferenceAuthEnv } from "./inference-auth.js"

type MemberKey = Extract<ActiveGatewayKey, { source: "member" }>
type ApiKey = Extract<ActiveGatewayKey, { source: "api_key" }>

/**
 * A Gateway caller: always a member, through either the key OpenWork issued to their own apps
 * (`keySource: "member"`, a gky_ id) or a key they created for 3rd party tools (`"api_key"`, a gak_ id).
 */
export type GatewayContext = {
  kind: "gateway"
  organizationId: ActiveGatewayKey["organization_id"]
  orgMembershipId: ActiveGatewayKey["org_membership_id"]
} & (
  | { keySource: "member"; gatewayKeyId: MemberKey["id"] }
  | { keySource: "api_key"; gatewayKeyId: ApiKey["id"] }
)

export function gatewayContextFor(key: ActiveGatewayKey): GatewayContext {
  const base = { kind: "gateway" as const, organizationId: key.organization_id, orgMembershipId: key.org_membership_id }
  return key.source === "api_key"
    ? { ...base, keySource: "api_key", gatewayKeyId: key.id }
    : { ...base, keySource: "member", gatewayKeyId: key.id }
}

export function gatewayAuth(dependencies: { findActiveGatewayKey: typeof findActiveGatewayKey }) {
  return createMiddleware<InferenceAuthEnv>(async (c, next) => {
    const requestId = buildRequestId()
    c.set("openworkRequestId", requestId)
    c.header("x-openwork-request-id", requestId)
    let bearer
    try {
      const value = readOpenWorkKey(c.req.raw)
      bearer = value === null ? null : gatewayBearerKey(value)
    } catch {
      return c.json({ error: { code: "invalid_api_key", type: "authentication_error", message: "A valid OpenWork Gateway key is required." } }, 401)
    }
    if (!bearer) return c.json({ error: { code: "missing_api_key", type: "authentication_error", message: "Missing OpenWork Gateway key." } }, 401)
    const key = await dependencies.findActiveGatewayKey(bearer)
    if (!key) return c.json({ error: { code: "invalid_api_key", type: "authentication_error", message: "Invalid OpenWork Gateway key." } }, 401)
    c.set("inference", gatewayContextFor(key))
    await next()
    c.res.headers.set("x-openwork-request-id", requestId)
  })
}
