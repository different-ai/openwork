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

// agent_permission_policy.updated / agent_permission_policy.removed. Each
// permission is its own snapshot field, so changedFields names the permissions
// that changed; a permission left unset is null (Allow for Everyone, inherits
// Everyone's for a team). `permissionChanges` annotates each changed permission
// with its before → after decision and, for permissions with lists (commands
// and websites), the patterns added to or removed from its allowed and
// blocked lists. People who can read the audit log need not be
// able to see agent permissions, and a pattern can hold a credential
// (`curl --password=… *`) or name a private site, skill or server, so every
// pattern is recorded as withheld: the log says how many were added or
// removed, never their text.

export type AgentPermissionAuditScope =
  | { kind: "everyone" }
  | { kind: "team"; teamId: string; teamName: string }

export type AgentPermissionAuditState = {
  /** The stored policy row, or null when nothing is set for this scope. */
  policyId: string | null
  settings: AgentPermissionSettings
}

/** A list's patterns as the audit records them: one withheld marker each. */
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

/** The decision a scope ends up with: an unset permission allows for Everyone and inherits for a team. */
function decisionLabel(scope: AgentPermissionAuditScope, definition: AgentPermissionDefinition, setting: AgentPermissionSetting | undefined): string {
  return setting?.decision ?? (scope.kind === "everyone" ? agentPermissionDefaultDecision(definition.key) : "inherit")
}

/** The stored patterns in `after` that `before` lacks, in audit form. */
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

/**
 * Permissions whose patterns changed while their audit form did not: a
 * pattern replaced by another. Named as markers so the change is recorded
 * without either value.
 */
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

/**
 * Saving Everyone's or a team's agent permissions (PUT). Saving nothing for a
 * team removes its overrides and is recorded as `removed`. Null when nothing changed.
 */
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
