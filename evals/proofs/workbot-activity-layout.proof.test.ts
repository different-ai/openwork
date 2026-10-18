import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotActivity } from "../worlds/workbot-activity.ts";

const test = spec.world(workbotActivity, { timeout: 60_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member sees real command milestones without a jumping or artificially held activity line", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("before: the member can still read the incomplete report", async () => {
    await user.see({ text: "The report has three sections." });
    evidence.recordAssertionEvidence("The existing answer remains readable", "The incomplete report is visible before the next request", (await probe.text()).includes("The report has three sections."));
    await user.screenshot();
  });
  await step("after: three real command milestones arrive promptly without shifting the card or composer", async () => {
    await user.type({ role: "textbox", label: "Message Workbot" }, "Check progress");
    await user.press("Enter");
    await user.see({ text: "Checking section 1" });
    const samples: Array<{ stage: number; top: number; composerTop: number; height: number }> = [];
    const arrivalMs = new Map<number, number>();
    await probe.eventually(async () => {
      const stage = world.progressStage();
      const updatedAt = world.progressUpdatedAt();
      const cards = await probe.dom('div[class~="max-w-[480px]"][class~="rounded-[14px]"]');
      const composer = await probe.dom("[data-workbot-composer]");
      const card = cards.elements.at(-1);
      const input = composer.elements[0];
      if (card && input) {
        samples.push({ stage, top: card.rect.top, composerTop: input.rect.top, height: card.rect.height });
        if (stage % 2 === 1 && card.text.includes(`Checking section ${(stage + 1) / 2}`) && !arrivalMs.has(stage)) arrivalMs.set(stage, Date.now() - updatedAt);
      }
      return stage;
    }, { within: 8000, label: "three commands settle without holding an obsolete status", until: stage => stage === 6 });
    const upwardJumps = samples.slice(1).filter((value, index) => value.top < (samples[index]?.top ?? value.top) - 1);
    const cardRange = Math.max(...samples.map(sample => sample.top)) - Math.min(...samples.map(sample => sample.top));
    const composerRange = Math.max(...samples.map(sample => sample.composerTop)) - Math.min(...samples.map(sample => sample.composerTop));
    expect(new Set(samples.map(sample => sample.stage)).size).toBeGreaterThanOrEqual(4);
    expect([...arrivalMs.keys()]).toEqual([1, 3, 5]);
    expect(Math.max(...arrivalMs.values())).toBeLessThan(500);
    expect(upwardJumps).toHaveLength(0);
    expect(cardRange).toBeLessThanOrEqual(1);
    expect(composerRange).toBeLessThanOrEqual(1);
    evidence.recordAssertionEvidence("1280×900: zero upward jumps and each command is visible within 500 ms", JSON.stringify({ arrivalMs: [...arrivalMs], upwardJumps: upwardJumps.length, cardRange, composerRange, samples }), upwardJumps.length === 0 && cardRange <= 1 && composerRange <= 1 && arrivalMs.size === 3);
    await user.screenshot();
  });
  await step("the failed final command ends honestly and the answer appears without simulated typing", async () => {
    await user.see({ text: "I couldn't verify every section." });
    await user.see({ text: "Computer work couldn't finish" });
    expect((await probe.dom('div[class~="max-w-[480px]"][class~="rounded-[14px]"]')).elements.at(-1)?.text).toContain("Computer work couldn't finish");
    expect((await probe.dom(".workbot-worker, .workbot-typing-dot")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Failure is not converted to a success badge", "The full final answer is visible; computer work couldn't finish", (await probe.text()).includes("I couldn't verify every section."));
    await user.screenshot();
  });
});
