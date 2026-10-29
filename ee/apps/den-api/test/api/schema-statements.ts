/**
 * Folds each `CREATE [UNIQUE] INDEX name ON table (cols)` into its table's
 * `CREATE TABLE`. The resulting tables are identical (same SHOW CREATE TABLE),
 * but MySQL builds them with one atomic DDL each instead of one per index.
 * Every test file creates its own database, so with ~15 files at once the
 * separate index DDLs dominated the suite (31s vs 6s per database measured).
 * Anything that does not match is kept as its own statement, after the tables.
 */
export function inlineIndexes(statements: readonly string[]): string[] {
  const tables = new Map<string, string>()
  const rest: string[] = []
  const tableName = (statement: string) => /^CREATE TABLE `([^`]+)`/.exec(statement)?.[1]
  for (const statement of statements) {
    const name = tableName(statement)
    if (name) tables.set(name, statement)
  }
  for (const statement of statements) {
    if (tableName(statement)) continue
    const index = /^CREATE (UNIQUE )?INDEX (`[^`]+`) ON `([^`]+)` (\(.+\))$/s.exec(statement)
    const target = index?.[3] ? tables.get(index[3]) : undefined
    const close = target?.lastIndexOf(")") ?? -1
    if (!index?.[3] || target === undefined || close < 0 || target.slice(close + 1).trim() !== "") {
      rest.push(statement)
      continue
    }
    tables.set(index[3], `${target.slice(0, close).trimEnd()},\n\t${index[1] ?? ""}INDEX ${index[2]} ${index[4]}\n)`)
  }
  return [...tables.values(), ...rest]
}
