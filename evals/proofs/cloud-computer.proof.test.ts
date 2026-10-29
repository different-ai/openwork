import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { cloudComputerWorld } from "../worlds/cloud-computer.ts";

const test = spec.world(cloudComputerWorld, { resources: { surfaces: ["appWeb"], services: ["den"] } });

test("a member opens their cloud computer without consent prompts and sees a useful setup state until its desktop is installed", async ({ world, user, agent, probe, step, evidence }) => {
  const button = { testId: "session-cloud-computer" };
  const controlVisible = async () => (await probe.dom('[data-testid="session-cloud-computer"]')).elements.length > 0;
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await step("before: a member without the remote computer rollout has no cloud control", async () => {
    await user.see("composer");
    await user.notSee(button);
    evidence.recordAssertionEvidence("Remote access is off", "The signed-in member's Web chat has no cloud computer control while remoteComputers is off.", !(await controlVisible()));
    await user.screenshot();
  });
  await step("after: enabling the rollout opens the computer directly and explains missing setup", async () => {
    await world.setRemote(true);
    await user.see(button, { timeoutMs: 60_000 });
    await user.click(button);
    await user.see({ testId: "cloud-computer-view" });
    await user.see({ text: "This workspace has no cloud computer. Ask your administrator to finish setup." }, { timeoutMs: 30_000 });
    await user.notSee({ text: "Allow for this chat" });
    await user.notSee({ text: "Always allow" });
    const visible = (await probe.dom('[data-testid="cloud-computer-view"]')).elements.length > 0;
    expect(visible).toBe(true);
    evidence.recordAssertionEvidence("Direct access with an honest setup state", "The computer opens without an approval card. This worker has no desktop image, so it asks the administrator to finish setup and shows no stale image.", visible);
    await user.screenshot();
    await user.press("Escape");
  });
  await step("turning the rollout off removes the control again", async () => {
    await world.setRemote(false);
    await probe.eventually(controlVisible, { within: 60_000, until: visible => !visible, label: "remote computer rollout is off" });
    await user.notSee(button);
    evidence.recordAssertionEvidence("The rollout can be reverted", "The cloud computer entry point disappears when the organization rollout is disabled.", !(await controlVisible()));
    await user.screenshot();
  });
});
