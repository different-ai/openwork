const PREFIX = "remote:"
const THREAD_KEY = /^(?:command|cloud):[^\s/]{1,240}$/

export function remoteSessionRouteId(threadKey: string): string {
  return `${PREFIX}${threadKey}`
}

export function remoteThreadKeyFromRouteId(sessionId: string | null | undefined): string | null {
  const id = sessionId?.trim()
  if (!id?.startsWith(PREFIX)) return null
  const key = id.slice(PREFIX.length)
  return THREAD_KEY.test(key) ? key : null
}

export function isRemoteSessionRouteId(sessionId: string | null | undefined): boolean {
  return remoteThreadKeyFromRouteId(sessionId) !== null
}
