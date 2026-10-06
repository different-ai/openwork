import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: versionPinning.

coreHooks.registerContributor({
  point: "me.desktopConfig",
  id: "legacy/version-pinning/desktop-config-allowed-versions",
  registrant: "legacy",
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 4,
  contribute: async ({ normalizedMetadata }) => (Array.isArray(normalizedMetadata.allowedDesktopVersions)
    ? { allowedDesktopVersions: normalizedMetadata.allowedDesktopVersions }
    : {}),
})
