/** @typedef {ReturnType<typeof setTimeout> | number} TimerHandle */

/**
 * Bounded, single-shot teardown for Electron's `before-quit`.
 *
 * Electron's `Browser::Quit()` runs `is_quitting_ = HandleBeforeQuit()`. When the
 * teardown promise settles without ever leaving the microtask queue (nothing was
 * running, as on an unactivated install), a direct `app.quit()` from the
 * continuation re-enters `Browser::Quit()` *inside* the outer `before-quit`
 * emit: the nested call sets `is_quitting_ = true` and closes the windows, then
 * the outer call returns `prevent_default = true` and overwrites it with
 * `false`. The last window then closes on the non-quitting branch, macOS keeps
 * a windowless process alive, and SIGTERM never exits. The sequencer therefore
 * always resumes the quit from a fresh macrotask and never from the emit.
 *
 * @param {{
 *   stop: () => Promise<unknown>,
 *   quit: () => void,
 *   exit: () => void,
 *   schedule?: (fn: () => void, delayMs: number) => TimerHandle,
 *   cancel?: (handle: TimerHandle) => void,
 *   stopDeadlineMs?: number,
 *   exitFailsafeMs?: number,
 *   report?: (message: string, error?: unknown) => void,
 * }} options
 */
export function createQuitSequencer({
  stop,
  quit,
  exit,
  schedule = (fn, delayMs) => setTimeout(fn, delayMs),
  cancel = (handle) => clearTimeout(handle),
  stopDeadlineMs = 10_000,
  exitFailsafeMs = 5_000,
  report = (message, error) => console.error(message, error),
}) {
  /** @type {"idle" | "stopping" | "quitting" | "gone"} */
  let phase = "idle";
  /** @type {TimerHandle | null} */
  let failsafe = null;

  function resumeQuit(reason) {
    if (phase !== "stopping") return;
    phase = "quitting";
    if (reason) report(`[desktop] ${reason}; quitting anyway`);
    // Fresh macrotask: never re-enter Browser::Quit() from inside the emit.
    schedule(() => {
      failsafe = schedule(() => {
        if (phase === "gone") return;
        report("[desktop] quit did not complete; exiting");
        exit();
      }, exitFailsafeMs);
      quit();
    }, 0);
  }

  return {
    /** @param {{ preventDefault: () => void }} event */
    handleBeforeQuit(event) {
      if (phase === "quitting" || phase === "gone") return;
      event.preventDefault();
      if (phase === "stopping") return;
      phase = "stopping";
      const deadline = schedule(() => resumeQuit(`stopping services took longer than ${stopDeadlineMs}ms`), stopDeadlineMs);
      let settled;
      try {
        settled = Promise.resolve(stop());
      } catch (error) {
        settled = Promise.reject(error);
      }
      settled.then(
        () => {
          cancel(deadline);
          resumeQuit();
        },
        (error) => {
          cancel(deadline);
          report("[desktop] stop services before quit failed", error);
          resumeQuit();
        },
      );
    },
    /** Call from `will-quit`: the quit reached Electron, so the failsafe stands down. */
    handleWillQuit() {
      phase = "gone";
      if (failsafe !== null) cancel(failsafe);
      failsafe = null;
    },
    phase: () => phase,
  };
}
