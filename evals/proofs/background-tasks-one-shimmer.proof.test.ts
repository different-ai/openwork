import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundTasksShimmer } from "../worlds/background-tasks-shimmer.ts";

const test = spec.world(backgroundTasksShimmer, {
  timeout: 480_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const RUNNING = /\d+ running background tasks?/;
const SHARED_LINE = /^Working \d+s · 2 running background tasks$/;

test("a member whose agent keeps working with commands in the background sees one shimmer across the whole status line", async ({ world, user, probe, step, evidence }) => {
  const shimmering = async (selector: string) => (await probe.dom(`${selector} .ow-text-shimmer`)).elements.map((element) => element.text.trim());

  await step("the agent leaves a report export running and the chat says 1 running background task", async () => {
    await user.type("composer", world.report.prompt);
    await user.click("Run task");
    await user.see({ text: world.report.started }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "1 running background task" }, { timeoutMs: 30_000 });
    const parts = await probe.eventually(() => shimmering("[data-background-tasks-line]"), {
      within: 15_000, intervalMs: 150, label: "the count on its own line after the turn", until: (found) => found.length > 0,
    });
    evidence.recordAssertionEvidence("The count shimmers on its own line once the turn ends", `shimmering parts: ${parts.length} (${parts.map((text) => `"${text}"`).join(", ")})`, parts.length === 1);
    expect(parts).toEqual(["1 running background task"]);
    await user.screenshot();
  });

  await step("after: while the agent keeps working, one shimmer sweeps Working and the count together", async () => {
    await user.type("composer", world.images.prompt);
    await user.click("Run task");
    await user.see({ text: /Working \d+s · 2 running background tasks/ }, { timeoutMs: 30_000 });
    const parts = await shimmering('[data-loading-message="working"]');
    const single = parts.length === 1 && SHARED_LINE.test(parts[0] ?? "");
    evidence.recordAssertionEvidence(
      "Working and the count share one shimmer, separator included",
      `shimmering parts: ${parts.length} (${parts.map((text) => `"${text}"`).join(", ")})`,
      single,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatch(SHARED_LINE);
    await user.screenshot();
  });

  await step("after: once the turn ends, the count keeps its own single shimmer", async () => {
    await user.see({ text: world.images.started }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "2 running background tasks" }, { timeoutMs: 30_000 });
    const parts = await probe.eventually(() => shimmering("[data-background-tasks-line]"), {
      within: 15_000, intervalMs: 150, label: "the count on its own line after the turn", until: (found) => found.length > 0,
    });
    await user.notSee({ text: /Working \d/ }, { timeoutMs: 1_000 });
    evidence.recordAssertionEvidence("The count alone still shimmers once", `shimmering parts: ${parts.length} (${parts.map((text) => `"${text}"`).join(", ")})`, parts.length === 1);
    expect(parts).toEqual(["2 running background tasks"]);
    await user.screenshot();
  });

  await step("when both commands finish, the count goes away", async () => {
    await world.release(world.report);
    await world.release(world.images);
    await user.see({ text: world.report.wake }, { timeoutMs: 60_000 });
    await user.see({ text: world.images.wake }, { timeoutMs: 60_000 });
    const left = (await probe.eventually(async () => (await probe.dom("[data-background-tasks]")).elements, {
      within: 30_000, intervalMs: 150, label: "the running count goes away", until: (found) => found.length === 0,
    })).length;
    await user.notSee({ text: RUNNING }, { timeoutMs: 1_000 });
    evidence.recordAssertionEvidence("No running count is left once every command has ended", `running counts on screen: ${left}`, left === 0);
    expect(left).toBe(0);
    await user.screenshot();
  });
});
