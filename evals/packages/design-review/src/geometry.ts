import type { LayoutBox, LayoutSnapshot } from "./layout.ts";
import { clampRegion, type DesignNote, type DesignRegion } from "./notes.ts";

/**
 * Measured design rules. Each one answers a question pixels cannot answer
 * exactly (does this text overlap that text, how wide is this gap, do these
 * starts line up) and stays quiet when the layout is a known good pattern.
 */

interface Rect { x: number; y: number; width: number; height: number }

const quote = (text: string) => `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
const right = (box: Rect) => box.x + box.width;
const bottom = (box: Rect) => box.y + box.height;
const centerY = (box: Rect) => box.y + box.height / 2;

function union(boxes: Rect[]): Rect {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return { x, y, width: Math.max(...boxes.map(right)) - x, height: Math.max(...boxes.map(bottom)) - y };
}

function region(layout: LayoutSnapshot, rect: Rect, pad = 4): DesignRegion | undefined {
  return clampRegion({
    x: (rect.x - pad) / layout.viewport.width,
    y: (rect.y - pad) / layout.viewport.height,
    width: (rect.width + pad * 2) / layout.viewport.width,
    height: (rect.height + pad * 2) / layout.viewport.height,
  });
}

function withRegion(note: Omit<DesignNote, "region">, rect: DesignRegion | undefined): DesignNote {
  return rect ? { ...note, region: rect } : note;
}

/** The code hooks of the boxes a note is about, most common first, so an agent can find the component. */
export function hooksOf(boxes: LayoutBox[]): Pick<DesignNote, "anchors" | "classes"> {
  const ranked = (values: string[]) => [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, 3);
  const anchors = ranked(boxes.map((box) => box.anchor).filter(Boolean));
  const classes = ranked(boxes.map((box) => box.classes).filter(Boolean));
  return { ...(anchors.length ? { anchors } : {}), ...(classes.length ? { classes } : {}) };
}

/** Text drawn on top of other text is never intended. */
export function checkOverlap(layout: LayoutSnapshot): DesignNote[] {
  const boxes = layout.boxes.filter((box) => box.opacity >= 0.3);
  const pairs: [LayoutBox, LayoutBox][] = [];
  for (let first = 0; first < boxes.length; first += 1) {
    const a = boxes[first];
    if (!a) continue;
    for (let second = first + 1; second < boxes.length; second += 1) {
      const b = boxes[second];
      if (!b) continue;
      const width = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
      const height = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
      if (width <= 1 || height <= 1) continue;
      const smaller = Math.min(a.width * a.height, b.width * b.height);
      if (smaller > 0 && (width * height) / smaller >= 0.3) pairs.push([a, b]);
    }
  }
  return pairs.slice(0, 3).map(([a, b]) => withRegion({
    rule: "layout.overlap",
    severity: "medium",
    title: "Text overlaps other text",
    detail: `${quote(a.text)} is drawn over ${quote(b.text)}.`,
    source: "layout",
    ...hooksOf([a, b]),
  }, region(layout, union([a, b]))));
}

/** A screen that scrolls sideways hides content at the window edge. */
export function checkHorizontalScroll(layout: LayoutSnapshot): DesignNote[] {
  const overflow = layout.document.width - layout.viewport.width;
  if (overflow <= 1) return [];
  const beyond = layout.boxes.filter((box) => right(box) > layout.viewport.width + 1 && !box.clipped);
  return [withRegion({
    rule: "layout.horizontal-scroll",
    severity: "medium",
    title: "The page is wider than the window",
    detail: `The document is ${Math.round(layout.document.width)}px wide in a ${layout.viewport.width}px window${beyond.length ? `; ${beyond.slice(0, 3).map((box) => quote(box.text)).join(", ")} run past the edge` : ""}.`,
    source: "layout",
    ...hooksOf(beyond),
  }, region(layout, { x: layout.viewport.width - 24, y: 0, width: 24, height: layout.viewport.height }, 0))];
}

/**
 * One-line boxes grouped by their vertical centre: the rows a reader scans.
 * Labels of small controls (buttons, chips, links) are left out so a label on
 * the left and a button on the right is not mistaken for a row of values; a
 * row that is itself one wide button still counts as a row.
 */
export function textRows(boxes: LayoutBox[], viewportWidth: number): LayoutBox[][] {
  const lines = boxes
    .filter((box) => box.opacity >= 0.2 && box.height <= 48 && (!box.interactive || box.controlWidth >= viewportWidth * 0.4))
    .sort((a, b) => centerY(a) - centerY(b) || a.x - b.x);
  const rows: LayoutBox[][] = [];
  for (const box of lines) {
    const row = rows.at(-1);
    const anchor = row?.[0];
    if (row && anchor && Math.abs(centerY(box) - centerY(anchor)) <= 3) row.push(box);
    else rows.push([box]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

interface SplitRow { row: LayoutBox[]; gap: number; at: number }

/**
 * Rows whose data columns are pushed to the far edge, leaving a hole between
 * a row's name and the values that describe it. A label on the left and one
 * state or action on the right (DESIGN.md S2) is not this: the right side
 * must hold at least two values, and the hole must dwarf the gaps between them.
 */
export function checkSplitRows(layout: LayoutSnapshot): DesignNote[] {
  const minimumGap = Math.max(240, layout.viewport.width * 0.2);
  const split: SplitRow[] = [];
  for (const row of textRows(layout.boxes, layout.viewport.width)) {
    if (row.length < 3) continue;
    let gap = 0;
    let at = -1;
    for (let index = 0; index < row.length - 1; index += 1) {
      const current = row[index];
      const next = row[index + 1];
      if (!current || !next) continue;
      const space = next.x - right(current);
      if (space > gap) {
        gap = space;
        at = index;
      }
    }
    const rightGroup = row.slice(at + 1);
    if (at < 0 || rightGroup.length < 2 || gap < minimumGap) continue;
    let innerGap = 0;
    for (let index = 0; index < rightGroup.length - 1; index += 1) {
      const current = rightGroup[index];
      const next = rightGroup[index + 1];
      if (current && next) innerGap = Math.max(innerGap, next.x - right(current));
    }
    if (gap < 2.5 * Math.max(innerGap, 24)) continue;
    split.push({ row, gap, at });
  }
  // One stray row is a coincidence; a repeated pattern is a layout.
  const byStart = new Map<number, SplitRow[]>();
  for (const entry of split) {
    const start = entry.row[entry.at + 1]?.x ?? 0;
    const key = [...byStart.keys()].find((existing) => Math.abs(existing - start) <= 4) ?? start;
    byStart.set(key, [...(byStart.get(key) ?? []), entry]);
  }
  const notes: DesignNote[] = [];
  for (const entries of byStart.values()) {
    if (entries.length < 3) continue;
    const gaps = entries.map((entry) => Math.round(entry.gap));
    const sample = entries[0];
    const before = sample?.row[sample.at];
    const after = sample?.row[sample.at + 1];
    if (!sample || !before || !after) continue;
    const holes = entries.flatMap((entry) => {
      const left = entry.row[entry.at];
      const next = entry.row[entry.at + 1];
      return left && next ? [{ x: right(left), y: Math.min(left.y, next.y), width: next.x - right(left), height: Math.max(left.height, next.height) }] : [];
    });
    notes.push(withRegion({
      rule: "layout.split-row",
      severity: "medium",
      title: "Columns drift away from their rows",
      detail: `${entries.length} rows leave a ${Math.min(...gaps)}–${Math.max(...gaps)}px hole between the row's text and its other values, e.g. ${quote(before.text)} … ${quote(after.text)}. Keep related values next to each other and let the longest text take the remaining width.`,
      source: "layout",
      ...hooksOf(entries.flatMap((entry) => entry.row)),
    }, region(layout, union(holes), 0)));
  }
  return notes;
}

/** Repeated rows whose columns start a few pixels apart: close enough to look like a mistake. */
export function checkLaneDrift(layout: LayoutSnapshot): DesignNote[] {
  const groups = new Map<string, LayoutBox[][]>();
  for (const row of textRows(layout.boxes, layout.viewport.width)) {
    const first = row[0];
    if (row.length < 3 || !first) continue;
    const key = `${row.length}:${Math.round(first.x / 4)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const notes: DesignNote[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 4) continue;
    const columns = rows[0]?.length ?? 0;
    for (let column = 1; column < columns; column += 1) {
      const cells = rows.flatMap((row) => {
        const cell = row[column];
        return cell ? [cell] : [];
      });
      const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
      const starts = spread(cells.map((cell) => cell.x));
      const ends = spread(cells.map(right));
      const middles = spread(cells.map((cell) => cell.x + cell.width / 2));
      if (starts < 1.5 || starts > 8 || ends <= 1.5 || middles <= 1.5) continue;
      notes.push(withRegion({
        rule: "layout.lane-drift",
        severity: "low",
        title: "A column does not start on one line",
        detail: `In ${rows.length} repeated rows, column ${column + 1} (${quote(cells[0]?.text ?? "")}) starts up to ${starts.toFixed(1)}px apart. Use a fixed-width slot so the lane is straight.`,
        source: "layout",
        ...hooksOf(cells),
      }, region(layout, union(cells))));
      if (notes.length >= 2) return notes;
    }
  }
  return notes;
}

function channels(color: string): [number, number, number, number] | null {
  // String slicing, not a regular expression: colours come from arbitrary pages.
  const open = color.indexOf("(");
  const close = color.lastIndexOf(")");
  if (open < 0 || close <= open || !color.slice(0, open).trim().toLowerCase().startsWith("rgb")) return null;
  const parts = color.slice(open + 1, close).split(/[\s,/]+/).filter(Boolean).map((part) => Number.parseFloat(part));
  const [red, green, blue, alpha = 1] = parts;
  if (red === undefined || green === undefined || blue === undefined || [red, green, blue, alpha].some((value) => !Number.isFinite(value))) return null;
  return [red, green, blue, alpha];
}

function luminance([red, green, blue]: [number, number, number]): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** WCAG contrast of a box's text over its background, counting transparency. */
export function contrastRatio(box: Pick<LayoutBox, "color" | "background" | "opacity">): number | null {
  const text = channels(box.color);
  const ground = channels(box.background);
  if (!text || !ground) return null;
  const alpha = text[3] * box.opacity;
  const mix = (index: 0 | 1 | 2) => text[index] * alpha + ground[index] * (1 - alpha);
  const blended: [number, number, number] = [mix(0), mix(1), mix(2)];
  const [lighter, darker] = [luminance(blended), luminance([ground[0], ground[1], ground[2]])].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Text a person cannot read at a glance. Disabled controls are exempt (WCAG 1.4.3). */
export function checkContrast(layout: LayoutSnapshot): DesignNote[] {
  const faint = layout.boxes.flatMap((box) => {
    if (box.disabled || box.fontSize < 11) return [];
    const ratio = contrastRatio(box);
    return ratio !== null && ratio < 3 ? [{ box, ratio }] : [];
  });
  if (faint.length === 0) return [];
  return [withRegion({
    rule: "layout.contrast",
    severity: "medium",
    title: "Text is too faint to read",
    detail: `${faint.length} text ${faint.length === 1 ? "item has" : "items have"} contrast under 3:1, e.g. ${faint.slice(0, 3).map(({ box, ratio }) => `${quote(box.text)} at ${ratio.toFixed(1)}:1`).join(", ")}.`,
    source: "layout",
    ...hooksOf(faint.map(({ box }) => box)),
  }, region(layout, union(faint.slice(0, 6).map(({ box }) => box))))];
}

/** Below 11px, text stops being readable for most people. */
export function checkTinyText(layout: LayoutSnapshot): DesignNote[] {
  const tiny = layout.boxes.filter((box) => box.fontSize > 0 && box.fontSize < 11 && box.text.length > 2 && box.opacity >= 0.5);
  if (tiny.length === 0) return [];
  return [withRegion({
    rule: "layout.tiny-text",
    severity: "low",
    title: "Text smaller than 11px",
    detail: `${tiny.length} text ${tiny.length === 1 ? "item is" : "items are"} under 11px, e.g. ${tiny.slice(0, 3).map((box) => `${quote(box.text)} at ${box.fontSize}px`).join(", ")}.`,
    source: "layout",
    ...hooksOf(tiny),
  }, region(layout, union(tiny.slice(0, 6))))];
}

export function checkLayout(layout: LayoutSnapshot): DesignNote[] {
  return [
    ...checkOverlap(layout),
    ...checkHorizontalScroll(layout),
    ...checkSplitRows(layout),
    ...checkLaneDrift(layout),
    ...checkContrast(layout),
    ...checkTinyText(layout),
  ];
}
