import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { uniqueIds } from "./connector-cleanup.js"

export type ManagedCleanupObjectType = "mcp" | "skill"

export type ManagedConfigObjectVersion = {
  normalizedPayloadJson: unknown
}

type SkillId = DenTypeId<"skill">
type ExternalMcpConnectionId = DenTypeId<"externalMcpConnection">

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function denSkillIdFromConfigObjectVersion(row: ManagedConfigObjectVersion | undefined): SkillId | null {
  const payload = row?.normalizedPayloadJson
  if (!isRecord(payload) || payload.openworkManaged !== "den_skill" || typeof payload.denSkillId !== "string") {
    return null
  }
  try {
    return normalizeDenTypeId("skill", payload.denSkillId)
  } catch {
    return null
  }
}

export function externalMcpConnectionIdsFromPayload(payload: unknown, options?: { ownedOnly?: boolean }): string[] {
  const ids = new Set<string>()
  const collect = (value: unknown) => {
    if (!isRecord(value) || value.openworkManaged !== "den_external_mcp") return
    if (options?.ownedOnly === true && value.externalMcpConnectionOwnedByPlugin !== true) return
    if (typeof value.externalMcpConnectionId === "string" && value.externalMcpConnectionId.trim()) {
      ids.add(value.externalMcpConnectionId.trim())
    }
  }

  collect(payload)
  if (isRecord(payload)) {
    const containers = [
      isRecord(payload.mcpServers) ? payload.mcpServers : null,
      isRecord(payload.mcp) ? payload.mcp : null,
    ].filter((entry): entry is Record<string, unknown> => Boolean(entry))
    for (const container of containers) {
      for (const value of Object.values(container)) collect(value)
    }
  }
  return [...ids]
}

function normalizedExternalMcpConnectionIdsFromPayload(payload: unknown, options?: { ownedOnly?: boolean }): ExternalMcpConnectionId[] {
  const ids: ExternalMcpConnectionId[] = []
  for (const value of externalMcpConnectionIdsFromPayload(payload, options)) {
    try {
      ids.push(normalizeDenTypeId("externalMcpConnection", value))
    } catch {
      // Ignore stale or malformed managed payload metadata.
    }
  }
  return uniqueIds(ids)
}

function externalMcpConnectionIdsFromConfigObjectVersion(row: ManagedConfigObjectVersion | undefined, options?: { ownedOnly?: boolean }): ExternalMcpConnectionId[] {
  return normalizedExternalMcpConnectionIdsFromPayload(row?.normalizedPayloadJson, options)
}

export function planManagedImportedConfigObjectCleanup(input: {
  active: Array<{ latestVersion: ManagedConfigObjectVersion | undefined; objectType: ManagedCleanupObjectType }>
  deleting: Array<{ latestVersion: ManagedConfigObjectVersion | undefined; objectType: ManagedCleanupObjectType }>
}) {
  const activeSkillIds = new Set(input.active.flatMap((entry) => {
    if (entry.objectType !== "skill") return []
    const skillId = denSkillIdFromConfigObjectVersion(entry.latestVersion)
    return skillId ? [skillId] : []
  }))
  const activeExternalMcpConnectionIds = new Set(input.active.flatMap((entry) => {
    if (entry.objectType !== "mcp") return []
    return externalMcpConnectionIdsFromConfigObjectVersion(entry.latestVersion)
  }))

  return {
    externalMcpConnectionIds: uniqueIds(input.deleting.flatMap((entry) => {
      if (entry.objectType !== "mcp") return []
      return externalMcpConnectionIdsFromConfigObjectVersion(entry.latestVersion, { ownedOnly: true })
        .filter((connectionId) => !activeExternalMcpConnectionIds.has(connectionId))
    })),
    skillIds: uniqueIds(input.deleting.flatMap((entry) => {
      if (entry.objectType !== "skill") return []
      const skillId = denSkillIdFromConfigObjectVersion(entry.latestVersion)
      return skillId && !activeSkillIds.has(skillId) ? [skillId] : []
    })),
  }
}
