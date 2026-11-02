import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { PR_LINK_TEXT, RAIL_PROMPT, RAIL_REPLY, textActivityRailWorld } from "../worlds/text-activity-rail.ts";

const test = spec.world(textActivityRailWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 720_000,
});

test("a member reads their agent's turn as plain sentences without organization setup", async ({ user, probe, step, evidence }) => {
  await step("the member opts into model reasoning, then asks the agent to update notes", async () => {
    await user.see("composer", { editable: true });
    await user.click({ testId: "account-status-menu" });
    await user.click({ role: "menuitem", label: "Settings" });
    await user.click({ role: "button", label: "Preferences" });
    await user.click({ role: "switch", label: "Show model reasoning" });
    await probe.eventually(() => probe.dom('[role="switch"][aria-label="Show model reasoning"][aria-checked="true"], [role="switch"][aria-label="Show model reasoning"][data-checked]'), {
      within: 10_000, label: "Show model reasoning is on", until: (value) => value.elements.length === 1,
    });
    // Settings is a page, not a dialog: return to the conversation the way a person does.
    await user.click({ role: "button", label: "Back to app" });
    await user.see("composer", { editable: true });
    await user.type("composer", RAIL_PROMPT);
    await probe.eventually(() => probe.dom('button[aria-label="Run task"]:not(:disabled)'), {
      within: 30_000, label: "the conversation is ready to run the task", until: (value) => value.elements.length === 1,
    });
    await user.click("Run task");
    await user.see({ text: RAIL_REPLY }, { timeoutMs: 180_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    const calls = (await probe.dom("[data-text-step], [data-text-group-summary]")).elements.length;
    evidence.recordAssertionEvidence("The completed turn already has text-first activity", `text-first rows: ${calls}`, calls > 0);
    expect(calls).toBeGreaterThan(0);
    await user.screenshot();
  });

  await step("the turn reads as one summary, a timed thought and OpenWork's own mark inline", async () => {
    await user.see({ text: RAIL_REPLY }, { timeoutMs: 60_000 });
    const summary = await probe.eventually(async () => (await probe.dom("[data-text-group-summary]")).elements.map((element) => element.text), {
      within: 30_000, label: "the text-first summary", until: (found) => found.length > 0,
    });
    const thought = (await probe.dom('[data-text-step-tone]')).elements.map((element) => element.text).filter((value) => value.startsWith("Thought"));
    const marks = (await probe.dom('[data-text-rail-mark] [data-connector-icon="openwork"]')).elements.length;
    const lanes = (await probe.dom('[data-tool-aggregate] span.size-5[aria-hidden="true"]')).elements.length;
    const ok = /^Explored \d+ files?, edited \d+ files?, ran 2 commands$/.test(summary[0] ?? "") && thought.length > 0 && marks >= 1 && lanes === 0;
    evidence.recordAssertionEvidence("One summary line, a thought, the OpenWork mark inline, no icon lane", `summary: ${JSON.stringify(summary)}; thought: ${JSON.stringify(thought)}; inline OpenWork marks: ${marks}; leading lanes: ${lanes}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("opening the summary lists one sentence per step, and the read that failed says so in red", async () => {
    await user.click({ text: /^Explored \d+ files?, edited/ });
    await user.see({ text: "Ran List the notes folder" });
    await user.see({ text: "Couldn't read missing.md" });
    const steps = (await probe.dom("[data-tool-aggregate-row] [data-text-step]")).elements.map((element) => element.text);
    const failed = (await probe.dom('[data-text-step-tone="failed"] .text-red-11')).elements.map((element) => element.text);
    const ok = steps.includes("Read brief.md") && steps.includes("Wrote summary.md") && steps.includes("Edited brief.md") && failed.includes("Couldn't read");
    evidence.recordAssertionEvidence("Each step is a sentence; the failure's verb is red", `steps: ${JSON.stringify(steps)}; red verbs: ${JSON.stringify(failed)}`, ok);
    expect(ok).toBe(true);
    await user.click({ label: "Show details for Couldn't read missing.md" });
    await user.see({ text: "Technical details" });
    await user.screenshot();
  });

  await step("opening a command shows the command and its output in one quiet card, with copy actions", async () => {
    await user.click({ label: "Show details for Ran List the notes folder" });
    const card = await probe.eventually(async () => (await probe.dom("[data-text-command-card]")).elements.map((element) => element.text), {
      within: 15_000, label: "the command card", until: (found) => found.length > 0,
    });
    const ok = (card[0] ?? "").includes("$ ls -1 notes") && (card[0] ?? "").includes("brief.md");
    evidence.recordAssertionEvidence("The card shows the command line and what it printed", `card: ${(card[0] ?? "").slice(0, 160)}`, ok);
    expect(ok).toBe(true);
    await user.click({ label: "Command actions" });
    await user.see({ text: "Copy output" });
    await user.press("Escape");
    await user.screenshot();
  });

  await step("the pull request in the answer carries its GitHub mark", async () => {
    const links = (await probe.dom('a[data-github-reference="pull"]')).elements.map((element) => element.text);
    const glyphs = (await probe.dom('a[data-github-reference="pull"] svg[data-github-reference-glyph="pull"]')).elements.length;
    const ok = links.some((value) => value.includes(PR_LINK_TEXT)) && glyphs === 1;
    evidence.recordAssertionEvidence("A GitHub pull request link shows its glyph and title", `links: ${JSON.stringify(links)}; glyphs: ${glyphs}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
