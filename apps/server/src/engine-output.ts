// Limits are UTF-16 code units, not bytes. Diagnostics must not grow with uptime.
export const ENGINE_OUTPUT_MAX_CHARS = 64 * 1024;
export const ENGINE_STARTUP_LINE_MAX_CHARS = 8 * 1024;

export function appendEngineOutputTail(tail: string, text: string): string {
  if (text.length >= ENGINE_OUTPUT_MAX_CHARS) return text.slice(-ENGINE_OUTPUT_MAX_CHARS);
  return tail.slice(-(ENGINE_OUTPUT_MAX_CHARS - text.length)) + text;
}

// Wait for a newline: even the port in an announcement can span chunks.
export function createEngineStartupLineReader(onLine: (line: string) => void) {
  let listener: typeof onLine | undefined = onLine;
  let pending = "";
  let oversized = false;
  return {
    write(text: string) {
      let start = 0;
      while (listener && start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline === -1 ? text.length : newline;
        if (!oversized) {
          if (pending.length + end - start > ENGINE_STARTUP_LINE_MAX_CHARS) {
            // Discard the whole line, not a suffix that could resemble readiness.
            pending = "";
            oversized = true;
          } else {
            pending += text.slice(start, end);
          }
        }
        if (newline === -1) return;
        const line = pending;
        const emit = !oversized;
        pending = "";
        oversized = false;
        if (emit) listener(line);
        start = newline + 1;
      }
    },
    stop() {
      listener = undefined;
      pending = "";
      oversized = false;
    },
  };
}
