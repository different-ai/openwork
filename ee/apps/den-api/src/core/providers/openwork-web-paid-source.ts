import type { OrganizationTable } from "@openwork-ee/den-db/schema"

type OrgId = typeof OrganizationTable.$inferSelect.id

/** The paid OpenWork Web subscription, as shown in the `/v1/billing/web` summary. */
export type OpenWorkWebSubscriptionView = {
  status: string
  paymentStatus: string
  quantity: number
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  endedAt: string | null
}

export type OpenWorkWebBillingFields = {
  configured: boolean
  hasEligibleSubscription: boolean
  subscription: OpenWorkWebSubscriptionView | null
}

/**
 * A paid source of OpenWork Web access. Billing contributes one on deployments
 * that have it; OpenWork Web access resolves without it everywhere else.
 */
export type OpenWorkWebPaidSource = {
  /** Whether the organization has an eligible paid subscription right now. */
  hasEligibleSubscription(organizationId: OrgId): Promise<boolean>
  /** The billing fields of the `/v1/billing/web` summary. */
  billingSummary(organizationId: OrgId): Promise<OpenWorkWebBillingFields>
}

export function createOpenWorkWebPaidSourceRegistry() {
  let registered: OpenWorkWebPaidSource | null = null
  return {
    register(source: OpenWorkWebPaidSource) {
      if (registered && registered !== source) {
        throw new Error("openwork_web_paid_source_already_registered")
      }
      registered = source
    },
    current(): OpenWorkWebPaidSource | null {
      return registered
    },
  }
}

const registry = createOpenWorkWebPaidSourceRegistry()

export function registerOpenWorkWebPaidSource(source: OpenWorkWebPaidSource): void {
  registry.register(source)
}

export function openWorkWebPaidSource(): OpenWorkWebPaidSource | null {
  return registry.current()
}
