import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { coreHooks, type CoreHookRejection } from "./core/hooks/index.js"
import { env } from "./env.js"
import { isMemberAddEligibilityEnforced, type MemberAddPath } from "./member-add-eligibility-config.js"
import { appLogger } from "./observability/logger.js"

const logger = appLogger.child({ component: "member_add_eligibility" })

export class MemberAddEligibilityError extends Error {
  constructor(readonly rejection: CoreHookRejection) {
    super(rejection.message)
    this.name = "MemberAddEligibilityError"
  }
}

function numericDetail(rejection: CoreHookRejection, key: string) {
  const value = rejection.details?.[key]
  return typeof value === "number" ? value : undefined
}

/**
 * Runs `member.addEligibility` for a member add. Returns the rejection only
 * when the path is enforced (DEN_MEMBER_ADD_ELIGIBILITY_*); otherwise a
 * would-be denial is logged as `member_add_eligibility_would_deny` and the
 * add goes ahead, and a failing check never blocks it.
 */
export async function checkMemberAddEligibility(input: {
  organizationId: string
  path: MemberAddPath
  netNewSeats: number
}): Promise<CoreHookRejection | null> {
  if (input.netNewSeats <= 0) return null
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const enforced = isMemberAddEligibilityEnforced(input.path, env.memberAddEligibility)
  let rejection: CoreHookRejection | null
  try {
    rejection = await coreHooks.runGuards("member.addEligibility", { organizationId, path: input.path, netNewSeats: input.netNewSeats })
  } catch (error) {
    if (enforced) throw error
    logger.warn("member_add_eligibility_check_failed", { organization_id: organizationId, path: input.path, error })
    return null
  }
  if (!rejection || enforced) return rejection
  logger.warn("member_add_eligibility_would_deny", {
    organization_id: organizationId,
    path: input.path,
    code: rejection.code,
    net_new_seats: input.netNewSeats,
    current_count: numericDetail(rejection, "currentCount"),
    free_seat_count: numericDetail(rejection, "freeSeatCount"),
  })
  return null
}
