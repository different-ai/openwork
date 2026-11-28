import { COMPUTER_CONNECTION_ID, COMPUTER_CONNECTION_NAME, COMPUTER_CONNECTION_TOOLS, personalAgentConnectorState } from "./connector-access.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentToolCatalog, PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import { externalMcpConnectionReadyForMember, listUsableExternalMcpConnections, type ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { externalMcpCompatibleCallbackUrl } from "../capability-sources/external-mcp-oauth-contract.js"
import { getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { evaluateToolPolicy } from "../capability-sources/external-mcp-tool-policy.js"
import { listNativeProviderUsableEntries } from "../capability-sources/native-provider-connections.js"
import { organizationFeatureEnabled } from "../features.js"
import { listTeamsForMember } from "../member-teams.js"
import { evaluateToolPermission } from "../tool-permissions/evaluate.js"
import { readSubjectToolPolicies } from "../tool-permissions/rules.js"
import { catalogOperationAvailableToCapabilities, filterGmailThreadRead, filterPersonalAgents } from "../mcp/catalog-availability.js"
import type { McpToolOperation } from "../mcp/catalog.js"
import { isCredentialBoundNativeOperation } from "../mcp/codemode-tools.js"
import { externalToolsSearchCacheKey } from "../mcp/external-capabilities.js"
import { getExternalToolsSearchCache, setExternalToolsSearchCache } from "../mcp/external-tools-search-cache.js"
import { nativeOperations } from "../mcp/native-capabilities.js"
import { env } from "../env.js"
import { OPENWORK_CONNECTION_ID, OPENWORK_CONNECTION_NAME, operationTool } from "./builtin-connection.js"
import { canManagePersonalAgent, type PersonalAgentAccess, type PersonalAgentCaller } from "./access.js"
import { organizationToolRule, personalAgentOrganizationRules, personalAgentToolRule } from "./org-rules.js"
import { personalAgentSharedLogins, sharedLoginPerson, supportsPersonalAgentSharedLogin } from "./shared-logins.js"
import { personalAgentToolIsReadOnly, personalAgentToolTitle } from "./permissions-policy.js"

export async function personalAgentUsableConnections(caller: PersonalAgentCaller) {
  const organizationId = normalizeDenTypeId("organization", caller.organizationId)
  const orgMembershipId = normalizeDenTypeId("member", caller.memberId)
  const teams = await listTeamsForMember({ organizationId, memberId: orgMembershipId })
  return listUsableExternalMcpConnections({ organizationId, orgMembershipId, teamIds: teams.map((team) => team.id) })
}

export async function personalAgentConnectionTools(caller: PersonalAgentCaller, connection: ExternalMcpConnectionRow) {
  const orgMembershipId = normalizeDenTypeId("member", caller.memberId)
  if (!await externalMcpConnectionReadyForMember(connection, orgMembershipId)) return { available: false, tools: [] }
  try {
    const client = connection.authType === "oauth" ? await getOrgOAuthClient(connection.organizationId, connection.id) : null
    const registered = client?.extra?.registeredRedirectUri
    const redirect = connection.authType !== "oauth" ? "http://127.0.0.1/unused-mcp-oauth-callback" : externalMcpCompatibleCallbackUrl({
      connectionId: connection.id, callbackMode: connection.oauthConfiguration?.callbackMode ?? "legacy-v1", createdAt: connection.createdAt,
      registeredRedirectUri: typeof registered === "string" ? registered : null,
    })
    const cacheKey = externalToolsSearchCacheKey(connection, { orgMembershipId, teamIds: [] })
    const cached = cacheKey ? getExternalToolsSearchCache(cacheKey) : undefined
    const tools = cached?.outcome === "success" ? cached.tools
      : await listExternalMcpTools(connection, redirect, connection.credentialMode === "per_member" ? { orgMembershipId } : undefined)
    if (cacheKey && cached?.outcome !== "success") setExternalToolsSearchCache(cacheKey, { outcome: "success", tools })
    return { available: true, tools: tools.map((tool) => ({ name: tool.name, title: personalAgentToolTitle(tool), write: !personalAgentToolIsReadOnly(tool.annotations) })) }
  } catch {
    return { available: false, tools: [] }
  }
}

type ListedTool = { name: string; title: string; write: boolean }

function operationTools(operations: readonly McpToolOperation[]): ListedTool[] {
  return operations.map(operationTool).filter(({ name }) => name.length <= 128)
    .map((tool) => ({ name: tool.name, title: tool.title, write: !personalAgentToolIsReadOnly(tool.annotations) }))
}

export async function personalAgentToolCatalog(caller: PersonalAgentCaller, policy: PersonalAgentToolPolicy, agent: PersonalAgentAccess, operations: readonly McpToolOperation[] = []): Promise<PersonalAgentToolCatalog> {
  const organizationId = normalizeDenTypeId("organization", caller.organizationId)
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const [teams, organization, memberRulesEnabled, managedDeploymentsEnabled, gmailThreadRead, computerOffered] = await Promise.all([
    listTeamsForMember({ organizationId, memberId }),
    personalAgentOrganizationRules(organizationId, { fresh: true }),
    organizationFeatureEnabled(organizationId, "toolPermissions"),
    organizationFeatureEnabled(organizationId, "managedDeployments"),
    organizationFeatureEnabled(organizationId, "gmailThreadRead"),
    organizationFeatureEnabled(organizationId, "remoteComputers"),
  ])
  const teamIds = teams.map(({ id }) => id)
  const [connections, native, teamPolicies, memberPolicies] = await Promise.all([
    listUsableExternalMcpConnections({ organizationId, orgMembershipId: memberId, teamIds }),
    listNativeProviderUsableEntries({ organizationId, orgMembershipId: memberId, teamIds }),
    memberRulesEnabled ? readSubjectToolPolicies(organizationId, "team", teamIds) : undefined,
    memberRulesEnabled ? readSubjectToolPolicies(organizationId, "member", [memberId]) : undefined,
  ])
  const callerPolicies = [...teamPolicies?.values() ?? [], ...memberPolicies?.values() ?? []]
  const logins = organization.sharedLogins ? await personalAgentSharedLogins(caller.organizationId, agent.agentId) : null
  const available = filterPersonalAgents(filterGmailThreadRead(operations, gmailThreadRead), true)
  const openWork = available.filter((operation) => !isCredentialBoundNativeOperation(operation) && catalogOperationAvailableToCapabilities({
    generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled, managedDeploymentsEnabled, usageSource: "agent",
  }, operation))
  const connectionTools = (connectionId: string, tools: readonly ListedTool[], connectionBlocksTool: (toolName: string) => boolean) => {
    const state = personalAgentConnectorState(agent, policy, connectionId)
    const onlyChosenTools = state === "off" && policy.connections[connectionId] === "ask"
    return {
      blocked: state !== "on", onlyChosenTools, lockedByOrganization: organization.toolPolicy.connections[connectionId] === "block",
      tools: tools.map((tool) => {
        const chosen = Object.hasOwn(policy.tools[connectionId] ?? {}, tool.name) ? policy.tools[connectionId][tool.name] : null
        const rule = organizationToolRule(organization, connectionId, tool.name)
        const lockedByOrganization = rule === "block" || connectionBlocksTool(tool.name)
        const reachable = state === "on" || (onlyChosenTools && chosen !== null && chosen !== "block")
        const access = evaluateToolPermission([
          reachable ? personalAgentToolRule(policy, connectionId, tool.name) : "block", lockedByOrganization ? "block" : rule,
          ...callerPolicies.map((callerPolicy) => personalAgentToolRule(callerPolicy, connectionId, tool.name)),
        ], { kind: "agent", readOnly: !tool.write })
        return { ...tool, chosen, lockedByOrganization, access, organizationRule: rule === "block" ? null : rule }
      }),
    }
  }
  const builtIn = (connectionId: string, name: string, tools: readonly ListedTool[]): PersonalAgentToolCatalog["connections"][number] => ({
    sharedLogin: null, canShareLogin: false, connectionId, name: name.slice(0, 160), available: true,
    ...connectionTools(connectionId, tools, () => false),
  })
  const catalog: PersonalAgentToolCatalog["connections"] = [
    builtIn(OPENWORK_CONNECTION_ID, OPENWORK_CONNECTION_NAME, operationTools(openWork)),
    ...(computerOffered ? [builtIn(COMPUTER_CONNECTION_ID, COMPUTER_CONNECTION_NAME, COMPUTER_CONNECTION_TOOLS.map(({ name, title }) => ({ name, title, write: false })))] : []),
    ...native.filter((entry) => entry.connectedForMe).map((entry) => builtIn(entry.id, entry.name, operationTools(nativeOperations(available, entry.nativeProviderKey)))),
  ]
  for (let index = 0; index < connections.length; index += 8) {
    catalog.push(...await Promise.all(connections.slice(index, index + 8).map(async (connection): Promise<PersonalAgentToolCatalog["connections"][number]> => {
      const { available: connected, tools } = await personalAgentConnectionTools(caller, connection)
      const sharedLogin = await sharedLoginPerson(connection, agent.agentId, logins?.get(connection.id))
      const canShareLogin = Boolean(logins) && connected && supportsPersonalAgentSharedLogin(connection)
        && agent.state === "active" && canManagePersonalAgent(agent.role)
      return {
        sharedLogin, canShareLogin, connectionId: connection.id, name: connection.name.slice(0, 160), available: connected,
        ...connectionTools(connection.id, tools, (toolName) => evaluateToolPolicy(connection.toolPolicy, toolName).blocked),
      }
    })))
  }
  return { connections: catalog }
}
