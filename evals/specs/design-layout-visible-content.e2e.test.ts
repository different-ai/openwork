import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { designLayoutVisibleContentWorld } from "../worlds/design-layout-visible-content.ts";

const test = spec.world(designLayoutVisibleContentWorld, {
  resources: { surfaces: ["appWeb"], services: [] },
});

const hiddenValues = ["event_fixture_001", "request_fixture_002", "operation_fixture_003", "content_visibility_fixture_004", "until_found_fixture_005"];

test("a reviewer measures only painted disclosure text and wrapped lines while real design defects still get flagged", async ({ world, user, step, evidence }) => {
  await step("given closed technical details, the review includes the label but no hidden identifiers", async () => {
    await user.navigate(world.url);
    await user.see({ role: "heading", text: "Visible content review" });
    await user.see({ role: "button", text: "Open technical details" });
    await user.see({ testId: "technical-summary" });
    const measured = await world.measure();
    const texts = measured.layout.boxes.map((box) => box.text);
    const hidden = texts.filter((text) => hiddenValues.includes(text));
    const ok = !measured.witness.detailsOpen && texts.includes("Technical details") && hidden.length === 0 && measured.overlaps.length === 0 && measured.contrast.length === 0;
    evidence.recordAssertionEvidence(
      "Closed disclosures contribute their visible label only",
      `Technical details ${texts.includes("Technical details") ? "included" : "missing"}; ${hidden.length} hidden identifiers, ${measured.overlaps.length} overlap notes, ${measured.contrast.length} contrast notes.`,
      ok,
    );
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("when the reviewer opens technical details, both visible identifiers are measured without overlap", async () => {
    await user.click({ role: "button", text: "Open technical details" });
    await user.see({ text: "event_fixture_001" });
    await user.see({ text: "request_fixture_002" });
    await user.see({ testId: "operation-summary" });
    const measured = await world.measure();
    const values = measured.layout.boxes.filter((box) => box.text === "event_fixture_001" || box.text === "request_fixture_002");
    const nestedHidden = measured.layout.boxes.filter((box) => box.text === "operation_fixture_003");
    const ok = measured.witness.detailsOpen && values.length === 2 && nestedHidden.length === 0 && measured.witness.cachedDetails.every((value) => value.painted) && measured.overlaps.length === 0;
    evidence.recordAssertionEvidence(
      "Opening a disclosure preserves the real detail text",
      `${values.length} visible identifiers, ${nestedHidden.length} identifiers from the still-closed nested row, ${measured.overlaps.length} overlap notes.`,
      ok,
    );
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after: closing technical details discards cached rectangles that Chrome no longer paints", async () => {
    await user.click({ role: "button", text: "Close technical details" });
    await user.see({ role: "button", text: "Open technical details" });
    await user.see({ testId: "technical-summary" });
    const measured = await world.measure();
    // The risky condition must occur: non-zero native Range rects survive the
    // trusted close click, but native content-visibility says they are unpainted.
    const cached = measured.witness.cachedDetails.filter((value) => !value.painted && value.rect.width > 0 && value.rect.height > 0);
    const hidden = measured.layout.boxes.filter((box) => hiddenValues.includes(box.text) || box.text === "Operation identifiers");
    const ok = !measured.witness.detailsOpen && cached.length === 2 && hidden.length === 0 && measured.overlaps.length === 0;
    evidence.recordAssertionEvidence(
      "Cached hidden rectangles do not become design defects",
      `${cached.length} unpainted identifiers retain non-zero Chrome rectangles (${cached.map((value) => `${Math.round(value.rect.width)}×${Math.round(value.rect.height)}px`).join(", ")}); ${hidden.length} hidden boxes collected; ${measured.overlaps.length} overlap notes.`,
      ok,
    );
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after: the wrapped capacity paragraph is measured as separate non-overlapping lines", async () => {
    await user.see({ role: "heading", text: "Capacity" });
    await user.see({ testId: "wrapped-paragraph" });
    const measured = await world.measure();
    const first = measured.witness.paragraphNodes[0];
    const wrapped = measured.witness.paragraphNodes.at(-1);
    if (!first || !wrapped) throw new Error("The split inline paragraph did not render.");
    const width = Math.max(0, Math.min(first.union.x + first.union.width, wrapped.union.x + wrapped.union.width) - Math.max(first.union.x, wrapped.union.x));
    const height = Math.max(0, Math.min(first.union.y + first.union.height, wrapped.union.y + wrapped.union.height) - Math.max(first.union.y, wrapped.union.y));
    const oldUnionOverlap = width * height / Math.min(first.union.width * first.union.height, wrapped.union.width * wrapped.union.height);
    const lines = measured.layout.boxes.filter((box) => box.anchor === '[data-testid="wrapped-paragraph"]');
    const actualFragments = measured.witness.paragraphNodes.flatMap((node) => node.fragments).filter((rect) => rect.width >= 1 && rect.height >= 1);
    const ok = measured.witness.paragraphNodes.length === 3 && wrapped.fragments.length >= 2 && oldUnionOverlap >= 0.3
      && lines.length === actualFragments.length && lines.every((line) => line.height <= 24) && measured.overlaps.length === 0;
    evidence.recordAssertionEvidence(
      "Wrapped inline siblings are not mistaken for overlapping text",
      `3 inline nodes; the last wraps into ${wrapped.fragments.length} fragments. Its old union covers ${Math.round(oldUnionOverlap * 100)}% of the first node; ${lines.length} real line boxes collected, ${measured.overlaps.length} overlap notes.`,
      ok,
    );
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("visible overlapping and faint problem controls still get design notes", async () => {
    await user.click({ role: "button", text: "Show problem controls" });
    await user.see({ role: "heading", text: "Problem controls" });
    await user.see({ testId: "faint-text" });
    const measured = await world.measure();
    const overlapping = measured.layout.boxes.filter((box) => box.anchor === '[data-testid="overlap-first"]' || box.anchor === '[data-testid="overlap-second"]');
    const faint = measured.layout.boxes.find((box) => box.anchor === '[data-testid="faint-text"]');
    const disabled = measured.layout.boxes.find((box) => box.anchor === '[data-testid="disabled-faint"]');
    const overlapFound = measured.overlaps.some((note) => note.anchors?.includes('[data-testid="overlap-first"]') && note.anchors.includes('[data-testid="overlap-second"]'));
    const faintFound = measured.contrast.some((note) => note.anchors?.includes('[data-testid="faint-text"]') && !note.detail.includes("Locked control"));
    const trusted = measured.witness.trustedClicks.length === 3 && measured.witness.trustedClicks.every((click) => click === "true");
    const hidden = measured.layout.boxes.filter((box) => hiddenValues.includes(box.text));
    const ok = overlapping.length === 2 && Boolean(faint) && disabled?.disabled === true && overlapFound && faintFound && trusted && hidden.length === 0;
    evidence.recordAssertionEvidence(
      "The repair removes false alarms, not real design checks",
      `${overlapping.length} visibly overlapping lines produce ${measured.overlaps.length} overlap note; faint text produces ${measured.contrast.length} contrast note; disabled text remains exempt. ${measured.witness.trustedClicks.length} trusted button clicks; ${hidden.length} hidden identifiers collected.`,
      ok,
    );
    expect(ok).toBe(true);
    expect(measured.overlaps.map((note) => note.rule)).toEqual(["layout.overlap"]);
    expect(measured.contrast.map((note) => note.rule)).toEqual(["layout.contrast"]);
    await user.screenshot();
  });
});
