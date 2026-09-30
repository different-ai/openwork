import { expect } from "vitest";
import { browserConversation, spec } from "@openwork/testkit";
import { browserConsentSummaryWorld } from "../worlds/browser-webmcp.ts";

const test = spec.world(browserConsentSummaryWorld, {
  resources: {
    surfaces: ["desktop"], services: [],
    nativeReason: "The engine browser tools require Electron's native WebContentsView and thread-consent host; appWeb cannot exercise that timeout.",
  },
});

test("a person can review browser access at their own pace and still receive a grounded project summary", async ({ world, agent, user, probe, step }) => {
  const sessionId = world.session.sessionId;
  const request = `Summarize the project briefing at ${world.origin}/briefing, including its launch date and blocker.`;
  const answer = "Project briefing: launch date October 14. Blocker: accessibility review pending.";
  const deniedAnswer = "Browser access was denied; I did not read the project briefing.";
  const conversation = async (id = sessionId) => {
    const response = await probe.desktopApi(`${world.enginePath}/session/${id}/message`);
    expect(response.status).toBe(200);
    if (!Array.isArray(response.body)) throw new Error("The engine returned no messages.");
    const prompts = response.body.filter((message: unknown) =>
      typeof message === "object" && message !== null && "info" in message
      && typeof message.info === "object" && message.info !== null
      && "role" in message.info && message.info.role === "user");
    return { ...browserConversation(response.body), prompts };
  };
  const witness = () => probe.browserFixtureState(world.origin);

  await step("the composer request waits for permission before contacting the project site", async () => {
    expect(request).not.toContain("October 14");
    expect(request).not.toContain("accessibility review pending");
    await user.type("composer", request);
    await user.press("Enter");
    await user.see({ text: "Allow browser control for this thread?" });
    const pending = await conversation();
    expect(pending.prompts).toHaveLength(1);
    expect(pending.calls.map((call) => call.name)).toEqual(["browser_tabs", "browser_open"]);
    expect(pending.calls[0].output).toMatchObject({ ok: true, tabs: [] });
    expect(pending.calls[1].output).toBeUndefined();
    expect((await witness()).pageRequests).toEqual([]);
    await user.screenshot();
  });

  await step("consent remains actionable after more than 31 seconds without replay or a premature answer", async () => {
    const started = Date.now();
    await probe.eventually(async () => {
      const pending = await conversation();
      expect(pending.prompts).toHaveLength(1);
      expect(pending.calls.map((call) => call.name)).toEqual(["browser_tabs", "browser_open"]);
      expect(pending.calls[1].output).toBeUndefined();
      expect(pending.calls[1].status).toBe("running");
      expect(pending.answer).not.toBe(answer);
      expect((await witness()).pageRequests).toEqual([]);
      return Date.now() - started;
    }, { within: 36_000, until: (elapsed) => elapsed > 31_000, label: "the engine's original open remains pending beyond the old deadline" });
    await user.see({ role: "button", label: "Allow for this thread" });
    await user.screenshot();
  });

  await step("one approval delivers the observed launch date and blocker in the original conversation", async () => {
    await user.click({ role: "button", label: "Allow for this thread" });
    const completed = await probe.eventually(conversation, {
      within: 60_000, until: (value) => value.answer === answer,
      label: "the model consumes the real page observation and finishes the original request",
    });
    expect(completed.prompts).toHaveLength(1);
    expect(completed.calls.map((call) => call.name)).toEqual(["browser_tabs", "browser_open", "browser_observe"]);
    expect(completed.calls.every((call) => call.status === "completed")).toBe(true);
    expect(completed.calls[1].output).toMatchObject({ ok: true, provider: "builtin", url: `${world.origin}/briefing` });
    expect(completed.calls[2].output).toMatchObject({ ok: true, tabId: completed.calls[1].output?.tabId });
    expect(completed.calls[2].output?.text).toContain("Launch date: October 14");
    expect(completed.calls[2].output?.text).toContain("Blocker: accessibility review pending");
    expect((await witness()).pageRequests).toEqual([{ path: "/briefing", signedIn: false }]);
    expect((await probe.browserState()).visibleSessionId).toBe(sessionId);
    await user.see({ text: answer });
    await user.screenshot();
  });

  await step("another conversation needs its own approval and denial produces no read or invented summary", async () => {
    const original = await conversation();
    const otherId = await agent.createSession("Separate project briefing");
    await user.type("composer", request);
    await user.press("Enter");
    await user.see({ text: "Allow browser control for this thread?" });
    const pending = await conversation(otherId);
    expect(pending.calls.map((call) => call.name)).toEqual(["browser_tabs", "browser_open"]);
    expect(pending.calls[0].output).toMatchObject({ ok: true, tabs: [] });
    expect(pending.calls[1].output).toBeUndefined();
    expect((await witness()).pageRequests).toEqual([{ path: "/briefing", signedIn: false }]);
    await user.screenshot();
    await user.click({ role: "button", label: "Deny" });
    const denied = await probe.eventually(() => conversation(otherId), {
      within: 60_000, until: (value) => value.answer === deniedAnswer,
      label: "the second engine turn acknowledges denial without reading or replaying",
    });
    expect(denied.prompts).toHaveLength(1);
    expect(denied.calls.map((call) => call.name)).toEqual(["browser_tabs", "browser_open"]);
    expect(denied.calls[1].output).toMatchObject({ ok: false, code: "user_denied", dispatched: false, mayHaveChangedState: false });
    expect((await witness()).pageRequests).toEqual([{ path: "/briefing", signedIn: false }]);
    expect(await conversation()).toEqual(original);
    await user.see({ text: deniedAnswer });
    await user.notSee({ text: answer });
    await user.screenshot();
  });
});
