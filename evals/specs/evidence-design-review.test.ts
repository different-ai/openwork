import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Surface } from "@openwork/cdp";
import {
  checkContrast,
  checkLaneDrift,
  checkLayout,
  checkOverlap,
  checkSplitRows,
  contrastRatio,
  critiquePrompt,
  layoutFileName,
  loadDesignRubric,
  parseCritique,
  reviewTestRunDesign,
  type LayoutBox,
  type LayoutSnapshot,
} from "@openwork/design-review";
import { createTestEvidence, reviewDesign, screenshot, withTestEvidence } from "@openwork/test-evidence";
import { assembleReview, renderReviewComment } from "@openwork/test-artifacts/review";

function box(text: string, x: number, y: number, width: number, extra: Partial<LayoutBox> = {}): LayoutBox {
  return {
    text, x, y, width, height: 16, fontSize: 13, fontWeight: 400,
    color: "rgb(17, 24, 39)", background: "rgb(255, 255, 255)", opacity: 1,
    interactive: false, controlWidth: 0, disabled: false, clipped: false, ...extra,
  };
}

function layout(boxes: LayoutBox[], width = 1920, height = 1080): LayoutSnapshot {
  return { version: 1, viewport: { width, height }, document: { width, height }, boxes, images: [], truncated: false };
}

const descriptions = [
  "Local (runs on this device)",
  "Cloud (sign in with your account)",
  "Tone, words we use and words we avoid in anything customer-facing.",
  "Renames and sorts vendor invoices in a folder by vendor and month.",
  "Drafts the Friday team update from this week's sessions, merged work and calendar.",
  "Web research with source notes and a cited one-page summary.",
];

// The Library as first shipped on a 1920 window: what it does in the middle,
// Kind and From pushed to the far right edge.
const libraryBefore = layout(descriptions.flatMap((text, row) => [
  box(`item-${row}`, 80, 300 + row * 63, 90),
  box(text, 378, 300 + row * 63, text.length * 6.6),
  box(row < 2 ? "Connector" : "Skill", 1462, 300 + row * 63, row < 2 ? 74 : 30),
  box("Local", 1599, 300 + row * 63, 37),
]));

// The fix: short columns first, what it does last.
const libraryAfter = layout(descriptions.flatMap((text, row) => [
  box(`item-${row}`, 296, 280 + row * 53, 90),
  box(row < 2 ? "Connector" : "Skill", 528, 280 + row * 53, row < 2 ? 59 : 24),
  box("Local", 624, 280 + row * 53, 30),
  box(text, 796, 280 + row * 53, text.length * 6),
]));

test("a Library whose columns sit at the far edge is flagged as rows drifting apart", () => {
  const notes = checkSplitRows(libraryBefore);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ rule: "layout.split-row", severity: "medium", source: "layout" });
  expect(notes[0]?.detail).toContain("6 rows leave a");
  expect(notes[0]?.region?.x).toBeGreaterThan(0.2);
});

test("a list whose rows are one wide button is still read as rows; a button beside a label is not a value", () => {
  const asButtons = layout(libraryBefore.boxes.map((entry) => ({ ...entry, interactive: true, controlWidth: 1600 })));
  expect(checkSplitRows(asButtons).map((note) => note.rule)).toEqual(["layout.split-row"]);
  const toolbar = layout([0, 1, 2, 3].flatMap((row) => [
    box(`Setting ${row}`, 260, 200 + row * 44, 120),
    box("Off", 1300, 200 + row * 44, 22),
    box("Change", 1700, 200 + row * 44, 50, { interactive: true, controlWidth: 72 }),
    box("Remove", 1780, 200 + row * 44, 50, { interactive: true, controlWidth: 72 }),
  ]));
  expect(checkSplitRows(toolbar)).toEqual([]);
});

test("the fixed Library, a settings row and a dense table are not flagged", () => {
  expect(checkSplitRows(libraryAfter)).toEqual([]);
  // DESIGN.md S2: label left, one state right.
  const settings = layout([0, 1, 2, 3].flatMap((row) => [box(`Setting ${row}`, 260, 200 + row * 44, 120), box("On", 1700, 200 + row * 44, 18)]));
  expect(checkSplitRows(settings)).toEqual([]);
  // A table with evenly spread columns: the widest gap does not dwarf the others.
  const table = layout([0, 1, 2, 3].flatMap((row) => [
    box(`Plugin ${row}`, 431, 300 + row * 52, 110),
    box("Sales", 790, 300 + row * 52, 34),
    box("Maya Rivera", 1029, 300 + row * 52, 75),
    box("2h ago", 1226, 300 + row * 52, 39),
  ]), 1440, 900);
  expect(checkSplitRows(table)).toEqual([]);
  expect(checkLayout(libraryAfter)).toEqual([]);
});

test("text drawn over other text is flagged; neighbours are not", () => {
  const overlapping = layout([box("Name", 296, 210, 34), box("On this computer", 270, 214, 100), box("Kind", 528, 210, 28)]);
  const notes = checkOverlap(overlapping);
  expect(notes).toHaveLength(1);
  expect(notes[0]?.detail).toContain("“Name” is drawn over “On this computer”");
  expect(checkOverlap(libraryAfter)).toEqual([]);
});

test("faint text is flagged by contrast, disabled controls are exempt", () => {
  expect(contrastRatio({ color: "rgb(17, 24, 39)", background: "rgb(255, 255, 255)", opacity: 1 })).toBeGreaterThan(15);
  const faint = layout([box("Hard to read", 10, 10, 80, { color: "rgb(205, 208, 214)" }), box("Locked", 10, 40, 40, { color: "rgb(205, 208, 214)", disabled: true })]);
  const notes = checkContrast(faint);
  expect(notes).toHaveLength(1);
  expect(notes[0]?.detail).toContain("“Hard to read”");
  expect(notes[0]?.detail).not.toContain("Locked");
});

test("a column that starts a few pixels apart across repeated rows is flagged as lane drift", () => {
  const drifting = layout([0, 1, 2, 3].flatMap((row) => [
    box(`Row ${row}`, 100, 100 + row * 44, 60),
    box("Skill", row % 2 ? 403 : 400, 100 + row * 44, 30),
    box("Local", 500, 100 + row * 44, 30),
  ]));
  const notes = checkLaneDrift(drifting);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ rule: "layout.lane-drift", severity: "low" });
  expect(checkLaneDrift(libraryAfter)).toEqual([]);
});

test("the rubric packs the OpenWork Design rules with DESIGN.md, and the critique is parsed defensively", async () => {
  const rubric = await loadDesignRubric();
  expect(rubric.text).toContain("OW-LIST-HEADER");
  expect(rubric.text).toContain("openwork-paper-design");
  expect(rubric.text).toContain("**S2** Settings and lists are compact rows");
  expect(rubric.hash).toMatch(/^[a-f0-9]{12}$/);
  const prompt = critiquePrompt({ png: Buffer.alloc(0), hash: "h", caption: "after: the Library", route: "#/extensions", layout: libraryBefore, measured: checkSplitRows(libraryBefore) }, rubric);
  expect(prompt).toContain("window 1920×1080");
  expect(prompt).toContain("layout.split-row");
  const notes = parseCritique(JSON.stringify({ findings: [
    { rule: "OW-LIST-HEADER", severity: "high", title: "Column header row on a plain list", evidence: "“Name Kind From What it does” above the rows", where: { x: 0.1, y: 0.2, width: 0.8, height: 0.03 } },
    { rule: "S2", severity: "low", title: "x", evidence: "y", where: null },
    { rule: "", severity: "low", title: "dropped: no rule", evidence: "" },
  ] }));
  expect(notes).toHaveLength(2);
  expect(notes[0]).toMatchObject({ rule: "OW-LIST-HEADER", severity: "medium", source: "vision", region: { x: 0.1, y: 0.2, width: 0.8, height: 0.03 } });
  expect(notes[1]?.region).toBeUndefined();
});

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function surface(page: LayoutSnapshot | "broken"): Surface {
  return { handle: { kind: "chrome", hostKind: "synthetic", name: "unit", cdpUrl: "http://127.0.0.1:1" }, client: {
    close() {}, async send(method, params) {
      if (method === "Page.captureScreenshot") return { data: PNG.toString("base64") };
      if (method === "Runtime.evaluate") {
        const expression = JSON.stringify(params ?? {});
        if (expression.includes("createTreeWalker")) {
          if (page === "broken") throw new Error("layout unavailable");
          return { result: { value: page } };
        }
        return { result: { value: { route: "#/extensions", visibleText: "Library" } } };
      }
      return {};
    },
  } };
}

test("every screenshot keeps its layout beside it, and a page that cannot report one still gets its screenshot", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "design-layout-"));
  try {
    const evidence = createTestEvidence({ name: "layout capture", outDir });
    await withTestEvidence(evidence, async () => {
      const first = await screenshot(surface(libraryBefore), { caption: "before: the Library" });
      expect(first.layout?.boxes).toHaveLength(libraryBefore.boxes.length);
      const second = await screenshot(surface("broken"), { caption: "a page without layout" });
      expect(second.layout).toBeUndefined();
    });
    await evidence.close();
    const record = JSON.parse(await readFile(join(outDir, "test-run.json"), "utf8"));
    const [withLayout, withoutLayout] = record.artifacts;
    expect(JSON.parse(await readFile(join(outDir, layoutFileName(withLayout.fileName)), "utf8")).boxes).toHaveLength(libraryBefore.boxes.length);
    await expect(readFile(join(outDir, layoutFileName(withoutLayout.fileName)), "utf8")).rejects.toThrow();
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("the design review writes advisory notes per screenshot and the report shows them without changing the verdict", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "design-review-"));
  try {
    const evidence = createTestEvidence({ name: "a member reads the Library", outDir });
    await withTestEvidence(evidence, async () => {
      await screenshot(surface(libraryBefore), { caption: "before: the Library on a wide window" });
      evidence.recordAssertionEvidence("the Library lists every item", "8 rows", true);
    });
    evidence.setOutcome("passed");
    await evidence.close();
    const prompts: string[] = [];
    const review = await reviewTestRunDesign(outDir, {
      vision: { model: "unit-model", ask: async ({ prompt }) => {
        prompts.push(prompt);
        return JSON.stringify({ findings: [
          { rule: "OW-LIST-HEADER", severity: "medium", title: "Column header row on a plain list", evidence: "“Name”, “Kind” and “From” label the columns", where: { x: 0.04, y: 0.2, width: 0.9, height: 0.03 } },
          // Restates the measured split-row note (same topic, same quoted text): dropped.
          { rule: "OW-LIST-LANES", severity: "medium", title: "Kind and From float at the far edge", evidence: "“Connector” sits 1000px from “item-0”" },
          { rule: "layout.split-row", severity: "medium", title: "a model may not claim a measured rule", evidence: "dropped" },
        ] });
      } },
      bypassCache: true,
    });
    const [fileName] = Object.keys(review.notes);
    expect(fileName).toMatch(/\.png$/);
    const notes = review.notes[fileName ?? ""] ?? [];
    expect(notes.map((note) => `${note.source}:${note.rule}`)).toEqual(["layout:layout.split-row", "vision:OW-LIST-HEADER"]);
    expect(prompts[0]).toContain("OW-REJECT-TINT");
    expect(review).toMatchObject({ model: "unit-model", errors: [] });
    expect(JSON.parse(await readFile(join(outDir, "design-review.json"), "utf8")).notes[fileName ?? ""]).toHaveLength(2);

    // Layout rules alone run without a model key.
    const measuredOnly = await reviewDesign(outDir, { vision: false });
    expect(measuredOnly.model).toBeNull();
    expect(measuredOnly.notes[fileName ?? ""]?.map((note) => note.rule)).toEqual(["layout.split-row"]);

    await writeFile(join(outDir, "design-review.json"), `${JSON.stringify(review)}\n`);
    const { report } = await assembleReview({ testRunDirs: [outDir] });
    const image = report.evidence.find((item) => item.kind === "image");
    expect(image?.kind === "image" ? image.designNotes?.map((note) => note.rule) : []).toEqual(["layout.split-row", "OW-LIST-HEADER"]);
    const comment = renderReviewComment(report);
    expect(comment).toContain("Selected evidence: **Passed**");
    expect(comment).toContain("Design review (advisory): 2 note(s), 2 worth fixing before merge.");

    // Notes recorded for another commit are ignored.
    await writeFile(join(outDir, "design-review.json"), `${JSON.stringify({ ...review, gitSha: "0".repeat(40) })}\n`);
    const stale = await assembleReview({ testRunDirs: [outDir] });
    const staleImage = stale.report.evidence.find((item) => item.kind === "image");
    expect(staleImage?.kind === "image" ? staleImage.designNotes : undefined).toBeUndefined();
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("a judged note about what an on-screen image depicts is dropped; a note about the screen itself is kept", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "design-review-image-"));
  try {
    const viewer = { ...layout([box("Library on a wide window", 40, 40, 300)], 1440, 1000), images: [{ x: 36, y: 98, width: 1068, height: 600 }] };
    const evidence = createTestEvidence({ name: "a reviewer opens a screenshot", outDir });
    await withTestEvidence(evidence, () => screenshot(surface(viewer), { caption: "the viewer shows a screenshot" }));
    await evidence.close();
    const review = await reviewTestRunDesign(outDir, {
      bypassCache: true,
      vision: { model: "unit-model", ask: async ({ prompt }) => {
        expect(prompt).toContain("Images on screen (content; never judge what they depict): x 36, y 98, 1068×600px.");
        return JSON.stringify({ findings: [
          { rule: "OW-LIST-LANES", severity: "medium", title: "Rows inside the screenshot drift", evidence: "inside the image", where: { x: 0.2, y: 0.2, width: 0.4, height: 0.2 } },
          { rule: "OW-REJECT-TINT", severity: "medium", title: "Verdict uses a tinted panel", evidence: "a pale green panel", where: { x: 0.02, y: 0.01, width: 0.6, height: 0.08 } },
        ] });
      } },
    });
    expect(Object.values(review.notes).flat().map((note) => note.rule)).toEqual(["OW-REJECT-TINT"]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("the committed rubric names every plugin skill it packs", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const rubric = await readFile(join(root, "evals", "design-review", "rubric.md"), "utf8");
  for (const skill of ["openwork-paper-design", "paper-design-consistency-audit", "openwork-ui-source-map", "rams", "web-design-guidelines", "better-ui", "impeccable", "interface-design"]) {
    expect(rubric).toContain(`\`${skill}\``);
  }
});
