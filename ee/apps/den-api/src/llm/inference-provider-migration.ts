/** Only use for the migration source's FOR UPDATE NOWAIT query, not arbitrary DB operations. */
export function isMigrationSourceLockConflict(error: unknown): boolean {
  const seen = new Set<object>()
  let current = error
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const code = "code" in current ? current.code : undefined
    const errno = "errno" in current ? current.errno : undefined
    const identifier = code ?? errno
    const sqlState = "sqlState" in current ? current.sqlState : "sqlstate" in current ? current.sqlstate : undefined
    // MySQL uses 3572; MariaDB uses 1205 even for an immediate NOWAIT conflict.
    if ((sqlState === undefined || sqlState === "HY000") && (
      identifier === "ER_LOCK_NOWAIT" || identifier === 3572 || identifier === "3572"
      || identifier === "ER_LOCK_WAIT_TIMEOUT" || identifier === 1205 || identifier === "1205"
    )) return true
    current = "cause" in current ? current.cause : undefined
  }
  return false
}
