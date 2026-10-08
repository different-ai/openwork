/**
 * The runner id for one organization on a Den from before runner rows were
 * scoped: such a Den refuses an install id already registered elsewhere.
 * Derived, never stored, so switching organizations back and forth reuses the
 * same registration instead of leaving a new stale runner each time.
 */
export function organizationRunnerId(installId: string, organizationId: string) {
  return `${installId}:${organizationId}`
}
