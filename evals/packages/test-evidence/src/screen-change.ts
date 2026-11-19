import { inflateSync } from "node:zlib";

/** A region of a screenshot as fractions of its width and height (0–1), so any renderer can overlay it. */
export interface EvidenceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What differs between a screenshot and the one before it in the same test. */
export interface ScreenChange {
  /** File name of the previous screenshot in this test; null for the first one. */
  since: string | null;
  /** What the person did in between, as traced: `click(text=Advanced options)`. */
  actions: string[];
  /** Share of the image that changed, 0–1. 0 means the same screen again. */
  ratio: number;
  /** Where it changed, largest first. A blinking caret and anti-aliasing are not changes. */
  boxes: EvidenceBox[];
  /** Visible text lines that appeared, and how many in all. */
  added: string[];
  addedCount: number;
  /** Visible text lines that went away, and how many in all. */
  removed: string[];
  removedCount: number;
}

interface Pixels {
  width: number;
  height: number;
  rgb: Uint8Array;
}

interface Bounds {
  count: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
const TEXT_LINES = 6;
const TEXT_LENGTH = 160;

/** Decodes the 8-bit, non-interlaced PNGs CDP writes; null for anything else. */
export function decodePng(buffer: Buffer): Pixels | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  const data: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8] ?? 0;
      color = body[9] ?? -1;
      interlace = body[12] ?? 0;
    } else if (type === "PLTE") palette = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = CHANNELS.get(color);
  if (!channels || depth !== 8 || interlace !== 0 || width === 0 || height === 0 || (color === 3 && !palette)) return null;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(data)); } catch { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels] : 0;
      let value = raw[line + x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      pixels[out + x] = value & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    if (palette) {
      const entry = pixels[source] * 3;
      rgb[index * 3] = palette[entry] ?? 0;
      rgb[index * 3 + 1] = palette[entry + 1] ?? 0;
      rgb[index * 3 + 2] = palette[entry + 2] ?? 0;
    } else if (channels <= 2) {
      rgb[index * 3] = pixels[source];
      rgb[index * 3 + 1] = pixels[source];
      rgb[index * 3 + 2] = pixels[source];
    } else {
      rgb[index * 3] = pixels[source];
      rgb[index * 3 + 1] = pixels[source + 1];
      rgb[index * 3 + 2] = pixels[source + 2];
    }
  }
  return { width, height, rgb };
}

/** A blinking caret: a changed sliver at most 3 px thick and 48 px long. */
function caretLike(bounds: Bounds): boolean {
  const width = bounds.x1 - bounds.x0 + 1;
  const height = bounds.y1 - bounds.y0 + 1;
  return (width <= 3 && height <= 48) || (height <= 3 && width <= 48);
}

function fraction(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Regions that differ between two screenshots. A pixel differs when a channel
 * moves more than `tolerance`; changed pixels group on an 8 px grid, groups up
 * to two cells apart merge (so one changed line of text is one region), and
 * caret-sized slivers drop out. A resized screen counts as changed everywhere.
 */
export function diffPixels(before: Pixels, after: Pixels, tolerance = 24, maxBoxes = 4): { ratio: number; boxes: EvidenceBox[] } {
  const { width, height } = after;
  if (before.width !== width || before.height !== height) return { ratio: 1, boxes: [{ x: 0, y: 0, width: 1, height: 1 }] };
  const cell = 8;
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cells = new Map<number, Bounds>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      if (Math.abs(before.rgb[index] - after.rgb[index]) <= tolerance
        && Math.abs(before.rgb[index + 1] - after.rgb[index + 1]) <= tolerance
        && Math.abs(before.rgb[index + 2] - after.rgb[index + 2]) <= tolerance) continue;
      const key = Math.floor(y / cell) * columns + Math.floor(x / cell);
      const found = cells.get(key);
      if (found) {
        found.count += 1;
        found.x0 = Math.min(found.x0, x);
        found.x1 = Math.max(found.x1, x);
        found.y0 = Math.min(found.y0, y);
        found.y1 = Math.max(found.y1, y);
      } else cells.set(key, { count: 1, x0: x, x1: x, y0: y, y1: y });
    }
  }
  const seen = new Set<number>();
  const regions: Bounds[] = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const queue = [start];
    const region: Bounds = { count: 0, x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    while (queue.length > 0) {
      const key = queue.pop() ?? 0;
      const found = cells.get(key);
      if (!found) continue;
      region.count += found.count;
      region.x0 = Math.min(region.x0, found.x0);
      region.x1 = Math.max(region.x1, found.x1);
      region.y0 = Math.min(region.y0, found.y0);
      region.y1 = Math.max(region.y1, found.y1);
      const row = Math.floor(key / columns);
      const column = key % columns;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const r = row + dy;
          const c = column + dx;
          if (r < 0 || c < 0 || r >= rows || c >= columns) continue;
          const next = r * columns + c;
          if (cells.has(next) && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    }
    regions.push(region);
  }
  const area = (bounds: Bounds) => (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1);
  const kept = regions.filter((region) => !caretLike(region)).sort((left, right) => area(right) - area(left));
  const merged = kept.slice(0, maxBoxes).map((region) => ({ ...region }));
  const last = merged.at(-1);
  // Fold the rest into the smallest kept region so nothing that changed goes unmarked.
  if (last) {
    for (const region of kept.slice(maxBoxes)) {
      last.x0 = Math.min(last.x0, region.x0);
      last.x1 = Math.max(last.x1, region.x1);
      last.y0 = Math.min(last.y0, region.y0);
      last.y1 = Math.max(last.y1, region.y1);
    }
  }
  const changed = kept.reduce((sum, region) => sum + region.count, 0);
  return {
    ratio: changed / (width * height),
    boxes: merged.map((region) => ({
      x: fraction(region.x0 / width),
      y: fraction(region.y0 / height),
      width: fraction((region.x1 - region.x0 + 1) / width),
      height: fraction((region.y1 - region.y0 + 1) / height),
    })),
  };
}

/** Ticking clocks ("3s", "2 min ago") and initials in avatars change without saying anything. */
const NOISE = /^(?:.{0,2}|\d+(?:\.\d+)?\s?(?:ms|s|sec|m|min|h|hr|d|w|mo|y)(?:\s+ago)?|just now|now)$/i;

function lines(text: string): string[] {
  const unique = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\s+/g, " ").trim();
    if (trimmed && !NOISE.test(trimmed)) unique.add(trimmed.length > TEXT_LENGTH ? `${trimmed.slice(0, TEXT_LENGTH - 1)}…` : trimmed);
  }
  return [...unique];
}

/** Visible text lines that appeared in `after` and went away from `before`. */
export function diffText(before: string, after: string, redact: (line: string) => string = (line) => line) {
  const previous = lines(before);
  const next = lines(after);
  const old = new Set(previous);
  const fresh = new Set(next);
  const added = next.filter((line) => !old.has(line));
  const removed = previous.filter((line) => !fresh.has(line));
  return {
    added: added.slice(0, TEXT_LINES).map(redact),
    addedCount: added.length,
    removed: removed.slice(0, TEXT_LINES).map(redact),
    removedCount: removed.length,
  };
}
