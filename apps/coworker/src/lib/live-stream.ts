/**
 * The words a reply is made of while they are still arriving.
 *
 * The engine writes a text or reasoning part to the thread only once that part
 * has ended; while it streams, the words travel as events. This keeps the one
 * part streaming right now for a thread, so a person who taps the live row can
 * glimpse the end of it. It is a buffer, not a record: a poll of the thread
 * still owns everything that has landed.
 */
export type LiveStream = {
  messageId: string;
  partId: string;
  /** `text`, `reasoning`, or empty until the engine has named the part. */
  type: string;
  text: string;
  /** The engine closed the part; the thread carries it now. */
  ended: boolean;
};

export type StreamEvent =
  | { kind: "delta"; threadId: string; messageId: string; partId: string; delta: string }
  | { kind: "part"; threadId: string; messageId: string; partId: string; type: string; text: string; ended: boolean };

const WORD_PARTS = new Set(["text", "reasoning"]);

/** Fold one engine event into the stream for one thread; events for other threads or for tool parts change nothing. */
export function applyStreamEvent(current: LiveStream | null, event: StreamEvent, threadId: string): LiveStream | null {
  if (event.threadId !== threadId) return current;
  if (event.kind === "delta") {
    if (!event.delta) return current;
    if (current && current.partId === event.partId) return { ...current, text: current.text + event.delta, ended: false };
    // A part the engine has not announced yet (or a newer one than the one we held): start with its words.
    return { messageId: event.messageId, partId: event.partId, type: "", text: event.delta, ended: false };
  }
  if (!WORD_PARTS.has(event.type)) return current;
  if (current && current.partId === event.partId) {
    // The announcement names the part; a later update carries its whole text once it ended.
    return { ...current, type: event.type, text: event.ended || event.text.length >= current.text.length ? event.text || current.text : current.text, ended: event.ended };
  }
  // A new part starting supersedes whatever streamed before it; a stale update of an older part does not.
  if (current && !current.ended && event.ended) return current;
  return { messageId: event.messageId, partId: event.partId, type: event.type, text: event.text, ended: event.ended };
}
