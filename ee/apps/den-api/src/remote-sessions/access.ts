import { and, eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema/org"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  DEFAULT_REMOTE_SESSION_ACCESS_MODE,
  REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY,
  REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY,
  effectiveRemoteSessionAccess,
  unchosenRemoteSessionAccess,
  type RemoteSessionAccessMode,
  type RunnerSessionReport,
} from "@openwork/types/automations"
import type { RemoteDeviceAccess } from "@openwork/types/den/remote-devices"
import { readOrganizationRemoteSessionSettings } from "@openwork/types/den/remote-sessions"
import type { StoredRunnerSessionReport } from "../automations/repository.js"
import { db } from "../db.js"
import { getOrganizationFeatures, getOrganizationFeaturesByMember, type FeatureMap } from "../features.js"
import { readOrganizationMetadataColumn } from "../organization-metadata.js"

export type RemoteSessionAccessPolicy = {
  enabled: true
  optIn: boolean
  devices: true
  ceiling: RemoteSessionAccessMode
}

export const ORGANIZATION_SESSION_ACCESS_DENIED_MESSAGE = "Your organization only allows sessions that were started remotely."
export const COMPUTER_SESSION_ACCESS_DENIED_MESSAGE =
  "That computer only allows sessions that were started remotely. Its owner can change this in Settings > Devices on that computer."
export const ORGANIZATION_REMOTE_ACCESS_OFF_MESSAGE = "Your organization has turned off tasks from other devices."
export const COMPUTER_REMOTE_ACCESS_OFF_MESSAGE =
  "That computer doesn't take tasks from other devices. Its owner can allow it in Settings > Devices on that computer."
export const COMPUTER_REMOTE_ACCESS_UPDATE_MESSAGE =
  "Update OpenWork on that computer, then allow tasks from other devices in Settings > Devices on it."

export function remoteSessionAccessPolicy(input: { features: Pick<FeatureMap, "remoteTasksOptIn">; metadata: unknown }): RemoteSessionAccessPolicy {
  const stored = readOrganizationRemoteSessionSettings(input.metadata).access
  return {
    enabled: true,
    optIn: input.features.remoteTasksOptIn,
    devices: true,
    ceiling: stored,
  }
}

export type RemoteSessionAccessSubject = { userId: string } | { memberId: string }

async function subjectUserId(organizationId: string, subject: RemoteSessionAccessSubject): Promise<string | null> {
  if ("userId" in subject) return subject.userId
  const members = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)),
    eq(MemberTable.id, normalizeDenTypeId("member", subject.memberId)),
  )).limit(1)
  return members[0]?.userId ?? null
}

export async function readRemoteSessionAccessPolicy(organizationId: string, subject: RemoteSessionAccessSubject): Promise<RemoteSessionAccessPolicy> {
  const userId = await subjectUserId(organizationId, subject)
  const [features, organization] = await Promise.all([
    getOrganizationFeatures(organizationId, userId ? { userId } : {}),
    readOrganizationMetadataColumn(normalizeDenTypeId("organization", organizationId)),
  ])
  return remoteSessionAccessPolicy({ features, metadata: organization?.metadata ?? null })
}

export async function readRemoteSessionAccessPolicies(organizationId: string, memberIds: readonly string[]): Promise<Map<string, RemoteSessionAccessPolicy>> {
  if (memberIds.length === 0) return new Map()
  const [features, organization] = await Promise.all([
    getOrganizationFeaturesByMember(organizationId),
    readOrganizationMetadataColumn(normalizeDenTypeId("organization", organizationId)),
  ])
  return new Map([...new Set(memberIds)].map((memberId) => [memberId, remoteSessionAccessPolicy({ features: features.forMember(memberId), metadata: organization?.metadata ?? null })]))
}

export type RunnerAccessCapabilities = {
  accessCapable: boolean
  choiceCapable: boolean
}

export function runnerAccessCapabilities(capabilities: readonly string[] | null | undefined): RunnerAccessCapabilities {
  return {
    accessCapable: capabilities?.includes(REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY) === true,
    choiceCapable: capabilities?.includes(REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY) === true,
  }
}

export function storedRunnerSessionReport(runner: RunnerAccessCapabilities, report: RunnerSessionReport, policy: RemoteSessionAccessPolicy): StoredRunnerSessionReport {
  const ceiling = !runner.choiceCapable && policy.optIn ? effectiveRemoteSessionAccess(policy.ceiling, DEFAULT_REMOTE_SESSION_ACCESS_MODE) : policy.ceiling
  const access = runner.choiceCapable && report.chosen !== true ? null : effectiveRemoteSessionAccess(ceiling, report.access)
  return { access, sessions: access === "all" ? report.sessions : [] }
}

export type ComputerSessionAccess = {
  supportsAccess: boolean
  chosen: boolean
  access: RemoteSessionAccessMode
  effectiveAccess: RemoteSessionAccessMode
}

export function computerSessionAccess(
  computer: RunnerAccessCapabilities & { reported: RemoteSessionAccessMode | null },
  policy: RemoteSessionAccessPolicy,
): ComputerSessionAccess {
  const reported = computer.reported === "all" && !computer.accessCapable ? DEFAULT_REMOTE_SESSION_ACCESS_MODE : computer.reported
  const view = (supportsAccess: boolean, chosen: boolean, access: RemoteSessionAccessMode): ComputerSessionAccess =>
    ({ supportsAccess, chosen, access, effectiveAccess: effectiveRemoteSessionAccess(policy.ceiling, access) })
  if (computer.choiceCapable) {
    return view(policy.optIn || computer.accessCapable, reported !== null, reported ?? unchosenRemoteSessionAccess(policy.optIn))
  }
  if (policy.optIn) return view(false, false, "off")
  return view(computer.accessCapable, false, reported === "all" ? "all" : DEFAULT_REMOTE_SESSION_ACCESS_MODE)
}

export function remoteAccessOffReason(policy: RemoteSessionAccessPolicy, computer: ComputerSessionAccess | null): string | null {
  if (policy.ceiling === "off") return ORGANIZATION_REMOTE_ACCESS_OFF_MESSAGE
  if (computer?.effectiveAccess !== "off") return null
  return policy.optIn && !computer.supportsAccess ? COMPUTER_REMOTE_ACCESS_UPDATE_MESSAGE : COMPUTER_REMOTE_ACCESS_OFF_MESSAGE
}

export function remoteDeviceAccess(
  runner: { capabilities: readonly string[] | null | undefined; sessionAccess: RemoteSessionAccessMode | null },
  policy: RemoteSessionAccessPolicy,
): RemoteDeviceAccess {
  const capabilities = runnerAccessCapabilities(runner.capabilities)
  const access = computerSessionAccess({ ...capabilities, reported: runner.sessionAccess }, policy)
  const reason = policy.ceiling === "off" || access.effectiveAccess !== access.access ? "organization"
    : !policy.optIn ? null
    : !capabilities.choiceCapable ? "update_required"
    : access.chosen ? null : "not_chosen"
  return { effective: access.effectiveAccess, chosen: access.chosen, reason }
}

export function attachedSessionDenial(policy: RemoteSessionAccessPolicy, computer: ComputerSessionAccess | null): string | null {
  if (policy.ceiling !== "all") return ORGANIZATION_SESSION_ACCESS_DENIED_MESSAGE
  if (computer?.effectiveAccess !== "all") return COMPUTER_SESSION_ACCESS_DENIED_MESSAGE
  return null
}
