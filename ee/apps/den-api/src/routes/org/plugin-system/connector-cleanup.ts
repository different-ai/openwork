export type ConnectorCleanupMarketplaceMembership<TPluginId extends string = string, TMarketplaceId extends string = string> = {
  marketplaceId: TMarketplaceId
  membershipSource: "api" | "connector" | "manual" | "system"
  pluginId: TPluginId
}

export function uniqueIds<TId extends string>(values: TId[]) {
  return [...new Set(values)]
}

export function planConnectorImportedResourceCleanup<TPluginId extends string, TMarketplaceId extends string>(input: {
  activeMarketplaceMemberships: Array<ConnectorCleanupMarketplaceMembership<TPluginId, TMarketplaceId>>
  activeMappingPluginIds: TPluginId[]
  activePluginMembershipPluginIds: TPluginId[]
  candidateMarketplaceIds: TMarketplaceId[]
  candidatePluginIds: TPluginId[]
}) {
  const candidateMarketplaceIds = uniqueIds(input.candidateMarketplaceIds)
  const candidatePluginIds = uniqueIds(input.candidatePluginIds)
  const candidateMarketplaceIdSet = new Set(candidateMarketplaceIds)
  const activeMappingPluginIdSet = new Set(input.activeMappingPluginIds)
  const activePluginMembershipPluginIdSet = new Set(input.activePluginMembershipPluginIds)

  const marketplaceMembershipsByPlugin = new Map<TPluginId, Array<ConnectorCleanupMarketplaceMembership<TPluginId, TMarketplaceId>>>()
  const marketplaceMembershipsByMarketplace = new Map<TMarketplaceId, Array<ConnectorCleanupMarketplaceMembership<TPluginId, TMarketplaceId>>>()
  for (const membership of input.activeMarketplaceMemberships) {
    const membershipsForPlugin = marketplaceMembershipsByPlugin.get(membership.pluginId) ?? []
    membershipsForPlugin.push(membership)
    marketplaceMembershipsByPlugin.set(membership.pluginId, membershipsForPlugin)

    const membershipsForMarketplace = marketplaceMembershipsByMarketplace.get(membership.marketplaceId) ?? []
    membershipsForMarketplace.push(membership)
    marketplaceMembershipsByMarketplace.set(membership.marketplaceId, membershipsForMarketplace)
  }

  const pluginIdsToDelete = candidatePluginIds.filter((pluginId) => {
    if (activeMappingPluginIdSet.has(pluginId) || activePluginMembershipPluginIdSet.has(pluginId)) {
      return false
    }

    const activeMarketplaceMemberships = marketplaceMembershipsByPlugin.get(pluginId) ?? []
    const hasNonConnectorDependency = activeMarketplaceMemberships.some((membership) => (
      !candidateMarketplaceIdSet.has(membership.marketplaceId) || membership.membershipSource !== "connector"
    ))
    return !hasNonConnectorDependency
  })
  const pluginIdsToDeleteSet = new Set(pluginIdsToDelete)

  const marketplaceIdsToDelete = candidateMarketplaceIds.filter((marketplaceId) => {
    const memberships = marketplaceMembershipsByMarketplace.get(marketplaceId) ?? []
    return memberships.every((membership) => pluginIdsToDeleteSet.has(membership.pluginId))
  })

  return {
    marketplaceIdsToDelete,
    pluginIdsToDelete,
  }
}
