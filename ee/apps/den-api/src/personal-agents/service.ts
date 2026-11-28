import { AUTOMATION_CLOUD_DEFAULT_MODEL, type AutomationRun } from "@openwork/types/automations"
import { personalAgentToolPolicyBlocks, type AutomationListItem } from "@openwork/automations"
import {
  EMPTY_PERSONAL_AGENT_TOOL_POLICY,
  PERSONAL_AGENT_ROUTINE_LIST_LIMIT,
  PERSONAL_AGENT_TOOL_POLICY_MAX_SCOPE_CHARACTERS,
  personalAgentToolPolicySchema,
  type CreatePersonalAgent,
  type CreatePersonalAgentRoutine,
  type PersonalAgentAccess,
  type PersonalAgentDetail,
  type PersonalAgentToolPolicy,
  type RunPersonalAgentNow,
  type UpdatePersonalAgent,
  type UpdatePersonalAgentRoutine,
} from "@openwork/types/den/personal-agents"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { automationRepository, listAgentRoutines } from "../automations/repository.js"
import { automationService, type AutomationRunNowOptions, type AutomationService } from "../automations/service.js"
import { externalMcpConnectionReadyForMember, getExternalMcpConnection } from "../capability-sources/external-mcp-connections.js"
import { agentToolLimitScopes } from "../mcp/workbot-turn-limits.js"
import type { PersonalAgentTransaction } from "./access.js"
import { recordPersonalAgentEvent } from "./events.js"
import { personalAgentUsableConnections } from "./permissions-catalog.js"
import { isBuiltInAgentConnection } from "./builtin-connection.js"
import { normalizedPersonalAgentConnectorName } from "./connector-access.js"
import { personalAgentNeverBlocks } from "./never.js"
import { personalAgentRepository } from "./repository.js"

type OwnerScope = Parameters<AutomationService["create"]>[0]

async function toolPolicyOverOrganizationConnectors(organizationId: string, policy: PersonalAgentToolPolicy): Promise<PersonalAgentToolPolicy> {
  const canonicalIds = new Map<string, string>()
  for (const connectionId of new Set([...Object.keys(policy.connections), ...Object.keys(policy.tools)])) {
    if (isBuiltInAgentConnection(connectionId)) continue
    if (!isDenTypeId("externalMcpConnection", connectionId)) throw new Error("personal_agent_tool_policy_connection_invalid")
    const connection = await getExternalMcpConnection({
      organizationId: normalizeDenTypeId("organization", organizationId),
      connectionId: normalizeDenTypeId("externalMcpConnection", connectionId),
    })
    if (!connection) throw new Error("personal_agent_tool_policy_connection_invalid")
    canonicalIds.set(connectionId, connection.id)
  }
  const canonical = (connectionId: string) => canonicalIds.get(connectionId) ?? connectionId
  const connections: Record<string, PersonalAgentAccess> = {}
  for (const [connectionId, access] of Object.entries(policy.connections)) {
    const id = canonical(connectionId)
    if (connections[id] !== "block") connections[id] = access
  }
  const tools: Record<string, Record<string, PersonalAgentAccess>> = {}
  for (const [connectionId, entries] of Object.entries(policy.tools)) {
    const target = tools[canonical(connectionId)] ??= {}
    for (const [name, access] of Object.entries(entries)) {
      if (target[name] !== "block") Object.defineProperty(target, name, { value: access, enumerable: true, configurable: true })
    }
  }
  if (!personalAgentToolPolicySchema.safeParse({ connections, tools }).success) throw new Error("personal_agent_tool_policy_too_large")
  const scopes = agentToolLimitScopes(personalAgentToolPolicyBlocks({ connections, tools }))
  if (JSON.stringify(scopes).length > PERSONAL_AGENT_TOOL_POLICY_MAX_SCOPE_CHARACTERS) throw new Error("personal_agent_tool_policy_too_large")
  return { connections, tools }
}

export class PersonalAgentService {
  constructor(private readonly automationOverride?: AutomationService) {}

  private get automations(): AutomationService {
    return this.automationOverride ?? automationService
  }

  async create(scope: OwnerScope, definition: CreatePersonalAgent): Promise<PersonalAgentDetail> {
    const replay = await personalAgentRepository.replayCreate({ ...scope, definition })
    if (replay) return replay
    const caller = { organizationId: scope.organizationId, memberId: scope.ownerMemberId }
    const desired = definition.toolPolicy ?? EMPTY_PERSONAL_AGENT_TOOL_POLICY
    const blocks = await personalAgentNeverBlocks(caller, definition.never ?? [])
    const canonical = await toolPolicyOverOrganizationConnectors(scope.organizationId, desired)
    const connections: PersonalAgentToolPolicy["connections"] = Object.fromEntries(Object.entries(canonical.connections).filter(([, rule]) => rule === "block"))
    const tools: PersonalAgentToolPolicy["tools"] = {}
    const names = new Set(definition.connectorNames?.map(normalizedPersonalAgentConnectorName))
    const usable = names.size ? await personalAgentUsableConnections(caller) : []
    for (const name of names) {
      const matches = usable.filter((connection) => normalizedPersonalAgentConnectorName(connection.name) === name)
      if (matches.length !== 1) continue
      const [connection] = matches
      if (connections[connection.id] === "block" || blocks.connections[connection.id] === "block") continue
      if (await externalMcpConnectionReadyForMember(connection, normalizeDenTypeId("member", caller.memberId))) connections[connection.id] = "allow"
    }
    for (const [id, entries] of Object.entries(canonical.tools)) {
      const rules = Object.entries(entries).filter(([, rule]) => rule === "block" || connections[id] === "allow")
      if (rules.length) tools[id] = Object.fromEntries(rules)
    }
    for (const [id, entries] of Object.entries(blocks.tools)) tools[id] = { ...tools[id], ...entries }
    const toolPolicy = await toolPolicyOverOrganizationConnectors(scope.organizationId, { connections: { ...connections, ...blocks.connections }, tools })
    return personalAgentRepository.create({ ...scope, definition, toolPolicy, legacyConnectorAccess: false,
      neverConnectionIds: Object.keys(blocks.connections), now: Date.now() })
  }

  async update(scope: OwnerScope, agentId: string, changes: UpdatePersonalAgent, actorMemberId?: string, tx?: PersonalAgentTransaction): Promise<PersonalAgentDetail | null> {
    const toolPolicy = changes.toolPolicy ? await toolPolicyOverOrganizationConnectors(scope.organizationId, changes.toolPolicy) : undefined
    return personalAgentRepository.update({ ...scope, agentId, changes, toolPolicy, actorMemberId, now: Date.now() }, tx)
  }

  list(scope: OwnerScope, input: { cursor?: string; limit?: number }) {
    return personalAgentRepository.list({ ...scope, cursor: input.cursor, limit: input.limit ?? 50 })
  }

  get(scope: OwnerScope, agentId: string, memberId?: string) {
    return personalAgentRepository.get({ ...scope, agentId, memberId })
  }

  archive(scope: OwnerScope, agentId: string) {
    return personalAgentRepository.archive({ ...scope, agentId, now: Date.now() })
  }

  private async routine(scope: OwnerScope, agentId: string, routineId: string): Promise<AutomationListItem> {
    const routine = isDenTypeId("automation", routineId) ? await this.automations.get(scope, routineId) : null
    if (routine?.automation.agentId !== agentId || routine.automation.state === "archived") throw new Error("personal_agent_routine_not_found")
    return routine
  }

  private async onlyRoutine(scope: OwnerScope, agentId: string): Promise<AutomationListItem> {
    const routines = await listAgentRoutines({ ...scope, agentId, limit: 2 })
    if (routines.length === 0) throw new Error("personal_agent_routine_required")
    if (routines.length > 1) throw new Error("personal_agent_routine_ambiguous")
    return routines[0]
  }

  private async active(scope: OwnerScope, agentId: string): Promise<PersonalAgentDetail | null> {
    const agent = await this.get(scope, agentId)
    return agent && agent.agent.state === "active" ? agent : null
  }

  async listRoutines(scope: OwnerScope, agentId: string, memberId?: string): Promise<{ items: AutomationListItem[] } | null> {
    const agent = await this.get(scope, agentId)
    if (!agent) return null
    return { items: await listAgentRoutines({ ...scope, agentId: agent.agent.id, limit: PERSONAL_AGENT_ROUTINE_LIST_LIMIT, memberId }) }
  }

  async createRoutine(scope: OwnerScope, agentId: string, routine: CreatePersonalAgentRoutine, actorMemberId = scope.ownerMemberId, tx?: PersonalAgentTransaction): Promise<AutomationListItem | null> {
    const agent = await this.active(scope, agentId)
    if (!agent) return null
    const created = await this.automations.create(scope, {
      name: routine.name,
      schedule: routine.schedule,
      action: {
        kind: "agent",
        instructions: routine.instructions,
        model: routine.model ?? {
          providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId,
          modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId,
          variant: null,
        },
      },
      executionTarget: "cloud",
    }, { agent: { agentId: agent.agent.id }, tx })
    await recordPersonalAgentEvent({ organizationId: scope.organizationId, agentId, actorMemberId, action: "routine.created", detail: { routineName: created.automation.name, active: created.automation.state === "active" } }, tx)
    return created
  }

  async updateRoutine(scope: OwnerScope, agentId: string, routineId: string, changes: UpdatePersonalAgentRoutine, actorMemberId = scope.ownerMemberId, tx?: PersonalAgentTransaction): Promise<AutomationListItem | null> {
    const current = tx ? await automationRepository.get({ ...scope, automationId: routineId, tx }) : await this.routine(scope, agentId, routineId)
    if (current?.automation.agentId !== agentId || current.automation.state === "archived") return null
    const { active = current.automation.state === "active", ...definition } = changes
    let updated: AutomationListItem | null = current
    if (Object.keys(definition).length > 0) updated = await this.automations.update(scope, routineId, definition, { tx })
    if (!updated) return null
    if (active !== (updated.automation.state === "active")) {
      updated = active ? await this.automations.activate(scope, routineId, tx) : await this.automations.deactivate(scope, routineId, tx)
    }
    if (!updated) return null
    await recordPersonalAgentEvent({ organizationId: scope.organizationId, agentId, actorMemberId, action: "routine.changed", detail: {
      routineName: updated.automation.name,
      name: updated.automation.name !== current.automation.name,
      instructions: updated.revision.instructions !== current.revision.instructions,
      schedule: JSON.stringify(updated.revision.schedule) !== JSON.stringify(current.revision.schedule),
      state: updated.automation.state !== current.automation.state,
      active: updated.automation.state === "active",
    } }, tx)
    return updated
  }

  async runNow(scope: OwnerScope, agentId: string, input: RunPersonalAgentNow, options: AutomationRunNowOptions = {}): Promise<{
    run: AutomationRun
    routine: AutomationListItem
    agentRevision: { id: string; version: number }
  } | null> {
    const agent = await this.active(scope, agentId)
    if (!agent) return null
    const chosen = input.routineId
      ? await this.routine(scope, agent.agent.id, input.routineId)
      : await this.onlyRoutine(scope, agent.agent.id)
    const run = await this.automations.runNow(scope, chosen.automation.id, options)
    const receipt = run ? await this.automations.getRun(scope, run.id, { actingMemberId: options.actingMemberId, agentId: agent.agent.id }) : null
    const pinned = receipt?.revision.agentRevisionId
      ? await personalAgentRepository.runDefinition(receipt.revision.agentRevisionId)
      : null
    if (!receipt || !pinned) throw new Error("personal_agent_routine_not_found")
    return {
      run: receipt.run,
      routine: { automation: receipt.automation, revision: receipt.revision, latestRun: receipt.run },
      agentRevision: { id: pinned.revisionId, version: pinned.version },
    }
  }
}

export const personalAgentService = new PersonalAgentService()
