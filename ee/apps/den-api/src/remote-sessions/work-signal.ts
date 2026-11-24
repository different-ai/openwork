type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

function ownerKey(organizationId: string, ownerMemberId: string): string {
  return `${organizationId}\0${ownerMemberId}`
}

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
    }
  }
}
