export const BUILD_RELOAD_WINDOW_MS = 5 * 60_000
const LAST_RELOAD = "workbot.buildReloadAt"

export function shouldReloadForNewBuild(lastReloadAt: number | null, now: number, online = true) {
  if (!online) return false
  if (lastReloadAt === null || !Number.isFinite(lastReloadAt)) return true
  const since = now - lastReloadAt
  return since < 0 || since >= BUILD_RELOAD_WINDOW_MS
}

function lastReload() {
  try {
    const value = sessionStorage.getItem(LAST_RELOAD)
    return value === null ? null : Number(value)
  } catch {
    return null
  }
}

function rememberReload(now: number) {
  try {
    sessionStorage.setItem(LAST_RELOAD, String(now))
    return true
  } catch {
    return false
  }
}

export function reloadOnStaleBuild() {
  window.addEventListener("vite:preloadError", () => {
    const now = Date.now()
    if (!shouldReloadForNewBuild(lastReload(), now, navigator.onLine) || !rememberReload(now)) return
    window.location.reload()
  })
}
