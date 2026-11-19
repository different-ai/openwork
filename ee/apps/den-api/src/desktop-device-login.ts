import { AsyncLocalStorage } from "node:async_hooks"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import type { FeatureDatabase } from "@openwork-ee/den-db/organization-features"
import { readFeatures } from "@openwork-ee/den-db/organization-features"
import { FeatureRolloutTable, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { APIError } from "better-auth/api"
import type { drizzleAdapter } from "better-auth/adapters/drizzle"
import { db } from "./db.js"
import { env } from "./env.js"
import { DEN_DESKTOP_DEVICE_CLIENT_ID } from "./device-clients.js"

export const DESKTOP_DEVICE_DISABLED_MESSAGE = "Device sign-in is not available on this server. Use the sign-in link instead."

export function desktopDeviceAccessDenied(): APIError {
  return new APIError("FORBIDDEN", { error: "access_denied", error_description: DESKTOP_DEVICE_DISABLED_MESSAGE })
}

/** Uncached, primary reads. Hold the rollout row through the protected write:
 * readFeatures locks org/member overrides, but not the deployment rollout.
 * Kill/disable and session insertion thus have an explicit commit ordering.
 */
export async function desktopDeviceLoginEnabled(database: FeatureDatabase, input?: { organizationId: string; userId: string }): Promise<boolean> {
  await database.select({ key: FeatureRolloutTable.feature_key }).from(FeatureRolloutTable)
    .where(eq(FeatureRolloutTable.feature_key, "remoteDesktopDeviceLogin")).for("share")
  if (!(await readFeatures(database, null, env.features)).remoteDesktopDeviceLogin) return false
  if (!input) return true
  const [member] = await database.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
    eq(MemberTable.userId, normalizeDenTypeId("user", input.userId)),
    isNull(MemberTable.removedAt),
  )).limit(1).for("share")
  if (!member) return false
  return (await readFeatures(database, input.organizationId, env.features, { userId: input.userId, lock: "share" })).remoteDesktopDeviceLogin
}

type AdapterFactory = ReturnType<typeof drizzleAdapter>
type Adapter = ReturnType<AdapterFactory>
type DesktopDeviceClaim = {
  clientId: typeof DEN_DESKTOP_DEVICE_CLIENT_ID
  userId: string
  organizationId: string
  ssoProviderId: string | null
  ssoAuthenticatedAt: Date | null
}
type DesktopDeviceRequest = { desktop: boolean; claim: DesktopDeviceClaim | null; insertStarted: boolean; closed: boolean }
const desktopDeviceRequest = new AsyncLocalStorage<DesktopDeviceRequest>()

/** The public auth proxy owns this scope. Nested/overlapping requests get
 * different stores; even async work surviving a response loses its claim.
 */
export function withDesktopDeviceClaimRequest<T>(run: () => Promise<T>): Promise<T> {
  const state: DesktopDeviceRequest = { desktop: false, claim: null, insertStarted: false, closed: false }
  return desktopDeviceRequest.run(state, async () => {
    try {
      return await run()
    } finally {
      state.claim = null
      state.closed = true
    }
  })
}

export function beginDesktopDeviceClaim(): void {
  const state = desktopDeviceRequest.getStore()
  if (!state || state.closed) throw desktopDeviceAccessDenied()
  state.desktop = true
}

export function requireDesktopDeviceClaim(userId: string): DesktopDeviceClaim {
  const state = desktopDeviceRequest.getStore()
  if (!state || state.closed || !state.desktop || !state.claim || state.claim.userId !== userId) throw desktopDeviceAccessDenied()
  return state.claim
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function approvedDesktopClaim(row: unknown): DesktopDeviceClaim {
  if (!isRecord(row) || row.status !== "approved" || row.clientId !== DEN_DESKTOP_DEVICE_CLIENT_ID
    || typeof row.userId !== "string" || !row.userId || typeof row.organizationId !== "string" || !row.organizationId
    || (row.ssoProviderId != null && typeof row.ssoProviderId !== "string")
    || (row.ssoAuthenticatedAt != null && (!(row.ssoAuthenticatedAt instanceof Date) || !Number.isFinite(row.ssoAuthenticatedAt.getTime())))) {
    throw desktopDeviceAccessDenied()
  }
  return {
    clientId: row.clientId, userId: row.userId, organizationId: row.organizationId,
    ssoProviderId: row.ssoProviderId ?? null, ssoAuthenticatedAt: row.ssoAuthenticatedAt ?? null,
  }
}

/** Capture only the successful atomic claim, never a pre-read of a code that
 * may still be pending. Better Auth deletes that row before createSession.
 * The adapter-only projection includes Den's EXISTING columns; it adds no DB
 * fields or protocol inputs and does not change the legacy staging path.
 * Session insertion still locks rollout/member policy and hashes its token.
 */
export function guardDesktopDeviceSessions(factory: AdapterFactory, transactionFactory: (database: FeatureDatabase) => AdapterFactory): AdapterFactory {
  return (options) => {
    const adapter = factory({
      ...options,
      plugins: [...options.plugins ?? [], {
        id: "den-device-claim-columns",
        schema: { deviceCode: { fields: {
          organizationId: { type: "string", required: false, input: false },
          ssoProviderId: { type: "string", required: false, input: false },
          ssoAuthenticatedAt: { type: "date", required: false, input: false },
        } } },
      }],
    })
    return {
      ...adapter,
      consumeOne: async <T>(data: Parameters<Adapter["consumeOne"]>[0]) => {
        const row = await adapter.consumeOne<T>(data)
        if (data.model !== "deviceCode") return row
        const state = desktopDeviceRequest.getStore()
        if (!state?.desktop && !(isRecord(row) && row.clientId === DEN_DESKTOP_DEVICE_CLIENT_ID)) return row
        if (!state || state.closed || !state.desktop) throw desktopDeviceAccessDenied()
        state.claim = null
        if (row != null) state.claim = approvedDesktopClaim(row)
        return row
      },
      create: async (data) => {
        const state = desktopDeviceRequest.getStore()
        if (data.model !== "session" || !state?.desktop) return adapter.create(data)
        if (typeof data.data.userId !== "string") throw desktopDeviceAccessDenied()
        const approval = requireDesktopDeviceClaim(normalizeDenTypeId("user", data.data.userId))
        if (state.insertStarted || data.data.activeOrganizationId !== approval.organizationId) throw desktopDeviceAccessDenied()
        state.insertStarted = true
        return db.transaction(async (tx) => {
          if (!await desktopDeviceLoginEnabled(tx, approval)) throw desktopDeviceAccessDenied()
          return transactionFactory(tx)(options).create(data)
        })
      },
    }
  }
}
