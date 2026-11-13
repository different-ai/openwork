import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerUseWorld } from "../worlds/desktop-chat-features.ts";

const test = spec.world(computerUseWorld, {
  resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "Computer readiness uses the Electron broker and real macOS helper." },
});

// The chat header used to carry a Computer status button; setup now lives in Settings.
const headerComputerControls = '[data-session-header] [aria-label^="Computer"]';
const settingsStatus = (state?: string) => `[data-testid="settings-computer-status"]${state ? `[data-state="${state}"]` : ""}`;

test("a person sets up computer use once in Settings, the chat header shows no computer status, without per-chat approval", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await step("before: the chat header shows no computer status", async () => {
    await probe.eventually(() => probe.dom("[data-session-header]"), { within: 60_000, until: (dom) => dom.elements.length === 1, label: "the chat header is on screen" });
    const controls = await probe.dom(headerComputerControls);
    expect(controls.elements).toHaveLength(0);
    const browserButtons = await probe.dom('button[aria-label^="Browser"]');
    expect(browserButtons.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("No status in the chat", "With computer use and the floating browser available, the chat header has no Computer button or status and one Browser button.", controls.elements.length === 0 && browserButtons.elements.length === 1);
    await user.screenshot();
  });
  await agent.run("settings.panel.open", { panel: "computer" });
  if (!world.platform.toLowerCase().includes("mac")) {
    await step("after: Settings reports that this platform has no native computer use", async () => {
      await probe.eventually(() => probe.dom(settingsStatus("unsupported")), { within: 60_000, until: (dom) => dom.elements.length === 1, label: "Settings reports unsupported" });
      const current = await world.snapshot();
      expect(current.readiness).toBe("unsupported");
      expect(current.session).toBeNull();
      evidence.recordAssertionEvidence("Native platform boundary", "The real helper reports unsupported, Settings says so and no native session exists.", current.readiness === "unsupported" && current.session === null);
      await user.screenshot();
    });
    return;
  }
  await step("after: Settings shows this Mac's computer use setup for every chat", async () => {
    await user.see({ testId: "settings-computer-status" }, { timeoutMs: 60_000 });
    const current = await world.snapshot();
    expect(current.enabled).toBe(true);
    await user.notSee({ text: "Allow for this chat" });
    await user.notSee({ text: "Always allow" });
    evidence.recordAssertionEvidence("Computer use is generally available", "Settings shows the real helper's readiness, with no Allow for this chat or Always allow controls.", current.enabled);
    await user.screenshot();
  });
});
