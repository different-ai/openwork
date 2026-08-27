export const OPENWORK_WEB_CHECKOUT_TYPE = "web";
export const OPENWORK_WEB_QUANTITY_DEFINITION = "joined_non_removed_members";
export const OPENWORK_WEB_UNIT_AMOUNT = 5000;
export const OPENWORK_WEB_CURRENCY = "usd";
export const OPENWORK_WEB_INTERVAL = "month";

export type StripeWebSubscription = {
  status: string;
  quantity: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  paymentStatus: string;
};

export type StripeWebBilling = {
  configured: boolean;
  priceId: string | null;
  unitAmount: typeof OPENWORK_WEB_UNIT_AMOUNT;
  currency: typeof OPENWORK_WEB_CURRENCY;
  interval: typeof OPENWORK_WEB_INTERVAL;
  quantityDefinition: typeof OPENWORK_WEB_QUANTITY_DEFINITION;
  quantity: number;
  expectedMonthlyTotal: number;
  hasEligibleSubscription: boolean;
  subscription: StripeWebSubscription | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSubscription(value: unknown): StripeWebSubscription | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.status !== "string" ||
    typeof value.quantity !== "number" ||
    !Number.isInteger(value.quantity) ||
    value.quantity < 1 ||
    (value.currentPeriodStart !== null && typeof value.currentPeriodStart !== "string") ||
    (value.currentPeriodEnd !== null && typeof value.currentPeriodEnd !== "string") ||
    typeof value.cancelAtPeriodEnd !== "boolean" ||
    typeof value.paymentStatus !== "string"
  ) {
    return undefined;
  }

  return {
    status: value.status,
    quantity: value.quantity,
    currentPeriodStart: value.currentPeriodStart,
    currentPeriodEnd: value.currentPeriodEnd,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    paymentStatus: value.paymentStatus,
  };
}

export function parseStripeWebBilling(payload: unknown): StripeWebBilling | null {
  if (!isRecord(payload) || !isRecord(payload.billing) || !isRecord(payload.billing.stripe) || !isRecord(payload.billing.stripe.web)) {
    return null;
  }

  const value = payload.billing.stripe.web;
  const subscription = parseSubscription(value.subscription);
  if (
    typeof value.configured !== "boolean" ||
    (value.priceId !== undefined && value.priceId !== null && typeof value.priceId !== "string") ||
    value.unitAmount !== OPENWORK_WEB_UNIT_AMOUNT ||
    value.currency !== OPENWORK_WEB_CURRENCY ||
    value.interval !== OPENWORK_WEB_INTERVAL ||
    value.quantityDefinition !== OPENWORK_WEB_QUANTITY_DEFINITION ||
    typeof value.quantity !== "number" ||
    !Number.isInteger(value.quantity) ||
    value.quantity < 1 ||
    typeof value.expectedMonthlyTotal !== "number" ||
    value.expectedMonthlyTotal !== value.quantity * OPENWORK_WEB_UNIT_AMOUNT ||
    typeof value.hasEligibleSubscription !== "boolean" ||
    subscription === undefined
  ) {
    return null;
  }

  return {
    configured: value.configured,
    priceId: typeof value.priceId === "string" ? value.priceId : null,
    unitAmount: value.unitAmount,
    currency: value.currency,
    interval: value.interval,
    quantityDefinition: value.quantityDefinition,
    quantity: value.quantity,
    expectedMonthlyTotal: value.expectedMonthlyTotal,
    hasEligibleSubscription: value.hasEligibleSubscription,
    subscription,
  };
}

export function getOpenWorkWebQuantityDescription(quantity: number): string {
  const memberLabel = quantity === 1 ? "member" : "members";
  return `${quantity} ${memberLabel}`;
}

export const OPENWORK_WEB_QUANTITY_EXPLANATION =
  "Billed for each joined member of your organization, including the owner. Pending invitations are not billed.";
