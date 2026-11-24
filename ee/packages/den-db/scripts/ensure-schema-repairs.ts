import "../src/load-env.ts"
import { ensureSchemaRepairs } from "../src/schema-repairs.ts"
import { createExecutor } from "./db-executor.ts"

async function main() {
  const executor = await createExecutor()
  try {
    await ensureSchemaRepairs(executor)
  } finally {
    await executor.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
