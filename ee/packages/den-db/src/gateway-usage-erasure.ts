import { eq, inArray, or } from "drizzle-orm"
import type { createDenDb } from "./client"
import { OrganizationTable } from "./schema/org"
import { fenceUsageOrganizationDeletion } from "./gateway-usage-lifecycle"
import {
  GatewayUsageAssignmentTable as Assignment,
  GatewayUsageAuditTable as Audit,
  GatewayUsageBucketTable as Bucket,
  GatewayUsageChargeTable as Charge,
  GatewayUsageEventTable as Event,
  GatewayUsageLimitTable as Limit,
  GatewayUsagePolicyTable as Policy,
  GatewayUsageQuarantineTable as Quarantine,
  GatewayUsageResetTable as Reset,
  GatewayUsageSubjectTable as Subject,
  GatewayUsageTrackingTable as Tracking,
} from "./schema/gateway-usage-limits"

type Db = ReturnType<typeof createDenDb>["db"]
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0]

export async function deleteGatewayUsageForOrganization(
  tx: Transaction,
  organizationId: typeof OrganizationTable.$inferSelect.id,
): Promise<void> {
  await fenceUsageOrganizationDeletion(tx, organizationId)
  const policies = tx
    .select({ id: Policy.id })
    .from(Policy)
    .where(eq(Policy.organizationId, organizationId))
  const events = tx
    .select({ id: Event.id })
    .from(Event)
    .where(eq(Event.organizationId, organizationId))
  const buckets = tx
    .select({ id: Bucket.id })
    .from(Bucket)
    .where(eq(Bucket.organizationId, organizationId))
  await tx
    .delete(Charge)
    .where(
      or(
        inArray(Charge.bucketId, buckets),
        inArray(Charge.eventId, events),
        inArray(Charge.policyId, policies),
      ),
    )
  await tx.delete(Reset).where(eq(Reset.organizationId, organizationId))
  await tx.delete(Audit).where(eq(Audit.organizationId, organizationId))
  await tx.delete(Assignment).where(eq(Assignment.organizationId, organizationId))
  await tx.delete(Limit).where(inArray(Limit.policyId, policies))
  await tx.delete(Quarantine).where(eq(Quarantine.organizationId, organizationId))
  await tx.delete(Event).where(eq(Event.organizationId, organizationId))
  await tx.delete(Bucket).where(eq(Bucket.organizationId, organizationId))
  await tx.delete(Subject).where(eq(Subject.organizationId, organizationId))
  await tx.delete(Tracking).where(eq(Tracking.organizationId, organizationId))
  await tx.delete(Policy).where(eq(Policy.organizationId, organizationId))
}
