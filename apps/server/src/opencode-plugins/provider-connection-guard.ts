import { scheduler, type ResumeMonitor, type Scheduler } from "./provider-resume-monitor.js";

export const CONNECTION_LOST_MESSAGE = "Connection lost while waiting for the model after the computer resumed; retrying";
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Let the engine retry a request that stays silent for 30 seconds after an
 * execution pause. Ordinary silence has no added timeout. Successful SSE
 * streams are observed; HTTP errors and other responses pass through intact.
 * This wrapper never replays a request or changes authentication itself.
 */
export function guardProviderFetch(fetchFn: FetchLike, monitor: ResumeMonitor, clock: Scheduler = scheduler): FetchLike {
  return async (input, init) => {
    const callerSignal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    callerSignal?.throwIfAborted();
    const abort = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, abort.signal]) : abort.signal;
    let cancelGrace: (() => void) | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let released = false;
    let waitingForProgress = true;
    let rejectFailure: (reason: unknown) => void = () => {};
    const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
    // A caller can abort between reads, when nobody is awaiting the failure.
    void failure.catch(() => {});

    const cleanup = () => {
      if (released) return;
      released = true;
      unsubscribe();
      cancelGrace?.();
      callerSignal?.removeEventListener("abort", onAbort);
    };
    const fail = (reason: unknown) => {
      cleanup();
      rejectFailure(reason);
      abort.abort(reason);
      void reader?.cancel(reason).catch(() => {});
    };
    const onAbort = () => fail(callerSignal?.reason);
    const progress = () => {
      waitingForProgress = false;
      cancelGrace?.();
      cancelGrace = undefined;
    };
    const unsubscribe = monitor.subscribe(() => {
      if (released || cancelGrace || !waitingForProgress) return;
      cancelGrace = clock.after(30_000, () => fail(new Error(CONNECTION_LOST_MESSAGE)));
    });
    callerSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await Promise.race([fetchFn(input, { ...init, signal }), failure]);
      progress();
      if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
        cleanup();
        return response;
      }
      const source = response.body.getReader();
      reader = source;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            waitingForProgress = true;
            const part = await Promise.race([source.read(), failure]);
            progress();
            if (part.done) {
              cleanup();
              controller.close();
            } else {
              controller.enqueue(part.value);
            }
          } catch (error) {
            cleanup();
            controller.error(error);
          }
        },
        async cancel(reason) {
          cleanup();
          abort.abort(reason);
          await source.cancel(reason);
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}
