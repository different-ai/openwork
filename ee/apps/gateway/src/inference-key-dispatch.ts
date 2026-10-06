import { MEMBER_FREE_STATUS_PATH, MEMBER_FREE_RESPONSES_PATH } from "@openwork/free-auto"
import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import type { Context } from "hono"
import type { FreeMemberHandler } from "./free/member/handler.js"
import { chatCompletionsPath, isJsonObject, openAiError, type InferenceEnv } from "./inference-http.js"
import type { InferenceKeyRow } from "./middleware/inference-auth.js"

/**
 * Free Auto on a key whose organization pays for OpenWork Models: the Auto status check, or a chat request for the
 * Auto model. Those go to the free handler, which bills the member's free allowance, never the organization.
 */
async function isFreeAutoRequest(request: Request): Promise<boolean> {
  const path = new URL(request.url).pathname
  if (request.method === "GET" && path === MEMBER_FREE_STATUS_PATH) return true
  if (request.method !== "POST" || (path !== chatCompletionsPath && path !== MEMBER_FREE_RESPONSES_PATH)) return false
  try {
    const body: unknown = await request.clone().json()
    return isJsonObject(body) && body.model === INFERENCE_FREE_MODEL_ID
  } catch { return false }
}

export type ModelsKeyRoute = { route: "free" | "models"; key: InferenceKeyRow }

/**
 * Decides who serves a request on the OpenWork Models (`ow_inf_`) route: free inference or paid OpenWork Models.
 * This is the one place per key kind where module checks belong (W0-06).
 */
export async function resolveModelsKeyRoute(c: Context<InferenceEnv>, input: { freeMemberAvailable: boolean }): Promise<ModelsKeyRoute | Response> {
  const identity = c.get("inference")
  if (identity.kind !== "models") return openAiError(401, "invalid_api_key", "An OpenWork Models key is required.")
  const key = identity.key
  const inference = c.get("organization")?.metadata?.inference
  if (!isJsonObject(inference) || inference.enabled !== true) {
    if (input.freeMemberAvailable) return { route: "free", key }
    return openAiError(403, "inference_disabled", "OpenWork Models are not enabled for this organization.")
  }
  if (input.freeMemberAvailable && await isFreeAutoRequest(c.req.raw)) return { route: "free", key }
  return { route: "models", key }
}

export async function handleInferenceKeyRequest(c: Context<InferenceEnv>, handlers: {
  freeMember?: FreeMemberHandler
  models: (c: Context<InferenceEnv>, key: InferenceKeyRow) => Promise<Response>
}): Promise<Response> {
  c.header("x-openwork-request-id", c.get("openworkRequestId"))
  c.header("cache-control", "no-store")
  const resolved = await resolveModelsKeyRoute(c, { freeMemberAvailable: Boolean(handlers.freeMember) })
  if (resolved instanceof Response) return resolved
  if (resolved.route === "free" && handlers.freeMember) return handlers.freeMember(c, resolved.key)
  return handlers.models(c, resolved.key)
}
