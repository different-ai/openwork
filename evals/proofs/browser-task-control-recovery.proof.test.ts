import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { browserWithoutPermissionPrompts } from "../worlds/browser-without-permission-prompts.ts";

const test = spec.world(browserWithoutPermissionPrompts, { timeout: 420_000, resources: {
  surfaces: ["desktop"], services: [], nativeReason: "Take over and Resume browser use Electron IPC and the conversation-owned native page view.",
} });

test("a member takes over the native browser and resumes it without granting another conversation access", async ({ world, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  const tabId = await step("the member's conversation opens its own native browser tab", async () => {
    await user.click({ text: world.session.title });
    const opened = await agent.browserTask({ sessionId, operation: "open", args: { url: world.origin } });
    if (!opened.ok || !opened.tabId) throw new Error("The native browser did not open its owned tab.");
    await user.see({ role: "button", label: "Take over" });
    const owner = (await probe.browserState()).tabs.find((tab) => tab.id === opened.tabId)?.ownerSessionId;
    expect(owner).toBe(sessionId);
    evidence.recordAssertionEvidence("The visible page belongs to the current conversation", `owner matches current conversation: ${owner === sessionId}`, owner === sessionId);
    await user.screenshot();
    return opened.tabId;
  });
  await step("after: Take over confirms human control and refuses automated page reads", async () => {
    await user.click({ role: "button", label: "Take over" });
    await user.see({ text: "You have control · resume when finished" });
    await user.see({ role: "button", label: "Resume browser" });
    const paused = await agent.browserTask({ sessionId, operation: "observe", args: { tabId } });
    const foreign = await agent.browserTask({ sessionId: world.neighbor.sessionId, operation: "observe", args: { tabId } });
    expect(paused).toMatchObject({ ok: false, code: "paused" });
    expect(foreign).toMatchObject({ ok: false, code: "wrong_conversation" });
    evidence.recordAssertionEvidence("Confirmed takeover pauses the agent and preserves conversation ownership", `current conversation: ${paused.code}; other conversation: ${foreign.code}`, paused.code === "paused" && foreign.code === "wrong_conversation");
    await user.screenshot();
  });
  await step("Resume browser restores only the owning conversation's page access", async () => {
    await user.click({ role: "button", label: "Resume browser" });
    await user.see({ role: "button", label: "Take over" });
    const resumed = await agent.browserTask({ sessionId, operation: "observe", args: { tabId } });
    const foreign = await agent.browserTask({ sessionId: world.neighbor.sessionId, operation: "observe", args: { tabId } });
    expect(resumed.ok).toBe(true); expect(foreign).toMatchObject({ ok: false, code: "wrong_conversation" });
    evidence.recordAssertionEvidence("A successful IPC resume is reflected in real page access, not an optimistic label", `owner access: ${resumed.ok}; other conversation: ${foreign.code}`, resumed.ok && foreign.code === "wrong_conversation");
    await user.screenshot();
  });
});
