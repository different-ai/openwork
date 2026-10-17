import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerUseWorld } from "../worlds/desktop-chat-features.ts";

const test = spec.world(computerUseWorld, {
  resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "Computer readiness and rollout cancellation use the Electron broker and real macOS helper." },
});

test("a person gets computer access from the rollout without chat consent, and an admin can turn it off", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  const button = { testId: "session-computer-control" };
  if (!world.platform.toLowerCase().includes("mac")) {
    await step("native Mac control stays unavailable on an unsupported platform", async () => {
      const current = await world.snapshot();
      expect(current.readiness).toBe("unsupported");
      expect(current.session).toBeNull();
      await user.notSee(button);
      evidence.recordAssertionEvidence("Native platform boundary", "The real helper reports unsupported and no Mac computer button or native session is exposed.", current.readiness === "unsupported" && current.session === null);
      await user.screenshot();
    });
    return;
  }
  await step("before: enabling the rollout makes computer controls available in a new chat", async () => {
    await user.see(button, { timeoutMs: 60_000 });
    await user.click(button);
    await user.see({ testId: "session-computer-popover" });
    const current = await world.snapshot();
    expect(current.enabled).toBe(true);
    await user.notSee({ text: "Allow for this chat" });
    await user.notSee({ text: "Always allow" });
    evidence.recordAssertionEvidence("The rollout supplies access", "A new chat is enabled without Allow for this chat or Always allow controls; the popover shows the real helper's readiness.", current.enabled);
    await user.screenshot();
    await user.press("Escape");
  });
  await step("after: turning the rollout off removes the control and blocks computer work", async () => {
    await world.setCapabilities({ computerUse: false });
    await probe.eventually(() => probe.dom('[data-testid="session-computer-control"]'), { within: 60_000, until: (dom) => dom.elements.length === 0, label: "the rollout removes the computer control" });
    const current = await world.snapshot();
    expect(current.enabled).toBe(false);
    expect(current.session).toBeNull();
    evidence.recordAssertionEvidence("The rollout disables access", "The control disappears and the broker reports disabled with no native session.", !current.enabled && current.session === null);
    await user.screenshot();
  });
});
