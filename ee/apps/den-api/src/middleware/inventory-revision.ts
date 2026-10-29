import type { MiddlewareHandler } from "hono"
import { cache } from "../cache.js"
import { emptyInventoryWrites, inventoryRevisionsToBump, notifyInventoryChanged, trackInventoryWrites } from "../inventory-writes.js"
import type { UserOrganizationsContext } from "./user-organizations.js"

/**
 * Bumps the inventory revision of every organization a request wrote to, once
 * the handler (and its transactions) has finished, so a desktop that reads the
 * new revision also reads the committed rows. Failed requests bump too: a
 * partial write may have committed, and an extra reload is harmless. Listeners
 * in this process (open Connect streams) hear about it at the same time.
 */
export const inventoryRevisionMiddleware: MiddlewareHandler<{ Variables: Partial<UserOrganizationsContext> }> = async (c, next) => {
  const writes = emptyInventoryWrites()
  try {
    await trackInventoryWrites(writes, next)
  } finally {
    const organizationIds = inventoryRevisionsToBump(writes, c.get("activeOrganizationId"))
    if (organizationIds.length > 0) {
      void cache.inventory.bump(organizationIds)
      notifyInventoryChanged(organizationIds)
    }
  }
}
