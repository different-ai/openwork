import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { reviewBrowserWorld, reviewNarrowWorld } from "../worlds/evidence-review.ts";

const test = spec.world(reviewBrowserWorld, {
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { placement: "local", commands: ["git"] },
});

test("a reviewer can triage failures and inspect linked evidence without losing context", async ({ world, user, probe, step, evidence }) => {
  await step("failed evidence is the focus and the sandbox is optional", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.failed}`);
    await user.see({ role: "heading", text: "Sharing a skill, from link to access" });
    await user.notSee({ role: "combobox", label: "Preview world" });
    await user.see({ text: "Selected evidence: Failed" });
    await user.see({ text: "1 section has a failing check. Start there." });
    await user.click({ role: "button", text: "Failed (1)" });
    expect((await probe.dom(".sections > .section")).elements).toHaveLength(1);
    expect((await probe.dom(".checks[open]")).elements).toHaveLength(1);
    await user.see({ text: "1 of 3 sections" });
    await user.see({ text: "Failed here" });
    await user.screenshot();
    await user.click({ role: "button", text: "Incomplete (0)" });
    await user.see({ text: "No incomplete sections." });
    await user.click({ role: "button", text: "Next failure" });
    expect((await probe.dom(".sections > .section")).elements).toHaveLength(3);
    evidence.recordAssertionEvidence("Failure filters and next-failure navigation preserve honest results", "The verdict banner names the failing section count; the failed report filters to one failed section with expanded checks and its failure frame labelled Failed here; the empty incomplete filter gives recovery; Next failure restores all three sections.", true);
  });

  await step("screenshots retain source assertions, support zoom, and restore keyboard focus", async () => {
    await user.click({ role: "link", label: "Inspect Share link dialog · fixture" });
    await user.see({ role: "button", text: "100% zoom" });
    expect((await probe.dom("dialog[open]")).elements).toHaveLength(1);
    await user.see({ role: "heading", text: "Checked in this step" });
    await user.click({ role: "button", text: "100% zoom" });
    expect((await probe.dom(".viewer-image.actual-size")).elements).toHaveLength(1);
    await user.click({ role: "button", text: "Fit to width" });
    expect((await probe.dom(".viewer-image.actual-size")).elements).toHaveLength(0);
    await user.screenshot();
    await user.press("ArrowRight");
    await user.see({ text: "2 of 2" });
    await user.press("Escape");
    expect((await probe.dom("dialog[open]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Evidence opens in a keyboard-accessible viewer", "The native dialog displays its step's checks alongside the screenshot, switches between actual size and fit, advances with ArrowRight, and closes with Escape.", true);
  });

  await step("before: a screenshot from a record without measurements shows only its caption", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.incomplete}`);
    await user.see({ text: "Existing documentation image, reused as a report fixture." });
    await user.notSee({ text: "Found on screen: “Create link”." });
    const marks = (await probe.dom(".gallery .mark")).elements.length;
    expect(marks).toBe(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("Older records render as before", `The unmeasured screenshot keeps its caption and description with ${marks} marks and no change or found-on-screen line.`, true);
  });

  await step("after: each screenshot says what the person did, what appeared, and what the step found", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.see({ text: "Clicked “Share”. “Share link” and “Publish a public link. Anyone with the URL can install this skill.” and 2 more lines appeared." });
    await user.see({ text: "Found on screen: “Create link”." });
    const marks = (await probe.dom(".gallery .mark")).elements.length;
    expect(marks).toBe(2);
    await user.screenshot();
    evidence.recordAssertionEvidence("Screenshots say what changed and what their step found", `The caption names the click and the lines that appeared, lists “Create link” as found on screen, and the thumbnail carries ${marks} marks: the changed dialog and the checked button.`, true);
  });

  await step("the viewer outlines the change and the checked button, and Hide marks clears them", async () => {
    await user.click({ role: "link", label: "Inspect Share link dialog · fixture" });
    await user.see({ role: "heading", text: "What changed" });
    await user.see({ role: "heading", text: "Found on screen" });
    await user.see({ role: "heading", text: "Checked in this step" });
    await user.see({ text: "Create link" });
    await user.click({ role: "button", text: "Hide marks" });
    const hidden = (await probe.dom(".viewer-image.marks-hidden")).elements.length;
    expect(hidden).toBe(1);
    await user.click({ role: "button", text: "Show marks" });
    await user.screenshot();
    await user.press("Escape");
    evidence.recordAssertionEvidence("The viewer explains the screenshot and its marks can be hidden", `What changed, Found on screen and the step's own check sit beside the image; Hide marks cleared the outlines (${hidden} hidden view) and Show marks restored them.`, true);
  });

  await step("a shared image link opens the same evidence directly", async () => {
    const image = world.report.evidence.find((item) => item.kind === "image");
    if (!image) throw new Error("Missing fixture image");
    await user.navigate(`${world.baseUrl}/r/${world.passed}#evidence-${image.id}`);
    await user.see({ role: "button", text: "100% zoom" });
    expect((await probe.dom("dialog[open]")).elements).toHaveLength(1);
    await user.see({ role: "heading", text: "Share link dialog · fixture" });
    await user.press("Escape");
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see({ role: "combobox", label: "Preview world" });
    await user.see({ text: "Freestyle is not connected. The review app owner can connect it." });
    await user.click({ role: "button", text: "Hide sandbox" });
    await user.notSee({ role: "combobox", label: "Preview world" });
    evidence.recordAssertionEvidence("Evidence deep links and sandbox disclosure work independently", "A direct image hash opens its screenshot; the sandbox can be shown and hidden without navigating away or implying that an unavailable provider is connected.", true);
  });

  await step("incomplete and reference reports keep their distinct verdicts", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.incomplete}`);
    await user.click({ role: "button", text: "Incomplete (1)" });
    await user.see({ text: "Selected evidence: Incomplete" });
    await user.see({ text: "Nothing failed, but 1 section is missing evidence or waiting for a judgment and 1 declared gap." });
    await user.see({ text: "Desktop restart remains outside this selected evidence." });
    await user.screenshot();
    await user.navigate(`${world.baseUrl}/r/${world.reference}`);
    await user.see({ text: "Selected evidence: Reference" });
    evidence.recordAssertionEvidence("Triage does not promote incomplete or reference evidence to passed", "A skipped run with a pending visual judgment remains Incomplete and keeps its declared coverage gap; the documentation-only report remains Reference.", true);
  });
});

const narrowTest = spec.world(reviewNarrowWorld, {
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { placement: "local", commands: ["git"] },
});

narrowTest("a narrow review keeps section navigation and evidence ahead of sandbox details", async ({ world, user, probe, evidence }) => {
  await user.navigate(`${world.baseUrl}/r/${world.incomplete}`);
  await user.see({ role: "combobox", label: "Jump to section" });
  await user.notSee({ role: "combobox", label: "Preview world" });
  await user.screenshot();
  await user.click({ role: "button", text: "Show sandbox" });
  await user.see({ role: "combobox", label: "Preview world" });
  await user.click({ role: "button", text: "Hide sandbox" });
  await user.click({ role: "link", label: "Inspect Share link dialog · fixture" });
  await user.see({ role: "button", text: "100% zoom" });
  expect((await probe.dom("dialog[open]")).elements).toHaveLength(1);
  await user.screenshot();
  await user.press("Escape");
  evidence.recordAssertionEvidence("Narrow layouts preserve navigation and evidence inspection", "At 390 × 844 the production page retains a native section selector, an optional sandbox, and a working screenshot viewer with Escape dismissal.", true);
});
