import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { taskActivityWeb } from "../worlds/task-activity-web.ts";

const test = spec.world(taskActivityWeb, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("a member keeps the original task and working time when sending a follow-up (ACT-01)", async ({ world, user, probe, step, evidence }) => {
  await user.type("composer", world.prompt);
  await user.click("Run task");
  const native = await probe.eventually(() => world.native(), {
    within: 90_000, intervalMs: 100, label: "native delegation has a running child association",
    until: (value) => Boolean(value?.childId),
  });
  if (!native?.childId) throw new Error("Missing native child association");
  expect(native.status, JSON.stringify(native)).toBe("running");
  evidence.recordJsonArtifact("Native delegation identity", native);
  const readWorkingFooter = () => probe.eval(() =>
    document.querySelector('[data-loading-message="working"]')?.textContent ?? "",
  );
  const working = await probe.eventually(readWorkingFooter, {
    within: 5_000, intervalMs: 100, label: "parent working footer remains visible during delegation",
    until: (value) => /^Working \d/.test(value),
  });
  const advanced = await probe.eventually(readWorkingFooter, {
    within: 5_000, intervalMs: 100, label: "parent working timer advances while the child is held",
    until: (value) => /^Working \d/.test(value) && value !== working,
  });
  expect(advanced).not.toBe(working);
  evidence.recordJsonArtifact("Parent working footer during delegation", { working, advanced });
  await step("before: the member sees one task with an advancing working timer", async () => {
    await user.see({ text: "Build isolated Azure repro" });
    evidence.recordAssertionEvidence("time advances while the helper is working", `${working} became ${advanced} while native delegation stayed running`, true);
    await user.screenshot();
  });
  const seconds = (text: string) => [...text.matchAll(/(\d+)\s*(h|m|s)/g)]
    .reduce((total, match) => total + Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1), 0);
  await user.type("composer", "What is the update?", { verify: true });
  // Busy Enter queues; the production Cmd/Ctrl+Enter shortcut sends steering now.
  await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await user.see({ text: "Build isolated Azure repro" });
  await user.see({ text: "What is the update?" });
  // TODO(primitive): correlate a visible task row with its initiating message.
  const order = await probe.eval(() => {
    const row = document.querySelector('[data-subagent-run]');
    const original = row?.closest('[data-message-id]');
    const followup = [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(message => message.innerText.includes("What is the update?"));
    return { messageId: original?.getAttribute('data-message-id'),
      childId: row?.getAttribute('data-subagent-session-id'),
      callId: row?.getAttribute('data-subagent-run'),
      precedesFollowup: Boolean(row && followup && (row.compareDocumentPosition(followup) & Node.DOCUMENT_POSITION_FOLLOWING)) };
  });
  expect(order).toMatchObject({ messageId: native.messageId, childId: native.childId,
    callId: native.callId, precedesFollowup: true });
  evidence.recordJsonArtifact("Original task and follow-up order", order);
  await step("after: the follow-up stays after its task and the working timer continues", async () => {
    await user.see({ text: "What is the update?" });
    const continued = await readWorkingFooter();
    expect(seconds(continued)).toBeGreaterThanOrEqual(seconds(advanced));
    evidence.recordAssertionEvidence("follow-up keeps task order and elapsed work", `Original task precedes its follow-up; ${advanced} continues as ${continued}`, true);
    await user.screenshot();
  });
  await user.click({ role: "button", label: /Build isolated Azure repro/ });
  await user.see({ text: /Working/ });
  await user.reload();
  await user.see({ text: /Working/ });
  expect((await probe.dom(`[data-session-surface-id="${native.childId}"]`)).elements).toHaveLength(1);
  expect((await world.replyState()).deliveredChunks).toBe(1);
  await user.notSee({ text: "Activity child finished." });
  await step("reloading keeps the same unfinished helper and its visible working state", async () => {
    await user.see({ text: /Working/ });
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Delegated activity opens the exact live child across reload",
    "Opening the original task and reloading preserves the child session and Working state while the provider remains held.", true);
});
