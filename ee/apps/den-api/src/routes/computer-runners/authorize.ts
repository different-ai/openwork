import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { COMPUTER_SHELL_RUNNER_CAPABILITY } from "@openwork/types/den/computers"
import { createMiddleware } from "hono/factory"
import { automationRunnerRowId } from "../../automations/repository.js"
import { db } from "../../db.js"
import { markFeaturesUsed } from "../../feature-usage.js"
import { organizationFeatureEnabled } from "../../features.js"
import { createRunnerProtocol } from "../session-runners/protocol.js"

const { authenticateRunner, attributeRunner } = createRunnerProtocol()

export type ComputerRunnerEnv = { Variables: { computerRunner: {
  organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user">; runnerId: string
} } }

export const authorizeComputerRunner = (requiresSandbox: boolean) => createMiddleware<ComputerRunnerEnv>(async (c, next) => {
  const identity = await authenticateRunner(c)
  if (!identity) return c.json({ error: "unauthorized" }, 401)
  attributeRunner(c, identity)
  const organizationId = normalizeDenTypeId("organization", identity.organizationId)
  const memberId = normalizeDenTypeId("member", identity.ownerMemberId)
  const [owner] = await db.$primary.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, organizationId), eq(MemberTable.id, memberId), isNull(MemberTable.removedAt),
  )).limit(1)
  if (!owner?.userId) return c.json({ error: "unauthorized" }, 401)
  if (!await organizationFeatureEnabled(organizationId, "computers", { userId: owner.userId })) {
    return c.json({ error: "feature_disabled", feature: "computers" }, 404)
  }
  if (requiresSandbox && !identity.capabilities.includes(COMPUTER_SHELL_RUNNER_CAPABILITY)) return c.json({ error: "runner_capability_required" }, 403)
  markFeaturesUsed({ organizationId, memberId, keys: ["computers"] })
  c.header("Cache-Control", "no-store")
  c.set("computerRunner", { organizationId, memberId, userId: normalizeDenTypeId("user", owner.userId), runnerId: automationRunnerRowId(identity) })
  await next()
})
