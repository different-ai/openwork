import { deviceShareProviderName, type DeviceShareProvider } from "@openwork/types/den/device-provider-share"
import { gatewayCredentialShape } from "../credential-prompt.js"
import { GatewayWriteError, resolveGatewayCatalog, validateGatewaySettings } from "./gateway-matrix.js"
import { isSupportedGatewayNpm } from "@openwork-ee/gateway-catalog"
import { buildProviderConfigSnapshot } from "./inference-provider-config.js"
import type { ModelsDevProvider } from "./models-dev.js"

export function catalogProviderSharesFromOneKey(catalog: ModelsDevProvider): boolean {
  if (!isSupportedGatewayNpm(catalog.npm)) return false
  if (gatewayCredentialShape(catalog.id, catalog.env)?.kind !== "api_key") return false
  try {
    const config = buildProviderConfigSnapshot(catalog)
    validateGatewaySettings(config, {})
    return resolveGatewayCatalog(catalog, [], config, false).models.length > 0
  } catch (error) {
    if (error instanceof GatewayWriteError) return false
    throw error
  }
}

export function deviceShareProviders(input: {
  providerIds: readonly string[]
  catalog: readonly ModelsDevProvider[]
  existing: readonly { providerId: string; name: string }[]
}): DeviceShareProvider[] {
  return input.providerIds.map((providerId) => {
    const catalog = input.catalog.find((entry) => entry.id === providerId)
    const name = deviceShareProviderName(catalog?.name, providerId)
    const shared = input.existing.find((entry) => entry.providerId === providerId)
    if (shared) return { providerId, name, status: "shared" as const, sharedAs: shared.name }
    return { providerId, name, status: catalog && catalogProviderSharesFromOneKey(catalog) ? "shareable" as const : "unsupported" as const }
  })
}
