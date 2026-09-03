import { inferenceBearerKey } from "@openwork-ee/utils/inference-bearer-key"
import { createMiddleware } from "hono/factory"
import type { findActiveInferenceKey as findActiveInferenceKeyFn } from "../keys.js"

export type InferenceKeyRow = NonNullable<Awaited<ReturnType<typeof findActiveInferenceKeyFn>>>

export type InferenceContext = {
  key: InferenceKeyRow
  organizationId: InferenceKeyRow["organization_id"]
  orgMembershipId: InferenceKeyRow["org_membership_id"]
  inferenceKeyId: InferenceKeyRow["id"]
}

export type InferenceAuthVariables = {
  inference: InferenceContext
}

export type InferenceAuthEnv = { Variables: InferenceAuthVariables }

export type InferenceAuthDependencies = {
  findActiveInferenceKey: typeof findActiveInferenceKeyFn
}

export function readInferenceBearerKey(request: Request) {
  const auth = request.headers.get("authorization")
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const value = auth.slice(7).trim()
    return value ? inferenceBearerKey(value) : null
  }
  const value = request.headers.get("x-api-key")?.trim()
  return value ? inferenceBearerKey(value) : null
}

export function inferenceAuth(dependencies: InferenceAuthDependencies) {
  return createMiddleware<InferenceAuthEnv>(async (c, next) => {
    const bearerKey = readInferenceBearerKey(c.req.raw)
    if (!bearerKey) {
      console.error("[inference-proxy] Missing inference API key", { path: c.req.path, method: c.req.method })
      return c.json({ error: { message: "Missing OpenWork inference API key.", type: "authentication_error", code: "missing_api_key" } }, 401)
    }

    const key = await dependencies.findActiveInferenceKey(bearerKey)
    if (!key) {
      console.error("[inference-proxy] Invalid inference API key", { path: c.req.path, method: c.req.method })
      return c.json({ error: { message: "Invalid OpenWork inference API key.", type: "authentication_error", code: "invalid_api_key" } }, 401)
    }

    c.set("inference", {
      key,
      organizationId: key.organization_id,
      orgMembershipId: key.org_membership_id,
      inferenceKeyId: key.id,
    })
    await next()
  })
}
