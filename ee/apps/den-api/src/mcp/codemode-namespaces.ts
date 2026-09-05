import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  listUsableExternalMcpConnections,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import {
  listNativeProviderUsableEntries,
  type NativeProviderConnectionEntry,
} from "../capability-sources/native-provider-connections.js"

export type NamedConnection = { id: string; name: string }

const RESERVED_CODEMODE_NAMESPACES = ["den", "skills", "marketplace", "admin", "$codemode", "__proto__", "constructor", "prototype"]
const IDENTIFIER_PATTERN = /^[a-z_$][a-z0-9_$]*$/i

export function codemodeScriptPath(namespace: string, toolName: string): string {
  return IDENTIFIER_PATTERN.test(toolName)
    ? `tools.${namespace}.${toolName}`
    : `tools.${namespace}[${JSON.stringify(toolName)}]`
}

export function sanitizeNamespaceSegment(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_")
  if (!sanitized) return "_"
  return /^[a-z_]/.test(sanitized) ? sanitized : `_${sanitized}`
}

function allocateNamespaceMap(
  connections: readonly NamedConnection[],
  used: Set<string>,
): Map<string, string> {
  const namespaces = new Map<string, string>()
  for (const connection of connections) {
    const base = sanitizeNamespaceSegment(connection.name)
    let namespace = base
    let suffix = 2
    while (used.has(namespace)) {
      namespace = `${base}_${suffix}`
      suffix += 1
    }
    used.add(namespace)
    namespaces.set(connection.id, namespace)
  }
  return namespaces
}

export function buildExternalNamespaceMap(connections: readonly NamedConnection[]): Map<string, string> {
  return allocateNamespaceMap(connections, new Set(RESERVED_CODEMODE_NAMESPACES))
}

export type CodemodeConnectionNamespaceMaps = {
  native: Map<string, string>
  externalMcp: Map<string, string>
}

export function buildCodemodeConnectionNamespaceMaps(input: {
  native: readonly NamedConnection[]
  externalMcp: readonly NamedConnection[]
}): CodemodeConnectionNamespaceMaps {
  const used = new Set(RESERVED_CODEMODE_NAMESPACES)
  return {
    native: allocateNamespaceMap(input.native, used),
    externalMcp: allocateNamespaceMap(input.externalMcp, used),
  }
}

export function isCodemodeEligibleConnection(
  connection: Pick<ExternalMcpConnectionRow, "toolPolicy" | "oauthIssuerReviewRequiredAt">,
): boolean {
  return !connection.toolPolicy?.allDisabled && !connection.oauthIssuerReviewRequiredAt
}

export type CodemodeConnectionNamespaceContext = {
  nativeProviderEntries: NativeProviderConnectionEntry[]
  externalMcpConnections: ExternalMcpConnectionRow[]
  codemodeNativeProviderEntries: NativeProviderConnectionEntry[]
  codemodeExternalMcpConnections: ExternalMcpConnectionRow[]
  namespaces: CodemodeConnectionNamespaceMaps
}

type CodemodeMemberIdentity = {
  orgMembershipId: DenTypeId<"member">
  teamIds: DenTypeId<"team">[]
}

export async function resolveCodemodeConnectionNamespaceContext(input: {
  organizationId: string
  member: CodemodeMemberIdentity | null
  includeExternalMcp?: boolean
}): Promise<CodemodeConnectionNamespaceContext> {
  if (!input.member) {
    return {
      nativeProviderEntries: [],
      externalMcpConnections: [],
      codemodeNativeProviderEntries: [],
      codemodeExternalMcpConnections: [],
      namespaces: buildCodemodeConnectionNamespaceMaps({ native: [], externalMcp: [] }),
    }
  }

  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const [nativeProviderEntries, externalMcpConnections] = await Promise.all([
    listNativeProviderUsableEntries({
      organizationId,
      orgMembershipId: input.member.orgMembershipId,
      teamIds: input.member.teamIds,
    }),
    input.includeExternalMcp === false
      ? Promise.resolve([])
      : listUsableExternalMcpConnections({
        organizationId,
        orgMembershipId: input.member.orgMembershipId,
        teamIds: input.member.teamIds,
      }),
  ])
  const codemodeNativeProviderEntries = nativeProviderEntries.filter((entry) => entry.connectedForMe === true)
  // Search chooses a bounded, query-ranked set to probe. Workflow namespaces
  // must include every eligible connection, including those found beyond that
  // search batch. Tool discovery already has a shared deadline and worker pool.
  const codemodeExternalMcpConnections = externalMcpConnections.filter(isCodemodeEligibleConnection)

  return {
    nativeProviderEntries,
    externalMcpConnections,
    codemodeNativeProviderEntries,
    codemodeExternalMcpConnections,
    namespaces: buildCodemodeConnectionNamespaceMaps({
      native: codemodeNativeProviderEntries,
      externalMcp: codemodeExternalMcpConnections,
    }),
  }
}
