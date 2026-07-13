export const SESSION_GROUPS_CONTRACT_VERSION = 1 as const
export const SESSION_GROUP_ID_MAX_LENGTH = 128
export const SESSION_GROUP_LABEL_MAX_LENGTH = 120
export const SESSION_GROUP_SESSION_ID_MAX_LENGTH = 256

export type SessionGroupDefinition = {
  id: string
  label: string
}

export type SessionGroupState = {
  groups: SessionGroupDefinition[]
  assignments: Record<string, string>
}

export type SessionGroupCommand =
  | { type: "replace"; state: unknown }
  | { type: "create"; id: string; label: string }
  | { type: "rename"; groupId: string; label: string }
  | { type: "remove"; groupId: string }
  | { type: "reorder"; groupIds: readonly string[] }
  | { type: "assign"; sessionId: string; groupId: string | null }

export type SessionGroupChange =
  | { action: "imported" }
  | { action: "created"; groupId: string }
  | { action: "updated"; groupId: string }
  | { action: "deleted"; groupId: string }
  | { action: "reordered" }
  | { action: "assigned"; sessionId: string; groupId?: string }

export type SessionGroupEventAction = SessionGroupChange["action"]

export type SessionGroupEvent = {
  id: string
  seq: number
  workspaceId: string
  type: "session_groups.updated"
  action: SessionGroupEventAction
  groupId?: string
  sessionId?: string
  timestamp: number
}

export type SessionGroupTransition = {
  state: SessionGroupState
  change: SessionGroupChange
  changed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeGroupId(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, SESSION_GROUP_ID_MAX_LENGTH)
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, SESSION_GROUP_LABEL_MAX_LENGTH)
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, SESSION_GROUP_SESSION_ID_MAX_LENGTH)
}

export function normalizeSessionGroupState(value: unknown): SessionGroupState {
  if (!isRecord(value)) return { groups: [], assignments: {} }

  const groups: SessionGroupDefinition[] = []
  const seenGroupIds = new Set<string>()
  if (Array.isArray(value.groups)) {
    for (const item of value.groups) {
      if (!isRecord(item)) continue
      const id = normalizeGroupId(item.id)
      const label = normalizeLabel(item.label)
      if (!id || !label || seenGroupIds.has(id)) continue
      groups.push({ id, label })
      seenGroupIds.add(id)
    }
  }

  const assignments: Record<string, string> = {}
  if (isRecord(value.assignments)) {
    for (const [sessionId, rawGroupId] of Object.entries(value.assignments)) {
      const normalizedSessionId = normalizeSessionId(sessionId)
      const groupId = normalizeGroupId(rawGroupId)
      if (!normalizedSessionId || !groupId || !seenGroupIds.has(groupId)) continue
      assignments[normalizedSessionId] = groupId
    }
  }

  return { groups, assignments }
}

function sameState(left: SessionGroupState, right: SessionGroupState): boolean {
  if (left.groups.length !== right.groups.length) return false
  for (let index = 0; index < left.groups.length; index += 1) {
    const a = left.groups[index]
    const b = right.groups[index]
    if (a?.id !== b?.id || a?.label !== b?.label) return false
  }
  const leftAssignments = Object.entries(left.assignments)
  const rightAssignments = Object.entries(right.assignments)
  if (leftAssignments.length !== rightAssignments.length) return false
  return leftAssignments.every(([sessionId, groupId]) => right.assignments[sessionId] === groupId)
}

export function applySessionGroupCommand(
  currentValue: SessionGroupState,
  command: SessionGroupCommand,
): SessionGroupTransition {
  const current = normalizeSessionGroupState(currentValue)
  let next: SessionGroupState
  let change: SessionGroupChange

  switch (command.type) {
    case "replace": {
      next = normalizeSessionGroupState(command.state)
      change = { action: "imported" }
      break
    }
    case "create": {
      const id = normalizeGroupId(command.id)
      const label = normalizeLabel(command.label)
      next = !id || !label || current.groups.some((group) => group.id === id)
        ? current
        : { ...current, groups: [...current.groups, { id, label }] }
      change = { action: "created", groupId: id }
      break
    }
    case "rename": {
      const groupId = normalizeGroupId(command.groupId)
      const label = normalizeLabel(command.label)
      next = !groupId || !label
        ? current
        : {
            ...current,
            groups: current.groups.map((group) =>
              group.id === groupId ? { ...group, label } : group,
            ),
          }
      change = { action: "updated", groupId }
      break
    }
    case "remove": {
      const groupId = normalizeGroupId(command.groupId)
      const assignments: Record<string, string> = {}
      for (const [sessionId, assignedGroupId] of Object.entries(current.assignments)) {
        if (assignedGroupId !== groupId) assignments[sessionId] = assignedGroupId
      }
      next = {
        groups: current.groups.filter((group) => group.id !== groupId),
        assignments,
      }
      change = { action: "deleted", groupId }
      break
    }
    case "reorder": {
      const byId = new Map(current.groups.map((group) => [group.id, group]))
      const used = new Set<string>()
      const groups: SessionGroupDefinition[] = []
      for (const rawId of command.groupIds) {
        const id = normalizeGroupId(rawId)
        const group = byId.get(id)
        if (!group || used.has(id)) continue
        groups.push(group)
        used.add(id)
      }
      for (const group of current.groups) {
        if (!used.has(group.id)) groups.push(group)
      }
      next = { ...current, groups }
      change = { action: "reordered" }
      break
    }
    case "assign": {
      const sessionId = normalizeSessionId(command.sessionId)
      const groupId = command.groupId === null ? "" : normalizeGroupId(command.groupId)
      const assignments = { ...current.assignments }
      if (sessionId) {
        if (groupId && current.groups.some((group) => group.id === groupId)) {
          assignments[sessionId] = groupId
        } else {
          delete assignments[sessionId]
        }
      }
      next = { ...current, assignments }
      change = {
        action: "assigned",
        sessionId,
        ...(groupId ? { groupId } : {}),
      }
      break
    }
  }

  const normalized = normalizeSessionGroupState(next)
  return {
    state: normalized,
    change,
    changed: !sameState(current, normalized),
  }
}
