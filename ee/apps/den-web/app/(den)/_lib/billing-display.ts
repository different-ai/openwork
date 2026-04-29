import {
  formatMoneyMinor,
  formatRecurringInterval,
  type BillingPrice,
  type BillingSummary,
} from "./den-flow";

export const WORKSPACE_PLAN_LIMITS = {
  includedMembers: 5,
  includedHostedWorkers: 1,
} as const;

export const LOCAL_MOCK_BILLING_PRICE: BillingPrice = {
  amount: 5000,
  currency: "usd",
  recurringInterval: "month",
  recurringIntervalCount: 1,
};

export type BillingPlanLabels = {
  amount: string;
  cadence: string;
  inline: string;
  available: boolean;
};

const PRODUCTION_BILLING_HOSTS = new Set(["app.openworklabs.com"]);

function normalizeHost(value: string | null | undefined) {
  const host = value?.split(",")[0]?.trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 ? host.slice(1, end) : host;
  }
  return host.split(":")[0] ?? null;
}

export function isProductionBillingHost(host: string | null | undefined) {
  const normalizedHost = normalizeHost(host);
  return normalizedHost ? PRODUCTION_BILLING_HOSTS.has(normalizedHost) : false;
}

export function isLocalMockBillingEnabled({
  flag,
  host,
  nodeEnv,
}: {
  flag: string | undefined;
  host?: string | null;
  nodeEnv: string | undefined;
}) {
  return flag === "1" && nodeEnv !== "production" && !isProductionBillingHost(host);
}

export function buildLocalMockBillingSummary(checkoutUrl: string | null): BillingSummary {
  return {
    featureGateEnabled: true,
    hasActivePlan: false,
    checkoutRequired: true,
    checkoutUrl,
    portalUrl: null,
    price: LOCAL_MOCK_BILLING_PRICE,
    subscription: null,
    invoices: [],
    productId: null,
    benefitId: null,
  };
}

export function formatBillingPlanLabels(price: BillingPrice | null): BillingPlanLabels {
  if (!price || price.amount === null) {
    return {
      amount: "Price unavailable",
      cadence: "billing cycle",
      inline: "Price unavailable",
      available: false,
    };
  }

  const amount = formatMoneyMinor(price.amount, price.currency);
  const cadence = formatRecurringInterval(price.recurringInterval, price.recurringIntervalCount);

  return {
    amount,
    cadence,
    inline: `${amount} ${cadence}`,
    available: true,
  };
}

export function formatBillingAmountLabel(amount: number | null | undefined, currency: string | null | undefined) {
  if (amount === null || amount === undefined) {
    return "Not available";
  }

  return formatMoneyMinor(amount, currency ?? null);
}

export function formatBillingStatusLabel(value: string | null | undefined) {
  if (!value) return "Purchase required";
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function getBillingStatusLabel(
  summary: Pick<BillingSummary, "hasActivePlan" | "subscription"> | null | undefined,
) {
  const subscription = summary?.subscription;

  if (subscription?.status) {
    return formatBillingStatusLabel(subscription.status);
  }

  return summary?.hasActivePlan ? "Active" : "Purchase required";
}

function formatIncludedNoun(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function getWorkspacePlanEntitlementCopy() {
  const members = formatIncludedNoun(WORKSPACE_PLAN_LIMITS.includedMembers, "member", "members");
  const workers = formatIncludedNoun(WORKSPACE_PLAN_LIMITS.includedHostedWorkers, "hosted worker", "hosted workers");

  return `Includes up to ${members} and ${workers}.`;
}

export function getWorkspacePlanInlineEntitlementCopy() {
  const members = formatIncludedNoun(WORKSPACE_PLAN_LIMITS.includedMembers, "member", "members");
  const workers = formatIncludedNoun(WORKSPACE_PLAN_LIMITS.includedHostedWorkers, "hosted worker", "hosted workers");

  return `include up to ${members} and ${workers}`;
}

export function getWorkspacePlanShortEntitlementCopy() {
  const members = formatIncludedNoun(WORKSPACE_PLAN_LIMITS.includedMembers, "member", "members");
  const workers = formatIncludedNoun(WORKSPACE_PLAN_LIMITS.includedHostedWorkers, "hosted worker", "hosted workers");

  return `${members} included · ${workers}`;
}
