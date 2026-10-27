import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AutomationSchedule } from "@openwork/types/automations"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"

/**
 * Whether an Automation's owner has a schedule feature: their organization's
 * setting, with an override for them as a member. The scheduler has no
 * request, so it resolves the owner's user itself.
 */
export async function ownerScheduleFeatureEnabled(
  owner: { organizationId: string; ownerMemberId: string },
  key: "automationIntervalSchedules" | "automationCalendarTriggers",
): Promise<boolean> {
  const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizeDenTypeId("member", owner.ownerMemberId)),
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", owner.organizationId)),
    isNull(MemberTable.removedAt),
  )).limit(1)
  return organizationFeatureEnabled(owner.organizationId, key, member?.userId ? { userId: member.userId } : {})
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * Whether a requested schedule only repeats the one the Automation already
 * has. Editors send the whole definition on every save, so an Automation made
 * while a schedule feature was on can still be renamed or re-instructed after
 * it is turned off.
 */
export function keepsCurrentSchedule(requested: AutomationSchedule, current: AutomationSchedule): boolean {
  return canonical(requested) === canonical(current)
}
