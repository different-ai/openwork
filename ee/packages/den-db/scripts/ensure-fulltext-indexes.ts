/**
 * Idempotently create the FULLTEXT indexes that Drizzle's DSL cannot express.
 *
 * Runs as a post-`db:migrate` step (and is reachable via bootstrap) so the index exists on
 * every apply path — including a `db:migrate`-only run on a database where the memory
 * migration was already baselined/recorded, which would otherwise leave the index silently
 * absent (memory-bank-architecture.md §3, B2).
 *
 * Usage:
 *   DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_den \
 *     node --import tsx scripts/ensure-fulltext-indexes.ts
 */
import "../src/load-env.ts"
import { ensureFulltextIndexes } from "../src/fulltext.ts"
import { createExecutor } from "./db-executor.ts"

async function main() {
  const executor = await createExecutor()
  try {
    await ensureFulltextIndexes(executor)
  } finally {
    await executor.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
