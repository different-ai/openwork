import { inferenceBearerKey } from "@openwork-ee/utils/inference-bearer-key"
import { createMiddleware } from "hono/factory"
import type { findActiveInferenceKey as findActiveInferenceKeyFn } from "../keys.js"
import type { GatewayContext } from "./gateway-auth.js"
import { buildRequestId } from "../relay.js"

export type InferenceKeyRow = NonNullable<Awaited<ReturnType<typeof findActiveInferenceKeyFn>>>

export type InferenceContext = {
  kind: "models"
  key: InferenceKeyRow
  organizationId: InferenceKeyRow["organization_id"]
  orgMembershipId: InferenceKeyRow["org_membership_id"]
  inferenceKeyId: InferenceKeyRow["id"]
}

export type InferenceAuthVariables = {
  inference: InferenceContext | GatewayContext
  openworkRequestId: string
}

export type InferenceAuthEnv = { Variables: InferenceAuthVariables }

export type InferenceAuthDependencies = {
  findActiveInferenceKey: typeof findActiveInferenceKeyFn
}

export function readOpenWorkKey(request: Request) {
  const auth = request.headers.get("authorization")
  const candidates = ["x-api-key", "x-goog-api-key", "api-key"].flatMap((name) => {
    const value = request.headers.get(name)
    return value === null ? [] : [value.trim()]
  })
  if (auth !== null) candidates.push(/^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? "")
  // Google SDK query auth carries the OpenWork key, never an upstream key.
  candidates.push(...new URL(request.url).searchParams.getAll("key"))
  if (candidates.some((value) => !value || /[\s,]/.test(value)) || new Set(candidates).size > 1) {
    throw new Error("ambiguous_api_key")
  }
  return candidates.length ? candidates[0] : null
}

export function readInferenceBearerKey(request: Request) {
  const value = readOpenWorkKey(request)
  if (value?.startsWith("ow_gw_")) throw new Error("invalid_api_key")
  return value ? inferenceBearerKey(value) : null
}

export function inferenceAuth(dependencies: InferenceAuthDependencies) {
  return createMiddleware<InferenceAuthEnv>(async (c, next) => {
    const requestId = buildRequestId()
    c.set("openworkRequestId", requestId)
    c.header("x-openwork-request-id", requestId)
    let bearerKey
    try { bearerKey = readInferenceBearerKey(c.req.raw) } catch (error) {
      if (error instanceof Error && error.message === "invalid_api_key") {
        return c.json({ error: { message: "An OpenWork Models key is required.", type: "authentication_error", code: "invalid_api_key" } }, 401)
      }
      return c.json({ error: { message: "Conflicting or malformed OpenWork credentials.", type: "authentication_error", code: "ambiguous_api_key" } }, 401)
    }
    if (!bearerKey) {
      return c.json({ error: { message: "Missing OpenWork Models API key.", type: "authentication_error", code: "missing_api_key" } }, 401)
    }

    const key = await dependencies.findActiveInferenceKey(bearerKey)
    if (!key) {
      return c.json({ error: { message: "Invalid OpenWork Models API key.", type: "authentication_error", code: "invalid_api_key" } }, 401)
    }

    c.set("inference", {
      kind: "models",
      key,
      organizationId: key.organization_id,
      orgMembershipId: key.org_membership_id,
      inferenceKeyId: key.id,
    })
    await next()
    c.res.headers.set("x-openwork-request-id", requestId)
  })
}
