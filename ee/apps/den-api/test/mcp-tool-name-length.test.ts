import { expect, test } from "bun:test"
import {
  BEDROCK_MAX_TOOL_NAME_LENGTH,
  buildMcpCatalog,
  MAX_CLIENT_PREFIX,
  MAX_TOOL_NAME_LENGTH,
  shortenToolName,
} from "../src/mcp/catalog.js"

// AWS Bedrock's Converse API rejects toolConfig.tools.*.member.toolSpec.name
// longer than 64 chars. MCP clients namespace tools as `<serverName>_<name>`;
// the OpenWork Cloud client uses the `openwork-cloud_` prefix (15 chars), so
// the registered name must stay <= 49 so the prefixed name validates.
const CLIENT_PREFIX = "openwork-cloud_"

test("budget constants leave room for the client prefix", () => {
  expect(CLIENT_PREFIX.length).toBe(MAX_CLIENT_PREFIX)
  expect(MAX_CLIENT_PREFIX + MAX_TOOL_NAME_LENGTH).toBe(BEDROCK_MAX_TOOL_NAME_LENGTH)
})

test("structural shortening drops V1 and path-param markers", () => {
  expect(shortenToolName("getV1Organization")).toBe("getOrganization")
  expect(shortenToolName("deleteV1ConnectorInstancesByConnectorInstanceIdAccessByGrantId")).toBe(
    "deleteConnectorInstancesAccess",
  )
})

test("shortened names stay within the Bedrock budget once prefixed", () => {
  const short = shortenToolName("deleteV1ConnectorInstancesByConnectorInstanceIdAccessByGrantId")
  expect(short.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH)
  expect((CLIENT_PREFIX + short).length).toBeLessThanOrEqual(BEDROCK_MAX_TOOL_NAME_LENGTH)
})

test("near-duplicate operationIds resolve to distinct, readable names", () => {
  const a = shortenToolName("getV1ConnectorInstancesByConnectorInstanceIdAccess")
  const b = shortenToolName("getV1ConnectorInstancesByConnectorInstanceIdConfiguration")
  expect(a).toBe("getConnectorInstancesAccess")
  expect(b).toBe("getConnectorInstancesConfiguration")
  expect(a).not.toBe(b)
})

test("shortening is deterministic", () => {
  const id = "deleteV1MarketplacesByMarketplaceIdPluginsByPluginId"
  expect(shortenToolName(id)).toBe(shortenToolName(id))
})

test("collisions against taken names fall back to a unique suffix", () => {
  const taken = new Set(["getOrganization"])
  const name = shortenToolName("getV1Organization", taken)
  expect(name).not.toBe("getOrganization")
  expect(taken.has(name)).toBe(false)
})

test("every catalog tool name fits Bedrock once client-prefixed", () => {
  // Reproduces the exact paths from Felix's Praxis Medicines Bedrock 400.
  const op = (operationId: string) => ({ operationId, "x-mcp": true })
  const document = {
    paths: {
      "/v1/config-objects/:configObjectId/access/:grantId": {
        delete: op("deleteV1ConfigObjectsByConfigObjectIdAccessByGrantId"),
      },
      "/v1/config-objects/:configObjectId/plugins/:pluginId": {
        delete: op("deleteV1ConfigObjectsByConfigObjectIdPluginsByPluginId"),
      },
      "/v1/connector-instances/:connectorInstanceId/access/:grantId": {
        delete: op("deleteV1ConnectorInstancesByConnectorInstanceIdAccessByGrantId"),
      },
      "/v1/llm-providers/:llmProviderId/access/:accessId": {
        delete: op("deleteV1LlmProvidersByLlmProviderIdAccessByAccessId"),
      },
      "/v1/marketplaces/:marketplaceId/access/:grantId": {
        delete: op("deleteV1MarketplacesByMarketplaceIdAccessByGrantId"),
      },
      "/v1/marketplaces/:marketplaceId/plugins/:pluginId": {
        delete: op("deleteV1MarketplacesByMarketplaceIdPluginsByPluginId"),
      },
      "/v1/plugins/:pluginId/config-objects/:configObjectId": {
        delete: op("deleteV1PluginsByPluginIdConfigObjectsByConfigObjectId"),
      },
      "/v1/config-objects/:configObjectId/versions/:versionId": {
        get: op("getV1ConfigObjectsByConfigObjectIdVersionsByVersionId"),
      },
      "/v1/connector-instances/:connectorInstanceId/access": {
        get: op("getV1ConnectorInstancesByConnectorInstanceIdAccess"),
      },
      "/v1/connector-instances/:connectorInstanceId/configuration": {
        get: op("getV1ConnectorInstancesByConnectorInstanceIdConfiguration"),
      },
    },
  }

  const catalog = buildMcpCatalog(document)
  expect(catalog.length).toBe(10)

  const names = new Set<string>()
  for (const tool of catalog) {
    const prefixed = CLIENT_PREFIX + tool.name
    expect(prefixed.length).toBeLessThanOrEqual(BEDROCK_MAX_TOOL_NAME_LENGTH)
    expect(names.has(tool.name)).toBe(false)
    names.add(tool.name)
  }
})

test("buildMcpCatalog guard throws if a name overflows the Bedrock budget", () => {
  // A pathological operationId that survives structural shortening yet is still
  // far too long must be caught at build time, not in production.
  const tooLong = `getV2${"X".repeat(80)}` // no V1 / ByXId markers to strip
  const document = {
    paths: { "/v2/x": { get: { operationId: tooLong, "x-mcp": true } } },
  }
  expect(() => buildMcpCatalog(document)).toThrow(/too long for Bedrock/)
})
