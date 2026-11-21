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
