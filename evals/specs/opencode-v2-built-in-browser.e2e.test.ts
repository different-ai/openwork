import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { v2BuiltInBrowser } from "../worlds/v2-built-in-browser.ts";

const test = spec.world(v2BuiltInBrowser, { timeout: 420_000,
  resources: { surfaces: ["desktop"], services: ["mock"], nativeReason: "The built-in browser uses Electron's native page view and browser approval UI." },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

test("a v2 conversation opens its built-in browser with approval and keeps other conversations' tabs private", async ({ world, user, agent, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  const sessionId = world.session.sessionId;
  const native = `/workspace/${world.workspace.workspaceId}/opencode2/api`;
  let tabId = "";
  await step("before: the conversation has no browser page open", async () => {
    await user.see("composer", { editable: true });
    const state = await probe.browserState();
    expect(state.tabs.filter(tab => tab.ownerSessionId === sessionId)).toHaveLength(0);
    evidence.recordAssertionEvidence("no browser tab was opened by fixture setup", "The native browser reports zero tabs owned by this conversation.", true);
    await user.screenshot();
  });
  await step("after: approving browser control opens the requested page", async () => {
    const prompt = `Open the built-in browser at ${world.pageOrigin}. ${randomUUID()}`;
    const reply = `The browser is open. ${randomUUID()}`;
    await world.prepareTurn(prompt, reply, [{ tool: "browser_tabs", arguments: {} }, { tool: "browser_open", arguments: { url: world.pageOrigin } }]);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: "Allow browser control for this thread?" }, { timeoutMs: 60_000 });
    expect((await probe.browserFixtureState(world.pageOrigin)).pageRequests).toHaveLength(0);
    await user.click({ role: "button", label: "Allow for this thread" });
    await user.see({ text: reply }, { timeoutMs: 90_000 });
    const state = await probe.eventually(() => probe.browserState(), { within: 15_000, label: "the requested page has its owned tab",
      until: state => state.tabs.some(tab => tab.ownerSessionId === sessionId) });
    await probe.eventually(() => probe.browserFixtureState(world.pageOrigin), { within: 15_000, label: "the fixture receives the browser navigation",
      until: state => state.pageRequests.some(request => request.path === "/") });
    const tab = state.tabs.find(tab => tab.ownerSessionId === sessionId);
    if (!tab) throw new Error("The browser opened no owned tab");
    tabId = tab.id;
    const messages = await probe.desktopApi(`${native}/session/${sessionId}/message`);
    expect(JSON.stringify(messages.body)).toContain("browser_open");
    expect(JSON.stringify(messages.body)).not.toContain("Unknown tool");
    evidence.recordAssertionEvidence("the native v2 tool opened the real browser after approval", "The requested site received the navigation and the native tab belongs to the requesting conversation; the site received no navigation before approval.", true);
    await user.screenshot();
  });
  await step("a different conversation cannot read that tab", async () => {
    const created = await agent.desktopApi(`${native}/session`, { method: "POST", body: { title: "Separate browser task" } });
    if (!record(created.body) || !record(created.body.data) || typeof created.body.data.id !== "string") throw new Error("The separate native conversation was not created");
    const other = created.body.data.id;
    const refused = await agent.browserTask({ sessionId: other, operation: "observe", args: { tabId } });
    expect(refused).toMatchObject({ ok: false, code: "wrong_conversation" });
    await user.see({ text: "The browser is open." });
    expect((await probe.browserState()).tabs.find(tab => tab.id === tabId)?.ownerSessionId).toBe(sessionId);
    evidence.recordAssertionEvidence("the existing browser ownership boundary remains enforced", `A different native conversation's observation was refused with ${refused.code}; the tab stayed owned by the requester.`, true);
    await user.screenshot();
  });
});
