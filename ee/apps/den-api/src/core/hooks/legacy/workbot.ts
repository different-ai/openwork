import { WORKBOT_OAUTH_CLIENT_ID } from "../../../workbot/config.js"
import { ensureWorkbotOAuthClient } from "../../../workbot/oauth-client.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: workbot.

// Workbot's first-party client follows DEN_WORKBOT_URL; created on its first sign-in.
coreHooks.registerMiddleware({
  point: "oauth.firstPartyClients",
  id: "legacy/workbot/ensure-oauth-client",
  registrant: "legacy",
  handler: async ({ clientId, adapter }) => {
    if (clientId === WORKBOT_OAUTH_CLIENT_ID) {
      await ensureWorkbotOAuthClient(adapter)
    }
  },
})

// Platform-owned metadata; always reserved, whatever the module state.
coreHooks.registerBootContributor({
  point: "org.reservedMetadataKeys",
  id: "legacy/workbot/reserved-metadata-keys",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security + 5,
  contribute: () => ({ capabilityKeys: ["workbot"] }),
})
