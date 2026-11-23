import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { composerInlineSuggestions } from "../worlds/composer-inline-suggestions.ts";

const test = spec.world(composerInlineSuggestions, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});
const list = '[data-composer-suggestions] [aria-label="Commands"]';
const suggestions = "[data-composer-suggestions]";
const mentions = `${suggestions} [aria-label="Mentions"] [role="option"]`;
const editor = "[data-composer-editor]";
const chip = `${editor} [data-composer-badge="skill"]`;

test("a teammate adds skills, tasks, and files without leaving the sentence", async ({ world, user, probe, step, evidence }) => {
  const shown = async () => (await probe.dom(list)).elements.length > 0;
  const seeSkill = () => probe.eventually(async () => (await probe.dom(`${list} [role="option"]`)).elements.map((item) => item.text), {
    within: 15_000, label: "the suggestions include Analytics Dashboard", until: (items) => items.some((item) => item.includes("/analytics-dashboard")),
  });
  const draft = async () => (await probe.dom(editor)).elements[0]?.text ?? "";
  const menuState = (open: boolean) => probe.eventually(shown, {
    within: 10_000, label: open ? "the slash suggestions open" : "the slash suggestions close", until: (state) => state === open,
  });

  const options = (selector: string, name: string) => probe.eventually(
    async () => (await probe.dom(selector)).elements.map((item) => item.text),
    { within: 15_000, label: `the suggestions include ${name}`, until: (items) => items.some((item) => item.includes(name)) },
  );
  const noPopover = () => probe.eventually(async () => (await probe.dom(suggestions)).elements.length, {
    within: 10_000, label: "no suggestion popover is visible", until: (count) => count === 0,
  });

  await step("before: a hash brings up a separate task menu", async () => {
    await user.click({ testId: `sidebar-session-${world.draftTask.sessionId}` });
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.type("composer", "#weekly", { replace: true });
    const rows = await options("[data-session-reference-menu] [role=option]", world.task.title);
    const foundTask = rows.some((row) => row.includes(world.task.title));
    evidence.recordAssertionEvidence("The separate task menu includes Weekly report", rows.join(", "), foundTask);
    await user.screenshot();
    expect(foundTask).toBe(true);
  });

  await step("before: an unmatched task query leaves an empty box", async () => {
    await user.type("composer", "#zzqxxzzq", { replace: true });
    await user.see({ text: /No tasks match/ });
    const hint = (await probe.dom(`${suggestions} [role="status"]`)).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("The old task menu shows a message instead of rows", hint, hint.includes("No tasks match"));
    await user.screenshot();
    expect(hint).toContain("No tasks match");
  });

  await step("before: the skill disappears from suggestions after a space", async () => {
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.type("composer", "/analytics", { replace: true });
    await seeSkill();
    await user.type("composer", " dash");
    const open = await menuState(false);
    const text = await draft();
    evidence.recordAssertionEvidence("Typing a second word closes the suggestions", text, !open && text === "/analytics dash");
    await user.screenshot();
    expect(text).toBe("/analytics dash");
  });

  await step("after: two words still find the Analytics Dashboard skill", async () => {
    await world.enableInlineSuggestions();
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.type("composer", "/analytics", { replace: true });
    await seeSkill();
    await user.type("composer", " dash");
    await seeSkill();
    const text = await draft();
    evidence.recordAssertionEvidence("The two-word query still offers Analytics Dashboard", `${text} → /analytics-dashboard`, text === "/analytics dash");
    await user.screenshot();
    expect(text).toBe("/analytics dash");
  });

  await step("after: picking a skill mid-sentence keeps the greeting", async () => {
    await user.type("composer", "hello /analy", { replace: true, intervalMs: 35 });
    await seeSkill();
    await user.press("Enter");
    await menuState(false);
    await user.type("composer", "for today");
    const text = await draft();
    const chips = (await probe.dom(chip)).elements;
    const keptSentence = /hello\s+analytics dashboard\s+for today/i.test(text) && chips.length === 1;
    evidence.recordAssertionEvidence("One skill chip sits between the greeting and the rest of the message", text, keptSentence);
    await user.screenshot();
    expect(keptSentence).toBe(true);
  });

  await step("after: one word shows both the file and the task", async () => {
    await user.type("composer", "compare @weekly", { replace: true });
    await options(mentions, world.task.title);
    const rows = await options(mentions, "weekly-notes.txt");
    const fileFirst = rows[0]?.includes("weekly-notes.txt") && rows[1]?.includes(world.task.title);
    evidence.recordAssertionEvidence("The file appears before the task for a one-word query", rows.join(", "), fileFirst === true);
    await user.screenshot();
    expect(fileFirst).toBe(true);
  });

  await step("after: two words show only the matching task", async () => {
    await user.type("composer", " report");
    expect(await draft()).toBe("compare @weekly report");
    const rows = await options(mentions, world.task.title);
    const taskOnly = rows.length === 1 && rows[0]?.includes(world.task.title);
    evidence.recordAssertionEvidence("Only Weekly report is offered", rows.join(", "), taskOnly === true);
    await user.screenshot();
    expect(taskOnly).toBe(true);
  });

  await step("after: Enter inserts the task without replacing the draft", async () => {
    await user.press("Enter");
    await noPopover();
    await user.type("composer", "for today");
    const text = await draft();
    const chips = (await probe.dom(`${editor} [data-session-reference-session]`)).elements;
    const kept = /compare\s+Weekly report\s+for today/.test(text) && chips.length === 1;
    evidence.recordAssertionEvidence("One task chip replaces only the query", text, kept);
    await user.screenshot();
    expect(kept).toBe(true);
  });

  await step("after: a file can still be attached with an at sign", async () => {
    await user.type("composer", "check @weekly-notes.txt", { replace: true });
    await options(mentions, "weekly-notes.txt");
    await user.press("Tab");
    await noPopover();
    const files = (await probe.dom(`${editor} [data-composer-badge="file"]`)).elements;
    const text = await draft();
    const inserted = files.length === 1 && /check\s+weekly-notes\.txt/.test(text);
    evidence.recordAssertionEvidence("Tab inserts the file chip without changing the other words", text, inserted);
    await user.screenshot();
    expect(inserted).toBe(true);
  });

  await step("after: prose after a file name closes the mention menu", async () => {
    await user.type("composer", "@weekly-notes.txt", { replace: true });
    await options(mentions, "weekly-notes.txt");
    await user.type("composer", " please summarise");
    const remaining = await noPopover();
    const text = await draft();
    evidence.recordAssertionEvidence("The file name and prose stay plain text with no popover", text, remaining === 0 && text === "@weekly-notes.txt please summarise");
    await user.screenshot();
    expect(text).toBe("@weekly-notes.txt please summarise");
  });

  for (const example of ["#weekly", "@zzqxxzzq", "/zzqxxzzq"]) {
    await step(`after: ${example} does not open an empty box`, async () => {
      await user.type("composer", "@weekly", { replace: true });
      await options(mentions, world.task.title);
      await user.type("composer", example, { replace: true });
      const remaining = await noPopover();
      const text = await draft();
      evidence.recordAssertionEvidence("No popover covers the draft", text, remaining === 0 && text === example);
      await user.screenshot();
      expect(text).toBe(example);
    });
  }

  for (const example of ["a/b", "https://example.invalid/analytics", "/usr/local"]) {
    await step(`then ${example} stays plain text without suggestions`, async () => {
      await user.type("composer", "/analytics", { replace: true });
      await seeSkill();
      await user.type("composer", example, { replace: true, intervalMs: 35 });
      const open = await menuState(false);
      const text = await draft();
      evidence.recordAssertionEvidence("No suggestions cover the draft", text, !open && text === example);
      await user.screenshot();
      expect(text).toBe(example);
    });
  }
});
