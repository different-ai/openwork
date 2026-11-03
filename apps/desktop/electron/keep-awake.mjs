// Keeps the computer from sleeping while agents are working (Settings >
// Preferences > Keep awake). Each window reports whether it wants the computer
// kept awake; one power-save blocker is held while any window does, and it is
// released when they all stop, a window goes away, or the app quits.

/**
 * @typedef {{
 *   start: (type: "prevent-app-suspension" | "prevent-display-sleep") => number,
 *   stop: (id: number) => void,
 *   isStarted: (id: number) => boolean,
 * }} PowerSaveBlockerLike
 */

/** @param {{ powerSaveBlocker: PowerSaveBlockerLike }} deps */
export function createKeepAwake({ powerSaveBlocker }) {
  /** @type {Set<number>} */
  const requesters = new Set();
  /** @type {number | null} */
  let blockerId = null;

  function sync() {
    if (requesters.size > 0) {
      if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return;
      // Stops the system sleeping; the display may still dim and lock.
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
      return;
    }
    if (blockerId === null) return;
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }

  return {
    /** @param {number} requesterId @param {boolean} active */
    set(requesterId, active) {
      if (active) requesters.add(requesterId);
      else requesters.delete(requesterId);
      sync();
      return { active: blockerId !== null };
    },
    /** @param {number} requesterId */
    forget(requesterId) {
      requesters.delete(requesterId);
      sync();
    },
    releaseAll() {
      requesters.clear();
      sync();
    },
    isActive() {
      return blockerId !== null;
    },
  };
}
