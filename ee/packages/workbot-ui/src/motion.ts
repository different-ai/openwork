/** How long the update callback waits for React to draw before the new snapshot is taken (a macrotask, not a frame). */
const SETTLE_MS = 16;

/**
 * Runs `update` inside a View Transition where the browser has one (Safari 18, Chrome 111), so the screen cross-fades
 * to what the update draws; otherwise, or with reduced motion, it just runs. The new snapshot is taken after a short
 * timeout, by when React has drawn the update. Not after a frame: browsers suppress rendering, and with it animation
 * frames, while the update callback runs, so waiting for one would freeze the page until the transition timed out.
 */
export function withViewTransition(update: () => void) {
  if (typeof document === "undefined" || typeof window === "undefined") return update();
  const start: unknown = Reflect.get(document, "startViewTransition");
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (typeof start !== "function" || reduced || document.visibilityState !== "visible") return update();
  let ran = false;
  const run = () => { if (!ran) { ran = true; update(); } };
  try {
    const transition: unknown = Reflect.apply(start, document, [() => new Promise<void>((resolve) => { run(); setTimeout(resolve, SETTLE_MS); })]);
    // A skipped or interrupted transition rejects these; the update itself has already run.
    for (const name of ["ready", "finished", "updateCallbackDone"]) {
      const settled: unknown = typeof transition === "object" && transition !== null ? Reflect.get(transition, name) : null;
      if (settled instanceof Promise) settled.catch(() => {});
    }
  } catch {
    run();
  }
}
