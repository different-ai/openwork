import { expect } from "vitest";
import { browserConversation, browserImageTarget, spec } from "@openwork/testkit";
import type { BrowserTaskInput } from "@openwork/testkit";
import { browserWebMcpWorld, setBrowserEnabled, setBrowserPolicy } from "../worlds/browser-webmcp.ts";

const test = spec.world(browserWebMcpWorld);

test("a conversation signs in, uses site tools and page controls with consent, isolation and recovery", async ({ world, seed, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  const task = (operation: BrowserTaskInput["operation"], args: BrowserTaskInput["args"] = {}) => agent.browserTask({ sessionId, operation, args });
  const witness = () => probe.browserFixtureState(world.origin);
  const conversation = async () => {
    const response = await probe.desktopApi(`${world.enginePath}/session/${sessionId}/message`);
    expect(response.status).toBe(200);
    return browserConversation(response.body);
  };
  const prompt = async (text: string) => {
    const response = await agent.desktopApi(`${world.enginePath}/session/${sessionId}/prompt_async`, {
      method: "POST", body: { model: { providerID: "browser-fixture", modelID: "fixture" }, parts: [{ type: "text", text }] },
    });
    expect(response.status).toBe(204);
  };

  const listed = await step("The engine discovers tools in the owned tab only after website access approval", async () => {
    expect(await witness()).toMatchObject({ signInCount: 0, records: [], sessionReads: 0 });
    await prompt("Open the controlled project page and discover its website tools.");
    await user.see({ role: "button", label: "Allow once" });
    const pending = await conversation();
    expect(pending.calls.find((call) => call.name === "webmcp_list_tools")?.output).toBeUndefined();
    expect(await witness()).toMatchObject({ signInCount: 0, records: [] });
    await user.click({ role: "button", label: "Allow once" });
    const completed = await probe.eventually(conversation, {
      within: 60_000, until: (value) => value.calls.length === 3 && value.calls.every((call) => call.status === "completed") && !!value.answer,
      label: "the discovery turn completes through the engine",
    });
    expect(completed.calls.map((call) => call.name)).toEqual(["browser_tabs", "browser_open", "webmcp_list_tools"]);
    expect(completed.calls[1].output).toMatchObject({ ok: true, tabId: world.tab.tabId });
    const result = completed.calls[2].output;
    expect(result).toMatchObject({ ok: true, tabId: world.tab.tabId, trust: "untrusted-site-content" });
    expect(result?.tools?.map((tool) => tool.name).sort()).toEqual(["read_session", "read_status", "save_draft", "slow_save"]);
    expect(await witness()).toMatchObject({ signInCount: 0, records: [] });
    if (!result?.tabId || !result.tools) throw new Error("No discovered website tools.");
    return { tabId: result.tabId, tools: result.tools };
  });
  const tabId = listed.tabId;
  const save = listed.tools.find((tool) => tool.name === "save_draft");
  if (!save) throw new Error("No concrete save tool.");

  await step("The person signs in directly during takeover and resumes the very same tab", async () => {
    expect(await task("observe", { tabId, includeImage: true })).toMatchObject({ ok: false, code: "sign_in_required" });
    await user.click({ role: "button", label: "Take over" });
    expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
    expect(await task("open", { url: `${world.origin}/new` })).toMatchObject({ ok: false, code: "paused" });
    const person = user.on(world.site);
    await person.see({ text: "Signed out" });
    await person.type({ label: "Fixture user" }, "fixture-user");
    await person.type({ label: "Fixture password" }, "fixture-password", { sensitive: true });
    expect(await witness()).toMatchObject({ signInCount: 0, records: [] });
    await person.click({ role: "button", label: "Sign in to project" });
    await person.see({ text: "Session active" });
    expect(await witness()).toMatchObject({ signInCount: 1, records: [] });
    expect(await probe.browserState()).toMatchObject({ activeTabId: tabId, visibleSessionId: sessionId });
    await user.click({ role: "button", label: "Resume browser" });
    const resumed = await task("observe", { tabId, includeImage: true });
    expect(resumed).toMatchObject({ ok: true, tabId });
    expect(resumed.text).toContain("Session active");
    expect(resumed.image?.data.length).toBeGreaterThan(100);
    evidence.recordAssertionEvidence("Explicit in-tab sign-in survives human takeover and resume", "The initial GET and filled-but-unsubmitted form recorded zero sign-ins. Only trusted form submission established the fixture session. Paused operations were refused and the same owned tab resumed with Session active.", true);
  });

  await step("Invalid input and denied action consent never invoke a website callback", async () => {
    expect(await task("site_tool", { tabId, toolId: save.toolId, input: { confirm: false } })).toMatchObject({ ok: false, code: "invalid_input" });
    const pending = task("site_tool", { tabId, toolId: save.toolId, input: { confirm: true } });
    await user.see({ role: "button", label: "Deny" });
    expect((await witness()).records).toEqual([]);
    await user.click({ role: "button", label: "Deny" });
    expect(await pending).toMatchObject({ ok: false, code: "user_denied" });
    expect((await witness()).records).toEqual([]);
  });

  await step("Execution approval and result sharing are separate, then the engine observes completion", async () => {
    await prompt("Save the controlled draft with its website tool, then verify the saved result in the page.");
    await user.see({ role: "button", label: "Allow once" });
    expect(await witness()).toMatchObject({ records: [], model: { receivedSaveResult: false, observedSaved: false } });
    await user.click({ role: "button", label: "Allow once" });
    await user.see({ role: "button", label: "Share result" });
    expect(await witness()).toMatchObject({
      signInCount: 1, records: [{ method: "webmcp", count: 1, signedIn: true }],
      model: { receivedSaveResult: false, observedSaved: false },
    });
    const withheld = await conversation();
    expect(withheld.calls.find((call) => call.name === "webmcp_call_tool")?.output).toBeUndefined();
    expect(withheld.calls.some((call) => call.name === "browser_observe")).toBe(false);
    expect(withheld.answer).not.toBe("Saved the draft and verified Saved 1 in the page.");
    await user.click({ role: "button", label: "Share result" });
    const completed = await probe.eventually(conversation, {
      within: 60_000, until: (value) => value.calls.length === 5 && value.calls.every((call) => call.status === "completed") && value.answer === "Saved the draft and verified Saved 1 in the page.",
      label: "the engine verifies the approved save in a new observation",
    });
    expect(completed.calls.slice(3).map((call) => call.name)).toEqual(["webmcp_call_tool", "browser_observe"]);
    expect(completed.calls[3].output).toMatchObject({ ok: true, dispatched: true, outcome: "callback_returned_verify_outcome", result: { saved: 1, signedIn: true } });
    expect(completed.calls[4].output).toMatchObject({ ok: true, tabId });
    expect(completed.calls[4].output?.text).toContain("Saved 1");
    expect(await witness()).toMatchObject({ signInCount: 1, records: [{ method: "webmcp", count: 1, signedIn: true }], model: { receivedSaveResult: true, observedSaved: true } });
    evidence.recordAssertionEvidence("No action before approval, no disclosure before sharing, no success before observation", "The fixture saw no save at execution review. It saw exactly one authenticated save at result review, while neither the model nor the transcript had its result. Sharing released the receipt; browser_observe then verified Saved 1 before the final answer.", true);
  });

  await step("A session-reading callback cannot disclose its result when sharing is denied", async () => {
    const secret = listed.tools.find((tool) => tool.name === "read_session");
    if (!secret) throw new Error("Missing session-read tool.");
    let settled = false;
    const pending = task("site_tool", { tabId, toolId: secret.toolId }).then((result) => { settled = true; return result; });
    await user.see({ role: "button", label: "Allow once" });
    expect((await witness()).sessionReads).toBe(0);
    await user.click({ role: "button", label: "Allow once" });
    await user.see({ role: "button", label: "Share result" });
    expect((await witness()).sessionReads).toBe(1);
    expect(settled).toBe(false);
    await user.click({ role: "button", label: "Deny" });
    const withheld = await pending;
    expect(withheld).toMatchObject({ ok: false, code: "result_withheld", mayHaveChangedState: true });
    expect(withheld.result).toBeUndefined();
    expect(JSON.stringify(withheld)).not.toContain("fixture_session");
    expect(await witness()).toMatchObject({ sessionReads: 1, records: [{ method: "webmcp", count: 1, signedIn: true }] });
  });

  await step("Takeover cancels a running callback and rejects new writes until human resume", async () => {
    const slow = listed.tools.find((tool) => tool.name === "slow_save");
    if (!slow) throw new Error("Missing cancellation fixture tool.");
    const pending = task("site_tool", { tabId, toolId: slow.toolId });
    await user.click({ role: "button", label: "Allow once" });
    await probe.eventually(witness, { within: 10_000, until: (value) => value.signals.includes("started"), label: "the callback started" });
    await user.click({ role: "button", label: "Take over" });
    expect(await pending).toMatchObject({ ok: false, mayHaveChangedState: true });
    const canceled = await probe.eventually(witness, { within: 10_000, until: (value) => value.signals.includes("canceled"), label: "the callback received cancellation" });
    expect(canceled.signals).toEqual(["started", "canceled"]);
    expect(canceled.records).toHaveLength(1);
    expect(await task("site_tool", { tabId, toolId: save.toolId, input: { confirm: true } })).toMatchObject({ ok: false, code: "paused" });
    expect(await task("open", { url: `${world.origin}/new` })).toMatchObject({ ok: false, code: "paused" });
    await user.click({ role: "button", label: "Resume browser" });
    expect((await task("observe", { tabId })).text).toContain("Saved 1");
    expect(await witness()).toMatchObject({ signInCount: 1, signals: ["started", "canceled"], records: [{ method: "webmcp", count: 1, signedIn: true }] });
  });

  await step("Takeover during execution-time discovery prevents a callback from starting after the delay is released", async () => {
    expect(await task("navigate", { tabId, url: `${world.origin}/execution-delay` })).toMatchObject({ ok: true });
    const tools = await task("site_tools", { tabId });
    const delayed = tools.tools?.find((tool) => tool.name === "delayed_save");
    if (!delayed) throw new Error("Missing delayed-discovery tool.");
    const pending = task("site_tool", { tabId, toolId: delayed.toolId });
    await user.see({ role: "button", label: "Allow once" });
    // The host's pre-approval revalidation has finished; delay the next getTools
    // inside actual dispatch, not discovery before the action is approved.
    await seed.browserFixtureDiscovery(world.app, world.origin, "hold");
    try {
      await user.click({ role: "button", label: "Allow once" });
      const held = await probe.eventually(witness, { within: 10_000, until: (value) => value.discovery.waiting >= 1, label: "registered execution waits in discovery before the callback" });
      expect(held.discovery).toMatchObject({ released: 0, resumed: 0, callbacks: 0 });
      const before = await probe.browserState();
      await user.click({ role: "button", label: "Take over" });
      expect(await pending).toMatchObject({ ok: false });
      await user.see({ role: "button", label: "Resume browser" });
      await seed.browserFixtureDiscovery(world.app, world.origin, "release");
      const released = await probe.eventually(witness, { within: 5_000, until: (value) => value.discovery.resumed === value.discovery.waiting, label: "the released discovery continuations have run" });
      expect(released.discovery).toEqual({ waiting: released.discovery.waiting, released: released.discovery.waiting, resumed: released.discovery.waiting, callbacks: 0 });
      expect(released.records).toEqual(held.records);
      expect(released.popups).toEqual(held.popups);
      expect(released.pageRequests).toEqual(held.pageRequests);
      expect(await probe.browserState()).toEqual(before);
      expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
      await user.click({ role: "button", label: "Resume browser" });
      expect((await task("observe", { tabId })).text).toContain("Nothing saved");
      expect((await witness()).discovery.callbacks).toBe(0);
    } finally {
      await seed.browserFixtureDiscovery(world.app, world.origin, "release");
    }
  });

  await step("Navigation invalidates site tools; DOM fallback uses a fresh observation in the signed-in tab", async () => {
    expect(await task("navigate", { tabId, url: `${world.origin}/fallback` })).toMatchObject({ ok: true, tabId });
    expect(await task("site_tool", { tabId, toolId: save.toolId, input: { confirm: true } })).toMatchObject({ ok: false, code: "stale_tool" });
    expect((await task("site_tools", { tabId })).tools).toEqual([]);
    const observed = await task("observe", { tabId, includeImage: true });
    expect(observed.text).toContain("Session active");
    expect(observed.image?.data.length).toBeGreaterThan(100);
    const ref = observed.elements?.find((element) => element.name === "Save draft")?.ref;
    if (!ref) throw new Error("Missing observed Save draft control.");
    const pending = task("act", { tabId, observationId: observed.observationId, action: { type: "click", ref } });
    await user.see({ role: "button", label: "Allow once" });
    expect((await witness()).records).toHaveLength(1);
    await user.click({ role: "button", label: "Allow once" });
    expect(await pending).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    expect(await task("act", { tabId, observationId: observed.observationId, action: { type: "click", ref } })).toMatchObject({ ok: false, code: "stale_observation" });
    const fresh = await probe.eventually(() => task("observe", { tabId }), { within: 5_000, until: (value) => value.text?.includes("Saved 1") === true, label: "the page visibly completes its DOM save" });
    expect(fresh.observationId).not.toBe(observed.observationId);
    expect(fresh.text).toContain("Saved 1");
    const state = await probe.eventually(witness, { within: 5_000, until: (value) => value.records.length === 2, label: "the fixture records the DOM save" });
    expect(state.records).toEqual([{ method: "webmcp", count: 1, signedIn: true }, { method: "dom", count: 1, signedIn: true }]);
    expect(state.signInCount).toBe(1);
    expect(state.pageRequests.filter((request) => request.path === "/fallback")).toEqual([{ path: "/fallback", signedIn: true }]);
  });

  await step("Image-derived input opens an owned popup without losing sign-in or exposing Node", async () => {
    const observed = await task("observe", { tabId, includeImage: true });
    const point = browserImageTarget(observed.image);
    expect(point.pixels).toBeGreaterThan(200);
    const pending = task("act", { tabId, observationId: observed.observationId, action: { type: "click", x: point.x, y: point.y } });
    await user.see({ role: "button", label: "Allow once" });
    expect((await witness()).popups).toEqual([]);
    await user.click({ role: "button", label: "Allow once" });
    expect(await pending).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    const state = await probe.eventually(() => probe.browserState(), { within: 10_000, until: (value) => !!value.activeTabId && value.activeTabId !== tabId, label: "the owned popup becomes active" });
    const popup = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!popup) throw new Error("No owned popup.");
    expect(popup.ownerSessionId).toBe(sessionId);
    expect((await task("observe", { tabId: popup.id })).text).toContain("Session active");
    const secure = await probe.eventually(witness, { within: 10_000, until: (value) => value.privileges.some((item) => item.page === "popup"), label: "the popup reports its isolation" });
    expect(secure).toMatchObject({ popups: [true], signInCount: 1 });
    expect(secure.privileges.find((item) => item.page === "popup")).toEqual({ page: "popup", blocked: true, require: "undefined", process: "undefined", Buffer: "undefined" });
    await user.hover({ role: "button", label: `Select tab: ${popup.label}` });
    await user.click({ role: "button", label: `Close tab: ${popup.label}` });
    expect(await task("observe", { tabId: popup.id })).toMatchObject({ ok: false, code: "tab_closed" });
    evidence.recordAssertionEvidence("Popup ownership, inherited sign-in, and isolation are independently witnessed", "A PNG-derived coordinate opened the popup only after approval. Its request carried the existing session without another sign-in. Hostile popup features exposed no Node globals and could not read the controlled cross-origin response.", true);
  });

  await step("Foreign conversations cannot inspect a tab or reuse its tool handles", async () => {
    expect((await task("navigate", { tabId, url: `${world.origin}/` })).ok).toBe(true);
    const own = await task("site_tools", { tabId });
    const ownTool = own.tools?.find((tool) => tool.name === "save_draft");
    if (!ownTool) throw new Error("Missing fresh owner tool handle.");
    const otherId = await agent.createSession("Separate browser task");
    const operations: BrowserTaskInput["operation"][] = ["observe", "site_tools", "site_tool"];
    for (const operation of operations) {
      expect(await agent.browserTask({ sessionId: otherId, operation, args: { tabId, toolId: ownTool.toolId, input: { confirm: true } } })).toMatchObject({ ok: false, code: "wrong_conversation" });
    }
    const otherTab = await agent.browserTask({ sessionId: otherId, operation: "open", args: { url: `${world.origin}/other` } });
    const access = agent.browserTask({ sessionId: otherId, operation: "site_tools", args: { tabId: otherTab.tabId } });
    await user.click({ role: "button", label: "Allow once" });
    expect((await access).ok).toBe(true);
    expect(await agent.browserTask({ sessionId: otherId, operation: "site_tool", args: { tabId: otherTab.tabId, toolId: ownTool.toolId, input: { confirm: true } } })).toMatchObject({ ok: false, code: "wrong_conversation" });
    const before = await probe.browserState();
    expect(await task("open", { url: `${world.origin}/background` })).toMatchObject({ ok: true, visible: false });
    expect(await probe.browserState()).toMatchObject({ visibleSessionId: before.visibleSessionId, activeTabId: before.activeTabId });
    expect((await witness()).records).toHaveLength(2);
    await user.click({ text: world.session.title });
    const ownerTab = (await probe.browserState()).tabs.find((tab) => tab.id === tabId);
    if (!ownerTab) throw new Error("The original tab was lost.");
    await user.click({ role: "button", label: `Select tab: ${ownerTab.label}` });
  });

  await step("Frame delegation follows actual child frames, with image-only controls still usable", async () => {
    expect((await task("navigate", { tabId, url: `${world.origin}/frames` })).ok).toBe(true);
    const frames = await probe.eventually(() => task("site_tools", { tabId }), { within: 15_000, until: (value) => !!value.tools?.some((tool) => tool.name === "frame_allowed"), label: "the delegated frame registers its tool" });
    expect(frames.tools?.map((tool) => tool.name)).toEqual(["frame_allowed"]);
    const state = await probe.eventually(witness, { within: 10_000, until: (value) => value.privileges.filter((item) => item.page.startsWith("/frame-")).length === 2, label: "both frames report their isolation" });
    expect(state.privileges.filter((item) => item.page.startsWith("/frame-")).sort((a, b) => a.page.localeCompare(b.page))).toEqual([
      { page: "/frame-allowed", require: "undefined", process: "undefined", Buffer: "undefined" },
      { page: "/frame-denied", require: "undefined", process: "undefined", Buffer: "undefined" },
    ]);
    const observed = await task("observe", { tabId, includeImage: true });
    expect(observed.elements?.some((element) => element.name === "Frame action")).toBe(false);
    const point = browserImageTarget(observed.image, [238, 111, 18]);
    const pending = task("act", { tabId, observationId: observed.observationId, action: { type: "click", x: point.x, y: point.y } });
    await user.see({ role: "button", label: "Allow once" });
    expect((await witness()).frameClicks).toBe(0);
    await user.click({ role: "button", label: "Allow once" });
    expect(await pending).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    expect((await probe.eventually(witness, { within: 5_000, until: (value) => value.frameClicks === 1, label: "the iframe received one visual click" })).frameClicks).toBe(1);
    expect(await task("act", { tabId, observationId: observed.observationId, action: { type: "click", x: point.x, y: point.y } })).toMatchObject({ ok: false, code: "stale_observation" });
    const fresh = await task("observe", { tabId, includeImage: true });
    expect(fresh.observationId).not.toBe(observed.observationId);
    expect(fresh.image?.data).not.toBe(observed.image?.data);
    expect((await witness()).records).toHaveLength(2);
    evidence.recordAssertionEvidence("Frame permissions and visual fallback preserve isolation", "Nested fallback iframe markup did not grant the undelegated sibling tools. Both cross-origin frames reported no Node globals. The approved PNG-derived click reached the child control once, changed a fresh image, and could not reuse the consumed observation.", true);
  });

  await step("Hostile schemas are rejected promptly without blocking observations or Take over", async () => {
    expect(await task("navigate", { tabId, url: `${world.origin}/hostile-schema` })).toMatchObject({ ok: true });
    const before = await witness();
    const started = Date.now();
    const result = await task("site_tools", { tabId });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.tools?.map((tool) => tool.name).sort()).toEqual(["read_session", "read_status", "save_draft", "slow_save"]);
    expect(result.rejectedTools).toEqual([
      expect.objectContaining({ name: "hostile_format", code: "unsupported_schema", error: expect.stringContaining("format") }),
      expect.objectContaining({ name: "hostile_pattern", code: "unsupported_schema", error: expect.stringContaining("pattern") }),
      expect.objectContaining({ name: "hostile_properties", code: "unsupported_schema", error: expect.stringContaining("patternProperties") }),
    ]);
    await user.notSee({ role: "button", label: "Allow once" });
    expect((await task("observe", { tabId })).text).toContain("Session active");
    await user.click({ role: "button", label: "Take over" });
    await user.see({ role: "button", label: "Resume browser" }, { timeoutMs: 5_000 });
    expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
    expect(await witness()).toMatchObject({ records: before.records, popups: before.popups, pageRequests: before.pageRequests });
    await user.click({ role: "button", label: "Resume browser" });
    expect((await task("observe", { tabId })).text).toContain("Nothing saved");
  });

  await step("Real Den origin and upload policy blocks requests before fixture writes, and can be updated", async () => {
    expect((await task("navigate", { tabId, url: `${world.origin}/denied` })).ok).toBe(true);
    expect((await task("site_tools", { tabId })).tools).toEqual([]);
    const den = await seed.den({ org: { name: "Browser restrictions" } });
    await seed.signIn(world.app, den.admin, "admin");
    await agent.run("route.session");
    await agent.run("session.open", { sessionId });
    const policy = async (origins: string[] | null, blockBrowserUploads = false) => {
      await setBrowserPolicy(seed, world.app, den, origins, blockBrowserUploads);
      await probe.eventually(async () => {
        const response = await probe.desktopApi("/managed-policy");
        expect(response.status).toBe(200);
        return response.body;
      }, { within: 30_000, label: "the desktop receives the real Den execution policy", until: (value) => {
        if (!value || typeof value !== "object" || !("policy" in value) || !value.policy || typeof value.policy !== "object" || !("execution" in value.policy)) return false;
        const execution = value.policy.execution;
        return !!execution && typeof execution === "object" && "blockBrowserUploads" in execution && execution.blockBrowserUploads === blockBrowserUploads
          && JSON.stringify("browserOrigins" in execution ? execution.browserOrigins : null) === JSON.stringify(origins);
      } });
    };
    await policy([world.origin], true);
    expect(await task("navigate", { tabId, url: `${world.origin}/allowed` })).toMatchObject({ ok: true, tabId });
    expect((await task("observe", { tabId })).text).toContain("Session active");
    const before = await witness();
    expect(await task("navigate", { tabId, url: `http://localhost:${new URL(world.origin).port}/` })).toMatchObject({ ok: false, code: "website_blocked" });
    expect(await task("navigate", { tabId, url: world.origin.replace("http:", "https:") })).toMatchObject({ ok: false, code: "website_blocked" });
    expect((await task("navigate", { tabId, url: `${world.origin}/redirect` })).ok).toBe(false);
    const afterRedirect = await task("observe", { tabId });
    if (afterRedirect.ok) expect(afterRedirect.url && new URL(afterRedirect.url).origin).toBe(world.origin);
    expect((await witness()).pageRequests).toEqual(before.pageRequests);
    expect(await task("navigate", { tabId, url: `${world.origin}/allowed` })).toMatchObject({ ok: true });
    // Reuse the owned page; isolate upload enforcement from origin enforcement.
    await policy(null, true);
    expect(await agent.browserRequest({ url: `${world.origin}/upload`, method: "POST", body: "controlled-upload" })).toMatchObject({ reached: false });
    expect(await witness()).toMatchObject({ uploads: 0, signInCount: 1, records: before.records });
    await policy([]);
    expect(await task("open", { url: `${world.origin}/blocked` })).toMatchObject({ ok: false, code: "website_blocked" });
    expect(await task("navigate", { tabId, url: `${world.origin}/` })).toMatchObject({ ok: false, code: "website_blocked" });
    expect(await task("site_tool", { tabId, toolId: save.toolId, input: { confirm: true } })).toMatchObject({ ok: false, code: "website_blocked" });
    expect(await witness()).toMatchObject({ uploads: 0, records: before.records, signInCount: 1 });
    await policy(null);
    expect(await agent.browserRequest({ url: `${world.origin}/upload`, method: "POST", body: "controlled-upload" })).toMatchObject({ reached: true });
    expect((await witness()).uploads).toBe(1);
    expect(await task("navigate", { tabId, url: `${world.origin}/fallback` })).toMatchObject({ ok: true, tabId });
    expect((await task("observe", { tabId })).text).toContain("Session active");
    const active = (await probe.browserState()).tabs.find((tab) => tab.id === tabId);
    if (!active) throw new Error("The original browser tab was lost.");
    await user.hover({ role: "button", label: `Select tab: ${active.label}` });
    await user.click({ role: "button", label: `Close tab: ${active.label}` });
    expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "tab_closed" });
    await setBrowserEnabled(seed, world.app, false);
    expect(await task("open", { url: world.origin })).toMatchObject({ ok: false, code: "browser_disabled" });
    const disabledState = await probe.browserState();
    const disabledRequests = (await witness()).pageRequests;
    const legacy = await agent.desktopApi("/experimental/ui-control/request", { method: "POST", body: {
      kind: "command", input: { id: "browser.open_url", args: { url: `${world.origin}/disabled`, provider: "builtin" }, origin: { sessionId } },
    } });
    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({ ok: false, error: expect.stringMatching(/Enable OpenWork Browser/i) });
    expect(await probe.browserState()).toEqual(disabledState);
    expect((await witness()).pageRequests).toEqual(disabledRequests);
    expect(await witness()).toMatchObject({ uploads: 1, frameClicks: 1, records: before.records, signInCount: 1, signals: ["started", "canceled"] });
    evidence.recordAssertionEvidence("Current Den execution policy blocks origin, redirect, upload and deny-all attempts", "The desktop reported exact browserOrigins and blockBrowserUploads from real administrator PATCHes. Blocked requests produced no fixture writes. The identical upload succeeded only after its restriction was removed. An empty origin list denied all; clearing it restored the same signed-in tab. Closed and disabled handles remained refused.", true);
  });
});
