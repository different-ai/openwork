import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { claudeHistoryImportWorld } from "../worlds/claude-history-import.ts";

const test = spec.world(claudeHistoryImportWorld, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

const WITHIN = 30_000;

test("an owner brings a Claude Code session into the workspace from Settings and reads it as a regular chat", async ({ world, user, probe, step, evidence }) => {
  const [fix, notes] = world.sessions;

  await step("workspace Import lists the Claude Code sessions saved for this folder without rollout setup", async () => {
    await user.navigate(world.settingsUrl("preferences"));
    await user.see({ text: "Permissions" }, { timeoutMs: 60_000 });
    await user.see({ text: "Import" }, { timeoutMs: 60_000 });
    await user.click({ text: "Import" });
    await user.see({ text: "Claude Code sessions in this folder" });
    await user.see({ text: fix.title }, { timeoutMs: WITHIN });
    await user.see({ text: notes.title });
    await user.see({ text: "Cowork tasks" });
    await user.see({ text: "Drop your Claude export here" });
    await user.see({ text: "Not included in Claude's export. Save the files you need from each task." });
    const listed = (await probe.has(fix.title)) && (await probe.has(notes.title));
    expect(listed).toBe(true);
    evidence.recordAssertionEvidence("Both saved sessions are offered, and Cowork is shown as not available", `"${notes.title}", "${fix.title}"; Cowork tasks: not included in Claude's export`, listed);
    await user.screenshot();
  });

  await step("importing one session marks it Imported and leaves the other untouched", async () => {
    // Sessions not imported yet start ticked; leave one out.
    await user.see({ role: "button", label: "Import 2 sessions" });
    await user.click({ role: "checkbox", label: notes.title });
    await user.click({ role: "button", label: "Import 1 session" });
    await user.see({ text: "Imported" }, { timeoutMs: WITHIN });
    await user.see({ role: "checkbox", label: notes.title });
    const imported = await probe.dom('[aria-label="' + fix.title + '"][data-disabled]');
    expect(imported.elements.length).toBe(1);
    evidence.recordAssertionEvidence("One session imported, one still offered", `"${fix.title}" shows Imported and can't be ticked again; "${notes.title}" is still offered`, imported.elements.length === 1);
    await user.screenshot();
  });

  await step("opening it shows the Claude Code conversation, with its question, the tool it ran and its answer", async () => {
    await user.click({ role: "button", label: "Open" });
    await user.see({ text: fix.question }, { timeoutMs: 60_000 });
    await user.see({ text: fix.answer }, { timeoutMs: WITHIN });
    const shown = (await probe.has(fix.question)) && (await probe.has(fix.answer));
    expect(shown).toBe(true);
    evidence.recordAssertionEvidence("The imported session opens as a chat", `Question "${fix.question}" and answer "${fix.answer}" are shown in the conversation`, shown);
    await user.screenshot();
  });

  await step("importing again does not duplicate it", async () => {
    await user.navigate(world.settingsUrl("import"));
    await user.see({ text: fix.title }, { timeoutMs: 60_000 });
    await user.see({ text: "Imported" });
    await user.see({ role: "button", label: "Import 1 session" });
    const stillImported = (await probe.dom('[aria-label="' + fix.title + '"][data-disabled]')).elements.length === 1;
    expect(stillImported).toBe(true);
    evidence.recordAssertionEvidence("Re-opening Import keeps one copy", `"${fix.title}" still shows Imported and can't be ticked; only "${notes.title}" is offered`, stillImported);
    await user.screenshot();
  });
});
