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

export class SessionEvents {
  private readonly listeners = new Map<string, Set<Listener>>()

  subscribe(sessionId: string, listener: Listener) {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
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
  }

}
