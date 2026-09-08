import { inferenceBearerKey } from "@openwork-ee/utils/inference-bearer-key"
import { createMiddleware } from "hono/factory"
import type { findActiveInferenceKey as findActiveInferenceKeyFn } from "../keys.js"
import { buildRequestId } from "../relay.js"

export type InferenceKeyRow = NonNullable<Awaited<ReturnType<typeof findActiveInferenceKeyFn>>>

export type InferenceContext = {
  key: InferenceKeyRow
  organizationId: InferenceKeyRow["organization_id"]
  orgMembershipId: InferenceKeyRow["org_membership_id"]
  inferenceKeyId: InferenceKeyRow["id"]
}

export type InferenceAuthVariables = {
  inference: InferenceContext
  openworkRequestId: string
}

export type InferenceAuthEnv = { Variables: InferenceAuthVariables }

export type InferenceAuthDependencies = {
  findActiveInferenceKey: typeof findActiveInferenceKeyFn
}

export function readInferenceBearerKey(request: Request) {
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
  return candidates.length ? inferenceBearerKey(candidates[0]) : null
}

export function inferenceAuth(dependencies: InferenceAuthDependencies) {
  return createMiddleware<InferenceAuthEnv>(async (c, next) => {
    const requestId = buildRequestId()
    c.set("openworkRequestId", requestId)
    c.header("x-openwork-request-id", requestId)
    let bearerKey
    try { bearerKey = readInferenceBearerKey(c.req.raw) } catch {
      return c.json({ error: { message: "Conflicting or malformed OpenWork credentials.", type: "authentication_error", code: "ambiguous_api_key" } }, 401)
    }
    if (!bearerKey) {
      console.error("[gateway-proxy] Missing Gateway API key", { path: c.req.path, method: c.req.method })
      return c.json({ error: { message: "Missing OpenWork Gateway API key.", type: "authentication_error", code: "missing_api_key" } }, 401)
    }

    const key = await dependencies.findActiveInferenceKey(bearerKey)
    if (!key) {
      console.error("[gateway-proxy] Invalid Gateway API key", { path: c.req.path, method: c.req.method })
      return c.json({ error: { message: "Invalid OpenWork Gateway API key.", type: "authentication_error", code: "invalid_api_key" } }, 401)
    }

    c.set("inference", {
      key,
      organizationId: key.organization_id,
      orgMembershipId: key.org_membership_id,
      inferenceKeyId: key.id,
    })
    await next()
    c.res.headers.set("x-openwork-request-id", requestId)
  })
}
