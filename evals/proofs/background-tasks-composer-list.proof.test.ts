import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundTasksComposer } from "../worlds/background-tasks-shimmer.ts";

const test = spec.world(backgroundTasksComposer, {
  timeout: 480_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

test("a member whose agent leaves commands running sees them listed on the composer, like its agents", async ({ world, user, probe, step, evidence }) => {
  const rows = async () => (await probe.dom("[data-background-tasks] [data-background-task-command]")).elements.map((element) => element.text.trim());

  await step("the agent leaves a report export running and the composer lists it under Background tasks", async () => {
    await user.type("composer", world.report.prompt);
    await user.click("Run task");
    await user.see({ text: world.report.started }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "Background tasks" }, { timeoutMs: 30_000 });
    await user.see({ text: "1 running" }, { timeoutMs: 30_000 });
    const found = await probe.eventually(rows, {
      within: 15_000, intervalMs: 150, label: "one command row on the composer", until: (list) => list.length === 1,
    });
    evidence.recordAssertionEvidence("One command row on the composer", JSON.stringify(found), found.length === 1);
    expect(found).toHaveLength(1);
    await user.screenshot();
  });

  await step("while the agent keeps working, the Working line is only Working and the composer lists both commands", async () => {
    await user.type("composer", world.images.prompt);
    await user.click("Run task");
    await user.see({ text: /Working \d+s/ }, { timeoutMs: 30_000 });
    const working = (await probe.dom('[data-loading-message="working"] .ow-text-shimmer')).elements.map((element) => element.text.trim());
    const found = await probe.eventually(rows, {
      within: 30_000, intervalMs: 150, label: "two command rows on the composer", until: (list) => list.length === 2,
    });
    evidence.recordAssertionEvidence(
      "No count on the Working line; two command rows on the composer",
      `working: ${JSON.stringify(working)}; rows: ${JSON.stringify(found)}`,
      working.length === 1 && /^Working \d+s$/.test(working[0] ?? "") && found.length === 2,
    );
    expect(working).toHaveLength(1);
    expect(working[0]).toMatch(/^Working \d+s$/);
    expect(found).toHaveLength(2);
    await user.screenshot();
  });

  await step("once the turn ends, both commands stay listed", async () => {
    await user.see({ text: world.images.started }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "2 running" }, { timeoutMs: 30_000 });
    const found = await rows();
    evidence.recordAssertionEvidence("Both rows remain after the turn", JSON.stringify(found), found.length === 2);
    expect(found).toHaveLength(2);
    await user.screenshot();
  });

  await step("when both commands finish, the list goes away", async () => {
    await world.release(world.report);
    await world.release(world.images);
    await user.see({ text: world.report.wake }, { timeoutMs: 60_000 });
    await user.see({ text: world.images.wake }, { timeoutMs: 60_000 });
    const left = (await probe.eventually(async () => (await probe.dom("[data-background-tasks]")).elements, {
      within: 30_000, intervalMs: 150, label: "the list goes away", until: (found) => found.length === 0,
    })).length;
    evidence.recordAssertionEvidence("No background task list once every command has ended", `lists on screen: ${left}`, left === 0);
    expect(left).toBe(0);
    await user.screenshot();
  });
});
