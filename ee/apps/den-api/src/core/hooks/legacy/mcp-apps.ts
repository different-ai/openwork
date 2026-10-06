import { appMcpServersEnabled } from "../../../mcp-app-rollout.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: mcpApps.

// Building your own Apps is on for every organization unless the deployment
// or the org's member-facing MCP connections turn it off.
coreHooks.registerContributor({
  point: "org.context",
  id: "legacy/mcp-apps/org-context-capability",
  registrant: "legacy",
  // Today a failure here is a 500; keep it.
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 6,
  contribute: async ({ metadata }) => ({ capabilities: { appMcpServers: appMcpServersEnabled(metadata) } }),
})
