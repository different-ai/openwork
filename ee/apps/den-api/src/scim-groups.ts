import { and, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  MemberTable,
  ScimGroupMemberTable,
  ScimGroupTable,
  ScimProviderTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { withOrganizationTeamMutation, type TeamMutationTransaction } from "./organization-team-roles.js"

export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group"
export const SCIM_LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"

export type ScimGroupMappingMode = "metadata_only" | "create_teams"

type ScimProvider = typeof ScimProviderTable.$inferSelect
type ScimGroup = typeof ScimGroupTable.$inferSelect
type ScimGroupMember = typeof ScimGroupMemberTable.$inferSelect

export type ScimGroupMemberInput = {
  value: string
  display?: string
  $ref?: string
}

export type ScimGroupInput = {
  externalId?: string | null
  displayName: string
  members?: ScimGroupMemberInput[]
}

export type ScimGroupPatchOperation = {
  op: "add" | "remove" | "replace"
  path?: string
  value?: unknown
}

export type ScimGroupResource = {
  schemas: [typeof SCIM_GROUP_SCHEMA]
  id: string
  externalId?: string
  displayName: string
  members: ScimGroupMemberInput[]
  meta: {
    resourceType: "Group"
    created: string
    lastModified: string
    location: string
  }
}

export type ScimGroupMutationResult =
  | { ok: true; group: ScimGroup }
  | { ok: false; status: 400 | 404 | 409; detail: string }

function normalizeMappingMode(value: string): ScimGroupMappingMode {
  return value === "create_teams" ? "create_teams" : "metadata_only"
}

function uniqueMembers(members: ScimGroupMemberInput[]) {
  const byValue = new Map<string, ScimGroupMemberInput>()
  for (const member of members) {
    const value = member.value.trim()
    if (value) {
      byValue.set(value, { ...member, value })
    }
  }
  return [...byValue.values()]
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null
}

function memberValues(value: unknown): ScimGroupMemberInput[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    const record = recordValue(entry)
    const memberValue = typeof record?.value === "string" ? record.value.trim() : ""
    if (!memberValue) {
      return []
    }
    const member: ScimGroupMemberInput = { value: memberValue }
    if (typeof record?.display === "string") member.display = record.display
    if (typeof record?.$ref === "string") member.$ref = record.$ref
    return [member]
  })
}

export function applyScimGroupPatch(input: {
  current: ScimGroupInput
  operations: ScimGroupPatchOperation[]
}): ScimGroupInput {
  let displayName = input.current.displayName
  let externalId = input.current.externalId
  let members = uniqueMembers(input.current.members ?? [])

  for (const operation of input.operations) {
    const path = operation.path?.trim() ?? ""
    const normalizedPath = path.toLowerCase()
    const objectValue = recordValue(operation.value)

    if (!path && objectValue) {
      if (typeof objectValue.displayName === "string") displayName = objectValue.displayName
      if (typeof objectValue.externalId === "string" || objectValue.externalId === null) {
        externalId = objectValue.externalId
      }
      if (Array.isArray(objectValue.members)) {
        members = operation.op === "add"
          ? uniqueMembers([...members, ...memberValues(objectValue.members)])
          : memberValues(objectValue.members)
      }
      continue
    }

    if (normalizedPath === "displayname") {
      if (operation.op === "remove") displayName = ""
      else if (typeof operation.value === "string") displayName = operation.value
      continue
    }
    if (normalizedPath === "externalid") {
      externalId = operation.op === "remove"
        ? null
        : typeof operation.value === "string" ? operation.value : externalId
      continue
    }
    if (normalizedPath === "members") {
      const patchMembers = memberValues(operation.value)
      if (operation.op === "add") members = uniqueMembers([...members, ...patchMembers])
      if (operation.op === "replace") members = patchMembers
      if (operation.op === "remove") {
        const removedValues = new Set(patchMembers.map((member) => member.value))
        members = patchMembers.length === 0 ? [] : members.filter((member) => !removedValues.has(member.value))
      }
      continue
    }

    const memberFilter = path.match(/^members\s*\[\s*value\s+eq\s+["']([^"']+)["']\s*\]$/i)
    if (operation.op === "remove" && memberFilter?.[1]) {
      members = members.filter((member) => member.value !== memberFilter[1])
    }
  }

  return { externalId, displayName, members }
}

async function loadGroupMembers(groupId: ScimGroup["id"], database: Pick<typeof db, "select"> = db) {
  return database
    .select()
    .from(ScimGroupMemberTable)
    .where(eq(ScimGroupMemberTable.groupId, groupId))
}

async function loadScimProvider(tx: TeamMutationTransaction, provider: ScimProvider) {
  const rows = await tx.select().from(ScimProviderTable).where(and(
    eq(ScimProviderTable.id, provider.id),
    eq(ScimProviderTable.organizationId, provider.organizationId),
    eq(ScimProviderTable.providerId, provider.providerId),
  )).limit(1)
  return rows[0] ?? null
}

async function findActiveOrganizationMember(tx: TeamMutationTransaction, input: {
  organizationId: ScimProvider["organizationId"]
  remoteUserId: string
}) {
  let userId: typeof AuthUserTable.$inferSelect.id
  try {
    userId = normalizeDenTypeId("user", input.remoteUserId)
  } catch {
    return null
  }

  const rows = await tx
    .select()
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, input.organizationId),
      eq(MemberTable.userId, userId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  return rows[0] ?? null
}

async function chooseScimTeamName(tx: TeamMutationTransaction, input: {
  organizationId: ScimProvider["organizationId"]
  displayName: string
  currentTeamId?: typeof TeamTable.$inferSelect.id
}) {
  const exactRows = await tx
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamTable.name, input.displayName)))
    .limit(1)
  if (!exactRows[0] || exactRows[0].id === input.currentTeamId) {
    return input.displayName
  }

  const suffixedName = `${input.displayName} (SCIM)`
  const suffixedRows = await tx
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamTable.name, suffixedName)))
    .limit(1)
  if (!suffixedRows[0]) {
    return suffixedName
  }

  return `${input.displayName} (SCIM ${createDenTypeId("team").slice(-6)})`
}

async function ensureGroupTeam(tx: TeamMutationTransaction, provider: ScimProvider, group: ScimGroup) {
  if (normalizeMappingMode(provider.groupMappingMode) !== "create_teams") {
    return group
  }
  if (group.teamId) {
    return group
  }

  const teamId = createDenTypeId("team")
  const now = new Date()
  const name = await chooseScimTeamName(tx, {
    organizationId: provider.organizationId,
    displayName: group.displayName,
  })

  await tx.insert(TeamTable).values({
    id: teamId,
    organizationId: provider.organizationId,
    name,
    createdAt: now,
    updatedAt: now,
  })
  await tx
    .update(ScimGroupTable)
    .set({ teamId, updatedAt: now })
    .where(and(eq(ScimGroupTable.id, group.id), isNull(ScimGroupTable.teamId)))

  return { ...group, teamId, updatedAt: now }
}

async function attachGroupMemberToTeam(tx: TeamMutationTransaction, input: {
  provider: ScimProvider
  group: ScimGroup
  member: ScimGroupMember
}) {
  if (!input.member.remoteUserId) {
    return
  }

  const organizationMember = await findActiveOrganizationMember(tx, {
    organizationId: input.provider.organizationId,
    remoteUserId: input.member.remoteUserId,
  })
  if (!organizationMember?.userId) {
    return
  }

  let teamMemberId: typeof TeamMemberTable.$inferSelect.id | null = null
  if (normalizeMappingMode(input.provider.groupMappingMode) === "create_teams" && input.group.teamId) {
    const existingRows = await tx
      .select({ id: TeamMemberTable.id })
      .from(TeamMemberTable)
      .where(and(
        eq(TeamMemberTable.teamId, input.group.teamId),
        eq(TeamMemberTable.orgMembershipId, organizationMember.id),
      ))
      .limit(1)

    teamMemberId = existingRows[0]?.id ?? null
    if (!existingRows[0]) {
      teamMemberId = createDenTypeId("teamMember")
      await tx.insert(TeamMemberTable).values({
        id: teamMemberId,
        teamId: input.group.teamId,
        orgMembershipId: organizationMember.id,
        userId: organizationMember.userId,
        createdAt: new Date(),
      })
    }
  }

  await tx
    .update(ScimGroupMemberTable)
    .set({
      userId: organizationMember.userId,
      orgMembershipId: organizationMember.id,
      teamMemberId,
      updatedAt: new Date(),
    })
    .where(eq(ScimGroupMemberTable.id, input.member.id))
}

async function detachOwnedTeamMembership(tx: TeamMutationTransaction, provider: ScimProvider, member: ScimGroupMember) {
  if (normalizeMappingMode(provider.groupMappingMode) === "create_teams" && member.teamMemberId) {
    await tx.delete(TeamMemberTable).where(eq(TeamMemberTable.id, member.teamMemberId))
  }
}

// All callers hold the organization lock and pass the same transaction through
// source reads, projection writes, and ownership updates.
async function replaceScimGroupMembers(tx: TeamMutationTransaction, input: {
  provider: ScimProvider
  group: ScimGroup
  members: ScimGroupMemberInput[]
}) {
  const group = await ensureGroupTeam(tx, input.provider, input.group)
  const nextMembers = uniqueMembers(input.members)
  const existing = await loadGroupMembers(group.id, tx)
  const nextValues = new Set(nextMembers.map((member) => member.value))
  const existingByValue = new Map(
    existing.flatMap((member) => member.remoteUserId ? [[member.remoteUserId, member]] : []),
  )

  for (const member of existing) {
    if (!member.remoteUserId) {
      continue
    }
    if (!nextValues.has(member.remoteUserId)) {
      await detachOwnedTeamMembership(tx, input.provider, member)
      await tx.delete(ScimGroupMemberTable).where(eq(ScimGroupMemberTable.id, member.id))
    }
  }

  for (const nextMember of nextMembers) {
    let member = existingByValue.get(nextMember.value)
    if (!member) {
      const memberId = createDenTypeId("scimGroupMember")
      const now = new Date()
      await tx.insert(ScimGroupMemberTable).values({
        id: memberId,
        groupId: group.id,
        organizationId: input.provider.organizationId,
        providerId: input.provider.providerId,
        remoteUserId: nextMember.value,
        createdAt: now,
        updatedAt: now,
      })
      const rows = await tx
        .select()
        .from(ScimGroupMemberTable)
        .where(eq(ScimGroupMemberTable.id, memberId))
        .limit(1)
      member = rows[0]
    }
    if (member && !member.teamMemberId) {
      await attachGroupMemberToTeam(tx, { provider: input.provider, group, member })
    }
  }

  return group
}

export async function createScimGroup(input: {
  provider: ScimProvider
  value: ScimGroupInput
}): Promise<ScimGroupMutationResult> {
  return withOrganizationTeamMutation(input.provider.organizationId, async (tx): Promise<ScimGroupMutationResult> => {
    const provider = await loadScimProvider(tx, input.provider)
    if (!provider) return { ok: false, status: 404, detail: "Provider not found" }
    const displayName = input.value.displayName.trim()
    if (!displayName) {
      return { ok: false, status: 400, detail: "displayName is required" }
    }

    if (input.value.externalId) {
      const duplicateRows = await tx
        .select({ id: ScimGroupTable.id })
        .from(ScimGroupTable)
        .where(and(
          eq(ScimGroupTable.providerId, provider.providerId),
          eq(ScimGroupTable.externalId, input.value.externalId),
        ))
        .limit(1)
      if (duplicateRows[0]) {
        return { ok: false, status: 409, detail: "A group with that externalId already exists" }
      }
    }

    const now = new Date()
    const groupId = createDenTypeId("scimGroup")
    await tx.insert(ScimGroupTable).values({
      id: groupId,
      organizationId: provider.organizationId,
      providerId: provider.providerId,
      scimGroupId: groupId,
      externalId: input.value.externalId ?? null,
      displayName,
      createdAt: now,
      updatedAt: now,
    })

    const rows = await tx.select().from(ScimGroupTable).where(eq(ScimGroupTable.id, groupId)).limit(1)
    const created = rows[0]
    if (!created) {
      throw new Error("SCIM group was created but could not be loaded")
    }
    const group = await replaceScimGroupMembers(tx, {
      provider,
      group: created,
      members: input.value.members ?? [],
    })
    return { ok: true, group }
  })
}

export async function getScimGroup(input: {
  provider: ScimProvider
  groupId: string
}, database: Pick<typeof db, "select"> = db) {
  let groupId: ScimGroup["id"]
  try {
    groupId = normalizeDenTypeId("scimGroup", input.groupId)
  } catch {
    return null
  }

  const rows = await database
    .select()
    .from(ScimGroupTable)
    .where(and(
      eq(ScimGroupTable.id, groupId),
      eq(ScimGroupTable.providerId, input.provider.providerId),
      eq(ScimGroupTable.organizationId, input.provider.organizationId),
    ))
    .limit(1)
  return rows[0] ?? null
}

export async function listScimGroups(provider: ScimProvider, database: Pick<typeof db, "select"> = db) {
  return database
    .select()
    .from(ScimGroupTable)
    .where(and(
      eq(ScimGroupTable.providerId, provider.providerId),
      eq(ScimGroupTable.organizationId, provider.organizationId),
    ))
}

export async function updateScimGroup(input: {
  provider: ScimProvider
  groupId: string
} & ({ value: ScimGroupInput } | { operations: ScimGroupPatchOperation[] })): Promise<ScimGroupMutationResult> {
  return withOrganizationTeamMutation(input.provider.organizationId, async (tx): Promise<ScimGroupMutationResult> => {
    const provider = await loadScimProvider(tx, input.provider)
    if (!provider) return { ok: false, status: 404, detail: "Provider not found" }
    const group = await getScimGroup({ provider, groupId: input.groupId }, tx)
    if (!group) {
      return { ok: false, status: 404, detail: "Group not found" }
    }
    const value = "value" in input ? input.value : applyScimGroupPatch({
      current: {
        displayName: group.displayName,
        externalId: group.externalId,
        members: (await loadGroupMembers(group.id, tx)).flatMap((member) => member.remoteUserId ? [{ value: member.remoteUserId }] : []),
      },
      operations: input.operations,
    })
    const displayName = value.displayName.trim()
    if (!displayName) {
      return { ok: false, status: 400, detail: "displayName is required" }
    }
    if (value.externalId && value.externalId !== group.externalId) {
      const duplicateRows = await tx
        .select({ id: ScimGroupTable.id })
        .from(ScimGroupTable)
        .where(and(
          eq(ScimGroupTable.providerId, provider.providerId),
          eq(ScimGroupTable.externalId, value.externalId),
        ))
        .limit(1)
      if (duplicateRows[0]) {
        return { ok: false, status: 409, detail: "A group with that externalId already exists" }
      }
    }

    const now = new Date()
    await tx
      .update(ScimGroupTable)
      .set({ externalId: value.externalId ?? null, displayName, updatedAt: now })
      .where(eq(ScimGroupTable.id, group.id))

    if (group.teamId && normalizeMappingMode(provider.groupMappingMode) === "create_teams") {
      const teamName = await chooseScimTeamName(tx, {
        organizationId: provider.organizationId,
        displayName,
        currentTeamId: group.teamId,
      })
      await tx.update(TeamTable).set({ name: teamName, updatedAt: now }).where(eq(TeamTable.id, group.teamId))
    }

    const updated = { ...group, externalId: value.externalId ?? null, displayName, updatedAt: now }
    const replaced = await replaceScimGroupMembers(tx, {
      provider,
      group: updated,
      members: value.members ?? [],
    })
    return { ok: true, group: replaced }
  })
}

export async function deleteScimGroup(input: {
  provider: ScimProvider
  groupId: string
}): Promise<{ ok: true } | { ok: false; status: 404; detail: string }> {
  return withOrganizationTeamMutation(input.provider.organizationId, async (tx): Promise<{ ok: true } | { ok: false; status: 404; detail: string }> => {
    const provider = await loadScimProvider(tx, input.provider)
    const group = provider ? await getScimGroup({ provider, groupId: input.groupId }, tx) : null
    if (!provider || !group) return { ok: false, status: 404, detail: "Group not found" }
    if (group.teamId && normalizeMappingMode(provider.groupMappingMode) === "create_teams") {
      await tx.update(TeamTable).set({ grantsOrganizationAdmin: false })
        .where(and(eq(TeamTable.id, group.teamId), eq(TeamTable.organizationId, input.provider.organizationId)))
    }
    const members = await tx.select().from(ScimGroupMemberTable).where(eq(ScimGroupMemberTable.groupId, group.id))
    const teamMemberIds = members.flatMap((member) => provider.groupMappingMode === "create_teams" && member.teamMemberId ? [member.teamMemberId] : [])
    if (teamMemberIds.length > 0) await tx.delete(TeamMemberTable).where(inArray(TeamMemberTable.id, teamMemberIds))
    await tx.delete(ScimGroupMemberTable).where(eq(ScimGroupMemberTable.groupId, group.id))
    await tx.delete(ScimGroupTable).where(eq(ScimGroupTable.id, group.id))
    return { ok: true }
  })
}

export async function serializeScimGroup(group: ScimGroup, baseUrl: string): Promise<ScimGroupResource> {
  const members = await loadGroupMembers(group.id)
  const resource: ScimGroupResource = {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    members: members.flatMap((member) => member.remoteUserId
      ? [{
          value: member.remoteUserId,
          $ref: `${baseUrl}/Users/${encodeURIComponent(member.remoteUserId)}`,
        }]
      : []),
    meta: {
      resourceType: "Group",
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: `${baseUrl}/Groups/${group.id}`,
    },
  }
  if (group.externalId) {
    resource.externalId = group.externalId
  }
  return resource
}

export async function setScimGroupMappingMode(input: {
  provider: ScimProvider
  mode: ScimGroupMappingMode
}) {
  await withOrganizationTeamMutation(input.provider.organizationId, async (tx) => {
    const provider = await loadScimProvider(tx, input.provider)
    if (!provider) return
    if (provider.groupMappingMode !== input.mode) {
      const groups = await tx.select({ teamId: ScimGroupTable.teamId }).from(ScimGroupTable)
        .where(and(eq(ScimGroupTable.providerId, input.provider.providerId), eq(ScimGroupTable.organizationId, input.provider.organizationId)))
      const teamIds = groups.flatMap((group) => group.teamId ? [group.teamId] : [])
      if (teamIds.length > 0) {
        await tx.update(TeamTable).set({ grantsOrganizationAdmin: false })
          .where(and(eq(TeamTable.organizationId, input.provider.organizationId), inArray(TeamTable.id, teamIds)))
        if (input.mode === "create_teams") {
          // Re-enabling mapping hands membership back to the IdP, not to the
          // manual edits made while the retained team was disconnected.
          await tx.delete(TeamMemberTable).where(inArray(TeamMemberTable.teamId, teamIds))
        }
      }
    }
    if (input.mode === "metadata_only" || provider.groupMappingMode !== input.mode) {
      await tx.update(ScimGroupMemberTable).set({ teamMemberId: null })
        .where(and(eq(ScimGroupMemberTable.providerId, provider.providerId), eq(ScimGroupMemberTable.organizationId, provider.organizationId)))
    }
    await tx.update(ScimProviderTable)
      .set({ groupMappingMode: input.mode, updatedAt: new Date() })
      .where(eq(ScimProviderTable.id, input.provider.id))
    if (input.mode === "create_teams") {
      const nextProvider = { ...provider, groupMappingMode: input.mode }
      const groups = await listScimGroups(nextProvider, tx)
      for (const group of groups) {
        const members = await loadGroupMembers(group.id, tx)
        await replaceScimGroupMembers(tx, {
          provider: nextProvider,
          group,
          members: members.flatMap((member) => member.remoteUserId
            ? [{ value: member.remoteUserId }]
            : []),
        })
      }
    }
  })
}

export async function reconcileScimGroupsForUser(input: {
  provider: ScimProvider
  userId: typeof AuthUserTable.$inferSelect.id
}) {
  return withOrganizationTeamMutation(input.provider.organizationId, async (tx) => {
    const provider = await loadScimProvider(tx, input.provider)
    if (!provider) return
    const memberships = await tx
      .select()
      .from(ScimGroupMemberTable)
      .where(and(
        eq(ScimGroupMemberTable.organizationId, provider.organizationId),
        eq(ScimGroupMemberTable.providerId, provider.providerId),
        or(eq(ScimGroupMemberTable.remoteUserId, input.userId), eq(ScimGroupMemberTable.userId, input.userId)),
      ))
    if (memberships.length === 0) {
      return
    }

    const groupIds = [...new Set(memberships.map((member) => member.groupId))]
    const groups = await tx
      .select()
      .from(ScimGroupTable)
      .where(and(
        inArray(ScimGroupTable.id, groupIds),
        eq(ScimGroupTable.providerId, provider.providerId),
        eq(ScimGroupTable.organizationId, provider.organizationId),
      ))
    const groupsById = new Map(groups.map((group) => [group.id, group]))

    for (const member of memberships) {
      const group = groupsById.get(member.groupId)
      if (group && !member.teamMemberId) {
        await attachGroupMemberToTeam(tx, { provider, group, member })
      }
    }
  })
}

export async function getScimManagedTeamIds(organizationId: ScimProvider["organizationId"], database: Pick<typeof db, "select"> = db) {
  const rows = await database
    .select({ teamId: ScimGroupTable.teamId })
    .from(ScimGroupTable)
    .innerJoin(ScimProviderTable, eq(ScimProviderTable.providerId, ScimGroupTable.providerId))
    .where(and(
      eq(ScimGroupTable.organizationId, organizationId),
      eq(ScimProviderTable.groupMappingMode, "create_teams"),
    ))
  return new Set(rows.flatMap((row) => row.teamId ? [row.teamId] : []))
}

export async function isScimManagedTeam(input: {
  organizationId: ScimProvider["organizationId"]
  teamId: typeof TeamTable.$inferSelect.id
}, database: Pick<typeof db, "select"> = db) {
  const rows = await database
    .select({ id: ScimGroupTable.id })
    .from(ScimGroupTable)
    .innerJoin(ScimProviderTable, eq(ScimProviderTable.providerId, ScimGroupTable.providerId))
    .where(and(
      eq(ScimGroupTable.organizationId, input.organizationId),
      eq(ScimGroupTable.teamId, input.teamId),
      eq(ScimProviderTable.groupMappingMode, "create_teams"),
    ))
    .limit(1)
  return Boolean(rows[0])
}
