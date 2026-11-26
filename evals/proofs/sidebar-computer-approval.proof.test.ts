import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sidebarComputerApproval } from "../worlds/sidebar-computer-approval.ts";

const test = spec.world(sidebarComputerApproval, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] } });

test("a person can spot and dismiss a computer-use approval from the chat sidebar", async ({ world, user, probe, step, evidence }) => {
  const row = (id: string) => ({ testId: `sidebar-session-${id}` });
  const attention = (id: string) => `[data-testid="sidebar-session-${id}"][aria-label$=", Needs your action"] [data-session-attention-indicator]`;
  const attentionCount = async (id: string) => (await probe.dom(attention(id))).elements.length;
  const approval = row(world.approval.sessionId);
  const unrelated = row(world.unrelated.sessionId);
  const card = { testId: "session-computer-request" };
  await user.resizeViewport({ width: 1280, height: 850, deviceScaleFactor: 1 });
  await user.reload();

  await step("before: neither chat asks for attention", async () => {
    await user.see(approval, { timeoutMs: 45_000 });
    await user.see(unrelated);
    await user.click(unrelated);
    const counts = await Promise.all([attentionCount(world.approval.sessionId), attentionCount(world.unrelated.sessionId)]);
    evidence.recordAssertionEvidence("No approval indicator appears before the request", `Attention dots in the two chats: ${counts.join(", ")}.`, counts.join() === "0,0");
    await user.screenshot();
    expect(counts).toEqual([0, 0]);
  });

  let attentionWhilePending = -1;
  await step("after: the sidebar marks the other chat when a private value needs approval", async () => {
    const delivered = await world.publish();
    expect(delivered, "the running app subscribed to the preload's approval event").toBe(true);
    await user.see(unrelated);
    await user.notSee(card);
    // Keep recording on base: the next step proves the missing dot was not a missing approval.
    await probe.eventually(() => attentionCount(world.approval.sessionId), {
      within: 2_000, label: "the background chat gains the attention dot", until: count => count === 1,
    }).catch(() => undefined);
    attentionWhilePending = await attentionCount(world.approval.sessionId);
    const untouched = await attentionCount(world.unrelated.sessionId);
    evidence.recordAssertionEvidence("Only the chat with the pending request gains an attention dot", `Approval chat attention dots=${attentionWhilePending}; unrelated chat attention dots=${untouched}; still viewing the unrelated chat.`, attentionWhilePending === 1 && untouched === 0);
    await user.screenshot();
    expect(untouched).toBe(0);
  });

  await step("when the person opens the marked chat, the approval card is waiting", async () => {
    await user.click(approval);
    await user.see(card, { text: /Fill this field on demo\.invalid\?/ });
    const open = (await probe.hash()).includes(world.approval.sessionId);
    evidence.recordAssertionEvidence("The indicated chat contains the private-value approval card", "The card asks whether to fill a field on demo.invalid. No value is typed or used.", open);
    await user.screenshot();
    expect(open).toBe(true);
  });

  await step("after: choosing Don't fill clears the card and its sidebar marker", async () => {
    await user.click({ testId: "session-computer-credential-dismiss" });
    await user.notSee(card);
    const dismissed = await world.dismissed();
    const left = await attentionCount(world.approval.sessionId);
    evidence.recordAssertionEvidence("The dismissal clears the pending approval", `The preload received the matching dismissal: ${dismissed}; card hidden; remaining attention dots=${left}.`, dismissed && left === 0);
    await user.screenshot();
    expect(dismissed).toBe(true);
    expect(left).toBe(0);
  });
  expect(attentionWhilePending, "the pending approval card should mark its sidebar row").toBe(1);
});
