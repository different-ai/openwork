// Electron runs Promise continuations before its native navigation callback
// returns. Stopping there hits Chromium's NavigationRequest safety CHECK and
// aborts the entire app; a microtask (including an async function) is not enough.

/**
 * Stop only the navigation the caller cancelled, after the native callback
 * unwinds. The guard must reject a closed/replaced tab or newer navigation.
 * @param {{ isDestroyed(): boolean, stop(): void }} contents
 * @param {() => boolean} isCurrent
 */
export function deferBrowserStop(contents, isCurrent) {
  setImmediate(() => {
    if (!contents.isDestroyed() && isCurrent()) contents.stop();
  });
}
