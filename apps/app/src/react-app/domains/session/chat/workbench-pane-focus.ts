/**
 * Puts the cursor in a workbench pane's composer once it has mounted (a new
 * side chat renders its composer a few frames after the pane opens). Returns
 * a cancel function.
 */
export function focusPaneComposerSoon(pane: "primary" | "secondary", options: { root?: ParentNode; frames?: number } = {}) {
  const root = options.root ?? document;
  let left = options.frames ?? 30;
  let handle = 0;
  const tick = () => {
    const editor = root.querySelector<HTMLElement>(`[data-workbench-pane="${pane}"] [data-composer-editor][contenteditable="true"]`);
    if (editor) {
      editor.focus({ preventScroll: true });
      return;
    }
    left -= 1;
    if (left > 0) handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(handle);
}
