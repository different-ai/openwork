import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerWindowApproval } from "../worlds/computer-window-approval.ts";

const test = spec.world(computerWindowApproval, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("enabled computer access continues without approval and preserves human handoff", async ({ world, user, probe, step, evidence }) => {
  await step("before: enabled access shows no status or permission prompt in the chat", async () => {
    await user.see({ text: "Computer use enabled" });
    await user.notSee({ testId: "session-computer-floating" });
    await user.notSee({ role: "button", label: "Allow this window" });
    expect(world.decisions()).toEqual([]);
    evidence.recordAssertionEvidence("Enabled access needs no approval", "Before work starts the chat shows no computer status or approval control.", world.decisions().length === 0);
    await user.screenshot();
  });
  await step("after: agent work appears without opening a popover or approving access", async () => {
    await world.startWork();
    await user.see({ testId: "session-computer-floating" });
    await user.see({ role: "button", label: "Take over" });
    await user.notSee({ role: "button", label: "Allow this window" });
    evidence.recordAssertionEvidence("The requested target opens directly", "The production broker and adapter started work, and the full chat control displayed Take over without opening a popover or sending an approval.", world.decisions().length === 0);
    await user.screenshot();
  });
  await step("follow-up: technical cleanup reopens directly", async () => {
    await world.followUp();
    await probe.eventually(world.snapshot, { within: 3000, until: value => value.session?.state === "active", label: "the follow-up silently renews its internal session" });
    await user.notSee({ role: "button", label: "Allow this window" });
    expect(world.decisions()).toEqual([]);
  });
  await step("after: takeover stays paused across cleanup until Continue", async () => {
    await user.click({ role: "button", label: "Take over" });
    await user.see({ role: "button", label: "Continue" });
    await world.followUp();
    await probe.eventually(world.snapshot, { within: 3000, until: value => value.session?.state === "paused", label: "the human handoff remains visible after technical cleanup" });
    await user.see({ role: "button", label: "Continue" });
    const blockedBrowser = await world.browserWork();
    expect(blockedBrowser.ok).toBe(false);
    expect(blockedBrowser.error?.code).toBe("computer_paused");
    expect(world.inputs()).toBe(0);
    await user.screenshot();
    await user.click({ role: "button", label: "Continue" });
    await world.followUp();
    await user.see({ role: "button", label: "Take over" });
    expect(world.inputs()).toBe(0);
    evidence.recordAssertionEvidence("Only Continue returns control", "Human takeover survived cleanup. Continue allowed fresh work without replaying an action.", world.inputs() === 0);
  });
  await step("Stop ends the current work", async () => {
    await user.click({ role: "button", label: "Stop" });
    await user.see({ text: "Current work stopped" });
    expect((await world.snapshot()).enabled).toBe(false);
    expect(world.decisions().map(value => Reflect.get(Object(value), "action"))).toEqual(["takeover", "resume"]);
  });
});
