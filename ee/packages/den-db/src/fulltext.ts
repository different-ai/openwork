import { MEMORY_CONTENT_FULLTEXT_INDEX } from "./schema/memory"

/**
 * Minimal query surface satisfied by both the mysql2 and PlanetScale executors used
 * across den-db scripts. Positional `?` args are bound by the driver.
 */
export type FulltextIndexExecutor = {
  query: (sql: string, args?: (string | number)[]) => Promise<Record<string, unknown>[]>
}

const MEMORY_TABLE = "memory"
const MEMORY_CONTEXT_TABLE = "memory_context"
const CREATED_AT_COLUMN = "created_at"
const PORTABLE_CREATED_AT_DEFAULT = "CURRENT_TIMESTAMP(3)"

type MemoryTimestampTable = typeof MEMORY_TABLE | typeof MEMORY_CONTEXT_TABLE

async function memoryCreatedAtDefaultIsPortable(
  executor: FulltextIndexExecutor,
  table: MemoryTimestampTable,
): Promise<boolean> {
  const rows = await executor.query(
    `SELECT column_default AS default_value FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, CREATED_AT_COLUMN],
  )
  const defaultValue = rows[0]?.default_value
  return (
    typeof defaultValue === "string" &&
    defaultValue.toUpperCase() === PORTABLE_CREATED_AT_DEFAULT
  )
}

async function normalizeMemoryCreatedAtDefault(
  executor: FulltextIndexExecutor,
  table: MemoryTimestampTable,
): Promise<{ normalized: boolean }> {
  if (await memoryCreatedAtDefaultIsPortable(executor, table)) {
    return { normalized: false }
  }

  const quotedTable = table === MEMORY_TABLE ? "`memory`" : "`memory_context`"
  await executor.query(
    `ALTER TABLE ${quotedTable} MODIFY \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`,
  )
  return { normalized: true }
}

export async function normalizeMemoryTimestampDefaults(
  executor: FulltextIndexExecutor,
): Promise<{ memory: boolean; memory_context: boolean }> {
  const memoryContext = await normalizeMemoryCreatedAtDefault(
    executor,
    MEMORY_CONTEXT_TABLE,
  )
  const memory = await normalizeMemoryCreatedAtDefault(executor, MEMORY_TABLE)
  return { memory: memory.normalized, memory_context: memoryContext.normalized }
}

async function memoryFulltextIndexExists(executor: FulltextIndexExecutor): Promise<boolean> {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [MEMORY_TABLE, MEMORY_CONTENT_FULLTEXT_INDEX],
  )
  return rows.length > 0
}

/**
 * Idempotently create the FULLTEXT index on `memory.content`.
 *
 * This MUST run on a path both the fresh-install bootstrap and the incremental migrate
 * paths hit: Drizzle's schema snapshot/push cannot emit a raw FULLTEXT index and
 * the baseline step marks migrations applied-without-executing, so a
 * migration-only index is silently absent on freshly bootstrapped databases
 * (memory-bank-architecture.md §3, B2).
 */
export async function ensureMemoryFulltextIndex(
  executor: FulltextIndexExecutor,
): Promise<{ created: boolean }> {
  await normalizeMemoryTimestampDefaults(executor)

  if (await memoryFulltextIndexExists(executor)) {
    return { created: false }
  }
  try {
    await executor.query(
      `CREATE FULLTEXT INDEX \`${MEMORY_CONTENT_FULLTEXT_INDEX}\` ON \`${MEMORY_TABLE}\` (\`content\`)`,
    )
  } catch (error) {
    // Another concurrent bootstrap may have created it between the check and the create.
    if (await memoryFulltextIndexExists(executor)) {
      return { created: false }
    }
    throw error
  }
  return { created: true }
}

/**
 * Single seam that creates every FULLTEXT index the schema needs but Drizzle's DSL cannot
 * express. Both DB apply paths call this — the bootstrap step and the post-`db:migrate`
 * hook — so the two paths cannot drift (memory-bank-architecture.md §3, B2). Add future
 * FULLTEXT indexes here.
 */
export async function ensureFulltextIndexes(executor: FulltextIndexExecutor): Promise<void> {
  const memory = await ensureMemoryFulltextIndex(executor)
  console.log(`[den-db] memory.content FULLTEXT index ${memory.created ? "created" : "already present"}`)
}

/**
 * Startup / CI assertion that the FULLTEXT index exists. Throws if it is missing so a
 * misconfigured database fails loudly instead of silently degrading search to no matches.
 */
export async function assertMemoryFulltextIndexExists(
  executor: FulltextIndexExecutor,
): Promise<void> {
  if (!(await memoryFulltextIndexExists(executor))) {
    throw new Error(
      `Missing FULLTEXT index '${MEMORY_CONTENT_FULLTEXT_INDEX}' on '${MEMORY_TABLE}.content'. ` +
        "Run `pnpm --filter @openwork-ee/den-db db:bootstrap` (or call ensureMemoryFulltextIndex) to create it.",
    )
  }
}
