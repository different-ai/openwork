import { and, eq, inArray } from "drizzle-orm"
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

/**
 * Events, quarantine and subject rows have no organization index, and charges no organization column, so each is
 * reached through an indexed column: members for events, quarantine and subjects, and bucket or event ids for
 * charges. Filtering on the organization column alone scanned every organization's rows inside the deletion
 * transaction. Member rows are kept until the organization is deleted, so every member's rows are reached. Buckets
 * and events are only deleted here, so every charge is reached through one of them.
 */
export async function deleteGatewayUsageForOrganization(
  tx: Transaction,
  organizationId: typeof OrganizationTable.$inferSelect.id,
): Promise<void> {
  const memberIds = (await fenceUsageOrganizationDeletion(tx, organizationId)).map((member) => member.id)
  const policies = tx
    .select({ id: Policy.id })
    .from(Policy)
    .where(eq(Policy.organizationId, organizationId))
  const bucketIds = (await tx
    .select({ id: Bucket.id })
    .from(Bucket)
    .where(eq(Bucket.organizationId, organizationId)))
    .map((bucket) => bucket.id)
  if (bucketIds.length > 0) await tx.delete(Charge).where(inArray(Charge.bucketId, bucketIds))
  if (memberIds.length > 0) {
    const events = and(inArray(Event.memberId, memberIds), eq(Event.organizationId, organizationId))
    const eventIds = (await tx.select({ id: Event.id }).from(Event).where(events)).map((event) => event.id)
    if (eventIds.length > 0) await tx.delete(Charge).where(inArray(Charge.eventId, eventIds))
    await tx.delete(Quarantine).where(and(inArray(Quarantine.memberId, memberIds), eq(Quarantine.organizationId, organizationId)))
    await tx.delete(Event).where(events)
    await tx.delete(Subject).where(and(inArray(Subject.memberId, memberIds), eq(Subject.organizationId, organizationId)))
  }
  await tx.delete(Reset).where(eq(Reset.organizationId, organizationId))
  await tx.delete(Audit).where(eq(Audit.organizationId, organizationId))
  await tx.delete(Assignment).where(eq(Assignment.organizationId, organizationId))
  await tx.delete(Limit).where(inArray(Limit.policyId, policies))
  await tx.delete(Bucket).where(eq(Bucket.organizationId, organizationId))
  await tx.delete(Tracking).where(eq(Tracking.organizationId, organizationId))
  await tx.delete(Policy).where(eq(Policy.organizationId, organizationId))
}
