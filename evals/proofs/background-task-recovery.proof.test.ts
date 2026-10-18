import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundTaskRecovery } from "../worlds/background-task-recovery.ts";

const test = spec.world(backgroundTaskRecovery, { timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] } });

test("a member sees last-known background work when checks fail and useful recovery when a command fails", async ({ world, user, probe, step, evidence }) => {
  await step("a report export runs in the background with one live status shimmer", async () => {
    await user.click({ text: world.session.title });
    await user.type("composer", world.report.prompt);
    await user.click("Run task");
    await user.see({ text: world.report.started }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "1 running background task" });
    const shimmers = await probe.eventually(async () => (await probe.dom("[data-background-tasks-line] .ow-text-shimmer")).elements.length, {
      within: 10_000, intervalMs: 100, label: "the count takes the finished turn's status line", until: (count) => count === 1,
    });
    expect(shimmers).toBe(1);
    evidence.recordAssertionEvidence("Confirmed background work has exactly one live shimmer", `status shimmers: ${shimmers}`, shimmers === 1);
    await user.screenshot();
  });
  await step("after: a failed command check retains the count and its age without claiming live progress", async () => {
    world.failChecks();
    await user.click({ text: world.neighbor.title });
    await user.click({ text: world.session.title });
    await user.see({ text: /1 background task last known running · checked .*couldn't verify/ }, { timeoutMs: 30_000 });
    const shimmers = (await probe.dom("[data-background-tasks] .ow-text-shimmer")).elements.length;
    const refused = world.refusedReads();
    expect(refused).toBeGreaterThan(0); expect(shimmers).toBe(0);
    evidence.recordAssertionEvidence("An actual refused check preserves last-known work and removes live shimmer", `refused running-command reads: ${refused}; status shimmers: ${shimmers}`, refused > 0 && shimmers === 0);
    await user.screenshot();
  });
  await step("a successful check restores one calm running count without duplicating work", async () => {
    world.restoreChecks();
    await user.click({ text: world.neighbor.title });
    await user.click({ text: world.session.title });
    await user.see({ text: "1 running background task" }, { timeoutMs: 30_000 });
    const positions: number[] = [];
    await probe.eventually(async () => {
      const line = (await probe.dom("[data-background-tasks-line]")).elements[0];
      if (line) positions.push(line.rect.top);
      return positions.length;
    }, { within: 5_000, intervalMs: 500, label: "sample the restored background status line", until: (count) => count >= 6 });
    const jumps = positions.slice(1).filter((position, index) => position < (positions[index] ?? position) - 1).length;
    const shimmers = (await probe.dom("[data-background-tasks-line] .ow-text-shimmer")).elements.length;
    expect(jumps).toBe(0); expect(shimmers).toBe(1);
    evidence.recordAssertionEvidence("Reconciliation keeps one count and a stable status position", `measure-chat-flicker: ${positions.length} samples, ${jumps} upward jumps; shimmers: ${shimmers}`, jumps === 0 && shimmers === 1);
    await user.screenshot();
  });
  await step("a failed background command offers output review instead of exposing a raw exit code as the recovery", async () => {
    await world.release(world.report);
    await user.see({ text: "Background task failed" }, { timeoutMs: 60_000 });
    await user.see({ text: "Ask to review the command's output before trying again." });
    const notices = (await probe.dom('[data-background-task-notice="failed"]')).elements;
    expect(notices).toHaveLength(1);
    const notice = notices[0]?.text ?? "";
    expect(notice).not.toContain("exit 2");
    await user.notSee({ text: "1 running background task" });
    evidence.recordAssertionEvidence("The real process failed once and its command is not replayed", `failed notices: ${notices.length}; useful next action visible; running count removed`, notices.length === 1 && notice.includes("review the command"));
    await user.screenshot();
  });
});
