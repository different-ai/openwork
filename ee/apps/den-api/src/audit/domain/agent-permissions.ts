import {
  AGENT_PERMISSION_EVERYONE,
  agentPermissionDefinitions,
  agentPermissionDefaultDecision,
  type AgentPermissionDefinition,
  type AgentPermissionSetting,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions"
import type { AuditChangeEventInput } from "../request-capture.js"
import { AUDIT_TEXT_WITHHELD, auditChangeEvent, organizationParent, relatedResource, targetResource, type AuditSnapshot } from "./snapshot.js"

export type AgentPermissionAuditScope =
  | { kind: "everyone" }
  | { kind: "team"; teamId: string; teamName: string }

export type AgentPermissionAuditState = {
  policyId: string | null
  settings: AgentPermissionSettings
}

function patternList(patterns: readonly string[] | undefined): string[] {
  return [...new Set(patterns ?? [])].map(() => AUDIT_TEXT_WITHHELD)
}

function serializeSetting(definition: AgentPermissionDefinition, setting: AgentPermissionSetting | undefined): AuditSnapshot | null {
  if (!setting) return null
  if (!definition.patterns) return { decision: setting.decision ?? null }
  return { decision: setting.decision ?? null, allow: patternList(setting.allow), block: patternList(setting.block) }
}

function serializePolicy(scope: AgentPermissionAuditScope, state: AgentPermissionAuditState): AuditSnapshot {
  const snapshot: AuditSnapshot = {
    scope: scope.kind,
    teamId: scope.kind === "team" ? scope.teamId : null,
  }
  for (const definition of agentPermissionDefinitions) snapshot[definition.key] = serializeSetting(definition, state.settings[definition.key])
  return snapshot
}

function decisionLabel(scope: AgentPermissionAuditScope, definition: AgentPermissionDefinition, setting: AgentPermissionSetting | undefined): string {
  const decision = setting?.decision ?? (scope.kind === "everyone" ? agentPermissionDefaultDecision(definition.key) : "inherit")
  if (definition.toggleMeans !== "requires" || decision === "inherit") return decision
  return decision === "allow" ? "not required" : "required"
}

function added(before: readonly string[] | undefined, after: readonly string[] | undefined): string[] {
  return patternList((after ?? []).filter((pattern) => !(before ?? []).includes(pattern)))
}

function permissionChanges(scope: AgentPermissionAuditScope, before: AgentPermissionSettings, after: AgentPermissionSettings): AuditSnapshot[] {
  return agentPermissionDefinitions.flatMap((definition): AuditSnapshot[] => {
    const from = before[definition.key]
    const to = after[definition.key]
    const decision = { before: decisionLabel(scope, definition, from), after: decisionLabel(scope, definition, to) }
    if (!definition.patterns) return decision.before !== decision.after ? [{ key: definition.key, label: definition.label, decision }] : []
    const change = {
      key: definition.key,
      label: definition.label,
      decision,
      allowAdded: added(from?.allow, to?.allow),
      allowRemoved: added(to?.allow, from?.allow),
      blockAdded: added(from?.block, to?.block),
      blockRemoved: added(to?.block, from?.block),
    }
    const changed = decision.before !== decision.after
      || change.allowAdded.length + change.allowRemoved.length + change.blockAdded.length + change.blockRemoved.length > 0
    return changed ? [change] : []
  })
}

function withheldPatternMarkers(before: AgentPermissionSettings, after: AgentPermissionSettings): string[] {
  const raw = (setting: AgentPermissionSetting | undefined) => JSON.stringify({
    allow: [...new Set(setting?.allow ?? [])].sort(),
    block: [...new Set(setting?.block ?? [])].sort(),
  })
  return agentPermissionDefinitions.flatMap((definition) => {
    const from = before[definition.key]
    const to = after[definition.key]
    const changed = raw(from) !== raw(to)
    const sameInAudit = JSON.stringify(serializeSetting(definition, from)?.allow ?? []) === JSON.stringify(serializeSetting(definition, to)?.allow ?? [])
      && JSON.stringify(serializeSetting(definition, from)?.block ?? []) === JSON.stringify(serializeSetting(definition, to)?.block ?? [])
    return changed && sameInAudit ? [`${definition.key}WithheldPatterns`] : []
  })
}

function resources(organizationId: string, scope: AgentPermissionAuditScope, policyId: string | null) {
  const label = scope.kind === "everyone" ? AGENT_PERMISSION_EVERYONE : scope.teamName
  return [
    scope.kind === "team"
      ? targetResource("team", scope.teamId, label)
      : targetResource("agent_permission_policy", policyId ?? `${organizationId}:everyone`, label),
    scope.kind === "team" && policyId ? relatedResource("agent_permission_policy", policyId) : null,
    organizationParent(organizationId),
  ]
}

export function agentPermissionPolicyChangedEvent(
  organizationId: string,
  scope: AgentPermissionAuditScope,
  before: AgentPermissionAuditState,
  after: AgentPermissionAuditState,
): AuditChangeEventInput | null {
  const removed = scope.kind === "team" && after.policyId === null
  return auditChangeEvent({
    action: removed ? "agent_permission_policy.removed" : "agent_permission_policy.updated",
    resources: resources(organizationId, scope, before.policyId ?? after.policyId),
    before: serializePolicy(scope, before),
    after: serializePolicy(scope, after),
    markers: withheldPatternMarkers(before.settings, after.settings),
    annotations: { permissionChanges: permissionChanges(scope, before.settings, after.settings) },
  })
}
