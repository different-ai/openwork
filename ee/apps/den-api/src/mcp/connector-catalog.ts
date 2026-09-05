import { connectorCatalogSchema, type ConnectorCatalog } from "@openwork/types/connection-action-app"
import { EXTERNAL_MCP_PRESETS } from "../capability-sources/external-mcp-presets.js"
import { openworkOrganizationConnectionsUrl } from "./connection-navigation.js"

export function connectorCatalogForQuery(query: string, showAll = false): ConnectorCatalog | null {
  const setupUrl = (id: string) => {
    const url = new URL(openworkOrganizationConnectionsUrl())
    url.searchParams.set("quickAdd", id)
    return url.toString()
  }
  const entries: ConnectorCatalog["entries"] = [
    { id: "google-workspace", name: "Google Workspace", description: "Gmail, Calendar, and Drive with your work account.", setup: "suite", setupUrl: setupUrl("google-workspace") },
    { id: "microsoft-365", name: "Microsoft 365", description: "Outlook, Calendar, and OneDrive with your work account.", setup: "suite", setupUrl: setupUrl("microsoft-365") },
    ...EXTERNAL_MCP_PRESETS.map(preset => ({
      id: preset.presetId,
      name: preset.displayName,
      description: preset.description,
      serviceUrl: preset.url,
      setup: preset.requiresOAuthClient ? "oauth_client" : preset.authType === "apikey" ? "api_key" : preset.authType === "none" ? "instant" : "oauth",
      setupUrl: setupUrl(preset.presetId),
    } satisfies ConnectorCatalog["entries"][number])),
  ]
  const normalized = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `
  const selectedIds = entries.filter(entry => [entry.id, entry.name].some(value => normalized.includes(` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `))).map(entry => entry.id)
  if (!showAll && selectedIds.length === 0 && !/\b(connectors?|integrations?|quick adds?|quick connect)\b/.test(normalized)) return null
  return connectorCatalogSchema.parse({ version: 1, entries, selectedIds: showAll ? [] : selectedIds })
}
