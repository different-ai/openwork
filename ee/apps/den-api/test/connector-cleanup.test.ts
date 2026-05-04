import { describe, expect, test } from "bun:test"
import { planConnectorImportedResourceCleanup } from "../src/routes/org/plugin-system/connector-cleanup.js"

describe("connector cleanup planning", () => {
  test("deletes connector-owned plugins and marketplaces when only connector memberships remain", () => {
    const result = planConnectorImportedResourceCleanup({
      activeMarketplaceMemberships: [
        { marketplaceId: "marketplace_1", membershipSource: "connector", pluginId: "plugin_1" },
      ],
      activeMappingPluginIds: [],
      activePluginMembershipPluginIds: [],
      candidateMarketplaceIds: ["marketplace_1"],
      candidatePluginIds: ["plugin_1"],
    })

    expect(result).toEqual({
      marketplaceIdsToDelete: ["marketplace_1"],
      pluginIdsToDelete: ["plugin_1"],
    })
  })

  test("keeps plugins alive when active imported objects remain", () => {
    const result = planConnectorImportedResourceCleanup({
      activeMarketplaceMemberships: [
        { marketplaceId: "marketplace_1", membershipSource: "connector", pluginId: "plugin_1" },
      ],
      activeMappingPluginIds: [],
      activePluginMembershipPluginIds: ["plugin_1"],
      candidateMarketplaceIds: ["marketplace_1"],
      candidatePluginIds: ["plugin_1"],
    })

    expect(result).toEqual({
      marketplaceIdsToDelete: [],
      pluginIdsToDelete: [],
    })
  })

  test("deletes connector-owned sibling plugins through the marketplace tree", () => {
    const result = planConnectorImportedResourceCleanup({
      activeMarketplaceMemberships: [
        { marketplaceId: "marketplace_1", membershipSource: "connector", pluginId: "plugin_1" },
        { marketplaceId: "marketplace_1", membershipSource: "connector", pluginId: "plugin_2" },
      ],
      activeMappingPluginIds: [],
      activePluginMembershipPluginIds: [],
      candidateMarketplaceIds: ["marketplace_1"],
      candidatePluginIds: ["plugin_1", "plugin_2"],
    })

    expect(result).toEqual({
      marketplaceIdsToDelete: ["marketplace_1"],
      pluginIdsToDelete: ["plugin_1", "plugin_2"],
    })
  })

  test("keeps plugins alive when they still have non-connector marketplace dependencies", () => {
    const result = planConnectorImportedResourceCleanup({
      activeMarketplaceMemberships: [
        { marketplaceId: "marketplace_1", membershipSource: "connector", pluginId: "plugin_1" },
        { marketplaceId: "marketplace_2", membershipSource: "manual", pluginId: "plugin_1" },
      ],
      activeMappingPluginIds: [],
      activePluginMembershipPluginIds: [],
      candidateMarketplaceIds: ["marketplace_1"],
      candidatePluginIds: ["plugin_1"],
    })

    expect(result).toEqual({
      marketplaceIdsToDelete: [],
      pluginIdsToDelete: [],
    })
  })
})
