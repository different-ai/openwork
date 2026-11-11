import { and, eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema/org"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  DEFAULT_REMOTE_SESSION_ACCESS_MODE,
  effectiveRemoteSessionAccess,
  type RemoteSessionAccessMode,
} from "@openwork/types/automations"
import { readOrganizationRemoteSessionSettings } from "@openwork/types/den/remote-sessions"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { readOrganizationMetadataColumn } from "../organization-metadata.js"

/**
 * Which sessions on a member's computers other devices may reach (feature
 * `remoteSessionAccess`). Every place that decides it asks here:
 *
 * - The organization's ceiling is `created` unless an owner or admin raised
 *   it, and always `created` while the feature is off.
 * - A computer's access is what its owner chose there, as the computer last
 *   reported it; `created` until it reports, and for apps that do not
 *   understand session access.
 * - What applies is the narrower of the two.
 */
export type RemoteSessionAccessPolicy = {
  /** The feature is on for this member of the organization. */
  enabled: boolean
  /** The widest access a member may choose; `created` while the feature is off. */
  ceiling: RemoteSessionAccessMode
}

export const REMOTE_SESSION_ACCESS_OFF: RemoteSessionAccessPolicy = { enabled: false, ceiling: DEFAULT_REMOTE_SESSION_ACCESS_MODE }

export const ORGANIZATION_SESSION_ACCESS_DENIED_MESSAGE = "Your organization only allows sessions that were started remotely."
export const COMPUTER_SESSION_ACCESS_DENIED_MESSAGE =
  "That computer only allows sessions that were started remotely. Its owner can change this in Settings > Devices on that computer."

/** The policy from a feature state and organization metadata that were already read. */
export function remoteSessionAccessPolicy(input: { enabled: boolean; metadata: unknown }): RemoteSessionAccessPolicy {
  if (!input.enabled) return REMOTE_SESSION_ACCESS_OFF
  return { enabled: true, ceiling: readOrganizationRemoteSessionSettings(input.metadata).access }
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
  if (!await organizationFeatureEnabled(organizationId, "remoteSessionAccess", userId ? { userId } : {})) return REMOTE_SESSION_ACCESS_OFF
  const organization = await readOrganizationMetadataColumn(normalizeDenTypeId("organization", organizationId))
  return remoteSessionAccessPolicy({ enabled: true, metadata: organization?.metadata ?? null })
}

/** What one computer allows right now, from its runner registration and latest report. */
export type ComputerSessionAccess = {
  /** The app there understands session access. */
  supportsAccess: boolean
  /** The owner's choice as last reported; `created` until it reports. */
  access: RemoteSessionAccessMode
  /** The choice capped by the organization's ceiling. */
  effectiveAccess: RemoteSessionAccessMode
}

export function computerSessionAccess(
  computer: { supportsAccess: boolean; reported: RemoteSessionAccessMode | null },
  policy: RemoteSessionAccessPolicy,
): ComputerSessionAccess {
  const access = computer.supportsAccess && computer.reported === "all" ? "all" : DEFAULT_REMOTE_SESSION_ACCESS_MODE
  return { supportsAccess: computer.supportsAccess, access, effectiveAccess: effectiveRemoteSessionAccess(policy.ceiling, access) }
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
