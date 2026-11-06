import type { HeadlessModelAccess, HeadlessModelCatalog } from "@openwork-ee/headless-protocol"
import { WORKBOT_DEFAULT_MODEL_ID } from "@openwork/types/den/workbot-settings"
import { cloudAgentGatewayAccess, cloudAgentGatewayCatalog, CloudAgentGatewayAccessError, type CloudAgentGatewayActor } from "./gateway-model.js"
import { cloudAgentLegacyAccess, cloudAgentLegacyCatalog, isLegacyCloudModelId, legacyCloudModelId } from "./legacy-model.js"

export type CloudAgentModelService = {
  catalog: (actor: CloudAgentGatewayActor) => Promise<HeadlessModelCatalog>
  access: (actor: CloudAgentGatewayActor, model: string) => Promise<HeadlessModelAccess>
}

/** Keep exact Gateway aliases and explicit legacy record identities; never guess from a vendor/model name. */
export function headlessExplicitModelId(model: { providerId: string; modelId: string }): string {
  return model.providerId.startsWith("lpr_") ? legacyCloudModelId(model.providerId, model.modelId) : model.modelId
}

export function createCloudAgentModelService(gateway: CloudAgentModelService, legacy: CloudAgentModelService): CloudAgentModelService {
  return {
    async catalog(actor) {
      const [gatewayCatalog, legacyCatalog] = await Promise.all([
        gateway.catalog(actor).catch(error => {
          // A legacy-only deployment need not configure Gateway. All other failures stay failures.
          if (!(error instanceof CloudAgentGatewayAccessError) || error.reason !== "gateway_not_configured") throw error
          return { models: [], defaultModel: WORKBOT_DEFAULT_MODEL_ID, verified: true }
        }),
        legacy.catalog(actor),
      ])
      const defaultModel = gatewayCatalog.models.some(model => model.id === gatewayCatalog.defaultModel)
        ? gatewayCatalog.defaultModel : legacyCatalog.defaultModel
      return { defaultModel, models: [...gatewayCatalog.models, ...legacyCatalog.models], verified: true }
    },
    access: (actor, model) => isLegacyCloudModelId(model) ? legacy.access(actor, model) : gateway.access(actor, model),
  }
}
const service = createCloudAgentModelService(
  { catalog: cloudAgentGatewayCatalog, access: cloudAgentGatewayAccess },
  { catalog: cloudAgentLegacyCatalog, access: cloudAgentLegacyAccess },
)
export const cloudAgentCatalog = service.catalog
export const cloudAgentAccess = service.access
