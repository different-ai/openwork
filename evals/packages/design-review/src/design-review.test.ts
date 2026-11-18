import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
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
import type { AskVision } from "./critique.ts";
import { layoutFileName, type LayoutBox, type LayoutSnapshot } from "./layout.ts";
import { DESIGN_REVIEW_FILE, parseDesignReviewFile } from "./notes.ts";
import { reviewTestRunDesign } from "./review.ts";

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

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function reviewFixture(count: number) {
  const directory = await mkdtemp(join(tmpdir(), "design-review-concurrency-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const artifacts = Array.from({ length: count }, (_, index) => ({
    fileName: `${index}.png`, caption: `capture ${index}`, hash: `image-${index}`, route: `/screen/${index}`,
  }));
  await writeFile(join(directory, "test-run.json"), JSON.stringify({ artifacts, gitSha: "fixture", specFile: "fixture.test.ts" }));
  for (const artifact of artifacts) {
    const index = Number(artifact.fileName.split(".")[0]);
    await writeFile(join(directory, artifact.fileName), String(index));
    // A distinct measured finding on EVERY screenshot, including queued ones.
    await writeFile(join(directory, layoutFileName(artifact.fileName)), JSON.stringify(layout([
      box(`Faint label ${index}`, 10, 10, 100, { color: "rgb(205, 208, 214)" }),
    ])));
  }
  const readReview = async () => {
    const review = parseDesignReviewFile(JSON.parse(await readFile(join(directory, DESIGN_REVIEW_FILE), "utf8")));
    if (!review) throw new Error("Invalid saved review");
    return review;
  };
  return { directory, artifacts, readReview };
}

const testRubric = { text: "Fixture rubric", hash: "fixture" };

function critiqueReply(index: number) {
  return JSON.stringify({ findings: [
    { rule: "S2", severity: "low", title: `Unique critique ${index}`, evidence: `Critique for capture ${index}`, where: null },
    { rule: "OW-LIST-HEADER", severity: "medium", title: "Repeated header finding", evidence: 'Header "Shared column" repeats', where: null },
  ] });
}

test("critiques at most three screenshots and checkpoints out-of-order completions in capture order", async () => {
  const { directory, artifacts, readReview } = await reviewFixture(6);
  const gates = artifacts.map(() => deferred<string>());
  const started = artifacts.map(() => deferred<void>());
  const calls: number[] = [];
  let active = 0;
  let peak = 0;
  const ask: AskVision = async ({ png, prompt }) => {
    const index = Number(png.toString());
    const gate = gates[index];
    const signal = started[index];
    if (!gate || !signal) throw new Error("Unexpected screenshot");
    expect(prompt).toContain(`Faint label ${index}`);
    calls.push(index);
    active += 1;
    peak = Math.max(peak, active);
    signal.resolve();
    try { return await gate.promise; } finally { active -= 1; }
  };
  const running = reviewTestRunDesign(directory, { vision: { ask, model: "fixture" }, rubric: testRubric, bypassCache: true, checkpoint: true });
  try {
    await Promise.all(started.slice(0, 3).map((entry) => entry.promise));
    expect(active).toBe(3);
    expect(calls.toSorted()).toEqual([0, 1, 2]);
    const initial = await readReview();
    expect(Object.keys(initial.notes)).toEqual(artifacts.map((artifact) => artifact.fileName));
    expect(initial.errors).toEqual(artifacts.map((artifact) => `${artifact.caption}: advisory critique not completed`));
    for (const entries of Object.values(initial.notes)) expect(entries.map((entry) => entry.rule)).toEqual(["layout.contrast"]);

    gates[1]?.resolve(critiqueReply(1));
    // A worker only starts its next critique AFTER the completed one is durable.
    await started[3]?.promise;
    const partial = await readReview();
    expect(Object.keys(partial.screens)).toEqual(artifacts.map((artifact) => artifact.fileName));
    expect(Object.keys(partial.notes)).toEqual(artifacts.map((artifact) => artifact.fileName));
    expect(partial.notes["1.png"]?.map((note) => note.rule)).toEqual(["layout.contrast", "OW-LIST-HEADER", "S2"]);
    expect(partial.errors).toEqual([0, 2, 3, 4, 5].map((index) => `capture ${index}: advisory critique not completed`));
    // The other five critiques remain blocked: disk already contains all layout
    // measurements plus capture 1's finished critique if the process dies now.
    expect(active).toBe(3);
    gates[2]?.resolve(critiqueReply(2));
    await started[4]?.promise;
    gates[0]?.resolve(critiqueReply(0));
    await started[5]?.promise;
    // Simultaneous completions exercise the serialized atomic-save queue.
    for (const index of [5, 4, 3]) gates[index]?.resolve(critiqueReply(index));
    const result = await running;
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(calls.toSorted()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.notes)).toEqual(artifacts.map((artifact) => artifact.fileName));
    for (let index = 0; index < artifacts.length; index += 1) {
      const entries = result.notes[`${index}.png`] ?? [];
      expect(entries.filter((entry) => entry.source === "layout")).toHaveLength(1);
      expect(entries.find((entry) => entry.rule === "S2")?.title).toBe(`Unique critique ${index}`);
    }
    const repeat = result.notes["0.png"]?.find((entry) => entry.rule === "OW-LIST-HEADER");
    expect(repeat?.detail).toBe('Header "Shared column" repeats Also on 5 later screenshots.');
    expect(Object.values(result.notes).flat().filter((entry) => entry.rule === "OW-LIST-HEADER")).toHaveLength(1);
    expect(await readReview()).toEqual(result);
  } finally {
    gates.forEach((gate, index) => gate.resolve(critiqueReply(index)));
    await running;
  }
});

test("critique failures preserve measurements, checkpoint errors, and do not abandon later screenshots", async () => {
  const { directory, artifacts, readReview } = await reviewFixture(6);
  // Missing images are advisory errors too, not a reason to omit DOM checks.
  await rm(join(directory, "4.png"));
  const gates = artifacts.map(() => deferred<string>());
  const started = artifacts.map(() => deferred<void>());
  const calls: number[] = [];
  const ask: AskVision = async ({ png }) => {
    const index = Number(png.toString());
    const gate = gates[index];
    if (!gate) throw new Error("Unexpected screenshot");
    calls.push(index);
    started[index]?.resolve();
    const reply = await gate.promise;
    if (index === 1) throw new Error("provider unavailable");
    return reply;
  };
  const running = reviewTestRunDesign(directory, { vision: { ask, model: "fixture" }, rubric: testRubric, bypassCache: true, checkpoint: true });
  try {
    await Promise.all(started.slice(0, 3).map((entry) => entry.promise));
    gates[2]?.resolve("not JSON");
    await started[3]?.promise;
    const partial = await readReview();
    expect(partial.errors[0]).toBe("capture 0: advisory critique not completed");
    expect(partial.errors[1]).toBe("capture 1: advisory critique not completed");
    expect(partial.errors[2]).toContain("capture 2: Design review response was not valid JSON");
    expect(partial.notes["2.png"]?.map((note) => note.rule)).toEqual(["layout.contrast"]);
    gates[1]?.resolve(critiqueReply(1));
    // The same worker records the missing image before advancing to capture 5.
    await started[5]?.promise;
    const failed = await readReview();
    expect(failed.errors[1]).toBe("capture 1: provider unavailable");
    expect(failed.errors[2]).toContain("capture 2: Design review response was not valid JSON");
    expect(failed.errors[4]).toContain("capture 4: ENOENT");
    gates.forEach((gate, index) => gate.resolve(critiqueReply(index)));
    const result = await running;
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toBe("capture 1: provider unavailable");
    expect(result.errors[1]).toContain("capture 2: Design review response was not valid JSON");
    expect(result.errors[2]).toContain("capture 4: ENOENT");
    expect(calls.toSorted()).toEqual([0, 1, 2, 3, 5]);
    for (const entries of Object.values(result.notes)) expect(entries.filter((entry) => entry.source === "layout")).toHaveLength(1);
    for (const index of [0, 3, 5]) expect(result.notes[`${index}.png`]?.some((entry) => entry.rule === "S2")).toBe(true);
    expect(await readReview()).toEqual(result);
  } finally {
    gates.forEach((gate, index) => gate.resolve(critiqueReply(index)));
    await running;
  }
});

test("layout-only and empty reviews need no critique and retain every screenshot", async () => {
  for (const count of [0, 2]) {
    const { directory, artifacts, readReview } = await reviewFixture(count);
    const result = await reviewTestRunDesign(directory, { checkpoint: true });
    expect(result.model).toBeNull();
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.notes)).toEqual(artifacts.map((artifact) => artifact.fileName));
    for (const entries of Object.values(result.notes)) expect(entries.map((entry) => entry.rule)).toEqual(["layout.contrast"]);
    expect(await readReview()).toEqual(result);
  }
});

test("the committed rubric names every plugin skill it packs", async () => {
  const rubric = await readFile(new URL("../../../design-review/rubric.md", import.meta.url), "utf8");
  for (const skill of ["openwork-paper-design", "paper-design-consistency-audit", "openwork-ui-source-map", "rams", "web-design-guidelines", "better-ui", "impeccable", "interface-design"]) {
    expect(rubric).toContain(`\`${skill}\``);
  }
});
