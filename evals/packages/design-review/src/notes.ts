/** A finding about how a screenshot looks. Advisory: it never changes a test verdict. */
export type DesignSeverity = "medium" | "low";

/** Where on the screenshot, as fractions of its width and height (0–1). */
export interface DesignRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignNote {
  /** A DESIGN.md id (S2, V2…), an OpenWork Design pack id (OW-LIST…), or a measured rule (layout.overlap…). */
  rule: string;
  severity: DesignSeverity;
  /** What is wrong, in a few words. */
  title: string;
  /** What was seen or measured, with on-screen text quoted. */
  detail: string;
  /** "layout": measured from the DOM boxes. "vision": judged from the pixels against the rubric. */
  source: "layout" | "vision";
  region?: DesignRegion;
  /** Where in the code: DOM hooks of the boxes involved, e.g. `[data-library-row="docs-helper"]`. */
  anchors?: string[];
  /** Class lists of the boxes involved: grep targets when no hook exists. */
  classes?: string[];
}

export const DESIGN_REVIEW_FILE = "design-review.json";

export interface DesignReviewFile {
  schemaVersion: 1;
  gitSha: string | null;
  reviewedAt: string;
  /** Vision model, or null when only the layout rules ran. */
  model: string | null;
  /** Short hash of the rubric the vision pass used. */
  rubric: string | null;
  /** Repository-relative spec that recorded the screenshots, when known. */
  specFile: string | null;
  /** What each screenshot shows: its caption (the spec step) and route. */
  screens: Record<string, { caption: string; route: string }>;
  /** Notes per screenshot file name in the same test-run directory. */
  notes: Record<string, DesignNote[]>;
  errors: string[];
}

/** The commands that reproduce a spec's design review on a laptop. */
export function reproCommand(specFile: string | null): string {
  const slug = specFile?.split("/").pop()?.replace(/\.e2e\.test\.ts$/, "").replace(/\.test\.ts$/, "");
  return slug
    ? `pnpm evals:e2e ${slug} --local && pnpm --dir evals design:review -- --test-run latest --json`
    : "pnpm --dir evals design:review -- --test-run latest --json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function clampRegion(region: DesignRegion): DesignRegion | undefined {
  const x = Math.min(Math.max(region.x, 0), 1);
  const y = Math.min(Math.max(region.y, 0), 1);
  const width = Math.min(Math.max(region.width, 0), 1 - x);
  const height = Math.min(Math.max(region.height, 0), 1 - y);
  if (width <= 0 || height <= 0) return undefined;
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

export function parseDesignNote(value: unknown): DesignNote | null {
  if (
    !isRecord(value)
    || typeof value.rule !== "string" || !value.rule.trim()
    || (value.severity !== "medium" && value.severity !== "low")
    || typeof value.title !== "string" || !value.title.trim()
    || typeof value.detail !== "string"
    || (value.source !== "layout" && value.source !== "vision")
  ) return null;
  const region = isRecord(value.region)
    && fraction(value.region.x) && fraction(value.region.y) && fraction(value.region.width) && fraction(value.region.height)
    ? clampRegion({ x: value.region.x, y: value.region.y, width: value.region.width, height: value.region.height })
    : undefined;
  const strings = (entry: unknown, limit: number) => Array.isArray(entry)
    ? entry.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.slice(0, limit)).slice(0, 3)
    : [];
  const anchors = strings(value.anchors, 200);
  const classes = strings(value.classes, 160);
  return {
    rule: value.rule.trim().slice(0, 40),
    severity: value.severity,
    title: value.title.trim().slice(0, 200),
    detail: value.detail.trim().slice(0, 1_000),
    source: value.source,
    ...(region ? { region } : {}),
    ...(anchors.length ? { anchors } : {}),
    ...(classes.length ? { classes } : {}),
  };
}

export function parseDesignReviewFile(value: unknown): DesignReviewFile | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.notes) || typeof value.reviewedAt !== "string") return null;
  const notes: Record<string, DesignNote[]> = {};
  for (const [fileName, entries] of Object.entries(value.notes)) {
    if (!Array.isArray(entries)) return null;
    const parsed: DesignNote[] = [];
    for (const entry of entries) {
      const note = parseDesignNote(entry);
      if (!note) return null;
      parsed.push(note);
    }
    notes[fileName] = parsed;
  }
  const screens: Record<string, { caption: string; route: string }> = {};
  if (isRecord(value.screens)) {
    for (const [fileName, screen] of Object.entries(value.screens)) {
      if (isRecord(screen) && typeof screen.caption === "string") screens[fileName] = { caption: screen.caption, route: typeof screen.route === "string" ? screen.route : "" };
    }
  }
  return {
    schemaVersion: 1,
    gitSha: typeof value.gitSha === "string" ? value.gitSha : null,
    reviewedAt: value.reviewedAt,
    model: typeof value.model === "string" ? value.model : null,
    rubric: typeof value.rubric === "string" ? value.rubric : null,
    specFile: typeof value.specFile === "string" ? value.specFile : null,
    screens,
    notes,
    errors: Array.isArray(value.errors) ? value.errors.filter((entry): entry is string => typeof entry === "string") : [],
  };
}
