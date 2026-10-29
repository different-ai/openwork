import { WORKBOT_DEFAULT_MODEL_ID, isWorkbotManagedLuna, type WorkbotModelTest } from "@openwork/types/den/workbot-settings"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps } from "../headless-runner/client.js"
import { workbotModelCatalog, readOrganizationDefaultModel } from "./model.js"
import { cloudAgentGatewayAccess } from "./gateway-model.js"
import { workbotManagedLunaAccess } from "./managed-luna.js"

/** Called only after user-session, feature, sensitive permission and durable diagnostic-rate checks. */
export async function testOrganizationWorkbotModel(organizationId: string, userId: string): Promise<WorkbotModelTest> {
  const actor = { organizationId, userId }
  const catalog = await workbotModelCatalog(actor).catch(() => null)
  const chosen = await readOrganizationDefaultModel(organizationId)
  const requestedModel = chosen ?? catalog?.defaultModel ?? WORKBOT_DEFAULT_MODEL_ID
  const failed = (errorCode: "model_unavailable" | "runner_unavailable"): WorkbotModelTest => ({ status: "failed", errorCode, requestedModel, reportedModel: null })
  if (catalog?.verified !== true || !catalog.models.some((model) => model.id === requestedModel)) return failed("model_unavailable")
  const deps = defaultHeadlessRunnerDeps()
  if (!deps) return failed("runner_unavailable")
  const modelAccess = await (isWorkbotManagedLuna(requestedModel) ? workbotManagedLunaAccess : cloudAgentGatewayAccess)(actor, requestedModel).catch(() => null)
  if (modelAccess === null) return failed("model_unavailable")
  return await createHeadlessRunnerClient(deps).testModel(requestedModel, modelAccess).catch(() => null) ?? failed("runner_unavailable")
}
