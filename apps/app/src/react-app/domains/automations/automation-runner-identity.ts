const RUNNER_ID_KEY = "openwork.automations.desktop-runner-id"

/**
 * One id per desktop install, kept for good. Den scopes runner rows by
 * organization and member, so the same install is a runner in every
 * organization it signs in to. The organization's devices list names this
 * desktop by the same id, so the computer and its runner are one entry.
 */
export function desktopRunnerId() {
  const existing = localStorage.getItem(RUNNER_ID_KEY)?.trim()
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(RUNNER_ID_KEY, created)
  return created
}

/**
 * The runner id for one organization on a Den from before runner rows were
 * scoped: such a Den refuses an install id already registered elsewhere.
 * Derived, never stored, so switching organizations back and forth reuses the
 * same registration instead of leaving a new stale runner each time.
 */
export function organizationRunnerId(installId: string, organizationId: string) {
  return `${installId}:${organizationId}`
}
