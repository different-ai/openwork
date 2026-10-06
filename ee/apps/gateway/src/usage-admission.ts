import {
  createGatewayUsageLimits,
  safeUsageDatabaseCode,
  type GatewayUsageScope,
  type GatewayUsageSnapshot,
} from "@openwork-ee/den-db/gateway-usage-limits"
import {
  gatewayAccountingUnavailableResponse,
  gatewayUsageLimitResponse,
} from "@openwork/types/den/gateway-usage-limits"
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import type { OrganizationContext } from "./middleware/org-context.js"
import { loadPricingCatalogFromFile, type PricingCatalog } from "./pricing.js"

// Usage admission: the only part of Gateway usage that the usage-limits module
// gates. Accounting (request log, settlement, rollups, spend) never comes
// through here; it lives behind `@openwork-ee/den-db/gateway-usage-accounting`
// and runs for every Gateway request. This is the only gateway file that may
// import `@openwork-ee/den-db/gateway-usage-limits`.

export type GatewayUsagePreflight = {
  protocol: GatewayRequestProtocol
  providerId: string
  modelId: string | null
  upstreamOrigin: string
  upstreamPath: string
  deferred: boolean
  /** The selected model row carries its own price (synced LiteLLM models). */
  priced?: boolean
}

export function isGatewayUsageAccountable(
  input: GatewayUsagePreflight,
  pricing: PricingCatalog | null,
): boolean {
  if (input.deferred || input.protocol === "passthrough" || input.modelId === null) return false

  const reportsCost =
    input.providerId === "openrouter" &&
    input.protocol === "openai_chat" &&
    input.upstreamOrigin === "https://openrouter.ai" &&
    input.upstreamPath === "/api/v1/chat/completions"

  return reportsCost || input.priced === true || pricing?.getModelPrice(input.providerId, input.modelId) != null
}

export type CheckGatewayUsage = (
  input: GatewayUsageScope & GatewayUsagePreflight & {
    requestId: string
    startedAt?: Date
    onAdmission?: (snapshot: GatewayUsageSnapshot) => void
  },
) => Promise<Response | null>

export const checkGatewayUsage: CheckGatewayUsage = async (input) => {
  const started = performance.now()
  try {
    const { db } = await import("./db.js")
    let pricing: PricingCatalog | null = null
    try {
      pricing = loadPricingCatalogFromFile()
    } catch {
      console.warn("[gateway-usage]", { stage: "pricing_catalog", code: "CATALOG_UNAVAILABLE" })
    }

    const scope = { organizationId: input.organizationId, memberId: input.memberId }
    const accountable = isGatewayUsageAccountable(input, pricing)
    const admission = await createGatewayUsageLimits(db).admit(scope, input.requestId, accountable, input.startedAt)
    input.onAdmission?.(admission.snapshot)
    if (admission.accountingUnavailable) return gatewayAccountingUnavailableResponse()
    return gatewayUsageLimitResponse(admission.usage)
  } catch (error) {
    console.warn("[gateway-usage]", { stage: "admission", durationMs: Math.round(performance.now() - started), code: safeUsageDatabaseCode(error) })
    return gatewayAccountingUnavailableResponse()
  }
}

export type UsageAdmissionDecision = "enforce" | "skip"

/**
 * Decides, per request, whether usage limits are enforced for an organization.
 * Only admission (`checkUsage`) depends on it; accounting always runs.
 *
 * When it returns `"skip"` ("usage limits off"), limits are **frozen and
 * unenforced**:
 *
 * | Thing | Behavior |
 * |---|---|
 * | Admission (`checkGatewayUsage`) | Not called. No limit or `openwork_gateway_accounting_unavailable` rejections from limits, including hard-limit-without-pricing and `coverage.captureEnabled=false`. |
 * | `X-OpenWork-Usage-State: blocked` limit responses | Never produced. Desktop quota plugins only react to rejection responses. |
 * | Request log, cost, rollups, spend reporting | Unchanged: written and readable. |
 * | `gateway_usage_tracking` capture flag (ops cutover) | Still honored by `startGatewayUsageLog` (`capture_suspended`, 503). It is an accounting safety switch, not a limit. |
 * | Policies, entries, assignments, subjects | Kept as is. Not evaluated. |
 * | Buckets | Frozen: no new charges. Requests made while off are never charged retroactively. |
 * | Reset requests | Kept. Pending ones expire by their normal rules on the next admission after re-enable. |
 * | Member lifecycle (`expireUsageRequestsForMembers`, entitlement mutation lock, org deletion erasure) | Still runs. |
 * | Turning it back on | Admission resumes on the next request. Open windows continue from stored consumption; ended windows roll over by the normal reset logic. No backfill. |
 *
 * With `"skip"` the request log row carries no `metadata.gateway_usage`, so
 * `startGatewayUsageLog` takes the attribution-less path and settlement
 * finalizes cost without bucket charges.
 */
export type UsageAdmissionPolicy = (input: {
  organizationId: string
  organization: OrganizationContext | null
}) => UsageAdmissionDecision | Promise<UsageAdmissionDecision>

/** Today's behavior: every organization's requests go through admission. */
export const enforceUsageAdmissionForAll: UsageAdmissionPolicy = () => "enforce"

export type UsageAdmissionDependencies = {
  usageAdmission: UsageAdmissionPolicy
  checkUsage: CheckGatewayUsage
}

/** Runs admission when the policy enforces it. Null means admitted (or skipped). */
export async function admitGatewayUsage(
  dependencies: UsageAdmissionDependencies,
  organization: OrganizationContext | null,
  input: Parameters<CheckGatewayUsage>[0],
): Promise<Response | null> {
  const decision = await dependencies.usageAdmission({ organizationId: input.organizationId, organization })
  return decision === "enforce" ? dependencies.checkUsage(input) : null
}
