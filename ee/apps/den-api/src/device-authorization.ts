import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { DeviceCodeTable, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for command-line sign-in.
 *
 * Better Auth's device-authorization plugin owns the protocol endpoints
 * (`/api/auth/device/code`, `/api/auth/device/token`, verify/approve/deny).
 * Den adds one thing: the approving person picks which organization the new
 * device session starts in, because a member of several organizations would
 * otherwise get a session with no active organization.
 */

/** The only client ids allowed to start a device login. */
export const DEN_DEVICE_CLIENT_IDS = ["openwork-cli"] as const

export const DEN_DEVICE_CODE_EXPIRES_IN = "15m"
export const DEN_DEVICE_CODE_POLL_INTERVAL = "5s"

export function isDenDeviceClientId(clientId: string): boolean {
  return DEN_DEVICE_CLIENT_IDS.some((allowed) => allowed === clientId)
}

/** Strip the display separator so "ABCD-EFGH" and "abcdefgh" match the stored code. */
export function normalizeDeviceUserCode(userCode: string): string {
  return userCode.replace(/[\s-]/g, "").toUpperCase()
}

type PendingDeviceOrganization = { userId: string; organizationId: string }

// Filled by the `/device/token` before-hook when the code is approved and read
// by the session-create hook in the same request; the after-hook always clears
// the entry so nothing outlives the request.
const pendingDeviceOrganizations = new Map<string, PendingDeviceOrganization>()

export async function stageDeviceSessionOrganization(deviceCode: string): Promise<void> {
  const [row] = await db
    .select({
      status: DeviceCodeTable.status,
      userId: DeviceCodeTable.userId,
      organizationId: DeviceCodeTable.organizationId,
    })
    .from(DeviceCodeTable)
    .where(eq(DeviceCodeTable.deviceCode, deviceCode))
    .limit(1)
  if (!row || row.status !== "approved" || !row.userId || !row.organizationId) {
    return
  }
  pendingDeviceOrganizations.set(deviceCode, { userId: row.userId, organizationId: row.organizationId })
}

export function clearDeviceSessionOrganization(deviceCode: string): void {
  pendingDeviceOrganizations.delete(deviceCode)
}

async function isActiveMember(input: { userId: string; organizationId: string }): Promise<boolean> {
  const [member] = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.userId, normalizeDenTypeId("user", input.userId)),
      eq(MemberTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  return Boolean(member)
}

/**
 * The organization a device session should start in, or null to keep the
 * default. Membership is re-checked at token time so a person removed between
 * approval and the next poll never lands in that organization.
 */
export async function takeDeviceSessionOrganization(input: { deviceCode: string; userId: string }): Promise<string | null> {
  const pending = pendingDeviceOrganizations.get(input.deviceCode)
  pendingDeviceOrganizations.delete(input.deviceCode)
  if (!pending || pending.userId !== input.userId) {
    return null
  }
  return await isActiveMember(pending) ? pending.organizationId : null
}

export type DeviceCodeLookup =
  | { ok: true; status: "pending" | "approved" | "denied"; clientId: string | null; expiresAt: Date }
  | { ok: false; error: "invalid_user_code" | "expired_user_code" }

/** What the verification page shows before the person decides. Never exposes the device code. */
export async function lookupDeviceUserCode(userCode: string, now = new Date()): Promise<DeviceCodeLookup> {
  const [row] = await db
    .select({ status: DeviceCodeTable.status, clientId: DeviceCodeTable.clientId, expiresAt: DeviceCodeTable.expiresAt })
    .from(DeviceCodeTable)
    .where(eq(DeviceCodeTable.userCode, normalizeDeviceUserCode(userCode)))
    .limit(1)
  if (!row) return { ok: false, error: "invalid_user_code" }
  if (row.expiresAt <= now) return { ok: false, error: "expired_user_code" }
  const status = row.status === "approved" || row.status === "denied" ? row.status : "pending"
  return { ok: true, status, clientId: row.clientId, expiresAt: row.expiresAt }
}

export type DeviceDecisionResult =
  | { ok: true; status: "approved" | "denied" }
  | { ok: false; status: 403 | 404 | 409; error: "not_a_member" | "invalid_user_code" | "already_decided"; message: string }

/**
 * Approve or deny a pending code for the signed-in person. Approval binds the
 * code to that person and the organization they chose; the CLI's next poll of
 * `/api/auth/device/token` then receives a session in that organization. A
 * code already bound to someone else, already decided, or expired is refused.
 */
export async function decideDeviceUserCode(input: {
  userCode: string
  userId: string
  decision: "approve" | "deny"
  organizationId?: string | null
  now?: Date
}): Promise<DeviceDecisionResult> {
  const now = input.now ?? new Date()
  const userId = normalizeDenTypeId("user", input.userId)
  const organizationId = input.decision === "approve" && input.organizationId
    ? normalizeDenTypeId("organization", input.organizationId)
    : null
  if (organizationId && !await isActiveMember({ userId, organizationId })) {
    return { ok: false, status: 403, error: "not_a_member", message: "You are not a member of that organization." }
  }
  const [row] = await db
    .select({ id: DeviceCodeTable.id, status: DeviceCodeTable.status, userId: DeviceCodeTable.userId, expiresAt: DeviceCodeTable.expiresAt })
    .from(DeviceCodeTable)
    .where(eq(DeviceCodeTable.userCode, normalizeDeviceUserCode(input.userCode)))
    .limit(1)
  if (!row || row.expiresAt <= now || (row.userId && row.userId !== userId)) {
    return { ok: false, status: 404, error: "invalid_user_code", message: "This code is invalid or has expired. Start sign-in again from your terminal." }
  }
  if (row.status !== "pending") {
    return { ok: false, status: 409, error: "already_decided", message: "This code was already used. Start sign-in again from your terminal." }
  }
  const status = input.decision === "approve" ? "approved" : "denied"
  // Guarded write: only a still-pending code that is unbound or bound to this
  // person changes, so two tabs racing cannot both decide.
  const result = await db
    .update(DeviceCodeTable)
    .set({ status, userId, organizationId })
    .where(and(
      eq(DeviceCodeTable.id, row.id),
      eq(DeviceCodeTable.status, "pending"),
      row.userId ? eq(DeviceCodeTable.userId, userId) : isNull(DeviceCodeTable.userId),
    ))
  if (affectedRows(result) === 0) {
    return { ok: false, status: 409, error: "already_decided", message: "This code was already used. Start sign-in again from your terminal." }
  }
  return { ok: true, status }
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}
