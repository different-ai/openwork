import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  checkContrast,
  checkLaneDrift,
  checkLayout,
  checkOverlap,
  checkSplitRows,
  contrastRatio,
  critiquePrompt,
  loadDesignRubric,
  parseCritique,
} from "./index.ts";
import type { LayoutBox, LayoutSnapshot } from "./layout.ts";

function box(text: string, x: number, y: number, width: number, extra: Partial<LayoutBox> = {}): LayoutBox {
  return {
    text, x, y, width, height: 16, fontSize: 13, fontWeight: 400,
    color: "rgb(17, 24, 39)", background: "rgb(255, 255, 255)", opacity: 1,
    interactive: false, controlWidth: 0, disabled: false, clipped: false, anchor: "", classes: "", ...extra,
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

test("a note names the code hooks of the rows it is about, so an agent can find the component", () => {
  const hooked = layout(libraryBefore.boxes.map((entry, index) => ({
    ...entry, anchor: `[data-library-row="item-${Math.floor(index / 4)}"]`, classes: index % 4 === 2 ? "w-[84px] text-xs" : "truncate text-[13px]",
  })));
  const [note] = checkSplitRows(hooked);
  expect(note?.anchors).toEqual(['[data-library-row="item-0"]', '[data-library-row="item-1"]', '[data-library-row="item-2"]']);
  expect(note?.classes).toEqual(["truncate text-[13px]", "w-[84px] text-xs"]);
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

test("hostile colours and model replies are parsed in linear time", () => {
  const started = performance.now();
  expect(contrastRatio({ color: `rgb(${"rgb((".repeat(50_000)}`, background: "rgb(255, 255, 255)", opacity: 1 })).toBeNull();
  expect(contrastRatio({ color: "color(srgb 1 0 0)", background: "rgb(255, 255, 255)", opacity: 1 })).toBeNull();
  expect(() => parseCritique(`\`\`\`${"\t".repeat(50_000)}`)).toThrow("Design review response was not valid JSON");
  expect(parseCritique("```json\n{\"findings\":[]}\n```")).toEqual([]);
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("the committed rubric names every plugin skill it packs", async () => {
  const rubric = await readFile(new URL("../../../design-review/rubric.md", import.meta.url), "utf8");
  for (const skill of ["openwork-paper-design", "paper-design-consistency-audit", "openwork-ui-source-map", "rams", "web-design-guidelines", "better-ui", "impeccable", "interface-design"]) {
    expect(rubric).toContain(`\`${skill}\``);
  }
});
