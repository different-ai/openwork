import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, organizationParent, relatedResource, targetResource, type AuditSnapshot } from "./snapshot.js"

// environment_variable.created / .updated / .deleted (admins) and
// environment_variable.own_value_set / .own_value_cleared / .assignment_selected
// (a member for themselves). Values are never recorded: snapshots say whether
// each assignment has a value, and the "valueMaterial" marker names a change.

export type EnvironmentVariableAuditState = {
  id: string
  name: string
  key: string
  description: string | null
  valueMode: string
  /** "everyone", "team:<id>" or "member:<id>", with whether a value is stored. */
  assignments: ReadonlyArray<{ target: string; hasValue: boolean }>
}

function serialize(state: EnvironmentVariableAuditState): AuditSnapshot {
  return {
    id: state.id,
    name: auditText(state.name),
    key: auditText(state.key),
    description: auditText(state.description, 2000),
    valueMode: state.valueMode,
    assignments: [...state.assignments]
      .sort((a, b) => a.target.localeCompare(b.target))
      .map((entry) => ({ target: entry.target, hasValue: entry.hasValue })),
  }
}

function resources(organizationId: string, state: { id: string; key: string }) {
  return [targetResource("environment_variable", state.id, state.key), organizationParent(organizationId)]
}

/** Assignments whose value was set, replaced or removed, for the event's annotations. Never the values. */
export function environmentVariableAdminChange(input: {
  organizationId: string
  before: EnvironmentVariableAuditState | null
  after: EnvironmentVariableAuditState | null
  valuesChangedFor: readonly string[]
}): AuditChangeEventInput | null {
  const state = input.after ?? input.before
  if (!state) return null
  const action = input.before === null ? "environment_variable.created"
    : input.after === null ? "environment_variable.deleted"
      : "environment_variable.updated"
  return auditChangeEvent({
    action,
    resources: resources(input.organizationId, state),
    before: input.before ? serialize(input.before) : null,
    after: input.after ? serialize(input.after) : null,
    markers: input.valuesChangedFor.length > 0 ? ["valueMaterial"] : [],
    annotations: input.after && input.valuesChangedFor.length > 0 ? { valuesChangedFor: [...input.valuesChangedFor].sort() } : undefined,
  })
}

export function environmentVariableOwnValueEvent(input: {
  organizationId: string
  variable: { id: string; key: string }
  memberId: string
  hadValue: boolean
  hasValue: boolean
}): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: input.hasValue ? "environment_variable.own_value_set" : "environment_variable.own_value_cleared",
    resources: [...resources(input.organizationId, input.variable), relatedResource("member", input.memberId)],
    before: { memberId: input.memberId, hasOwnValue: input.hadValue },
    after: { memberId: input.memberId, hasOwnValue: input.hasValue },
    markers: input.hasValue || input.hadValue ? ["valueMaterial"] : [],
  })
}

export function environmentVariableAssignmentSelectedEvent(input: {
  organizationId: string
  variable: { id: string; key: string }
  memberId: string
  before: string | null
  after: string | null
}): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "environment_variable.assignment_selected",
    resources: [...resources(input.organizationId, input.variable), relatedResource("member", input.memberId)],
    before: { memberId: input.memberId, selectedAccessId: input.before },
    after: { memberId: input.memberId, selectedAccessId: input.after },
  })
}
