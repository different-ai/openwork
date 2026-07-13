export function isDuplicateDatabaseEntry(error: unknown): boolean {
  const visited = new Set<object>()
  let current = error
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current)
    if ("code" in current && current.code === "ER_DUP_ENTRY") return true
    if ("errno" in current && current.errno === 1062) return true
    if (
      "message" in current
      && typeof current.message === "string"
      && /duplicate entry|unique constraint/i.test(current.message)
    ) return true
    current = "cause" in current ? current.cause : null
  }
  return false
}
