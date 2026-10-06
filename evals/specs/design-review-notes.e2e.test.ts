import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { designReviewWorld } from "../worlds/design-review.ts";

const test = spec.world(designReviewWorld, {
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { placement: "local", commands: ["git"] },
});

test("a reviewer sees what is off in a PR screenshot before merging, and a clean screen gets no design notes", async ({ world, user, probe, step, evidence }) => {
  const [apart, together] = world.captured;
  if (!apart || !together) throw new Error("The world captured too few screens.");
  const notesOf = (review: typeof apart.review) => Object.values(review.notes).flat();

  await step("given a captured screen whose row values sit far from their names, the design review measures the hole", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.designReport}`);
    await user.see({ role: "heading", text: "Design review of two Library layouts" });
    const split = notesOf(apart.review).find((note) => note.rule === "layout.split-row");
    evidence.recordAssertionEvidence(
      "The layout captured with the screenshot shows the hole",
      split ? `${split.severity}: ${split.title}. ${split.detail}` : `no split-row note; notes: ${notesOf(apart.review).map((note) => note.rule).join(", ") || "none"}`,
      split?.severity === "medium",
    );
    expect(split?.severity).toBe("medium");
  });

  await step("the report flags that screenshot with a design note worth fixing, and the verdict stays Passed", async () => {
    await user.see({ text: "1 design note, 1 worth fixing" });
    await user.see({ text: "Selected evidence: Passed" });
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Design notes are advisory",
      "The gallery counts 1 design note, 1 worth fixing; the report verdict is still Passed.",
      true,
    );
  });

  await step("after: opening the screenshot outlines the hole and names the rule and the fix", async () => {
    await user.click({ role: "link", label: `Inspect ${apart.title}` });
    await user.see({ role: "heading", text: "Design notes" });
    await user.see({ text: "Columns drift away from their rows" });
    await user.see({ text: "layout.split-row" });
    const regions = await probe.eventually(async () => (await probe.dom(".design-region.medium")).elements, {
      within: 5_000, label: "the hole is outlined on the screenshot", until: (elements) => elements.length === 1 && (elements[0]?.rect.width ?? 0) > 40,
    });
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "The note points at the hole",
      `1 outlined region, ${Math.round(regions[0]?.rect.width ?? 0)}×${Math.round(regions[0]?.rect.height ?? 0)}px on the scaled screenshot, numbered like its note.`,
      regions.length === 1,
    );
  });

  await step("hiding the notes shows the plain screenshot again", async () => {
    await user.click({ role: "button", text: "Hide design notes" });
    const regions = await probe.eventually(async () => (await probe.dom(".design-region")).elements, {
      within: 5_000, label: "outlines are hidden", until: (elements) => elements.length === 0,
    });
    await user.see({ role: "button", text: "Show design notes" });
    evidence.recordAssertionEvidence("Outlines can be hidden", `${regions.length} outlines after Hide design notes`, regions.length === 0);
  });

  await step("a screen whose values sit next to their names gets no design note", async () => {
    const notes = notesOf(together.review);
    evidence.recordAssertionEvidence(
      "No false alarm on the fixed layout",
      `${notes.length} design notes on the layout that keeps values next to their names${notes.length ? `: ${notes.map((note) => `${note.rule} ${note.detail}`).join("; ")}` : ""}`,
      notes.length === 0,
    );
    expect(notes).toEqual([]);
    await user.press("ArrowRight");
    // Wait on the dialog's own title: the page behind it repeats the same words.
    await probe.eventually(async () => (await probe.dom("dialog[open] #viewer-title")).elements[0]?.text ?? "", {
      within: 5_000, label: "the viewer moves to the next screenshot", until: (title) => title === together.title,
    });
    await user.notSee({ role: "heading", text: "Design notes" });
    await user.notSee({ role: "button", text: "Show design notes" });
    await user.screenshot();
  });
});
