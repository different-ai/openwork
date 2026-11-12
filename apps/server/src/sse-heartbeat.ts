const HEARTBEAT = new TextEncoder().encode(": heartbeat\n\n");

/**
 * Sends an SSE comment at a fixed interval while an event stream is open, so
 * its client can tell a quiet stream from a dead one. `frames` must deliver
 * whole frames per chunk: a comment then never lands inside a frame.
 */
export function withSseHeartbeat(frames: ReadableStream<Uint8Array>, intervalMs: number): ReadableStream<Uint8Array> {
  const reader = frames.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        // Bytes already waiting for the client attest liveness themselves.
        if ((controller.desiredSize ?? 0) > 0) controller.enqueue(HEARTBEAT);
      }, intervalMs);
      timer.unref?.();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (!done) return controller.enqueue(value);
        clearInterval(timer);
        controller.close();
      } catch (error) {
        clearInterval(timer);
        throw error;
      }
    },
    async cancel(reason) {
      cancelled = true;
      clearInterval(timer);
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
