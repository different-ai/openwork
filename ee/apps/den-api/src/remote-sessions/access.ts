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

/**
 * What other devices may do on a member's computers. Every place that decides
 * it asks here:
 *
 * - The organization's ceiling is `created` unless someone who can edit its
 *   settings changed it. `off` applies whatever the features say; `all` only
 *   while `remoteSessionAccess` is on, and reads as `created` otherwise.
 * - A computer's access is what its owner chose there. Only an app with
 *   `remote_session_choice_v1` can say they chose, by reporting `chosen`; until
 *   it does, the computer is `off` with the organization's opt-in
 *   (`remoteTasksOptIn`) and `created` without it.
 * - An app without that capability cannot be turned off or left unchosen by its
 *   owner, and reports `created` or `all` by itself. Without the opt-in that
 *   is honoured as it always was. With the opt-in the computer is `off`
 *   whatever it reports, until the app is updated.
 * - What applies is the narrower of the two. `off`: nothing reaches the
 *   computer. `created`: tasks can be started there and those sessions
 *   reached. `all`: also sessions that were started on the computer itself.
 */
export type RemoteSessionAccessPolicy = {
  /** `remoteSessionAccess` is on for this member: sessions started on a computer can be reached where both allow `all`. */
  enabled: true
  /** `remoteTasksOptIn` is on for this member: a computer whose owner has not chosen takes nothing. */
  optIn: boolean
  /** `remoteDevices` is on for this member: Den shows them what applies on each of their computers. */
  devices: true
  /** The widest access a member may choose. */
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

/** The policy from feature states and organization metadata that were already read. */
export function remoteSessionAccessPolicy(input: { features: Pick<FeatureMap, "remoteTasksOptIn">; metadata: unknown }): RemoteSessionAccessPolicy {
  const stored = readOrganizationRemoteSessionSettings(input.metadata).access
  return {
    enabled: true,
    optIn: input.features.remoteTasksOptIn,
    devices: true,
    ceiling: stored,
  }
}

/** Who the policy is read for: the signed-in person, or the member a runner belongs to. */
export type RemoteSessionAccessSubject = { userId: string } | { memberId: string }

async function subjectUserId(organizationId: string, subject: RemoteSessionAccessSubject): Promise<string | null> {
  if ("userId" in subject) return subject.userId
  const members = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)),
    eq(MemberTable.id, normalizeDenTypeId("member", subject.memberId)),
  )).limit(1)
  return members[0]?.userId ?? null
}

/** The organization's current policy for one of its members, read fresh: a lowered ceiling applies to the next call. */
export async function readRemoteSessionAccessPolicy(organizationId: string, subject: RemoteSessionAccessSubject): Promise<RemoteSessionAccessPolicy> {
  const userId = await subjectUserId(organizationId, subject)
  const [features, organization] = await Promise.all([
    getOrganizationFeatures(organizationId, userId ? { userId } : {}),
    readOrganizationMetadataColumn(normalizeDenTypeId("organization", organizationId)),
  ])
  return remoteSessionAccessPolicy({ features, metadata: organization?.metadata ?? null })
}

/**
 * The policy for each of several members of one organization, by member id:
 * the organization's metadata and features are read once, and member
 * overrides in one batch, however many members there are.
 */
export async function readRemoteSessionAccessPolicies(organizationId: string, memberIds: readonly string[]): Promise<Map<string, RemoteSessionAccessPolicy>> {
  if (memberIds.length === 0) return new Map()
  const [features, organization] = await Promise.all([
    getOrganizationFeaturesByMember(organizationId),
    readOrganizationMetadataColumn(normalizeDenTypeId("organization", organizationId)),
  ])
  return new Map([...new Set(memberIds)].map((memberId) => [memberId, remoteSessionAccessPolicy({ features: features.forMember(memberId), metadata: organization?.metadata ?? null })]))
}

/** What a runner's registration says its app can do about access. */
export type RunnerAccessCapabilities = {
  /** `remote_session_access_v1`: it can refuse a session, so sessions started on the computer may be reached (`all`). */
  accessCapable: boolean
  /** `remote_session_choice_v1`: its owner can turn remote access off or leave it unchosen, and its reports say which. */
  choiceCapable: boolean
}

export function runnerAccessCapabilities(capabilities: readonly string[] | null | undefined): RunnerAccessCapabilities {
  return {
    accessCapable: capabilities?.includes(REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY) === true,
    choiceCapable: capabilities?.includes(REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY) === true,
  }
}

/**
 * What Den keeps of a runner's report. Never more than the organization's
 * ceiling, and sessions only with `all`. From an app whose owner can choose:
 * their choice, or nothing until they made one (Den works out the default).
 * From an app whose owner cannot: what it reported, and under the opt-in
 * nothing wider than `created`, so no session titles from a computer that is off.
 */
export function storedRunnerSessionReport(runner: RunnerAccessCapabilities, report: RunnerSessionReport, policy: RemoteSessionAccessPolicy): StoredRunnerSessionReport {
  const ceiling = !runner.choiceCapable && policy.optIn ? effectiveRemoteSessionAccess(policy.ceiling, DEFAULT_REMOTE_SESSION_ACCESS_MODE) : policy.ceiling
  const access = runner.choiceCapable && report.chosen !== true ? null : effectiveRemoteSessionAccess(ceiling, report.access)
  return { access, sessions: access === "all" ? report.sessions : [] }
}

/** What one computer allows right now, from its runner registration and latest report. */
export type ComputerSessionAccess = {
  /**
   * Without the opt-in: the app there understands session access. With it:
   * the computer can be allowed at all, which takes an app whose owner can choose.
   */
  supportsAccess: boolean
  /** The owner has chosen there: an app that can say so reported it. */
  chosen: boolean
  /** The owner's choice; until they choose, or where they cannot, what applies by default. */
  access: RemoteSessionAccessMode
  /** That capped by the organization's ceiling. */
  effectiveAccess: RemoteSessionAccessMode
}

export function computerSessionAccess(
  computer: RunnerAccessCapabilities & { reported: RemoteSessionAccessMode | null },
  policy: RemoteSessionAccessPolicy,
): ComputerSessionAccess {
  // Only an app that can refuse a session shares the ones started on its computer.
  const reported = computer.reported === "all" && !computer.accessCapable ? DEFAULT_REMOTE_SESSION_ACCESS_MODE : computer.reported
  const view = (supportsAccess: boolean, chosen: boolean, access: RemoteSessionAccessMode): ComputerSessionAccess =>
    ({ supportsAccess, chosen, access, effectiveAccess: effectiveRemoteSessionAccess(policy.ceiling, access) })
  if (computer.choiceCapable) {
    return view(policy.optIn || computer.accessCapable, reported !== null, reported ?? unchosenRemoteSessionAccess(policy.optIn))
  }
  // An app from before the owner could choose: nothing it reports is their choice.
  if (policy.optIn) return view(false, false, "off")
  return view(computer.accessCapable, false, reported === "all" ? "all" : DEFAULT_REMOTE_SESSION_ACCESS_MODE)
}

/**
 * Why nothing reaches a computer right now, or null when tasks can be started
 * there. The organization's ceiling comes first and needs no computer. Under
 * the opt-in a computer that cannot be allowed has to be updated first; every
 * other computer that is off is its owner's to allow.
 */
export function remoteAccessOffReason(policy: RemoteSessionAccessPolicy, computer: ComputerSessionAccess | null): string | null {
  if (policy.ceiling === "off") return ORGANIZATION_REMOTE_ACCESS_OFF_MESSAGE
  if (computer?.effectiveAccess !== "off") return null
  return policy.optIn && !computer.supportsAccess ? COMPUTER_REMOTE_ACCESS_UPDATE_MESSAGE : COMPUTER_REMOTE_ACCESS_OFF_MESSAGE
}

/**
 * What a device record says of a computer that takes tasks: what applies, and
 * why when something other than its owner's own choice decides it. The
 * organization's limit comes first (its ceiling is `off`, or narrower than
 * what the owner chose); then, under the opt-in, an app that has to be updated
 * before it can be allowed; then an owner who has not chosen yet.
 */
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

/**
 * Why a session reached through an attach may not be used right now, or null
 * when it may. Sessions that were started remotely never come through here.
 */
export function attachedSessionDenial(policy: RemoteSessionAccessPolicy, computer: ComputerSessionAccess | null): string | null {
  if (policy.ceiling !== "all") return ORGANIZATION_SESSION_ACCESS_DENIED_MESSAGE
  if (computer?.effectiveAccess !== "all") return COMPUTER_SESSION_ACCESS_DENIED_MESSAGE
  return null
}
