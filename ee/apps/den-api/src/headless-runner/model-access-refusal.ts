const MODEL_ACCESS_REFUSALS = new Set([
  "cloud_agent_model_unavailable",
  "cloud_model_unavailable",
  "model_access_unavailable",
  "cloud_agent_gateway_model_unavailable",
  "cloud_agent_gateway_member_not_found",
])

export const isModelAccessRefusal = (error: unknown) => error instanceof Error && MODEL_ACCESS_REFUSALS.has(error.message)
