import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { spreadsheetPrompt, spreadsheetReadOnly } from "../worlds/spreadsheet-read-only.ts";

const test = spec.world(spreadsheetReadOnly, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] }, needs: { commands: ["bun"] },
});

test("a person previews a workbook without overwriting its other sheets, formulas, formatting or chart", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the person opens their existing workbook from the conversation", async () => {
    await user.type("composer", spreadsheetPrompt);
    await user.click("Run task");
    await user.see({ role: "link", label: "preservation.xlsx" }, { timeoutMs: 120_000 });
    await user.click({ role: "link", label: "preservation.xlsx" });
    await user.see({ label: "Row 1, column 1" }, { timeoutMs: 30_000 });
    const cells = (await probe.dom("input[readonly]")).elements;
    expect(cells.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The workbook opens as read-only values", `${cells.length} read-only cells; original workbook SHA-256 ${world.originalHash}`, cells.length > 0);
    await user.screenshot();
  });
  await step("after: the first-sheet preview offers download but cannot save a flattened workbook", async () => {
    await user.see({ text: "Read-only · First sheet · Values only" });
    await user.notSee({ role: "button", label: /^Save$/ });
    await user.notSee({ role: "button", label: /^Row$/ });
    await user.click("Artifact actions");
    await user.see({ role: "menuitem", label: "Download" });
    expect(await world.workbookHash()).toBe(world.originalHash);
    evidence.recordAssertionEvidence("The original workbook remains byte-for-byte intact", `No Save or Row controls; Download available; SHA-256 unchanged: ${await world.workbookHash()}`, (await world.workbookHash()) === world.originalHash);
    await user.screenshot();
    await user.click("Artifact actions");
    await user.click("Close artifact");
  });
  await step("CSV remains editable and saves only the delimited table", async () => {
    await user.click({ role: "link", label: "editable.csv" });
    await user.see({ label: "Row 2, column 1" });
    await user.type({ label: "Row 2, column 1" }, "Updated", { replace: true });
    await user.click({ role: "button", label: /^Save$/ });
    const csv = await probe.eventually(() => world.csv(), { within: 10_000, label: "the table edit is saved", until: value => value.includes("Updated") });
    expect(csv).toContain("Updated");
    expect(await world.workbookHash()).toBe(world.originalHash);
    evidence.recordAssertionEvidence("Delimited edits save without touching the workbook", `CSV: ${csv.trim()}; workbook SHA-256 unchanged`, csv.includes("Updated") && (await world.workbookHash()) === world.originalHash);
    await user.screenshot();
    await user.click("Close artifact");
  });
  await step("a missing workbook stays a missing reference rather than an editable empty file", async () => {
    await user.click({ role: "link", label: "missing.xlsx" });
    await user.see({ text: "This file is missing or outside the workspace." });
    await user.notSee({ role: "button", label: /^Save$/ });
    expect(await world.workbookHash()).toBe(world.originalHash);
    evidence.recordAssertionEvidence("A missing reference never creates a replacement workbook", "Missing-file message visible; no Save control; original workbook hash unchanged", (await world.workbookHash()) === world.originalHash);
    await user.screenshot();
  });
});
