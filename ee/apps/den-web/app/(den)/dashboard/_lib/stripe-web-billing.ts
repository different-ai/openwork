export const OPENWORK_WEB_CHECKOUT_TYPE = "web";
/** Joined members only; pending invitations are not billed. */
export const OPENWORK_WEB_QUANTITY_JOINED_MEMBERS = "joined_non_removed_members";
/** Members plus pending invitations: the same users every subscription bills. */
export const OPENWORK_WEB_QUANTITY_BILLING_USERS = "members_and_pending_invitations";
export type OpenWorkWebQuantityDefinition = typeof OPENWORK_WEB_QUANTITY_JOINED_MEMBERS | typeof OPENWORK_WEB_QUANTITY_BILLING_USERS;

function isOpenWorkWebQuantityDefinition(value: unknown): value is OpenWorkWebQuantityDefinition {
  return value === OPENWORK_WEB_QUANTITY_JOINED_MEMBERS || value === OPENWORK_WEB_QUANTITY_BILLING_USERS;
}
export const OPENWORK_WEB_UNIT_AMOUNT = 5000;
export const OPENWORK_WEB_CURRENCY = "usd";
export const OPENWORK_WEB_INTERVAL = "month";

export type OpenWorkWebAccessSource = "subscription" | "complimentary" | null;

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
  quantityDefinition: OpenWorkWebQuantityDefinition;
  quantity: number;
  expectedMonthlyTotal: number;
  hasEligibleSubscription: boolean;
  hasAccess: boolean;
  accessSource: OpenWorkWebAccessSource;
  complimentaryAccess: boolean;
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
  const quantityDefinition = value.quantityDefinition;
  const subscription = parseSubscription(value.subscription);
  const accessSource: OpenWorkWebAccessSource | undefined = value.accessSource === "subscription" || value.accessSource === "complimentary"
    ? value.accessSource
    : value.accessSource === null
      ? null
      : undefined;
  if (
    typeof value.configured !== "boolean" ||
    (value.priceId !== undefined && value.priceId !== null && typeof value.priceId !== "string") ||
    value.unitAmount !== OPENWORK_WEB_UNIT_AMOUNT ||
    value.currency !== OPENWORK_WEB_CURRENCY ||
    value.interval !== OPENWORK_WEB_INTERVAL ||
    !isOpenWorkWebQuantityDefinition(quantityDefinition) ||
    typeof value.quantity !== "number" ||
    !Number.isInteger(value.quantity) ||
    value.quantity < 1 ||
    typeof value.expectedMonthlyTotal !== "number" ||
    value.expectedMonthlyTotal !== value.quantity * OPENWORK_WEB_UNIT_AMOUNT ||
    typeof value.hasEligibleSubscription !== "boolean" ||
    typeof value.hasAccess !== "boolean" ||
    accessSource === undefined ||
    typeof value.complimentaryAccess !== "boolean" ||
    value.hasAccess !== (accessSource !== null) ||
    (accessSource === "subscription" && value.hasEligibleSubscription !== true) ||
    (value.hasAccess && value.hasEligibleSubscription && accessSource !== "subscription") ||
    (accessSource === "complimentary" && value.complimentaryAccess !== true) ||
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
    quantityDefinition,
    quantity: value.quantity,
    expectedMonthlyTotal: value.expectedMonthlyTotal,
    hasEligibleSubscription: value.hasEligibleSubscription,
    hasAccess: value.hasAccess,
    accessSource,
    complimentaryAccess: value.complimentaryAccess,
    subscription,
  };
}

/** True when OpenWork Web bills pending invitations too. */
export function openWorkWebCountsPendingInvitations(definition: OpenWorkWebQuantityDefinition | null | undefined): boolean {
  return definition === OPENWORK_WEB_QUANTITY_BILLING_USERS;
}

export function getOpenWorkWebQuantityDescription(quantity: number, definition?: OpenWorkWebQuantityDefinition | null): string {
  if (openWorkWebCountsPendingInvitations(definition)) {
    return `${quantity} ${quantity === 1 ? "user" : "users"}`;
  }
  const memberLabel = quantity === 1 ? "member" : "members";
  return `${quantity} ${memberLabel}`;
}

export function getOpenWorkWebQuantityExplanation(definition: OpenWorkWebQuantityDefinition | null | undefined): string {
  return openWorkWebCountsPendingInvitations(definition)
    ? "Billed for each member of your organization, including the owner, and each pending invitation until it expires."
    : "Billed for each joined member of your organization, including the owner. Pending invitations are not billed.";
}
