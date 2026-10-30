import { z } from "zod";

/**
 * Plans, per-person prices, checkout return targets and the billing response
 * shapes Den API sends and Den web reads (ENG-874). One module so the server
 * and the browser can never disagree about a price or a safe return path.
 */

export const BILLING_PLAN_TIERS = ["free", "team", "enterprise"] as const;
export type BillingPlanTier = (typeof BILLING_PLAN_TIERS)[number];
export const BILLING_PLAN_SOURCES = ["default", "stripe", "manual", "grandfathered"] as const;
export type BillingPlanSource = (typeof BILLING_PLAN_SOURCES)[number];

/**
 * Plans a billing admin can buy by card. Enterprise is never bought by card:
 * a platform admin sets it in /admin › Billing and OpenWork invoices it.
 */
export const PLAN_CHECKOUT_TIERS = ["team"] as const;
export type PlanCheckoutTier = (typeof PLAN_CHECKOUT_TIERS)[number];

/** Team: $10 for every person once the workspace passes its free people. */
export const TEAM_PLAN_UNIT_AMOUNT = 1000;
export const PLAN_CURRENCY = "usd";
export const PLAN_INTERVAL = "month";
/** Most people one plan checkout may add on top of the people already counted. */
export const PLAN_MAX_ADD_PEOPLE = 50;

const PLAN_TIER_RANK: Record<BillingPlanTier, number> = { free: 0, team: 1, enterprise: 2 };

/** free < team < enterprise. */
export function planTierRank(tier: BillingPlanTier): number {
  return PLAN_TIER_RANK[tier];
}

export function isPlanCheckoutTier(value: unknown): value is PlanCheckoutTier {
  return value === "team";
}

function wholeCount(value: number, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;
}

export type PlanQuote = { people: number; unitAmount: number; monthlyTotal: number };

/**
 * What a plan costs per month: every counted person (joined and invited) plus
 * the people being added, at the plan's per-person price. Never fewer than one.
 */
export function quotePlan(input: {
  plan: PlanCheckoutTier;
  people: number;
  addPeople?: number;
}): PlanQuote {
  const people = Math.max(1, wholeCount(input.people) + wholeCount(input.addPeople ?? 0, PLAN_MAX_ADD_PEOPLE));
  const unitAmount = TEAM_PLAN_UNIT_AMOUNT;
  return { people, unitAmount, monthlyTotal: people * unitAmount };
}

// ─── Checkout return targets ─────────────────────────────────────────────────

/** Show "Back to OpenWork Desktop" after paying instead of returning to a Den page. */
export const BILLING_RETURN_DESKTOP = "desktop";
export type BillingReturnTo = typeof BILLING_RETURN_DESKTOP | `/dashboard/${string}`;
export const BILLING_RETURN_TO_MAX_LENGTH = 256;
/** Which product a Stripe return page is confirming. */
export const BILLING_CHECKOUT_RETURN_KINDS = ["models", "web", "seat", "plan"] as const;
export type BillingCheckoutReturnKind = (typeof BILLING_CHECKOUT_RETURN_KINDS)[number];

const RETURN_TO_PARSE_BASE = "https://den.invalid";

function isDashboardPath(value: string): value is `/dashboard/${string}` {
  return value.startsWith("/dashboard/");
}

/**
 * The only places a checkout may send someone back to: `desktop`, or a Den
 * dashboard path (optionally with a query). Anything else (other origins,
 * protocol-relative `//`, backslashes, dot segments, encoded or control
 * characters, fragments, over 256 characters) is refused with `null`, and the
 * caller falls back to its own default.
 */
export function parseBillingReturnTo(value: unknown): BillingReturnTo | null {
  if (typeof value !== "string" || value.length === 0 || value.length > BILLING_RETURN_TO_MAX_LENGTH) return null;
  if (value === BILLING_RETURN_DESKTOP) return BILLING_RETURN_DESKTOP;
  if (!isDashboardPath(value)) return null;
  if (value.includes("//") || value.includes("\\") || value.includes("#")) return null;
  // Printable ASCII only: no whitespace, control or non-ASCII characters.
  if (!/^[\x21-\x7e]+$/.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, RETURN_TO_PARSE_BASE);
  } catch {
    return null;
  }
  // The browser would land exactly here: same origin, no dot segments or
  // percent-decoding that changes the path.
  if (parsed.origin !== RETURN_TO_PARSE_BASE || `${parsed.pathname}${parsed.search}` !== value) return null;
  return isDashboardPath(parsed.pathname) ? value : null;
}

/** Appends query parameters to a validated dashboard path. */
export function withReturnParams(path: `/dashboard/${string}`, params: Record<string, string>): string {
  const url = new URL(path, RETURN_TO_PARSE_BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

// ─── Billing that is not configured ──────────────────────────────────────────

export const BILLING_NOT_CONFIGURED_PRODUCTS = ["seat", "inference", "web", "team", "portal", "checkout"] as const;
export type BillingNotConfiguredProduct = (typeof BILLING_NOT_CONFIGURED_PRODUCTS)[number];

const BILLING_NOT_CONFIGURED_MESSAGES: Record<BillingNotConfiguredProduct, string> = {
  inference: "OpenWork Models isn't sold on this deployment.",
  seat: "Paid seats aren't sold on this deployment.",
  web: "OpenWork Web isn't sold on this deployment.",
  team: "The Team plan isn't sold on this deployment.",
  portal: "Billing isn't set up on this deployment.",
  checkout: "Billing isn't set up on this deployment.",
};

export function billingNotConfiguredMessage(product: BillingNotConfiguredProduct): string {
  return BILLING_NOT_CONFIGURED_MESSAGES[product];
}

export const billingNotConfiguredErrorSchema = z.object({
  error: z.literal("billing_not_configured"),
  product: z.enum(BILLING_NOT_CONFIGURED_PRODUCTS),
  message: z.string(),
});
export type BillingNotConfiguredError = z.infer<typeof billingNotConfiguredErrorSchema>;

// ─── Shapes in GET /v1/billing, checkout and the 402 seat quote ─────────────

export const planCheckoutRequestSchema = z.object({
  type: z.enum(["inference", "seat", "web", "plan"]).optional(),
  plan: z.enum(PLAN_CHECKOUT_TIERS).optional(),
  addPeople: z.number().int().min(0).max(PLAN_MAX_ADD_PEOPLE).optional(),
  /** `desktop` or a `/dashboard/...` path; anything else is ignored. */
  returnTo: z.string().max(2048).optional(),
});
export type PlanCheckoutRequest = z.infer<typeof planCheckoutRequestSchema>;

export const checkoutStartResponseSchema = z.object({
  url: z.string(),
  /** The plan changed without a new payment page; `url` is the return page. */
  completed: z.boolean().optional(),
});
export type CheckoutStartResponse = z.infer<typeof checkoutStartResponseSchema>;

/** Who pays for the organization's plan: nobody (Free, or set by a platform admin and invoiced), or a Team subscription in Stripe. */
export const PLAN_PAID_BY = ["none", "stripe_team"] as const;
export type PlanPaidBy = (typeof PLAN_PAID_BY)[number];

/** A calendar date, `YYYY-MM-DD`, such as the optional end of a plan a platform admin set. */
export const planEndDateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Use a date such as 2026-11-22.");

/**
 * An organization's plan as every check sees it: the one rule that decides how
 * many users it may have. `userLimit` is null when nothing limits it (a paid
 * Stripe plan bills every user, or the deployment does not gate seats).
 * `endsAt` is display only: nothing changes when it passes.
 */
export const organizationPlanStateSchema = z.object({
  tier: z.enum(BILLING_PLAN_TIERS),
  source: z.enum(BILLING_PLAN_SOURCES),
  paidBy: z.enum(PLAN_PAID_BY),
  /** Joined members plus unexpired pending invitations. */
  users: z.number().int().nonnegative(),
  userLimit: z.number().int().positive().nullable(),
  /** Users a platform admin set for a Team or Enterprise plan; null on Free. */
  seats: z.number().int().positive().nullable(),
  endsAt: planEndDateSchema.nullable(),
  ended: z.boolean(),
}).meta({ ref: "OrganizationPlanState" });
export type OrganizationPlanState = z.infer<typeof organizationPlanStateSchema>;

export const billingPlanSummarySchema = z.object({
  tier: z.enum(BILLING_PLAN_TIERS),
  source: z.enum(BILLING_PLAN_SOURCES),
  /** Joined plus invited people; pending invitations count toward the plan. */
  people: z.number().int(),
  joined: z.number().int(),
  invited: z.number().int(),
  freeSeatCount: z.number().int(),
  /** Users the plan allows, counting pending invitations; null when nothing limits it. Older Den APIs omit it. */
  userLimit: z.number().int().nullable().default(null),
  /** Optional end date of a plan a platform admin set (`YYYY-MM-DD`), display only. Older Den APIs omit it. */
  endsAt: z.string().nullable().default(null),
});
export type BillingPlanSummary = z.infer<typeof billingPlanSummarySchema>;

const planOfferSchema = z.object({
  /** Sold on this deployment (Stripe and the price are set up). */
  available: z.boolean(),
  unitAmount: z.number().int(),
  currency: z.string(),
  interval: z.string(),
});
export const billingPlansSchema = z.object({
  team: planOfferSchema,
});
export type BillingPlans = z.infer<typeof billingPlansSchema>;
export type BillingPlanOffer = z.infer<typeof planOfferSchema>;

/** Attached to the 402 an invitation gets when the workspace has used its free people. */
export const seatPlanQuoteSchema = z.object({
  plan: z.literal("team"),
  /** People after this invitation. */
  people: z.number().int(),
  joined: z.number().int(),
  invited: z.number().int(),
  unitAmount: z.number().int(),
  monthlyTotal: z.number().int(),
  currency: z.string(),
  interval: z.string(),
  /** Team checkout is sold on this deployment. */
  available: z.boolean(),
});
export type SeatPlanQuote = z.infer<typeof seatPlanQuoteSchema>;
