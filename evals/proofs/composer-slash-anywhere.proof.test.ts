import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { composerSlashAnywhere } from "../worlds/composer-slash-anywhere.ts";

const test = spec.world(composerSlashAnywhere, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});
const list = '[data-composer-suggestions] [aria-label="Commands"]';
const editor = "[data-composer-editor]";
const chip = `${editor} [data-composer-badge="skill"]`;

test("a teammate finds and inserts a skill without leaving the sentence", async ({ world, user, probe, step, evidence }) => {
  const shown = async () => (await probe.dom(list)).elements.length > 0;
  const seeSkill = () => probe.eventually(async () => (await probe.dom(`${list} [role="option"]`)).elements.map((item) => item.text), {
    within: 15_000, label: "the suggestions include Analytics Dashboard", until: (items) => items.some((item) => item.includes("/analytics-dashboard")),
  });
  const draft = async () => (await probe.dom(editor)).elements[0]?.text ?? "";
  const menuState = (open: boolean) => probe.eventually(shown, {
    within: 10_000, label: open ? "the slash suggestions open" : "the slash suggestions close", until: (state) => state === open,
  });

  await step("before: the skill disappears from suggestions after a space", async () => {
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.type("composer", "/analytics");
    await seeSkill();
    await user.type("composer", " dash");
    const open = await menuState(false);
    const text = await draft();
    evidence.recordAssertionEvidence("Typing a second word closes the suggestions", text, !open && text === "/analytics dash");
    await user.screenshot();
    expect(text).toBe("/analytics dash");
  });

  await step("after: two words still find the Analytics Dashboard skill", async () => {
    await world.enableSlashSuggestions();
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
