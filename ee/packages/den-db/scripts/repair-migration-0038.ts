import "../src/load-env.ts"
import { createExecutor } from "./db-executor.ts"
import { repairMigration0038 } from "./migration-0038-repair.ts"

async function main() {
  const executor = await createExecutor()
  try {
    const result = await repairMigration0038(executor)
    console.log(`[den-db] 0038 repair status: ${result.status}`)
    for (const operation of result.operations) console.log(`[den-db] 0038 repair: ${operation}`)
  } finally {
    await executor.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
