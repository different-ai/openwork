import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { layoutFileName, parseLayoutSnapshot, type LayoutSnapshot } from "./layout.ts";
import { critiqueScreenshot, loadDesignRubric, type AskVision, type DesignRubric } from "./critique.ts";
import { checkLayout } from "./geometry.ts";
import { DESIGN_REVIEW_FILE, type DesignNote, type DesignReviewFile } from "./notes.ts";

export interface ReviewDesignOptions {
  /** The judged pass: a provider and model. Without it only the measured rules run. */
  vision?: { ask: AskVision; model: string } | null;
  bypassCache?: boolean;
  rubric?: DesignRubric;
}

interface ScreenshotEntry { fileName: string; caption: string; hash: string; route: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function screenshots(record: Record<string, unknown>): ScreenshotEntry[] {
  if (!Array.isArray(record.artifacts)) return [];
  return record.artifacts.flatMap((artifact) => {
    if (
      !isRecord(artifact)
      || typeof artifact.fileName !== "string"
      || !artifact.fileName.endsWith(".png")
      || basename(artifact.fileName) !== artifact.fileName
    ) return [];
    return [{
      fileName: artifact.fileName,
      caption: typeof artifact.caption === "string" ? artifact.caption : artifact.fileName,
      hash: typeof artifact.hash === "string" ? artifact.hash : artifact.fileName,
      route: typeof artifact.route === "string" ? artifact.route : "",
    }];
  });
}

async function readLayout(testRunDir: string, fileName: string): Promise<LayoutSnapshot | null> {
  const raw = await readFile(join(testRunDir, layoutFileName(fileName)), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    return parseLayoutSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

const severityOrder = { medium: 0, low: 1 } as const;

/** On-screen text a note quotes, normalised: “Kind”, "Sync with OpenWork Cloud". */
function quoted(text: string): string[] {
  return [...text.matchAll(/[“"]([^”"]{4,})[”"]/g)].flatMap((match) => {
    let value = (match[1] ?? "").replaceAll("…", "").trim();
    let end = value.length;
    while (end > 0 && ".,;:".includes(value.charAt(end - 1))) end -= 1;
    value = value.slice(0, end).trim().toLowerCase();
    return value ? [value] : [];
  });
}

/**
 * The model is told not to repeat measured findings but sometimes restates
 * one in its own words; a judged note quoting the same on-screen text as a
 * measured note on that screenshot adds nothing.
 */
const sameTopic: Record<string, readonly string[]> = {
  "layout.split-row": ["OW-LIST-LANES", "OW-CRAFT-ALIGN", "OW-CRAFT-SPACE", "OW-CRAFT-FIT"],
  "layout.lane-drift": ["OW-LIST-LANES", "OW-CRAFT-ALIGN", "OW-CONSIST-DENSITY"],
  "layout.overlap": ["OW-CRAFT-FIT", "OW-CRAFT-ALIGN", "OW-CRAFT-SPACE"],
  "layout.horizontal-scroll": ["OW-CRAFT-FIT"],
  "layout.contrast": ["OW-CRAFT-CONTRAST", "V2"],
  "layout.tiny-text": ["V1", "OW-CONSIST-TYPE", "OW-CRAFT-CONTRAST"],
};

/** Share of the smaller region that the two regions have in common. */
function regionOverlap(a: DesignNote["region"], b: DesignNote["region"]): number {
  if (!a || !b) return 0;
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return width > 0 && height > 0 && smaller > 0 ? (width * height) / smaller : 0;
}

function restatesMeasured(note: DesignNote, measured: DesignNote[]): boolean {
  const own = quoted(`${note.title} ${note.detail}`);
  return measured.some((entry) => (sameTopic[entry.rule] ?? []).includes(note.rule)
    && (regionOverlap(note.region, entry.region) >= 0.5
      || quoted(entry.detail).some((text) => own.some((value) => value.startsWith(text) || text.startsWith(value)))));
}

/**
 * A judged note pointing inside an image on screen (a screenshot shown in the
 * review app, an artifact preview) is about what the image depicts, not about
 * this screen; the rubric says so, and this enforces it.
 */
function insideImage(note: DesignNote, layout: LayoutSnapshot | null): boolean {
  if (!note.region || !layout?.images.length) return false;
  const { width: screenWidth, height: screenHeight } = layout.viewport;
  const region = { x: note.region.x * screenWidth, y: note.region.y * screenHeight, width: note.region.width * screenWidth, height: note.region.height * screenHeight };
  const area = region.width * region.height;
  if (area <= 0) return false;
  return layout.images.some((image) => {
    const width = Math.min(region.x + region.width, image.x + image.width) - Math.max(region.x, image.x);
    const height = Math.min(region.y + region.height, image.y + image.height) - Math.max(region.y, image.y);
    return width > 0 && height > 0 && (width * height) / area >= 0.6;
  });
}

/**
 * The same finding on several screenshots (a label already on dev that every
 * step shows) is reported once, on its first screenshot, instead of
 * repeating down the gallery. Measured notes match on their exact text;
 * judged notes match on rule and the on-screen text they quote.
 */
function collapseRepeats(notes: Record<string, DesignNote[]>): void {
  const seen = new Map<string, { note: DesignNote; repeats: number }>();
  for (const [fileName, entries] of Object.entries(notes)) {
    notes[fileName] = entries.filter((note) => {
      const quotes = quoted(`${note.title} ${note.detail}`);
      const key = note.source === "layout"
        ? `${note.rule}\n${note.detail}`
        : `${note.rule}\n${quotes[0] ?? note.title.toLowerCase()}`;
      const first = seen.get(key);
      if (!first) {
        seen.set(key, { note, repeats: 0 });
        return true;
      }
      first.repeats += 1;
      return false;
    });
  }
  for (const { note, repeats } of seen.values()) {
    if (repeats > 0) note.detail = `${note.detail} Also on ${repeats} later ${repeats === 1 ? "screenshot" : "screenshots"}.`;
  }
}

/**
 * Reviews every screenshot in one test run: measured layout rules first, then
 * (with a model key) a critique against the OpenWork design rubric. Writes
 * `design-review.json` beside `test-run.json`. Advisory: it never touches
 * the run's judgments or verdict.
 */
export async function reviewTestRunDesign(testRunDir: string, options: ReviewDesignOptions = {}): Promise<DesignReviewFile> {
  const value: unknown = JSON.parse(await readFile(join(testRunDir, "test-run.json"), "utf8"));
  if (!isRecord(value)) throw new Error(`Invalid test run: ${testRunDir}`);
  const vision = options.vision
    ? { ...options.vision, rubric: options.rubric ?? await loadDesignRubric() }
    : null;
  const notes: Record<string, DesignNote[]> = {};
  const errors: string[] = [];
  for (const shot of screenshots(value)) {
    const layout = await readLayout(testRunDir, shot.fileName);
    const measured = layout ? checkLayout(layout) : [];
    let judged: DesignNote[] = [];
    if (vision) {
      try {
        const png = await readFile(join(testRunDir, shot.fileName));
        judged = await critiqueScreenshot(
          { png, hash: shot.hash, caption: shot.caption, route: shot.route, layout, measured },
          vision.rubric,
          { ask: vision.ask, model: vision.model, bypassCache: options.bypassCache },
        );
      } catch (error) {
        errors.push(`${shot.caption}: ${errorMessage(error)}`);
      }
    }
    notes[shot.fileName] = [...measured, ...judged.filter((note) => !note.rule.startsWith("layout.") && !restatesMeasured(note, measured) && !insideImage(note, layout))]
      .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }
  collapseRepeats(notes);
  const review: DesignReviewFile = {
    schemaVersion: 1,
    gitSha: typeof value.gitSha === "string" ? value.gitSha : null,
    reviewedAt: new Date().toISOString(),
    model: vision?.model ?? null,
    rubric: vision?.rubric.hash ?? null,
    notes,
    errors,
  };
  await writeFile(join(testRunDir, DESIGN_REVIEW_FILE), `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return review;
}

/** Markdown for a job summary or a terminal: one line per note, grouped by screenshot. */
export function renderDesignReview(name: string, review: DesignReviewFile): string {
  const lines = [`### ${name}`];
  const entries = Object.entries(review.notes);
  const total = entries.reduce((count, [, notes]) => count + notes.length, 0);
  lines.push(`${total} design ${total === 1 ? "note" : "notes"} on ${entries.length} ${entries.length === 1 ? "screenshot" : "screenshots"}${review.model ? ` (layout rules + ${review.model}, rubric ${review.rubric})` : " (layout rules only)"}.`);
  for (const [fileName, notes] of entries) {
    if (notes.length === 0) continue;
    lines.push("", `**${fileName}**`);
    for (const note of notes) lines.push(`- ${note.severity} \`${note.rule}\` ${note.title}: ${note.detail}`);
  }
  for (const error of review.errors) lines.push(`- Not reviewed: ${error}`);
  return `${lines.join("\n")}\n`;
}
