import "../src/load-env.ts"
import { reconcilePermissionsFromEnv } from "./permission-reconciliation.ts"

reconcilePermissionsFromEnv().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
