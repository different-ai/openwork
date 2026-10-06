import type { OrganizationTable } from "@openwork-ee/den-db/schema"
import type { SubscriptionType } from "./subscription-status.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

export type SubscriptionChange = {
  organizationId: OrgId
  type: SubscriptionType
  change: "activated" | "deactivated"
  reason: "checkout" | "webhook" | "sync" | "disabling_status"
}

export type SubscriptionChangeListener = (change: SubscriptionChange) => Promise<void>

export function createSubscriptionChangeRegistry() {
  const listeners: SubscriptionChangeListener[] = []
  return {
    on(listener: SubscriptionChangeListener) {
      if (!listeners.includes(listener)) {
        listeners.push(listener)
      }
    },
    /** Runs listeners one at a time, in registration order. The first error stops the run and propagates. */
    async emit(change: SubscriptionChange) {
      for (const listener of listeners) {
        await listener(change)
      }
    },
  }
}

const registry = createSubscriptionChangeRegistry()

export function onSubscriptionChange(listener: SubscriptionChangeListener): void {
  registry.on(listener)
}

export async function emitSubscriptionChange(change: SubscriptionChange): Promise<void> {
  await registry.emit(change)
}
