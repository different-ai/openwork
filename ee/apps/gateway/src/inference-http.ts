import type { InferenceAuthVariables } from "./middleware/inference-auth.js"
import type { OrganizationVariables } from "./middleware/org-context.js"

/** Pieces both the key-kind dispatcher and the OpenWork Models handler use. */
export type InferenceEnv = { Variables: InferenceAuthVariables & OrganizationVariables }
export type JsonObject = Record<string, unknown>

export const chatCompletionsPath = "/api/v1/chat/completions"

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function openAiError(status: number, code: string, message: string) {
  return Response.json({ error: { message, type: "invalid_request_error", code } }, { status })
}
