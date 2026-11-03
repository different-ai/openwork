/**
 * In-process wake-up for runner event streams: enqueueing a remote-session
 * command wakes the streams of that owner held by this Den instance, so their
 * desktop hears about the task at once. Streams on another instance still find
 * it with their periodic pending check; this only shortens the wait.
 */

type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

function ownerKey(organizationId: string, ownerMemberId: string): string {
  return `${organizationId}\0${ownerMemberId}`
}

/** Calls `listener` whenever a command is queued for this owner; returns the unsubscribe. */
export function onRemoteSessionWork(organizationId: string, ownerMemberId: string, listener: Listener): () => void {
  const key = ownerKey(organizationId, ownerMemberId)
  const set = listeners.get(key) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key)
  }
}

export function signalRemoteSessionWork(organizationId: string, ownerMemberId: string): void {
  for (const listener of listeners.get(ownerKey(organizationId, ownerMemberId)) ?? []) {
    try {
      listener()
    } catch {
      // A broken stream must not stop the enqueue or the other listeners.
    }
  }
}
