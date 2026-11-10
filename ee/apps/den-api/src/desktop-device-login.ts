import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import type { FeatureDatabase } from "@openwork-ee/den-db/organization-features"
import { readFeatures } from "@openwork-ee/den-db/organization-features"
import { FeatureRolloutTable, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { APIError } from "better-auth/api"
import type { drizzleAdapter } from "better-auth/adapters/drizzle"
import { db } from "./db.js"
import { env } from "./env.js"

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
type ApprovedDesktopSession = { organizationId: string; userId: string }
// Keyed by the fresh, server-generated session token, not a client-supplied code.
// The adapter consumes this immediately; no device secret is stored here.
const approvedSessions = new Map<string, ApprovedDesktopSession>()

export function stageApprovedDesktopSession(token: string, approval: ApprovedDesktopSession): void {
  approvedSessions.set(token, approval)
}

/** Only this client's session insert uses the transaction-bound adapter. The
 * factory includes session hashing, so the guard sees the in-memory token and
 * never bypasses the existing at-rest token protection.
 */
export function guardDesktopDeviceSessions(factory: AdapterFactory, transactionFactory: (database: FeatureDatabase) => AdapterFactory, onFailure: (token: string) => void): AdapterFactory {
  return (options) => {
    const adapter = factory(options)
    return {
      ...adapter,
      create: async (data) => {
        const token = data.model === "session" && typeof data.data.token === "string" ? data.data.token : null
        const approval = token ? approvedSessions.get(token) : undefined
        if (token) approvedSessions.delete(token)
        if (!approval) return adapter.create(data)
        try {
          return await db.transaction(async (tx) => {
            if (!await desktopDeviceLoginEnabled(tx, approval)) throw desktopDeviceAccessDenied()
            return transactionFactory(tx)(options).create(data)
          })
        } catch (error) {
          if (token) onFailure(token)
          throw error
        }
      },
    }
  }
}
