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
import { deleteRemoteSessionTailsForRunner } from "./remote-sessions/tails.js"
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

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

export type ComputerDisconnection = typeof ComputerDisconnectionTable.$inferSelect

export type SignInSession = { id: string; createdAt: Date }

export const COMPUTER_DISCONNECTED_MESSAGE = "This computer was disconnected from your organization. Sign in again to reconnect it."
export const computerDisconnectedBody = { error: COMPUTER_DISCONNECTED_ERROR, message: COMPUTER_DISCONNECTED_MESSAGE } as const
export const COMPUTER_DISCONNECTED_SESSION_MESSAGE = "That computer was disconnected from your organization. Sign in on it again to reach it."

const DESKTOP_PROVIDER = "openwork_desktop"
const MCP_INTERNAL_SESSION_ID = "mcp_internal"

export function computerDisconnectedException() {
  return new HTTPException(403, { res: Response.json(computerDisconnectedBody, { status: 403 }) })
}

export class ComputerDisconnectedError extends Error {
  constructor() {
    super(COMPUTER_DISCONNECTED_ERROR)
    this.name = "ComputerDisconnectedError"
  }
}

export function signInSessionOf(c: { get: <K extends "apiKey" | "session">(key: K) => AuthContextVariables[K] }): SignInSession | null {
  const session = c.get("session")
  if (!session || session.id === MCP_INTERNAL_SESSION_ID || c.get("apiKey")) return null
  return { id: session.id, createdAt: new Date(session.createdAt) }
}

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

export type RunnerStanding = "active" | "inactive" | "disconnected"

export async function runnerStanding(identity: { organizationId: string; ownerMemberId: string; runnerId: string }): Promise<RunnerStanding> {
  if (!await isActiveAutomationOwner(identity)) return "inactive"
  return await findDisconnection(identity.organizationId, identity.ownerMemberId, identity.runnerId) ? "disconnected" : "active"
}

export async function runnerDisconnected(identity: { organizationId: string; ownerMemberId: string; runnerId: string }): Promise<boolean> {
  return await findDisconnection(identity.organizationId, identity.ownerMemberId, identity.runnerId) !== null
}

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

export const deviceDisconnectionJoin = and(
  eq(RemoteDeviceTable.provider, DESKTOP_PROVIDER),
  eq(ComputerDisconnectionTable.id, RemoteDeviceTable.externalId),
  eq(ComputerDisconnectionTable.organizationId, RemoteDeviceTable.organizationId),
  eq(ComputerDisconnectionTable.ownerMemberId, RemoteDeviceTable.ownerMemberId),
)

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

export async function deleteOrganizationComputerDisconnections(database: RemoteDeviceDatabase, organizationId: OrganizationId) {
  await database.delete(ComputerDisconnectionTable).where(eq(ComputerDisconnectionTable.organizationId, organizationId))
}

export async function dropDisconnectedRunner(scope: { organizationId: string; ownerMemberId: string; runnerId: string }) {
  await db.delete(AutomationRunnerTable).where(and(
    eq(AutomationRunnerTable.id, automationRunnerRowId(scope)),
    eq(AutomationRunnerTable.organization_id, normalizeDenTypeId("organization", scope.organizationId)),
    eq(AutomationRunnerTable.owner_member_id, normalizeDenTypeId("member", scope.ownerMemberId)),
  ))
}

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
  await deleteRemoteSessionTailsForRunner({
    organizationId: scope.organizationId,
    ownerMemberId: scope.ownerMemberId,
    runnerId: scope.installId,
  })
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

async function endDesktopSignIn(input: {
  organizationId: OrganizationId
  ownerMemberId: MemberId
  authSessionId: DenTypeId<"session"> | null
  actorSessionId: string | null
}): Promise<boolean> {
  if (!input.authSessionId || input.authSessionId === input.actorSessionId) return false
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
  await cache.auth.revokeSession(session.token)
  await cache.auth.revokeSessionId(session.id)
  const { recordOrganizationSessionsRevoked } = await import("./audit/domain/sessions.js")
  await recordOrganizationSessionsRevoked({
    organizationId: input.organizationId, memberId: input.ownerMemberId, userId: session.userId, sessions: [session], reasonCode: COMPUTER_DISCONNECTED_ERROR,
  })
  return true
}

export async function disconnectDesktop(input: {
  organizationId: OrganizationId
  ownerMemberId: MemberId
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
  const [runner] = await db.$primary.select({ installId: AutomationRunnerTable.install_id, authSessionId: AutomationRunnerTable.auth_session_id })
    .from(AutomationRunnerTable).where(and(eq(AutomationRunnerTable.id, input.runnerRowId), runnerOwned)).limit(1)
  const installId = runner?.installId ?? null
  const scope = { organizationId: input.organizationId, ownerMemberId: input.ownerMemberId, runnerRowId: input.runnerRowId }

  await db.transaction(async (tx) => {
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
