import { personalAgentConnectorState } from "./connector-access.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentToolCatalog, PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import { externalMcpConnectionReadyForMember, listUsableExternalMcpConnections, type ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { externalMcpCompatibleCallbackUrl } from "../capability-sources/external-mcp-oauth-contract.js"
import { getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { evaluateToolPolicy } from "../capability-sources/external-mcp-tool-policy.js"
import { organizationFeatureEnabled } from "../features.js"
import { listTeamsForMember } from "../member-teams.js"
import { evaluateToolPermission } from "../tool-permissions/evaluate.js"
import { readSubjectToolPolicies } from "../tool-permissions/rules.js"
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
    const tools = await listExternalMcpTools(connection, redirect, connection.credentialMode === "per_member" ? { orgMembershipId } : undefined)
    return { available: true, tools: tools.map((tool) => ({ name: tool.name, title: personalAgentToolTitle(tool), write: !personalAgentToolIsReadOnly(tool.annotations) })) }
  } catch {
    return { available: false, tools: [] }
  }
}

export async function personalAgentToolCatalog(caller: PersonalAgentCaller, policy: PersonalAgentToolPolicy, agent: PersonalAgentAccess): Promise<PersonalAgentToolCatalog> {
  const organizationId = normalizeDenTypeId("organization", caller.organizationId)
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const [teams, organization, memberRulesEnabled] = await Promise.all([
    listTeamsForMember({ organizationId, memberId }),
    personalAgentOrganizationRules(organizationId, { fresh: true }),
    organizationFeatureEnabled(organizationId, "toolPermissions"),
  ])
  const teamIds = teams.map(({ id }) => id)
  const [connections, teamPolicies, memberPolicies] = await Promise.all([
    listUsableExternalMcpConnections({ organizationId, orgMembershipId: memberId, teamIds }),
    memberRulesEnabled ? readSubjectToolPolicies(organizationId, "team", teamIds) : undefined,
    memberRulesEnabled ? readSubjectToolPolicies(organizationId, "member", [memberId]) : undefined,
  ])
  const callerPolicies = [...teamPolicies?.values() ?? [], ...memberPolicies?.values() ?? []]
  const logins = organization.sharedLogins ? await personalAgentSharedLogins(caller.organizationId, agent.agentId) : null
  const catalog: PersonalAgentToolCatalog["connections"] = []
  for (let index = 0; index < connections.length; index += 8) {
    catalog.push(...await Promise.all(connections.slice(index, index + 8).map(async (connection): Promise<PersonalAgentToolCatalog["connections"][number]> => {
      const { available, tools } = await personalAgentConnectionTools(caller, connection)
      const sharedLogin = await sharedLoginPerson(connection, agent.agentId, logins?.get(connection.id))
      const canShareLogin = Boolean(logins) && available && supportsPersonalAgentSharedLogin(connection)
        && agent.state === "active" && canManagePersonalAgent(agent.role)
      return {
        sharedLogin, canShareLogin,
        connectionId: connection.id, name: connection.name.slice(0, 160), available,
        blocked: personalAgentConnectorState(agent, policy, connection.id) !== "on", lockedByOrganization: organization.toolPolicy.connections[connection.id] === "block",
        tools: tools.map((tool) => {
          const chosen = Object.hasOwn(policy.tools[connection.id] ?? {}, tool.name) ? policy.tools[connection.id][tool.name] : null
          const rule = organizationToolRule(organization, connection.id, tool.name)
          const lockedByOrganization = rule === "block" || evaluateToolPolicy(connection.toolPolicy, tool.name).blocked
          const access = evaluateToolPermission([
            personalAgentConnectorState(agent, policy, connection.id) !== "on" ? "block" : personalAgentToolRule(policy, connection.id, tool.name), lockedByOrganization ? "block" : rule,
            ...callerPolicies.map((callerPolicy) => personalAgentToolRule(callerPolicy, connection.id, tool.name)),
          ], { kind: "agent", readOnly: !tool.write })
          return { ...tool, chosen, lockedByOrganization, access, organizationRule: rule === "block" ? null : rule }
        }),
      }
    })))
  }
  return { connections: catalog }
}
