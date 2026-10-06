import type { OrganizationTable } from "@openwork-ee/den-db/schema"

type OrgId = typeof OrganizationTable.$inferSelect.id

export type SubscriptionType = "inference" | "seat" | "web"

export type SubscriptionStatusProvider = {
  hasActiveSubscription(organizationId: OrgId, type: SubscriptionType): Promise<boolean>
}

/** A deployment without billing has no subscriptions. */
export const NO_SUBSCRIPTIONS: SubscriptionStatusProvider = {
  async hasActiveSubscription() {
    return false
  },
}

export function createSubscriptionStatusRegistry() {
  let registered: SubscriptionStatusProvider | null = null
  return {
    register(provider: SubscriptionStatusProvider) {
      if (registered && registered !== provider) {
        throw new Error("subscription_status_provider_already_registered")
      }
      registered = provider
    },
    current(): SubscriptionStatusProvider {
      return registered ?? NO_SUBSCRIPTIONS
    },
  }
}

const registry = createSubscriptionStatusRegistry()

export function registerSubscriptionStatusProvider(provider: SubscriptionStatusProvider): void {
  registry.register(provider)
}

export function subscriptionStatus(): SubscriptionStatusProvider {
  return registry.current()
}
