/**
 * Adds rows for new catalog permissions to every organization's Member, Admin and
 * Super admin permission sets. Run after migrations; see permission-reconciliation.ts.
 *
 * Usage:
 *   DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_den \
 *     node --conditions=development --import tsx scripts/reconcile-permissions.ts
 */
import "../src/load-env.ts"
import { reconcilePermissionsFromEnv } from "./permission-reconciliation.ts"

reconcilePermissionsFromEnv().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
