import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { composerPromptHistory } from "../worlds/composer-prompt-history.ts";
import { longHistoryLast, longHistoryOtherTitle, longHistoryTitle } from "../worlds/chat.ts";

const test = spec.world(composerPromptHistory, { timeout: 600_000 });

test("composer recalls durable prompts across reloads and a real desktop restart without leaking into another session", async ({ user, step, world }) => {
  await user.click({ role: "button", label: new RegExp(`^${longHistoryTitle}`) });
  await user.see({ text: longHistoryLast }, { timeoutMs: 60_000 });
  for (const boot of ["reload", "second reload", "restart"]) {
    await step(`recall after ${boot}`, async () => {
      if (boot === "restart") {
        const restarted = await world.restart();
        expect(restarted.origin).not.toBe(restarted.previousOrigin);
        // A desktop relaunch opens the workspace landing page; reopen the
        // persisted conversation rather than testing automatic route restore.
        await user.click({ role: "button", label: new RegExp(`^${longHistoryTitle}`) });
      } else {
        await user.reload();
      }
      await user.see({ text: longHistoryLast }, { timeoutMs: 60_000 });
      await user.see("composer", { editable: true, text: "" });
      await user.click("composer");
      await user.press("ArrowUp");
      await user.see("composer", { text: longHistoryLast });
      await user.press("ArrowUp");
      await user.see("composer", { text: "Stored history message 149 of 150." });
      await user.press("ArrowDown");
      await user.see("composer", { text: longHistoryLast });
      await user.press("ArrowDown");
      await user.see("composer", { text: "" });
    });
  }
  await step("an unsent draft is not overwritten by recall", async () => {
    const draft = "Keep this unsent draft";
    await user.type("composer", draft);
    await user.press("ArrowUp");
    await user.see("composer", { text: draft });
    await user.reload();
    await user.see("composer", { editable: true, text: draft });
    await user.click("composer");
    await user.press("ArrowUp");
    await user.see("composer", { text: draft });
  });
  await step("an unrelated empty conversation has no recall history", async () => {
    await user.click({ role: "button", label: new RegExp(`^${longHistoryOtherTitle}`) });
    await user.see("composer", { editable: true, text: "" });
    await user.click("composer");
    await user.press("ArrowUp");
    await user.see("composer", { text: "" });
    await user.notSee({ text: longHistoryLast });
  });
});
