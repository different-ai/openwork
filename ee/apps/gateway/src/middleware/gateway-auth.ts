import { gatewayBearerKey } from "@openwork-ee/utils/gateway-bearer-key"
import { createMiddleware } from "hono/factory"
import type { findActiveGatewayKey } from "../keys.js"
import { buildRequestId } from "../relay.js"
import { readOpenWorkKey, type InferenceAuthEnv } from "./inference-auth.js"

type GatewayKeyRow = NonNullable<Awaited<ReturnType<typeof findActiveGatewayKey>>>
export type GatewayContext = {
  kind: "gateway"
  organizationId: GatewayKeyRow["organization_id"]
  orgMembershipId: GatewayKeyRow["org_membership_id"]
  gatewayKeyId: GatewayKeyRow["id"]
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
    c.set("inference", { kind: "gateway", organizationId: key.organization_id, orgMembershipId: key.org_membership_id, gatewayKeyId: key.id })
    await next()
    c.res.headers.set("x-openwork-request-id", requestId)
  })
}
