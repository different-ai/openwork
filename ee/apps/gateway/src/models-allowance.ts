import { OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, openWorkModelsAllowanceErrorBody, type InferenceWindowType } from "@openwork/types/den/inference"

export type ExhaustedAllowance = {
  limitedBy: string
  windowType: InferenceWindowType
  limitedBucket?: { limitAmount: number; usedAmount: number; windowEndAt: Date }
}

/**
 * The organization used its OpenWork Models allowance. Not a rate limit: it lasts until the window resets, so the
 * answer tells clients not to retry, says when it resets, and never names the organization.
 */
export function openWorkModelsAllowanceResponse(limits: ExhaustedAllowance, now = Date.now()): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "x-openwork-error-code": OPENWORK_MODELS_ALLOWANCE_ERROR_CODE,
    "x-openwork-usage-state": "blocked",
    "x-should-retry": "false",
    "x-openwork-limit-bucket-id": limits.limitedBy,
    "x-openwork-limit-window-type": limits.windowType,
  })
  const bucket = limits.limitedBucket
  if (bucket) {
    const retryAfter = Math.max(0, Math.ceil((bucket.windowEndAt.getTime() - now) / 1000))
    headers.set("retry-after", String(retryAfter))
    headers.set("x-openwork-limit-reset-at", bucket.windowEndAt.toISOString())
    headers.set("x-ratelimit-limit-tokens", String(bucket.limitAmount))
    headers.set("x-ratelimit-remaining-tokens", "0")
    headers.set("x-ratelimit-reset-tokens", `${retryAfter}s`)
  }
  return new Response(JSON.stringify(openWorkModelsAllowanceErrorBody()), { status: 429, headers })
}
