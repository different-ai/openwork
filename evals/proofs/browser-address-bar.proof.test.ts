import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { browserAddressBar } from "../worlds/browser-address-bar.ts";

const test = spec.world(browserAddressBar, {
  resources: { surfaces: ["desktop"], services: ["den"],
    nativeReason: "A desktop conversation owns the native browser tab receiving the address bar navigation." },
});

test("the browser address bar accepts a search draft and still opens website addresses", async ({ world, agent, user, probe, evidence, step }) => {
  let tabId: string | undefined;
  const address = { role: "textbox", label: "Search Google or enter an address" } as const;
  await step("before: the existing tab offers the address-only field", async () => {
    await agent.run("session.open", { sessionId: world.session.sessionId });
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    await user.see({ testId: "session-browser-toggle" }, { timeoutMs: 60_000 });
    const opened = await agent.browserTask({ sessionId: world.session.sessionId, operation: "open", args: { url: world.page } });
    expect(opened.ok).toBe(true);
    tabId = opened.tabId;
    await user.see({ role: "textbox", label: "Website address" });
    await user.screenshot();
  });
  await step("after: the same tab accepts a search draft, then opens an entered address", async () => {
    await world.enableSearch();
    await user.see(address, { timeoutMs: 90_000 });
    await user.type(address, "meeting notes");
    await user.screenshot();
    await user.press("Escape");
    const destination = world.page + "?view=summary";
    await user.type(address, destination);
    await user.press("Enter");
    const state = await probe.eventually(() => agent.browserTask({ sessionId: world.session.sessionId, operation: "observe", args: { tabId } }), {
      within: 20_000, label: "the built-in browser reaches the entered address", until: reply => reply.url === destination,
    });
    evidence.recordAssertionEvidence("The address reaches the website", "The page has the requested query.", state.url === destination);
    expect(state.url).toBe(destination);
    await user.screenshot();
  });
});
