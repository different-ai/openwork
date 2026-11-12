import { and, eq, gt, inArray, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  AutomationRunTable,
  AutomationRunnerTable,
  AutomationTable,
  ComputerDisconnectionTable,
  MemberTable,
  RemoteDeviceTable,
} from "@openwork-ee/den-db/schema"
import { RemoteSessionCommandTable, RemoteSessionRequestTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { COMPUTER_DISCONNECTED_ERROR } from "@openwork/types/den/remote-devices"
import { HTTPException } from "hono/http-exception"
import { isActiveAutomationOwner } from "./automations/authority.js"
import { automationDesktopLeaseOwner, automationRunnerRowId } from "./automations/repository.js"
import { cache } from "./cache.js"
import { db } from "./db.js"
import { recordRemoteDeviceEvent, type RemoteDeviceDatabase } from "./remote-device-events.js"
import { detachableCommands, detachedCommandValues } from "./remote-sessions/commands.js"
import type { AuthContextVariables } from "./session.js"

/**
 * Disconnecting a signed-in desktop (`computer_disconnection`).
 *
 * A desktop holds its member's ordinary Den session and a stateless runner
 * credential it mints again from that session within a second of being
 * refused, so removing its registration alone revokes nothing. A disconnection
 * row is the durable refusal for one install: no runner credential is minted
 * for it, the ones it still holds are refused on every runner route, and its
 * reports are not taken. Where Den knows the sign-in session the desktop uses,
 * and it is not the one asking, that session is ended too.
 *
 * Signing in on the computer again, a session created after the disconnect,
 * deletes the row. Nothing else does.
 */
type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

export type ComputerDisconnection = typeof ComputerDisconnectionTable.$inferSelect

/** A real sign-in: never an API key or the session Den synthesizes for its own MCP principal. */
export type SignInSession = { id: string; createdAt: Date }

/** What a disconnected desktop is told when it asks for a runner credential, calls a runner route or reports itself. */
export const COMPUTER_DISCONNECTED_MESSAGE = "This computer was disconnected from your organization. Sign in again to reconnect it."
export const computerDisconnectedBody = { error: COMPUTER_DISCONNECTED_ERROR, message: COMPUTER_DISCONNECTED_MESSAGE } as const
/** What someone reaching for a session on a disconnected computer is told. */
export const COMPUTER_DISCONNECTED_SESSION_MESSAGE = "That computer was disconnected from your organization. Sign in on it again to reach it."

const DESKTOP_PROVIDER = "openwork_desktop"
const MCP_INTERNAL_SESSION_ID = "mcp_internal"

/** The 403 a runner route answers with instead of the 401 that makes a desktop mint a new credential. */
export function computerDisconnectedException() {
  return new HTTPException(403, { res: Response.json(computerDisconnectedBody, { status: 403 }) })
}

export class ComputerDisconnectedError extends Error {
  constructor() {
    super(COMPUTER_DISCONNECTED_ERROR)
    this.name = "ComputerDisconnectedError"
  }
}

/** The request's sign-in session when it came with one. */
export function signInSessionOf(c: { get: <K extends "apiKey" | "session">(key: K) => AuthContextVariables[K] }): SignInSession | null {
  const session = c.get("session")
  if (!session || session.id === MCP_INTERNAL_SESSION_ID || c.get("apiKey")) return null
  return { id: session.id, createdAt: new Date(session.createdAt) }
}

/** Only a sign-in that happened after the disconnect connects the computer again. */
export function signedInAfterDisconnect(disconnection: Pick<ComputerDisconnection, "disconnectedAt">, session: SignInSession | null): boolean {
  return session !== null && session.createdAt.getTime() > disconnection.disconnectedAt.getTime()
}

function disconnectionOf(scope: { organizationId: string; ownerMemberId: string; runnerRowId: string }) {
  return and(
    eq(ComputerDisconnectionTable.id, scope.runnerRowId),
    eq(ComputerDisconnectionTable.organizationId, normalizeDenTypeId("organization", scope.organizationId)),
    eq(ComputerDisconnectionTable.ownerMemberId, normalizeDenTypeId("member", scope.ownerMemberId)),
  )
}

/**
 * The disconnection of one member's install, if it was disconnected.
 * primary: a desktop asks again within a second of being refused.
 */
export async function findDisconnection(
  organizationId: string,
  ownerMemberId: string,
  installId: string,
  database: RemoteDeviceDatabase = db.$primary,
): Promise<ComputerDisconnection | null> {
  const runnerRowId = automationRunnerRowId({ organizationId, ownerMemberId, runnerId: installId })
  const [row] = await database.select().from(ComputerDisconnectionTable)
    .where(disconnectionOf({ organizationId, ownerMemberId, runnerRowId })).limit(1)
  return row ?? null
}

/**
 * A disconnected install asks to be taken again. With a sign-in newer than the
 * disconnect the computer is connected again; anything else stays refused.
 */
export async function reconnectIfSignedInAgain(
  disconnection: ComputerDisconnection,
  session: SignInSession | null,
  options: { database?: RemoteDeviceDatabase; now?: Date } = {},
): Promise<"connected" | "refused"> {
  if (!signedInAfterDisconnect(disconnection, session)) return "refused"
  const now = options.now ?? new Date()
  const reconnect = async (database: RemoteDeviceDatabase) => {
    await database.delete(ComputerDisconnectionTable).where(disconnectionOf({ ...disconnection, runnerRowId: disconnection.id }))
    const [device] = await database.select({ id: RemoteDeviceTable.id }).from(RemoteDeviceTable).where(desktopDevice(disconnection)).limit(1)
    if (device) {
      await recordRemoteDeviceEvent(database, {
        organizationId: disconnection.organizationId, deviceId: device.id, type: "restored", actor: "device", message: "Signed in again", now,
      })
    }
  }
  if (options.database) await reconnect(options.database)
  else await db.transaction(reconnect)
  return "connected"
}

/**
 * Whether a runner credential is honoured right now. Runner credentials are
 * stateless and outlive both membership changes and a disconnect, so every
 * runner request asks; a held-open stream asks periodically.
 */
export type RunnerStanding = "active" | "inactive" | "disconnected"

export async function runnerStanding(identity: { organizationId: string; ownerMemberId: string; runnerId: string }): Promise<RunnerStanding> {
  if (!await isActiveAutomationOwner(identity)) return "inactive"
  return await findDisconnection(identity.organizationId, identity.ownerMemberId, identity.runnerId) ? "disconnected" : "active"
}

/** Whether a session's or a target's computer was disconnected, for callers that reach it by its install id. */
export async function runnerDisconnected(identity: { organizationId: string; ownerMemberId: string; runnerId: string }): Promise<boolean> {
  return await findDisconnection(identity.organizationId, identity.ownerMemberId, identity.runnerId) !== null
}

/** The same for callers that hold the `computerId` remote sessions name the computer by. */
export async function computerDisconnected(scope: { organizationId: string; ownerMemberId: string; computerId: string }): Promise<boolean> {
  const [row] = await db.$primary.select({ id: ComputerDisconnectionTable.id }).from(ComputerDisconnectionTable)
    .where(disconnectionOf({ ...scope, runnerRowId: scope.computerId })).limit(1)
  return row !== undefined
}

function desktopDevice(scope: { organizationId: OrganizationId; ownerMemberId: MemberId; id: string }) {
  return and(
    eq(RemoteDeviceTable.organizationId, scope.organizationId),
    eq(RemoteDeviceTable.provider, DESKTOP_PROVIDER),
    eq(RemoteDeviceTable.externalId, scope.id),
    eq(RemoteDeviceTable.ownerMemberId, scope.ownerMemberId),
  )
}

/** Joins a device row to its disconnection; only a member's own signed-in desktop ever has one. */
export const deviceDisconnectionJoin = and(
  eq(RemoteDeviceTable.provider, DESKTOP_PROVIDER),
  eq(ComputerDisconnectionTable.id, RemoteDeviceTable.externalId),
  eq(ComputerDisconnectionTable.organizationId, RemoteDeviceTable.organizationId),
  eq(ComputerDisconnectionTable.ownerMemberId, RemoteDeviceTable.ownerMemberId),
)

/** When each of these devices was disconnected, by device id; connected devices are absent. */
export async function deviceDisconnections(
  deviceIds: readonly DenTypeId<"remoteDevice">[],
  database: RemoteDeviceDatabase = db.$primary,
): Promise<Map<string, Date>> {
  if (deviceIds.length === 0) return new Map()
  const rows = await database.select({ deviceId: RemoteDeviceTable.id, disconnectedAt: ComputerDisconnectionTable.disconnectedAt })
    .from(RemoteDeviceTable).innerJoin(ComputerDisconnectionTable, deviceDisconnectionJoin)
    .where(inArray(RemoteDeviceTable.id, [...deviceIds]))
  return new Map(rows.map((row) => [row.deviceId, row.disconnectedAt]))
}

/** Every disconnection of an organization, when the organization is deleted. */
export async function deleteOrganizationComputerDisconnections(database: RemoteDeviceDatabase, organizationId: OrganizationId) {
  await database.delete(ComputerDisconnectionTable).where(eq(ComputerDisconnectionTable.organizationId, organizationId))
}

/** A registration written while its install was being disconnected: the disconnect wins. */
export async function dropDisconnectedRunner(scope: { organizationId: string; ownerMemberId: string; runnerId: string }) {
  await db.delete(AutomationRunnerTable).where(and(
    eq(AutomationRunnerTable.id, automationRunnerRowId(scope)),
    eq(AutomationRunnerTable.organization_id, normalizeDenTypeId("organization", scope.organizationId)),
    eq(AutomationRunnerTable.owner_member_id, normalizeDenTypeId("member", scope.ownerMemberId)),
  ))
}

/**
 * The work that was going through the computer. With the install id: the
 * attaches it delivered are detached, what it had claimed or was addressed to
 * it is failed, and an Automation run it holds is handed back. Without it (a
 * registration from before the id was kept) only what names the computer by
 * its row id can be found; requests for its other sessions are refused when
 * they are made (runnerDisconnected), and a run it holds ends when its lease does.
 */
async function releaseDesktopWork(scope: { organizationId: OrganizationId; ownerMemberId: MemberId; runnerRowId: string; installId: string | null }, now: Date) {
  const owned = and(
    eq(RemoteSessionCommandTable.org_id, scope.organizationId),
    eq(RemoteSessionCommandTable.owner_member_id, scope.ownerMemberId),
  )
  const failed = {
    status: "failed" as const,
    error_code: COMPUTER_DISCONNECTED_ERROR,
    error_message: COMPUTER_DISCONNECTED_SESSION_MESSAGE,
    updated_at: now,
  }
  const targeted = and(
    eq(RemoteSessionCommandTable.status, "pending"),
    inArray(RemoteSessionCommandTable.target_computer_id, scope.installId ? [scope.runnerRowId, scope.installId] : [scope.runnerRowId]),
  )
  if (scope.installId) {
    await db.update(RemoteSessionCommandTable).set(detachedCommandValues(now)).where(and(
      owned, eq(RemoteSessionCommandTable.claimed_by_runner_id, scope.installId), detachableCommands(),
    ))
  }
  // The released key lets the same task be asked for again once the computer is back.
  await db.update(RemoteSessionCommandTable).set({ ...failed, idempotency_key: null }).where(and(
    owned,
    scope.installId
      ? or(targeted, and(eq(RemoteSessionCommandTable.status, "claimed"), eq(RemoteSessionCommandTable.claimed_by_runner_id, scope.installId)))
      : targeted,
  ))
  if (!scope.installId) return
  await db.update(RemoteSessionRequestTable).set({ ...failed, completed_at: now }).where(and(
    eq(RemoteSessionRequestTable.org_id, scope.organizationId),
    eq(RemoteSessionRequestTable.owner_member_id, scope.ownerMemberId),
    eq(RemoteSessionRequestTable.target_runner_id, scope.installId),
    inArray(RemoteSessionRequestTable.status, ["pending", "claimed"]),
  ))
  // Handed back the way a lost lease is: the scheduler's next pass retries or fails the run.
  const automations = db.select({ id: AutomationTable.id }).from(AutomationTable).where(and(
    eq(AutomationTable.organization_id, scope.organizationId),
    eq(AutomationTable.owner_member_id, scope.ownerMemberId),
  ))
  await db.update(AutomationRunTable).set({ lease_expires_at: new Date(now.getTime() - 1), updated_at: now }).where(and(
    inArray(AutomationRunTable.automation_id, automations),
    eq(AutomationRunTable.lease_owner, automationDesktopLeaseOwner({ ownerMemberId: scope.ownerMemberId, runnerId: scope.installId })),
    inArray(AutomationRunTable.status, ["claimed", "running"]),
    gt(AutomationRunTable.lease_expires_at, now),
  ))
}

/** Ends the sign-in the desktop used, unless it is unknown, gone, someone else's or the one asking. */
async function endDesktopSignIn(input: {
  organizationId: OrganizationId
  ownerMemberId: MemberId
  authSessionId: DenTypeId<"session"> | null
  actorSessionId: string | null
}): Promise<boolean> {
  if (!input.authSessionId || input.authSessionId === input.actorSessionId) return false
  // primary: the session may have been created moments ago.
  const [session] = await db.$primary.select({
    id: AuthSessionTable.id, token: AuthSessionTable.token, userId: AuthSessionTable.userId,
    expiresAt: AuthSessionTable.expiresAt, activeOrganizationId: AuthSessionTable.activeOrganizationId,
  }).from(AuthSessionTable)
    .innerJoin(MemberTable, and(
      eq(MemberTable.userId, AuthSessionTable.userId),
      eq(MemberTable.id, input.ownerMemberId),
      eq(MemberTable.organizationId, input.organizationId),
    ))
    .where(eq(AuthSessionTable.id, input.authSessionId)).limit(1)
  if (!session) return false
  await db.delete(AuthSessionTable).where(eq(AuthSessionTable.id, session.id))
  // Revocation is the authoritative point that invalidates cached auth, as in revokeBearerSession.
  await cache.auth.revokeSession(session.token)
  await cache.auth.revokeSessionId(session.id)
  // Direct delete: no better-auth hook fires. Imported lazily, as session.ts does: the audit
  // emitters load the auth stack, which the remote-session capabilities must not pull in.
  const { recordOrganizationSessionsRevoked } = await import("./audit/domain/sessions.js")
  await recordOrganizationSessionsRevoked({
    organizationId: input.organizationId, memberId: input.ownerMemberId, userId: session.userId, sessions: [session], reasonCode: COMPUTER_DISCONNECTED_ERROR,
  })
  return true
}

/**
 * Disconnects one member's signed-in desktop. Safe to repeat: a computer that
 * is already disconnected keeps its original time and records nothing new.
 * `signedOut` says whether the sign-in the desktop used was ended.
 */
export async function disconnectDesktop(input: {
  organizationId: OrganizationId
  ownerMemberId: MemberId
  /** The install's runner row id: the desktop's `remote_device.external_id`. */
  runnerRowId: string
  actor: { memberId: MemberId; sessionId: string | null }
  byAdmin: boolean
  now?: Date
}): Promise<{ signedOut: boolean }> {
  const now = input.now ?? new Date()
  const runnerOwned = and(
    eq(AutomationRunnerTable.organization_id, input.organizationId),
    eq(AutomationRunnerTable.owner_member_id, input.ownerMemberId),
  )
  // primary: a desktop that registered a moment ago is still signed out.
  const [runner] = await db.$primary.select({ installId: AutomationRunnerTable.install_id, authSessionId: AutomationRunnerTable.auth_session_id })
    .from(AutomationRunnerTable).where(and(eq(AutomationRunnerTable.id, input.runnerRowId), runnerOwned)).limit(1)
  const installId = runner?.installId ?? null
  const scope = { organizationId: input.organizationId, ownerMemberId: input.ownerMemberId, runnerRowId: input.runnerRowId }

  await db.transaction(async (tx) => {
    // The device row serializes disconnects with each other and with the desktop's own report.
    const [device] = await tx.select({ id: RemoteDeviceTable.id }).from(RemoteDeviceTable)
      .where(desktopDevice({ ...scope, id: input.runnerRowId })).limit(1).for("update")
    const [existing] = await tx.select({ id: ComputerDisconnectionTable.id }).from(ComputerDisconnectionTable)
      .where(disconnectionOf(scope)).limit(1).for("update")
    if (!existing) {
      await tx.insert(ComputerDisconnectionTable).values({
        id: input.runnerRowId, organizationId: input.organizationId, ownerMemberId: input.ownerMemberId,
        disconnectedAt: now, disconnectedByMemberId: input.actor.memberId, createdAt: now,
      })
    }
    // Every reader treats a missing registration as a computer that is gone; the refused mint keeps it gone.
    await tx.delete(AutomationRunnerTable).where(and(
      inArray(AutomationRunnerTable.id, installId ? [input.runnerRowId, installId] : [input.runnerRowId]),
      runnerOwned,
    ))
    if (!existing && device) {
      await recordRemoteDeviceEvent(tx, {
        organizationId: input.organizationId, deviceId: device.id, type: "disconnected", level: "warning", actor: "member", actorId: input.actor.memberId,
        message: input.byAdmin ? "Disconnected by an admin" : "Disconnected by its owner", now,
      })
    }
  })

  await releaseDesktopWork({ ...scope, installId }, now)
  const signedOut = await endDesktopSignIn({
    organizationId: input.organizationId, ownerMemberId: input.ownerMemberId,
    authSessionId: runner?.authSessionId ?? null, actorSessionId: input.actor.sessionId,
  })
  return { signedOut }
}
