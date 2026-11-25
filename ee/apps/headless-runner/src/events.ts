export type SessionEvent =
  | { type: "changed"; messageId: string; status?: string }
  | { type: "text"; messageId: string; step: number; delta: string; reset?: boolean }
  | { type: "tool"; messageId: string; step: number; tool: string; description?: string; view?: "browser" | "computer" }

type Listener = (event: SessionEvent) => void

export const READY_MESSAGE = JSON.stringify({ type: "ready" })

export type EventSockets = {
  accept(sessionId: string): Response
  send(sessionId: string, data: string): void
}

export class SessionEvents {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly enders = new Map<string, Set<() => void>>()
  private sockets: EventSockets | null = null

  useSockets(sockets: EventSockets) {
    this.sockets = sockets
  }

  acceptSocket(sessionId: string): Response | null {
    return this.sockets?.accept(sessionId) ?? null
  }

  subscribe(sessionId: string, listener: Listener, onEnd?: () => void) {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(listener)
    this.listeners.set(sessionId, set)
    const ends = this.enders.get(sessionId) ?? new Set()
    if (onEnd) {
      ends.add(onEnd)
      this.enders.set(sessionId, ends)
    }
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
      if (onEnd) ends.delete(onEnd)
      if (ends.size === 0) this.enders.delete(sessionId)
    }
  }

  end(sessionId: string) {
    for (const onEnd of [...(this.enders.get(sessionId) ?? [])]) {
      try {
        onEnd()
      } catch {
      }
    }
  }

  emit(sessionId: string, event: SessionEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener(event)
      } catch {
      }
    }
    if (!this.sockets) return
    try {
      this.sockets.send(sessionId, JSON.stringify(event))
    } catch {
    }
  }
}
