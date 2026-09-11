export type LineBoundaryMove = {
  alter: "move" | "extend";
  backward: boolean;
};

type LineBoundaryKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">;

/**
 * Home / End (optionally with Shift) move or extend the caret to the visual
 * line boundary inside the composer.
 *
 * On macOS Chromium binds the bare keys to `scrollTo{Beginning,End}OfDocument`
 * and only moves the caret when nothing in the scroll chain accepts that
 * scroll; the shell's `body { overscroll-behavior: none }` ends the chain at
 * `body`, so the caret never moved. Any other modifier (Cmd/Ctrl/Alt) keeps the
 * platform's own binding, e.g. Ctrl+Home on Windows for document start.
 */
export function lineBoundaryMoveForKey(event: LineBoundaryKeyEvent): LineBoundaryMove | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key !== "Home" && event.key !== "End") return null;
  return { alter: event.shiftKey ? "extend" : "move", backward: event.key === "Home" };
}
