import { env } from "./env.js"

export const PLAN_TIERS = ["free", "team", "enterprise"] as const
export type PlanTier = (typeof PLAN_TIERS)[number]

export const PLAN_SOURCES = ["default", "stripe", "manual", "grandfathered"] as const
export type PlanSource = (typeof PLAN_SOURCES)[number]

export type OrganizationPlan = {
  tier: PlanTier
  source: PlanSource
  grandfatheredAt?: string
}

export const ENTITLEMENT_KEYS = ["sso", "desktopPolicies", "orgControls", "analytics"] as const
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number]

export type OrganizationEntitlements = Record<EntitlementKey, boolean>

export type EnterprisePlanRequiredError = {
  error: "enterprise_plan_required"
  feature: EntitlementKey
  message: string
}

const ENTITLEMENT_FEATURE_LABELS: Record<EntitlementKey, string> = {
  sso: "SSO / SAML",
  desktopPolicies: "Desktop policies",
  orgControls: "Enforced SSO and desktop version controls",
  analytics: "Usage analytics",
}

type MetadataInput = Record<string, unknown> | string | null | undefined

type EntitlementOptions = {
  gatingEnabled?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseMetadata(input: MetadataInput): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === "string" && (PLAN_TIERS as readonly string[]).includes(value)
}

function isPlanSource(value: unknown): value is PlanSource {
  return typeof value === "string" && (PLAN_SOURCES as readonly string[]).includes(value)
}

export function parseOrganizationPlan(metadata: MetadataInput): OrganizationPlan {
  const parsed = parseMetadata(metadata)
  const plan = isRecord(parsed.plan) ? parsed.plan : {}

  return {
    tier: isPlanTier(plan.tier) ? plan.tier : "free",
    source: isPlanSource(plan.source) ? plan.source : "default",
    ...(typeof plan.grandfatheredAt === "string" ? { grandfatheredAt: plan.grandfatheredAt } : {}),
  }
}

export function getOrganizationEntitlements(
  metadata: MetadataInput,
  options: EntitlementOptions = {},
): OrganizationEntitlements {
  const gatingEnabled = options.gatingEnabled ?? env.planGatingEnabled
  const entitled = !gatingEnabled || parseOrganizationPlan(metadata).tier === "enterprise"

  return {
    sso: entitled,
    desktopPolicies: entitled,
    orgControls: entitled,
    analytics: entitled,
  }
}

export function checkEntitlement(
  metadata: MetadataInput,
  key: EntitlementKey,
  options: EntitlementOptions = {},
): { ok: true } | { ok: false; status: 402; response: EnterprisePlanRequiredError } {
  if (getOrganizationEntitlements(metadata, options)[key]) {
    return { ok: true }
  }

  return {
    ok: false,
    status: 402,
    response: {
      error: "enterprise_plan_required",
      feature: key,
      message: `${ENTITLEMENT_FEATURE_LABELS[key]} requires an Enterprise plan. Talk to us at openworklabs.com/enterprise.`,
    },
  }
}
