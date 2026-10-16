// Shared by the OpenCode engine proxy: classifying engine transport failures
// and splitting its event stream into bounded SSE frames.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEngineConnectionFailure(error: unknown): boolean {
  // Node/undici occasionally drops the transport cause. This classifier is
  // only used for managed OpenCode engine traffic, never external egress.
  if (error instanceof TypeError && error.message === "fetch failed" && error.cause === undefined) return true;
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "string") {
      return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|socket hang up|other side closed|Unable to connect|Headers Timeout Error/i.test(current);
    }
    if (!isRecord(current) || visited.has(current)) return false;
    visited.add(current);
    const code = current.code;
    // An engine that dies mid-request closes the socket (UND_ERR_SOCKET, EPIPE).
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_SOCKET") return true;
    const message = current.message;
    if (typeof message === "string" && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|socket hang up|other side closed|Unable to connect|Headers Timeout Error/i.test(message)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Cap on the text one unterminated SSE frame may buffer before the stream is
 * treated as malformed. Sized well above any legitimate single engine event
 * (large tool outputs included) so real frames are never truncated; only a
 * stream that stops terminating frames hits it.
 */
export const ENGINE_SSE_FRAME_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Incremental SSE frame splitter for the engine event stream. It bounds the
 * memory a single unterminated frame can hold: completed frames are always
 * returned, and `overflow` turns true once the pending remainder exceeds the
 * cap so the caller can drop that connection instead of buffering it forever.
 */
export class BoundedSseFrameBuffer {
  private readonly decoder = new TextDecoder();
  private buffered = "";

  constructor(private readonly maxFrameChars = ENGINE_SSE_FRAME_MAX_CHARS) {}

  push(chunk: Uint8Array): { frames: string[]; overflow: boolean } {
    this.buffered += this.decoder.decode(chunk, { stream: true });
    const frames: string[] = [];
    while (true) {
      const delimiter = this.buffered.match(/\r?\n\r?\n/);
      if (!delimiter || delimiter.index === undefined) break;
      frames.push(this.buffered.slice(0, delimiter.index));
      this.buffered = this.buffered.slice(delimiter.index + delimiter[0].length);
    }
    return { frames, overflow: this.buffered.length > this.maxFrameChars };
  }
}
