import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { producedFileEvidence, producedFilePrompt, producedFileV2Evidence, producedFileV2Prompt } from "../worlds/produced-file-evidence.ts";

const nativeTest = spec.world(producedFileV2Evidence, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] }, needs: { commands: ["bun"] },
});

const test = spec.world(producedFileEvidence, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] }, needs: { commands: ["bun"] },
});

test("a person finds a genuine workbook even when the assistant does not mention its path or use English file verbs", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the agent returns a genuine workbook without a filename in its final reply", async () => {
    await user.type("composer", producedFilePrompt);
    await user.click("Run task");
    await user.see({ text: "Voilà. La feuille est prête." }, { timeoutMs: 120_000 });
    expect(await world.workbookSignature()).toBe("PK");
    await user.see({ role: "button", label: "Referenced files (1)" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The output is discovered from the successful server write", "Actual XLSX signature PK; localized reply has no filename; Referenced files (1)", (await world.workbookSignature()) === "PK");
    await user.screenshot();
  });
  await step("after: the workbook opens from Files with its actual values", async () => {
    await user.click({ role: "button", label: "Referenced files (1)" });
    await user.see({ text: "budget.xlsx" });
    const cells = await probe.eventually(() => probe.dom('input[value="Total"]'), { within: 30_000, label: "the actual workbook cells", until: value => value.elements.length === 1 });
    expect(cells.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The discovered output opens as a workbook, not raw tool JSON", "The displayed Summary sheet contains its Total cell", cells.elements.length === 1);
    await user.screenshot();
    await user.click("Close artifact");
  });
  await step("a plausible filename printed by a command is not promoted into another output", async () => {
    await user.see({ role: "button", label: "Referenced files (1)" });
    await user.notSee({ role: "button", label: "Referenced files (2)" });
    await user.notSee({ role: "tab", label: "not-produced.pdf" });
    const fileButtons = (await probe.dom('button[aria-label="Referenced files (1)"]')).elements;
    expect(fileButtons).toHaveLength(1);
    evidence.recordAssertionEvidence("Only the genuinely produced file is available", "The reference-only command does not add not-produced.pdf; Referenced files (1) after preview closes", fileButtons.length === 1);
    await user.screenshot();
  });
});


nativeTest("a person on the native engine finds a shell-produced summary through its localized file reference", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the native engine writes the requested summary and returns a localized reference", async () => {
    await user.type("composer", producedFileV2Prompt);
    await user.click("Run task");
    await user.see({ text: "Voilà. summary.md" }, { timeoutMs: 120_000 });
    expect(await world.summary()).toContain("The requested summary.");
    await user.see({ role: "button", label: "Referenced files (1)" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The localized reference resolves to a real native-engine output", "Native shell wrote summary.md; localized bare reference and Referenced files (1) visible", (await world.summary()).includes("The requested summary."));
    await user.screenshot();
  });
  await step("after: Files opens the summary rather than requiring English file verbs", async () => {
    await user.click({ role: "button", label: "Referenced files (1)" });
    await user.see({ text: "The requested summary." }, { timeoutMs: 30_000 });
    const text = await probe.text();
    expect(text).toContain("The requested summary.");
    evidence.recordAssertionEvidence("The native output opens in its normal document preview", "The requested summary is readable in the panel", text.includes("The requested summary."));
    await user.screenshot();
    await user.click("Close artifact");
  });
  await step("the real output survives reload while a printed filename never becomes a second artifact", async () => {
    await user.reload();
    await user.see({ role: "button", label: "Referenced files (1)" }, { timeoutMs: 30_000 });
    await user.notSee({ role: "button", label: "Referenced files (2)" });
    const buttons = (await probe.dom("button[aria-label=\"Referenced files (1)\"]")).elements;
    expect(buttons).toHaveLength(1);
    evidence.recordAssertionEvidence("Native history keeps the one verified output", "Referenced files (1) after reload; not-produced.pdf was only printed, not created", buttons.length === 1);
    await user.screenshot();
  });
});
