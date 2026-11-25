export function isMigrationSourceLockConflict(error: unknown): boolean {
  const seen = new Set<object>()
  let current = error
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const code = "code" in current ? current.code : undefined
    const errno = "errno" in current ? current.errno : undefined
    const identifier = code ?? errno
    const sqlState = "sqlState" in current ? current.sqlState : "sqlstate" in current ? current.sqlstate : undefined
    if ((sqlState === undefined || sqlState === "HY000") && (
      identifier === "ER_LOCK_NOWAIT" || identifier === 3572 || identifier === "3572"
      || identifier === "ER_LOCK_WAIT_TIMEOUT" || identifier === 1205 || identifier === "1205"
    )) return true
    current = "cause" in current ? current.cause : undefined
  }
  return false
}
