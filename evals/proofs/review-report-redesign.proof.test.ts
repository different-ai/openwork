import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { reviewReportWorld } from "../worlds/review-report.ts";

// The production review app with synthetic report inputs on loopback; no OpenWork or Den surface is needed.
const test = spec.world(reviewReportWorld, {
  timeout: 180_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] },
});

test("a reviewer reads a failing report from its verdict and evidence map, then filters, opens steps and the sandbox panel as before", async ({ world, user, probe, step, evidence }) => {
  await step("after: the failing report leads with its verdict, counts and an evidence map", async () => {
    await user.see({ text: "Selected evidence: Failed" });
    await user.see({ role: "heading", text: "Evidence map" });
    const verdict = (await probe.dom(".verdict")).elements;
    const lanes = (await probe.dom(".map-lane")).elements;
    expect(verdict).toHaveLength(1);
    expect(lanes.map((lane) => lane.text)).toEqual([expect.stringContaining("Passed"), expect.stringContaining("Failed"), expect.stringContaining("Reference")]);
    evidence.recordAssertionEvidence("The verdict and a three-lane evidence map open the report", `${verdict.length} verdict card; lanes: ${lanes.map((lane) => lane.text.slice(0, 40)).join(" | ")}`, verdict.length === 1 && lanes.length === 3);
    await user.screenshot();
  });

  await step("a step card in the map opens that screenshot in the viewer", async () => {
    await user.click({ role: "link", label: "Inspect Model picker with the new provider", nth: 0 });
    await user.see({ role: "dialog" });
    await user.see({ role: "heading", text: "Model picker with the new provider" });
    const hash = await probe.hash();
    expect(hash).toContain("evidence-picker-shot");
    evidence.recordAssertionEvidence("The map step opens the viewer at that screenshot", `hash ${hash}`, hash.includes("evidence-picker-shot"));
    await user.screenshot();
    await user.press("Escape");
    await user.notSee({ role: "dialog" });
  });

  await step("the Failed filter leaves only the failing section", async () => {
    await user.click({ role: "button", label: /^Failed\b/ });
    await user.see({ text: "1 of 3 sections" });
    const sections = (await probe.dom("section.section")).elements;
    expect(sections).toHaveLength(1);
    evidence.recordAssertionEvidence("Filtering shows one failing section", `${sections.length} section visible: ${sections[0]?.text.slice(0, 48)}`, sections.length === 1);
    await user.screenshot();
  });

  await step("a lane in the map clears the filter and jumps to its section", async () => {
    await user.click({ role: "link", label: /^1\s+Passed\s+A member connects a provider/ });
    await user.see({ text: "3 of 3 sections" });
    const hash = await probe.eventually(() => probe.hash(), { within: 5_000, label: "section anchor", until: (value) => value.includes("connect-run") });
    expect(hash).toContain("connect-run");
    evidence.recordAssertionEvidence("The lane resets the filter and lands on its section", `hash ${hash}; status reads 3 of 3 sections`, hash.includes("connect-run"));
    await user.screenshot();
  });

  await step("the sandbox panel opens beside the report and says the provider is not connected", async () => {
    await user.click({ role: "button", label: /Show sandbox/ });
    await user.see({ role: "heading", text: "Your sandbox" });
    await user.see({ text: /Freestyle is not connected/ });
    const panel = (await probe.dom("#sandbox-panel")).elements;
    const width = panel[0]?.rect.width ?? 0;
    expect(width).toBeGreaterThan(300);
    evidence.recordAssertionEvidence("The sandbox panel opens beside the report with an honest provider state", `panel ${Math.round(width)}px wide; Your sandbox heading and the not-connected line are visible`, width > 300);
    await user.screenshot();
    await user.click({ role: "button", label: /Hide sandbox/ });
  });

  await step("after: on a phone-width screen the report stacks into one column with a section picker", async () => {
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ role: "combobox", label: "Jump to section" });
    await user.see({ text: "Selected evidence: Failed" });
    const page = await probe.dom(".report");
    expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
    evidence.recordAssertionEvidence("Narrow screens keep the verdict and a section picker without sideways scrolling", `document ${page.documentWidth}px in a ${page.viewportWidth}px viewport`, page.documentWidth <= page.viewportWidth);
    await user.screenshot();
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  });

  await step("after: a passing report shows a neutral verdict with every check passed", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.see({ text: "Selected evidence: Passed" });
    await user.see({ text: "Every recorded check passed." });
    await user.notSee({ text: "Selected evidence: Failed" });
    const lanes = (await probe.dom(".map-lane.failed")).elements;
    expect(lanes).toHaveLength(0);
    evidence.recordAssertionEvidence("The passing report reads Passed with no failing lane", `Selected evidence: Passed; ${lanes.length} failing lanes`, lanes.length === 0);
    await user.screenshot();
  });
});
