/**
 * Gateway usage accounting: the always-on half of Gateway usage.
 *
 * Everything here runs whenever the AI Gateway runs, whether or not usage
 * limits are enforced for the organization: the write-ahead request log,
 * settlement (cost, rollup-safe finalization), retention guards, member and
 * organization lifecycle cleanup, and the reconciliation/recovery operations.
 * Never gate these on the usage-limits module; only admission
 * (`createGatewayUsageLimits().admit` in `./gateway-usage-limits`) is gated.
 */
import type { GatewayUsageDb } from "./gateway-usage-read"
import { settleGatewayUsage, type UsageLogRow } from "./gateway-usage-settlement"
import { runGatewayUsageTransaction } from "./gateway-usage-tx"

export { GatewayUsageError, safeUsageDatabaseCode } from "./gateway-usage-errors"
export { deleteGatewayUsageForOrganization } from "./gateway-usage-erasure"
export { reconcileGatewayUsageBatch } from "./gateway-usage-reconciliation"
export { listPendingGatewayUsageRequests, recoverGatewayUsageRequests, rotateGatewayUsageEpoch } from "./gateway-usage-operations"
export {
  startGatewayUsageLog,
  assertUsageRetentionSafe,
  expireUsageRequestsForMembers,
  fenceUsageOrganizationDeletion,
} from "./gateway-usage-lifecycle"
export type { GatewayUsageDb, GatewayUsageScope, GatewayUsageSnapshot } from "./gateway-usage-read"

/**
 * Finalizes one `org_provider` request log row: writes cost and usage, and
 * charges buckets only when the row was admitted with a usage snapshot.
 * Returns false for other routes and when the row no longer exists.
 */
export function recordGatewayUsage(db: GatewayUsageDb, row: UsageLogRow, clock: () => Date = () => new Date()): Promise<boolean> {
  if (row.route !== "org_provider") return Promise.resolve(false)
  return runGatewayUsageTransaction(db, clock, (tx, now) => settleGatewayUsage(tx, row, now))
}
