export const DASHBOARD_ACTIVITY_LIMIT = 5

export type DashboardActivityTarget =
  | { type: "connection"; connectionId: string }
  | { type: "llm_provider"; llmProviderId: string }
  | { type: "gateway_provider"; inferenceProviderId: string }
  | { type: "marketplace"; marketplaceId: string }
  | { type: "skill"; pluginId: string; skillId: string }

export type DashboardActivityEntry = {
  id: string
  kind: "connection" | "skill" | "plugin" | "provider"
  title: string
  detail: string
  occurredAt: string
  target: DashboardActivityTarget
  logo?: { name: string; url?: string; providerId?: string }
}

export type DashboardActivitySources = {
  connections: ReadonlyArray<{ id: string; name: string; url: string | null; createdAt: Date }>
  llmProviders: ReadonlyArray<{ id: string; name: string; providerId: string; createdAt: Date }>
  gatewayProviders: ReadonlyArray<{ id: string; name: string; providerId: string; createdAt: Date }>
  pluginAttachments: ReadonlyArray<{
    id: string
    createdAt: Date
    pluginName: string
    marketplaceId: string
    marketplaceName: string
    skillCount: number
  }>
  skillVersions: ReadonlyArray<{
    id: string
    createdAt: Date
    skillId: string
    skillTitle: string
    pluginId: string
    pluginName: string
  }>
}

function validDate(value: Date) {
  return Number.isFinite(value.getTime())
}

export function newestDashboardActivity(entries: readonly DashboardActivityEntry[], limit = DASHBOARD_ACTIVITY_LIMIT): DashboardActivityEntry[] {
  const unique = new Map<string, DashboardActivityEntry>()
  for (const entry of entries) {
    if (Number.isFinite(Date.parse(entry.occurredAt))) unique.set(entry.id, entry)
  }
  return [...unique.values()]
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || left.id.localeCompare(right.id))
    .slice(0, limit)
}

export function buildDashboardActivity(sources: DashboardActivitySources): DashboardActivityEntry[] {
  const entries: DashboardActivityEntry[] = []
  for (const connection of sources.connections) {
    if (!validDate(connection.createdAt)) continue
    entries.push({
      id: `connection:${connection.id}`,
      kind: "connection",
      title: `${connection.name} was added`,
      detail: "Connection",
      occurredAt: connection.createdAt.toISOString(),
      target: { type: "connection", connectionId: connection.id },
      logo: { name: connection.name, ...(connection.url ? { url: connection.url } : {}) },
    })
  }
  for (const provider of sources.llmProviders) {
    if (!validDate(provider.createdAt)) continue
    entries.push({
      id: `provider:legacy:${provider.id}`,
      kind: "provider",
      title: `${provider.name} was added`,
      detail: "Model provider",
      occurredAt: provider.createdAt.toISOString(),
      target: { type: "llm_provider", llmProviderId: provider.id },
      logo: { name: provider.name, providerId: provider.providerId },
    })
  }
  for (const provider of sources.gatewayProviders) {
    if (!validDate(provider.createdAt)) continue
    entries.push({
      id: `provider:gateway:${provider.id}`,
      kind: "provider",
      title: `${provider.name} was added`,
      detail: "Model provider",
      occurredAt: provider.createdAt.toISOString(),
      target: { type: "gateway_provider", inferenceProviderId: provider.id },
      logo: { name: provider.name, providerId: provider.providerId },
    })
  }
  for (const attachment of sources.pluginAttachments) {
    if (!validDate(attachment.createdAt)) continue
    entries.push({
      id: `plugin:${attachment.id}`,
      kind: "plugin",
      title: `${attachment.pluginName} was added to the ${attachment.marketplaceName} marketplace`,
      detail: `Plugin with ${attachment.skillCount} ${attachment.skillCount === 1 ? "skill" : "skills"}`,
      occurredAt: attachment.createdAt.toISOString(),
      target: { type: "marketplace", marketplaceId: attachment.marketplaceId },
    })
  }
  for (const version of sources.skillVersions) {
    if (!validDate(version.createdAt)) continue
    entries.push({
      id: `skill:${version.id}`,
      kind: "skill",
      title: `A new version of ${version.skillTitle} was published`,
      detail: `Skill in ${version.pluginName}`,
      occurredAt: version.createdAt.toISOString(),
      target: { type: "skill", pluginId: version.pluginId, skillId: version.skillId },
    })
  }
  return newestDashboardActivity(entries)
}

export function pickSkillParents<T extends { skillId: string }>(rows: readonly T[]): Map<string, T> {
  const parents = new Map<string, T>()
  for (const row of rows) {
    if (!parents.has(row.skillId)) parents.set(row.skillId, row)
  }
  return parents
}
