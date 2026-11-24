const RUNNER_ID_KEY = "openwork.automations.desktop-runner-id"

export function desktopRunnerId() {
  const existing = localStorage.getItem(RUNNER_ID_KEY)?.trim()
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(RUNNER_ID_KEY, created)
  return created
}

export function organizationRunnerId(installId: string, organizationId: string) {
  return `${installId}:${organizationId}`
}
