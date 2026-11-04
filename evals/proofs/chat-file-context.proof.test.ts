import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  benchmarkDirectory, benchmarkMarker, chatFileContext, decoyMarker,
  fileContextPrompt, missingPath, secondDirectory, secondMarker,
} from "../worlds/chat-file-context.ts";

const test = spec.world(chatFileContext, {
  resources: { surfaces: ["appWeb"], services: ["mock"] }, timeout: 360_000,
});

// This is renderer + real workspace-runtime UI coverage, not a native path proof.
// No fake native bridge: outside-home native paths have implementation tests.
test("a member previews each bare report from its preceding handoff directory, not a same-named root file", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("given: two handoffs name the same report in different directories", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", fileContextPrompt);
    await user.click("Run task");
    await user.see({ role: "link", text: "Preview missing attachment" }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    const replies = await world.replies();
    const text = await probe.text();
    expect(replies).toBeGreaterThan(0);
    expect(text).toContain(benchmarkDirectory);
    expect(text).toContain(secondDirectory);
    evidence.recordAssertionEvidence("The real engine delivered both directory contexts before any click", `model replies=${replies}; directories=${benchmarkDirectory}, ${secondDirectory}; same report name in both handoffs`, replies > 0 && text.includes(benchmarkDirectory) && text.includes(secondDirectory));
    await user.screenshot();
  });

  for (const handoff of [
    { label: "first", directory: benchmarkDirectory, marker: benchmarkMarker, otherMarker: secondMarker, link: "Preview benchmark", index: 0 },
    { label: "second", directory: secondDirectory, marker: secondMarker, otherMarker: benchmarkMarker, link: "Preview second benchmark", index: 1 },
  ]) {
    for (const presentation of ["inline filename", "Markdown link"]) {
      await step(`after: the ${handoff.label} ${presentation} previews its own handoff, never the root decoy`, async () => {
        await user.click(presentation === "inline filename"
          ? { role: "button", label: "Open benchmark-report.md", nth: handoff.index }
          : { role: "link", text: handoff.link });
        await user.see({ text: handoff.marker }, { timeoutMs: 30_000 });
        await user.notSee({ text: decoyMarker });
        await user.notSee({ text: handoff.otherMarker });
        const text = await probe.text();
        const correct = text.includes(handoff.marker) && !text.includes(decoyMarker) && !text.includes(handoff.otherMarker);
        expect(correct).toBe(true);
        evidence.recordAssertionEvidence("The nearest preceding directory wins without later context contamination", `${presentation}; expected=${handoff.directory}benchmark-report.md; preview=${handoff.marker}; root decoy and other handoff absent`, correct);
        await user.screenshot();
        await user.click({ role: "button", label: "Close artifact" });
      });
    }
  }

  await step("after: a missing attachment offers a calm copy-path fallback", async () => {
    await user.click({ role: "link", text: "Preview missing attachment" });
    await user.see({ text: "This file is on another machine or is no longer available." });
    await user.see({ role: "button", text: "Copy path" });
    const text = await probe.text();
    const errors = (await probe.dom('[data-sonner-toast] .lucide-octagon-x')).elements;
    expect(text).not.toMatch(/Could not find .* on disk/);
    expect(text).not.toContain("This is not a local file path");
    expect(errors).toHaveLength(0);
    evidence.recordAssertionEvidence("A missing reference remains copyable without a disk-error toast", `path=${missingPath}; notice=This file is on another machine or is no longer available.; Copy path visible; error toasts=${errors.length}`, errors.length === 0 && !/Could not find .* on disk/.test(text));
    await user.screenshot();
  });
});
