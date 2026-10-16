import { and, asc, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { ensureMemberGatewayKey } from "../gateway-keys.js"

/**
 * With DEN_HEADLESS_MODEL_AUTH=member_gateway_key the headless runner has no model key of its own: it calls this
 * deployment's AI Gateway, and every turn carries the key of the member it runs for. Their provider access, usage
 * limits and usage records then apply to Slack replies, cloud Automations and Workbot exactly as on their desktop.
 * The runner holds the key in memory for that turn only.
 */
export function headlessUsesMemberGatewayKeys() {
  return env.headlessModelAuth === "member_gateway_key"
}

/** The member's Gateway key for one turn, or undefined when the runner pays with its own key. */
export async function headlessTurnModelKey(input: { userId: string; organizationId: string }): Promise<string | undefined> {
  if (!headlessUsesMemberGatewayKeys()) return undefined
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const [member] = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, normalizeDenTypeId("user", input.userId)), isNull(MemberTable.removedAt)))
    .limit(1)
  if (!member) throw new Error("member_not_found")
  return ensureMemberGatewayKey({ organizationId, memberId: member.id })
}

/**
 * The key the runner lists models with: the earliest active owner's. Member-key mode is single-organization only
 * (env.ts refuses it otherwise), so this names the one organization. Undefined when there is no owner yet.
 */
export async function headlessCatalogModelKey(): Promise<string | undefined> {
  if (!headlessUsesMemberGatewayKeys()) return undefined
  const [owner] = await db
    .select({ id: MemberTable.id, organizationId: MemberTable.organizationId })
    .from(MemberTable)
    .where(and(sql`${MemberTable.role} like ${"%owner%"}`, isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false)))
    .orderBy(asc(MemberTable.createdAt))
    .limit(1)
  if (!owner) return undefined
  return ensureMemberGatewayKey({ organizationId: owner.organizationId, memberId: owner.id })
}
