/**
 * What model resolution and token minting throw when the member may not use the model: the Slack and Workbot model
 * policies, the Slack worker's missing installation, and the Gateway (CloudAgentGatewayAccessError and its member
 * lookup). Sending a turn mints a token first, so a send can throw one of these or a plain network error; only these
 * end the work, and anything else is the runner being unreachable.
 */
const MODEL_ACCESS_REFUSALS = new Set([
  "cloud_agent_model_unavailable",
  "cloud_model_unavailable",
  "model_access_unavailable",
  "cloud_agent_gateway_model_unavailable",
  "cloud_agent_gateway_member_not_found",
])

export const isModelAccessRefusal = (error: unknown) => error instanceof Error && MODEL_ACCESS_REFUSALS.has(error.message)
