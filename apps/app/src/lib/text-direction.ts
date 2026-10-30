const RTL_CHARACTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHARACTER = /[A-Za-z]/;

export type TextDirection = "rtl" | "ltr";

/**
 * The direction of a run of text, decided by the dominant script rather than
 * the first strong character: a Persian sentence that opens with an English
 * word ("OpenWork یک برنامه است") is still right-to-left.
 *
 * Counts strong letters only (Latin vs Persian/Arabic); digits,
 * punctuation and emoji are neutral. Ties favour right-to-left. Returns null
 * when the text has no strong letters, so callers can inherit instead.
 */
export function textDirectionOf(text: string): TextDirection | null {
  let rtl = 0;
  let ltr = 0;
  for (const character of text) {
    if (RTL_CHARACTER.test(character)) rtl += 1;
    else if (LTR_CHARACTER.test(character)) ltr += 1;
  }
  if (rtl === 0 && ltr === 0) return null;
  return rtl >= ltr ? "rtl" : "ltr";
}

/** Blocks that hold their own paragraph/direction, and inline runs that never do. */
const DIRECTION_BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, td, th";
const DIRECTION_ISOLATED_SELECTOR = "pre, code, kbd, samp, .katex";

/**
 * Give a rendered message its direction from the text itself. The root takes
 * the whole message's direction; each block overrides it with its own, and a
 * neutral block (numbers, punctuation only) is left to inherit the root. Code
 * and math are skipped, so they stay left-to-right.
 */
export function applyBlockDirection(root: HTMLElement, text = ""): void {
  root.setAttribute("dir", textDirectionOf(text) ?? "ltr");

  for (const block of root.querySelectorAll<HTMLElement>(DIRECTION_BLOCK_SELECTOR)) {
    if (block.closest(DIRECTION_ISOLATED_SELECTOR)) continue;
    const direction = textDirectionOf(block.textContent ?? "");
    if (direction) block.setAttribute("dir", direction);
    else block.removeAttribute("dir");
  }
}
