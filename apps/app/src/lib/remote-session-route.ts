/**
 * A task on another computer opens in the main pane under its own session
 * route, `remote:<threadKey>` (e.g. `remote:command:rsc_…`), so it navigates,
 * returns and restores like a local helper. The id never reaches the local
 * engine: the route reads it as "no local session" plus a remote task.
 */

const PREFIX = "remote:"
const THREAD_KEY = /^(?:command|cloud):[^\s/]{1,240}$/

export function remoteSessionRouteId(threadKey: string): string {
  return `${PREFIX}${threadKey}`
}

/** The task's thread key for a `remote:` session id, or null for any local session id. */
export function remoteThreadKeyFromRouteId(sessionId: string | null | undefined): string | null {
  const id = sessionId?.trim()
  if (!id?.startsWith(PREFIX)) return null
  const key = id.slice(PREFIX.length)
  return THREAD_KEY.test(key) ? key : null
}

export function isRemoteSessionRouteId(sessionId: string | null | undefined): boolean {
  return remoteThreadKeyFromRouteId(sessionId) !== null
}
