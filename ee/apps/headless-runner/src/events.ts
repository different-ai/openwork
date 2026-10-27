/**
 * Live events for one session, so a caller can show a turn as it happens
 * instead of polling. Nothing here is stored: the transcript in SQLite stays
 * the source of truth, and a reader that misses an event re-reads the session.
 *
 * - `changed`: the stored transcript or a turn's status changed; re-read it.
 * - `text`: model text as it is written, for the model call `step` of a turn
 *   (0-based count of the turn's assistant messages). It is replaced by the
 *   stored assistant message once that step finishes.
 * - `tool`: the model started writing a tool call in that step, so a caller can show the work starting while
 *   the call's input is still being written (a long script can take a while).
 */
export type SessionEvent =
  | { type: "changed"; messageId: string; status?: string }
  /** `reset` drops the text streamed so far for this step: the model call was retried. */
  | { type: "text"; messageId: string; step: number; delta: string; reset?: boolean }
  /** The model started writing a call to `tool` in model call `step`; the stored call follows when it finishes. */
  | { type: "tool"; messageId: string; step: number; tool: string }

type Listener = (event: SessionEvent) => void

/** The first message on a live-event WebSocket, as `event: ready` starts the SSE stream. */
export const READY_MESSAGE = JSON.stringify({ type: "ready" })

/**
 * Live events over WebSockets, on a host that can hold them (a celld cell keeps them hibernatable: they outlive the
 * cell's memory and its code version, so a socket can't be found through an in-memory listener). Each message is one
 * event's JSON, exactly what the SSE stream's `data:` lines carry. The Node host has none: callers use SSE there.
 */
export type EventSockets = {
  /** Answers an upgrade with a socket for the session's events whose first message is `READY_MESSAGE`. */
  accept(sessionId: string): Response
  /** Sends one event's JSON to every socket open on the session, including ones accepted before the host slept. */
  send(sessionId: string, data: string): void
}

export class SessionEvents {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly enders = new Map<string, Set<() => void>>()
  private sockets: EventSockets | null = null

  /** Publishes every event to the host's WebSockets too; set again each time the host starts (a cell wakes). */
  useSockets(sockets: EventSockets) {
    this.sockets = sockets
  }

  /** The upgrade answer for a live-event WebSocket, or null where the host holds no sockets (callers use SSE). */
  acceptSocket(sessionId: string): Response | null {
    return this.sockets?.accept(sessionId) ?? null
  }

  /** `onEnd` runs when the session's events stop here for good (it moved to its own cell): the reader reconnects. */
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

  /** Ends every reader of the session here (see subscribe's `onEnd`). */
  end(sessionId: string) {
    for (const onEnd of [...(this.enders.get(sessionId) ?? [])]) {
      try {
        onEnd()
      } catch {
        // A broken reader never affects the others.
      }
    }
  }

  emit(sessionId: string, event: SessionEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener(event)
      } catch {
        // A broken reader never affects the turn.
      }
    }
    if (!this.sockets) return
    try {
      this.sockets.send(sessionId, JSON.stringify(event))
    } catch {
      // Nor does a broken socket.
    }
  }
}
