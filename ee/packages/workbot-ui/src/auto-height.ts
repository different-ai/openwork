/**
 * Fits a message box to its text without ever collapsing it on the page.
 *
 * The usual way (height: auto, read scrollHeight, set it back) shrinks the box to one line for a forced layout on
 * every keystroke. The conversation above it is a flex sibling, so for that instant it grows; the browser clamps its
 * scrollTop to the new, smaller maximum, and when the box snaps back the conversation is left a line or more short of
 * the bottom. The next render scrolls it back: the messages jitter as the person types. Measuring an invisible copy
 * instead leaves the page's layout untouched, and the box only changes height when the text gains or loses a line.
 */
export function measureTextareaHeight(node: HTMLTextAreaElement, max: number) {
  const parent = node.parentElement;
  if (!parent) return null;
  const copy = node.cloneNode(false);
  if (!(copy instanceof HTMLTextAreaElement)) return null;
  copy.removeAttribute("id");
  copy.removeAttribute("name");
  copy.removeAttribute("autofocus");
  copy.setAttribute("aria-hidden", "true");
  copy.tabIndex = -1;
  copy.value = node.value;
  const style = copy.style;
  style.position = "absolute";
  style.visibility = "hidden";
  style.pointerEvents = "none";
  style.top = "0";
  style.left = "0";
  style.flex = "none";
  style.width = `${node.getBoundingClientRect().width}px`;
  style.height = "0";
  style.maxHeight = "none";
  style.overflow = "hidden";
  parent.appendChild(copy);
  const height = copy.scrollHeight;
  copy.remove();
  return Math.min(height, max);
}

/** Sets the box's height only when its line count changed, so typing within a line never touches layout. */
export function fitTextarea(node: HTMLTextAreaElement, max: number) {
  const height = measureTextareaHeight(node, max);
  if (height === null) return;
  const next = `${height}px`;
  if (node.style.height !== next) node.style.height = next;
}
