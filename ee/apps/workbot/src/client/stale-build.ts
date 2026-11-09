/**
 * A tab left open across a deploy still runs the build it loaded. The parts of the app it has not fetched yet (the
 * calendar, the screen viewer) are files of that build, and the server no longer has them. Vite reports the failed
 * load as `vite:preloadError`; loading the page again picks up the current build.
 */

/** One reload per tab in this long: a file that is really missing must not reload the page in a loop. */
export const BUILD_RELOAD_WINDOW_MS = 5 * 60_000
const LAST_RELOAD = "workbot.buildReloadAt"

/** Whether to load the page again now, given when this tab last did for the same reason (null: never). */
export function shouldReloadForNewBuild(lastReloadAt: number | null, now: number, online = true) {
  // Offline, the file is out of reach rather than gone, and a reload would trade the page for the browser's error page.
  if (!online) return false
  if (lastReloadAt === null || !Number.isFinite(lastReloadAt)) return true
  const since = now - lastReloadAt
  // A time in the future is a clock that moved back, not a recent reload.
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

/** The event is left alone either way: where the page does not reload, the failed load surfaces the way it did before. */
export function reloadOnStaleBuild() {
  window.addEventListener("vite:preloadError", () => {
    const now = Date.now()
    // Where the reload cannot be remembered, nothing would stop the next one.
    if (!shouldReloadForNewBuild(lastReload(), now, navigator.onLine) || !rememberReload(now)) return
    window.location.reload()
  })
}
