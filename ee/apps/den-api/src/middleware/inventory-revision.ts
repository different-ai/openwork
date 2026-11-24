import type { MiddlewareHandler } from "hono"
import { cache } from "../cache.js"
import { emptyInventoryWrites, inventoryRevisionsToBump, notifyInventoryChanged, trackInventoryWrites } from "../inventory-writes.js"
import type { UserOrganizationsContext } from "./user-organizations.js"

export const inventoryRevisionMiddleware: MiddlewareHandler<{ Variables: Partial<UserOrganizationsContext> }> = async (c, next) => {
  const writes = emptyInventoryWrites()
  try {
    await trackInventoryWrites(writes, next)
  } finally {
    const organizationIds = inventoryRevisionsToBump(writes, c.get("activeOrganizationId"))
    if (organizationIds.length > 0) {
      void cache.inventory.bump(organizationIds, { providerInventory: writes.providerInventory })
      notifyInventoryChanged(organizationIds)
    }
  }
}
