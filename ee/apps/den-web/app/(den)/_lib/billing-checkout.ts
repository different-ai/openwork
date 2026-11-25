import {
  BILLING_RETURN_DESKTOP,
  PLAN_MAX_ADD_PEOPLE,
  billingNotConfiguredErrorSchema,
  billingNotConfiguredMessage,
  billingPlanSummarySchema,
  billingPlansSchema,
  checkoutStartResponseSchema,
  parseBillingReturnTo,
  seatPlanQuoteSchema,
  withReturnParams,
  type BillingCheckoutReturnKind,
  type BillingNotConfiguredProduct,
  type BillingPlans,
  type BillingPlanSummary,
  type BillingReturnTo,
  type CheckoutStartResponse,
  type PlanCheckoutTier,
  type SeatPlanQuote,
} from "@openwork/types/den/billing-plans";
import { getRequestError, requestJson } from "./den-flow";

export {
  BILLING_RETURN_DESKTOP,
  billingNotConfiguredMessage,
  parseBillingReturnTo,
  PLAN_MAX_ADD_PEOPLE,
  quotePlan,
  TEAM_PLAN_UNIT_AMOUNT,
  withReturnParams,
  type BillingCheckoutReturnKind,
  type BillingNotConfiguredProduct,
  type BillingPlanOffer,
  type BillingPlans,
  type BillingPlanSummary,
  type BillingReturnTo,
  type PlanCheckoutTier,
  type SeatPlanQuote,
} from "@openwork/types/den/billing-plans";

export class BillingNotConfiguredError extends Error {
  readonly product: BillingNotConfiguredProduct;

  constructor(product: BillingNotConfiguredProduct, message = billingNotConfiguredMessage(product)) {
    super(message);
    this.name = "BillingNotConfiguredError";
    this.product = product;
  }
}

export function isBillingNotConfiguredError(error: unknown): error is BillingNotConfiguredError {
  return error instanceof BillingNotConfiguredError;
}

export function parseBillingNotConfigured(payload: unknown): BillingNotConfiguredError | null {
  const parsed = billingNotConfiguredErrorSchema.safeParse(payload);
  return parsed.success ? new BillingNotConfiguredError(parsed.data.product, parsed.data.message) : null;
}

function billingRecord(payload: unknown): unknown {
  return payload && typeof payload === "object" && "billing" in payload ? payload.billing : null;
}

export function parseBillingPlanSummary(payload: unknown): BillingPlanSummary | null {
  const billing = billingRecord(payload);
  const parsed = billingPlanSummarySchema.safeParse(billing && typeof billing === "object" && "plan" in billing ? billing.plan : null);
  return parsed.success ? parsed.data : null;
}

export function parseBillingPlans(payload: unknown): BillingPlans | null {
  const billing = billingRecord(payload);
  const parsed = billingPlansSchema.safeParse(billing && typeof billing === "object" && "plans" in billing ? billing.plans : null);
  return parsed.success ? parsed.data : null;
}

export function parseSeatPlanQuote(payload: unknown): SeatPlanQuote | null {
  const parsed = seatPlanQuoteSchema.safeParse(payload && typeof payload === "object" && "quote" in payload ? payload.quote : null);
  return parsed.success ? parsed.data : null;
}

export type StartCheckoutInput = {
  type: "inference" | "seat" | "web" | "plan";
  plan?: PlanCheckoutTier;
  addPeople?: number;
  returnTo?: string | null;
  headers?: Record<string, string>;
};

type CheckoutRequester = (path: string, init: RequestInit, timeoutMs: number) => Promise<{ response: Response; payload: unknown }>;

export async function startCheckout(input: StartCheckoutInput, request: CheckoutRequester = requestJson): Promise<CheckoutStartResponse> {
  const returnTo = parseBillingReturnTo(input.returnTo ?? null);
  const body = {
    type: input.type,
    ...(input.plan ? { plan: input.plan } : {}),
    ...(typeof input.addPeople === "number" ? { addPeople: input.addPeople } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
  const { response, payload } = await request(
    "/v1/billing/stripe/checkout",
    { method: "POST", body: JSON.stringify(body), ...(input.headers ? { headers: input.headers } : {}) },
    12000,
  );
  if (!response.ok) {
    const notConfigured = response.status === 503 ? parseBillingNotConfigured(payload) : null;
    if (notConfigured) throw notConfigured;
    throw getRequestError(payload, response, `Checkout failed (${response.status}).`);
  }
  const parsed = checkoutStartResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Checkout response did not include a URL.");
  return parsed.data;
}

export function peopleLabel(plan: Pick<BillingPlanSummary, "people" | "joined" | "invited">): string {
  return `${plan.people} ${plan.people === 1 ? "person" : "people"} (${plan.joined} joined, ${plan.invited} invited)`;
}

export function defaultTeamPeople(plan: Pick<BillingPlanSummary, "people" | "freeSeatCount">, requestedAddPeople: number | null): number {
  const add = requestedAddPeople ?? (plan.people >= plan.freeSeatCount ? 1 : 0);
  return Math.max(1, plan.people + Math.min(PLAN_MAX_ADD_PEOPLE, Math.max(0, add)));
}

export type CheckoutReturnDestination =
  | { kind: "desktop" }
  | { kind: "path"; href: string };

export function checkoutReturnDestination(input: { returnTo: string | null; sessionId: string | null }): CheckoutReturnDestination | null {
  const returnTo = parseBillingReturnTo(input.returnTo);
  if (!returnTo) return null;
  if (returnTo === BILLING_RETURN_DESKTOP) return { kind: "desktop" };
  return {
    kind: "path",
    href: withReturnParams(returnTo, { checkout: "complete", ...(input.sessionId ? { session_id: input.sessionId } : {}) }),
  };
}

const RETURN_PAGE_NAMES: { prefix: string; name: string }[] = [
  { prefix: "/dashboard/members", name: "Members" },
  { prefix: "/dashboard/billing", name: "Billing" },
  { prefix: "/dashboard/ai-gateway", name: "AI Gateway" },
  { prefix: "/dashboard/web", name: "OpenWork Web" },
  { prefix: "/dashboard/sso", name: "Single sign-on" },
  { prefix: "/dashboard/scim", name: "SCIM" },
  { prefix: "/dashboard/auth-security", name: "Auth & Security" },
];

export function checkoutReturnLabel(input: { returnTo: string | null; kind: BillingCheckoutReturnKind | null }): string {
  const returnTo = parseBillingReturnTo(input.returnTo);
  if (returnTo === BILLING_RETURN_DESKTOP) return "Back to OpenWork Desktop";
  if (returnTo) {
    const path = returnTo.split("?")[0] ?? returnTo;
    if (path.startsWith("/dashboard/ai-gateway") && returnTo.includes("tab=openwork-models")) return "Back to OpenWork Models";
    const match = RETURN_PAGE_NAMES.find((entry) => path === entry.prefix || path.startsWith(`${entry.prefix}/`));
    return match ? `Back to ${match.name}` : "Back to the dashboard";
  }
  if (input.kind === "models") return "Back to OpenWork Models";
  if (input.kind === "web") return "Back to OpenWork Web";
  return "Back to Billing";
}

export type CheckoutSuccessTitleInput = {
  kind: BillingCheckoutReturnKind | null;
  planTier: BillingPlanSummary["tier"] | null;
  organizationName: string;
};

export function checkoutSuccessTitle(input: CheckoutSuccessTitleInput): string {
  if (input.kind === "models") return `OpenWork Models is on for ${input.organizationName}`;
  if (input.kind === "web") return `OpenWork Web is on for ${input.organizationName}`;
  if (input.kind === "plan" && input.planTier === "enterprise") return `Enterprise is active for ${input.organizationName}`;
  if (input.kind === "plan" || input.kind === "seat") return `Team is active for ${input.organizationName}`;
  return `Billing is up to date for ${input.organizationName}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

export function isCheckoutConfirmed(kind: BillingCheckoutReturnKind | null, payload: unknown): boolean {
  const stripe = record(record(billingRecord(payload))?.stripe);
  if (!stripe) return false;
  const seats = record(stripe.seats);
  const web = record(stripe.web);
  switch (kind) {
    case "web":
      return web?.hasEligibleSubscription === true || web?.hasAccess === true;
    case "seat":
      return seats?.hasActiveSubscription === true;
    case "plan": {
      const plan = parseBillingPlanSummary(payload);
      return seats?.hasActiveSubscription === true && plan !== null && plan.tier !== "free";
    }
    case "models":
    case null:
      return stripe.hasActiveSubscription === true;
  }
}

export function parseCheckoutReturnKind(value: string | null): BillingCheckoutReturnKind | null {
  return value === "models" || value === "web" || value === "seat" || value === "plan" ? value : null;
}
