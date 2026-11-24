/**
 * What a screenshot's page looked like as boxes: every visible line of text
 * with its position, size, colour and background. Design checks read this
 * because a screenshot cannot say exactly where text starts, what overlaps,
 * or how wide a gap is; the DOM can.
 */
export interface LayoutBox {
  /** Collapsed text, at most 80 characters. */
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: number;
  /** Text colour in sRGB, `rgba(r, g, b, a)`, whatever colour space the CSS used. */
  color: string;
  /** First opaque background behind the text in sRGB, `rgb(r, g, b)`; white when none is set. */
  background: string;
  /** Product of the element's and its ancestors' opacity. */
  opacity: number;
  /** Inside a button, link, input or other control. */
  interactive: boolean;
  /** Width of that control, 0 when there is none. A row-sized button is still a row. */
  controlWidth: number;
  /** Inside a disabled or aria-disabled control: dimming is intentional. */
  disabled: boolean;
  /** The text is cut by an overflow container (intentional truncation). */
  clipped: boolean;
  /**
   * Nearest stable hook in the DOM, as a selector an agent can grep for:
   * `[data-library-row="docs-helper"]`, `[aria-label="More for Slack"]`, or "".
   */
  anchor: string;
  /** The text element's own class list (first 160 characters): another grep target. */
  classes: string;
}

export interface LayoutRect { x: number; y: number; width: number; height: number }

export interface LayoutSnapshot {
  version: 1;
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  boxes: LayoutBox[];
  /** Large images, videos and canvases: content showing something else (a screenshot, a preview). */
  images: LayoutRect[];
  /** More text than the box limit was on screen; checks see the first boxes only. */
  truncated: boolean;
}

/** Enough for a dense screen; past this the checks see the first boxes only. */
export const LAYOUT_BOX_LIMIT = 1200;

/**
 * Runs in the page. It must stay self-contained (no imports, no named inner
 * functions) because it is serialized and evaluated over CDP.
 */
export function collectLayout(limit: number): LayoutSnapshot {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const boxes: LayoutBox[] = [];
  let truncated = false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const round = (value: number) => Math.round(value * 10) / 10;
  // Computed colours come back in the authored space (oklab, oklch, color-mix);
  // a 1px canvas converts any of them to sRGB bytes.
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true });
  const srgb = (value: string): [number, number, number, number] | null => {
    if (!paint) return null;
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "rgba(0, 0, 0, 0)";
    paint.fillStyle = value;
    paint.fillRect(0, 0, 1, 1);
    const data = paint.getImageData(0, 0, 1, 1).data;
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
  };
  const isPainted = (element: Element): boolean => {
    // display:contents has no box of its own, but its text can still be painted.
    let boxElement = element;
    while (getComputedStyle(boxElement).display === "contents" && boxElement.parentElement) boxElement = boxElement.parentElement;
    if (typeof boxElement.checkVisibility === "function"
      && !boxElement.checkVisibility({ contentVisibilityAuto: true })) return false;
    // Chromium can retain non-zero Range rects inside closed details. Only its
    // first direct summary stays painted; a nested or second summary does not.
    // Keep this fallback for browsers without checkVisibility, and check every
    // ancestor so an inner summary cannot escape a closed outer disclosure.
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (!current.matches("details:not([open])")) continue;
      const summary = Array.from(current.children).find((child) => child.tagName === "SUMMARY");
      if (!summary?.contains(element)) return false;
    }
    return true;
  };
  textNodes: for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    const element = node.parentElement;
    if (!text || !element) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.visibility === "collapse" || !isPainted(element)) continue;
    let opacity = 1;
    let background = "";
    const clips: DOMRect[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const currentStyle = getComputedStyle(current);
      opacity *= Number.parseFloat(currentStyle.opacity) || 0;
      if (!background) {
        const fill = srgb(currentStyle.backgroundColor);
        if (fill && fill[3] > 0.5) background = `rgb(${fill[0]}, ${fill[1]}, ${fill[2]})`;
      }
      if (current !== element.ownerDocument.documentElement
        && (currentStyle.overflowX !== "visible" || currentStyle.overflowY !== "visible")) clips.push(current.getBoundingClientRect());
    }
    if (opacity < 0.05) continue;
    const control = element.closest("button, a, input, select, textarea, label, [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox]");
    // Nearest attribute a person put there on purpose: data-testid first, then
    // any other data-* that is not UI-library state, then an aria-label.
    let anchor = "";
    for (let current: Element | null = element; current && !anchor; current = current.parentElement) {
      const names = current.getAttributeNames();
      const chosen = names.includes("data-testid")
        ? "data-testid"
        : names.find((name) => name.startsWith("data-")
          && !/^data-(state|side|align|orientation|disabled|highlighted|open|closed|popup-open|pressed|checked|selected|active|focused|hovered|starting-style|ending-style|instant|base-ui.*|slot|radix.*|headlessui.*)$/.test(name));
      if (chosen) {
        const value = (current.getAttribute(chosen) ?? "").slice(0, 60);
        anchor = value ? `[${chosen}="${value}"]` : `[${chosen}]`;
      } else if (current.hasAttribute("aria-label")) {
        anchor = `[aria-label="${(current.getAttribute("aria-label") ?? "").slice(0, 60)}"]`;
      }
    }
    const ink = srgb(style.color);
    const range = document.createRange();
    range.selectNodeContents(node);
    // A wrapped node's bounding rect unions its lines and covers neighbouring
    // inline text that is not overlapped on screen. Measure each real fragment.
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) continue;
      let left = rect.left;
      let top = rect.top;
      let right = rect.right;
      let bottom = rect.bottom;
      let clipped = false;
      for (const clip of clips) {
        if (rect.left < clip.left - 1 || rect.right > clip.right + 1 || rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1) clipped = true;
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
      if (right - left < 1 || bottom - top < 1) continue;
      // Text under a modal, popover or sticky bar is not what the person sees.
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (hit && !element.contains(hit) && !hit.contains(element)) continue;
      if (boxes.length >= limit) {
        truncated = true;
        break textNodes;
      }
      boxes.push({
        text: text.slice(0, 80),
        x: round(left),
        y: round(top),
        width: round(right - left),
        height: round(bottom - top),
        fontSize: Number.parseFloat(style.fontSize) || 0,
        fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
        color: ink ? `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${round(ink[3] * 100) / 100})` : style.color,
        background: background || "rgb(255, 255, 255)",
        opacity: round(opacity),
        interactive: control !== null,
        controlWidth: control ? round(control.getBoundingClientRect().width) : 0,
        disabled: element.closest("[disabled], [aria-disabled=true]") !== null,
        clipped,
        anchor,
        classes: (element.getAttribute("class") ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      });
    }
  }
  const images: LayoutRect[] = [];
  for (const media of Array.from(document.querySelectorAll("img, video, canvas, picture, iframe"))) {
    const rect = media.getBoundingClientRect();
    const width = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
    if (width >= 96 && height >= 96 && getComputedStyle(media).visibility === "visible" && isPainted(media)) {
      images.push({ x: round(Math.max(rect.left, 0)), y: round(Math.max(rect.top, 0)), width: round(width), height: round(height) });
    }
  }
  return {
    version: 1,
    viewport: { width: viewportWidth, height: viewportHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    boxes,
    images: images.slice(0, 50),
    truncated,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBox(value: unknown): LayoutBox | null {
  if (
    !isRecord(value)
    || typeof value.text !== "string"
    || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)
    || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)
    || !isFiniteNumber(value.fontSize) || !isFiniteNumber(value.fontWeight)
    || typeof value.color !== "string" || typeof value.background !== "string"
    || !isFiniteNumber(value.opacity)
    || typeof value.interactive !== "boolean" || typeof value.disabled !== "boolean" || typeof value.clipped !== "boolean"
  ) return null;
  const controlWidth = isFiniteNumber(value.controlWidth) ? value.controlWidth : 0;
  const anchor = typeof value.anchor === "string" ? value.anchor.slice(0, 200) : "";
  const classes = typeof value.classes === "string" ? value.classes.slice(0, 160) : "";
  return {
    text: value.text,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    fontSize: value.fontSize,
    fontWeight: value.fontWeight,
    color: value.color,
    background: value.background,
    opacity: value.opacity,
    interactive: value.interactive,
    controlWidth,
    disabled: value.disabled,
    clipped: value.clipped,
    anchor,
    classes,
  };
}

function parseSize(value: unknown): { width: number; height: number } | null {
  if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) return null;
  return { width: value.width, height: value.height };
}

/** Accepts what came back from the page or a stored sidecar; anything malformed is no layout. */
export function parseLayoutSnapshot(value: unknown): LayoutSnapshot | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.boxes) || typeof value.truncated !== "boolean") return null;
  const viewport = parseSize(value.viewport);
  const documentSize = parseSize(value.document);
  if (!viewport || !documentSize) return null;
  const images: LayoutRect[] = [];
  for (const entry of Array.isArray(value.images) ? value.images : []) {
    if (isRecord(entry) && isFiniteNumber(entry.x) && isFiniteNumber(entry.y) && isFiniteNumber(entry.width) && isFiniteNumber(entry.height)) {
      images.push({ x: entry.x, y: entry.y, width: entry.width, height: entry.height });
    }
  }
  const boxes: LayoutBox[] = [];
  for (const entry of value.boxes) {
    const box = parseBox(entry);
    if (!box) return null;
    boxes.push(box);
  }
  return { version: 1, viewport, document: documentSize, boxes, images, truncated: value.truncated };
}

/** Sidecar next to `NN-caption.png`: `NN-caption.layout.json`. */
export function layoutFileName(screenshotFileName: string): string {
  return screenshotFileName.replace(/\.png$/, ".layout.json");
}
