import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewReport } from "@openwork/review";
import { composeSections, designNotesLabel, visualState, type ImageEvidence } from "./sections.ts";

const sha = "b".repeat(40);
const createdAt = "2026-10-21T18:42:00.000Z";
const image = (id: string, sourceId: string, judgments: ImageEvidence["judgments"] = [], designNotes?: ImageEvidence["designNotes"]): ImageEvidence => ({
  kind: "image", id, sourceId, caption: id, asset: `${id}.png`, description: "", judgments, ...(designNotes ? { designNotes } : {}),
});

const report: ReviewReport = {
  schemaVersion: 1, title: "Fixture", gitSha: sha, createdAt, gaps: [],
  sources: [
    { kind: "test-run", id: "ok", name: "ok", gitSha: sha, createdAt, asset: "ok.json", outcome: "passed" },
    { kind: "test-run", id: "bad", name: "bad", gitSha: sha, createdAt, asset: "bad.json", outcome: "failed" },
    { kind: "docshot", id: "doc", name: "doc", gitSha: sha, createdAt, asset: "doc.json" },
  ],
  sections: [
    { id: "ok", title: "Passing run", sourceId: "ok", evidenceIds: ["ok-checks", "ok-shot"] },
    { id: "orphan", title: "Missing source", sourceId: "gone", evidenceIds: [] },
    { id: "bad", title: "Failing run", sourceId: "bad", evidenceIds: ["bad-checks", "missing-evidence"] },
    { id: "doc", title: "Reference", sourceId: "doc", evidenceIds: ["doc-shot"] },
  ],
  evidence: [
    { kind: "assertion", id: "ok-checks", sourceId: "ok", caption: "checks", judgments: [{ expectation: "works", state: "passed", reasoning: "" }] },
    image("ok-shot", "ok", [{ expectation: "looks right", state: "passed", reasoning: "" }]),
    { kind: "assertion", id: "bad-checks", sourceId: "bad", caption: "checks", judgments: [
      { expectation: "first", state: "passed", reasoning: "" }, { expectation: "second", state: "failed", reasoning: "" },
    ] },
    image("doc-shot", "doc"),
  ],
};

test("sections keep report order, number only renderable sections, and split checks from screenshots", () => {
  const sections = composeSections(report);
  assert.deepEqual(sections.map((section) => [section.number, section.id, section.verdict]), [
    [1, "ok", "Passed"], [2, "bad", "Failed"], [3, "doc", "Reference"],
  ]);
  assert.deepEqual(sections[0]?.assertions.map((item) => item.expectation), ["works"]);
  assert.deepEqual(sections[0]?.images.map((item) => item.id), ["ok-shot"]);
  assert.deepEqual(sections[1]?.assertions.map((item) => item.state), ["passed", "failed"]);
  assert.equal(sections[1]?.images.length, 0, "unknown evidence ids are skipped, not rendered as blanks");
  assert.equal(sections[2]?.source.kind, "docshot");
});

test("a screenshot's visual state is its worst judgment, and null when nothing was judged", () => {
  assert.equal(visualState(image("a", "s")), null);
  assert.equal(visualState(image("a", "s", [{ expectation: "x", state: "passed", reasoning: "" }])), "passed");
  assert.equal(visualState(image("a", "s", [{ expectation: "x", state: "passed", reasoning: "" }, { expectation: "y", state: "pending", reasoning: "" }])), "pending");
  assert.equal(visualState(image("a", "s", [{ expectation: "x", state: "pending", reasoning: "" }, { expectation: "y", state: "failed", reasoning: "" }])), "failed");
});

test("design note labels count notes and the ones worth fixing", () => {
  const note = (severity: "medium" | "low") => ({ rule: "V4", severity, title: "t", detail: "d", source: "layout" as const });
  assert.equal(designNotesLabel(image("a", "s")), null);
  assert.equal(designNotesLabel(image("a", "s", [], [note("low")])), "1 design note");
  assert.equal(designNotesLabel(image("a", "s", [], [note("medium"), note("low")])), "2 design notes, 1 worth fixing");
});
