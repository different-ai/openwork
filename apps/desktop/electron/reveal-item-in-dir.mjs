import path from "node:path";

function openPathResult(error) {
  return error && error.trim() ? error : undefined;
}

/**
 * Reveal `rawTarget` in the OS file manager.
 *
 * Extracted from main.mjs so the branching is unit-testable via injected deps.
 * Behavior is intentionally identical on every platform: `shell.showItemInFolder`
 * is the cross-platform API and, unlike opening the parent directory, it selects
 * the item. It returns `void`, so a failure there is not detectable — that is a
 * limitation of Electron, and degrading the working case to work around it would
 * lose item selection for every user. The failure this can report is the one that
 * actually bites: a `target` the main process cannot see on disk (skill paths are
 * produced by the server, so they can diverge from the client filesystem).
 */
export async function revealItemInDir(rawTarget, deps) {
  const target = String(rawTarget ?? "").trim();
  if (!target) return "Path is required.";

  if (deps.existsSync(target)) {
    deps.showItemInFolder(target);
    return undefined;
  }

  // The exact file may not exist yet (or the path is slightly off); fall back to
  // opening the containing directory so the user still lands in the right place.
  // `openPath` returns an error string, so this branch is reportable.
  const parent = (deps.platform === "win32" ? path.win32 : path).dirname(target);
  if (parent && parent !== target && deps.existsSync(parent)) {
    return openPathResult(await deps.openPath(parent));
  }
  return `Could not find "${target}" on disk.`;
}
