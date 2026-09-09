import { expect } from "vitest";
import { browserConversation, browserImageTarget, spec } from "@openwork/testkit";
import type { BrowserTaskInput } from "@openwork/testkit";
import { browserWebMcpWorld, setBrowserEnabled, setBrowserPolicy } from "../worlds/browser-webmcp.ts";
import { attachBuiltinTab, browserTabHandle } from "../worlds/browser-panel.ts";

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

  const listed = await step("The first agent open mounts consent before any GET, then separately requests reading access", async () => {
    expect((await probe.browserState()).tabs).toEqual([]);
    expect(await witness()).toMatchObject({ pageRequests: [], signInCount: 0, records: [], sessionReads: 0 });
    await prompt("Open the controlled project page and discover its website tools.");
    await user.see({ role: "button", label: "Allow origin in this tab" });
    const opening = await conversation();
    expect(opening.calls.map((call) => call.name)).toEqual(["browser_tabs", "browser_open"]);
    expect(opening.calls[0].output).toMatchObject({ ok: true, tabs: [] });
    expect(opening.calls[1].output).toBeUndefined();
    const mounted = await probe.browserState();
    expect(mounted.tabs).toHaveLength(1);
    expect(mounted.tabs[0]).toMatchObject({ id: mounted.activeTabId, ownerSessionId: sessionId, label: "New tab" });
    expect(mounted.visibleSessionId).toBe(sessionId);
    expect(mounted.nativeViews.find((view) => view.tabId === mounted.activeTabId)).toMatchObject({ attached: true, aboveApp: true, visible: false });
    expect((await witness()).pageRequests).toEqual([]);
    await user.notSee({ role: "button", label: "Allow reading this origin" });
    await user.click({ role: "button", label: "Allow origin in this tab" });
    await user.see({ role: "button", label: "Allow reading this origin" });
    const pending = await conversation();
    expect(pending.calls[1].output).toMatchObject({ ok: true, tabId: mounted.activeTabId });
    expect(pending.calls.find((call) => call.name === "webmcp_list_tools")?.output).toBeUndefined();
    expect(await witness()).toMatchObject({ pageRequests: [{ path: "/", signedIn: false }], signInCount: 0, records: [] });
    await user.click({ role: "button", label: "Allow reading this origin" });
    const completed = await probe.eventually(conversation, {
      within: 60_000, until: (value) => value.calls.length === 3 && value.calls.every((call) => call.status === "completed") && !!value.answer,
      label: "the discovery turn completes through the engine",
    });
    expect(completed.calls.map((call) => call.name)).toEqual(["browser_tabs", "browser_open", "webmcp_list_tools"]);
    expect(completed.calls[1].output).toMatchObject({ ok: true, tabId: mounted.activeTabId });
    const result = completed.calls[2].output;
    expect(result).toMatchObject({ ok: true, tabId: mounted.activeTabId, trust: "untrusted-site-content" });
    expect(result?.tools?.map((tool) => tool.name).sort()).toEqual(["read_session", "read_status", "save_draft", "slow_save"]);
    expect(await witness()).toMatchObject({ signInCount: 0, records: [] });
    if (!result?.tabId || !result.tools) throw new Error("No discovered website tools.");
    return { tabId: result.tabId, tools: result.tools };
  });
  const tabId = listed.tabId;
  // Resolve the already-approved exact tab for trusted human sign-in, without a new GET.
  const handle = browserTabHandle(await agent.run("browser.open_url", { url: `${world.origin}/`, provider: "builtin" }));
  expect(handle.tabId).toBe(tabId);
  await using site = await attachBuiltinTab(world.app, handle.targetId);
  expect((await witness()).pageRequests).toEqual([{ path: "/", signedIn: false }]);
  const save = listed.tools.find((tool) => tool.name === "save_draft");
  if (!save) throw new Error("No concrete save tool.");

  await step("Denied and closed pending opens contact no destination and release their blank tabs", async () => {
    const before = await probe.browserState();
    const requests = (await witness()).pageRequests;
    for (const decision of ["deny", "close"]) {
      const pending = task("open", { url: `${world.origin}/navigation-${decision}` });
      await user.see({ role: "button", label: "Allow origin in this tab" });
      const state = await probe.browserState();
      const blank = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (!blank) throw new Error("The pending open has no review tab.");
      expect(state.tabs).toHaveLength(before.tabs.length + 1);
      expect(blank).toMatchObject({ ownerSessionId: sessionId, label: "New tab" });
      expect((await witness()).pageRequests).toEqual(requests);
      if (decision === "deny") await user.click({ role: "button", label: "Deny" });
      else {
        await user.hover({ role: "button", label: `Select tab: ${blank.label}` });
        await user.click({ role: "button", label: `Close tab: ${blank.label}` });
      }
      const result = await pending;
      expect(result).toMatchObject({ ok: false, dispatched: false, mayHaveChangedState: false });
      if (decision === "deny") expect(result.code).toBe("user_denied");
      await probe.eventually(() => probe.browserState(), { within: 5_000, until: (value) => value.tabs.length === before.tabs.length, label: "the refused open releases its blank tab" });
      expect((await probe.browserState()).tabs).toEqual(before.tabs);
      expect((await witness()).pageRequests).toEqual(requests);
    }
  });

  await step("A redirect needs its destination origin approved, and localhost works after explicit approval", async () => {
    const requests = (await witness()).pageRequests;
    const redirect = task("open", { url: `${world.origin}/redirect` });
    await user.see({ role: "button", label: "Allow origin in this tab" });
    expect((await witness()).pageRequests).toEqual(requests);
    await user.click({ role: "button", label: "Allow origin in this tab" });
    const localhost = `http://localhost:${new URL(world.origin).port}`;
    await user.see({ text: `Allow this conversation to connect to ${localhost} in this tab?` });
    await user.see({ role: "button", label: "Allow origin in this tab" });
    // /redirect does not render a page; /fallback would record the destination GET.
    expect((await witness()).pageRequests).toEqual(requests);
    await user.click({ role: "button", label: "Deny" });
    expect(await redirect).toMatchObject({ ok: false });
    expect((await witness()).pageRequests).toEqual(requests);

    const pending = task("open", { url: `${localhost}/localhost-approved` });
    await user.see({ role: "button", label: "Allow origin in this tab" });
    expect((await witness()).pageRequests).toEqual(requests);
    await user.click({ role: "button", label: "Allow origin in this tab" });
    const opened = await pending;
    expect(opened).toMatchObject({ ok: true, visible: true, url: `${localhost}/localhost-approved` });
    expect((await witness()).pageRequests).toEqual([...requests, { path: "/localhost-approved", signedIn: false }]);
    const tools = task("site_tools", { tabId: opened.tabId });
    await user.click({ role: "button", label: "Allow reading this origin" });
    expect(await tools).toMatchObject({ ok: true, tabId: opened.tabId });
    await user.hover({ role: "button", label: "Select tab: Project localhost-approved" });
    await user.click({ role: "button", label: "Close tab: Project localhost-approved" });
    expect(await task("observe", { tabId: opened.tabId })).toMatchObject({ ok: false, code: "tab_closed" });
  });

  await step("The person signs in directly during takeover and resumes the very same tab", async () => {
    expect(await task("observe", { tabId, includeImage: true })).toMatchObject({ ok: false, code: "sign_in_required" });
    await user.click({ role: "button", label: "Take over" });
    expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
    expect(await task("open", { url: `${world.origin}/new` })).toMatchObject({ ok: false, code: "paused" });
    const person = user.on(site);
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
    const requests = (await witness()).pageRequests;
    const navigation = task("navigate", { tabId, url: `${world.origin}/execution-delay` });
    await user.see({ role: "button", label: "Allow origin in this tab" });
    expect((await witness()).pageRequests).toEqual(requests);
    await user.click({ role: "button", label: "Allow origin in this tab" });
    expect(await navigation).toMatchObject({ ok: true });
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
      const released = await probe.eventually(witness, { within: 5_000, until: ({ discovery }) => discovery.canceled + discovery.released === discovery.waiting && discovery.resumed === discovery.released, label: "every pending discovery request was canceled or its released continuation finished" });
      expect(released.discovery.callbacks).toBe(0);
      expect(released.discovery.canceled + released.discovery.resumed).toBe(held.discovery.waiting);
      expect(released.records).toEqual(held.records);
      expect(released.popups).toEqual(held.popups);
      expect(released.pageRequests).toEqual(held.pageRequests);
      expect(await probe.browserState()).toEqual(before);
      expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
      // CDP-injected webpage mouse/key input must not authorize manual redirects.
      const page = user.on(site);
      await page.click({ label: "Draft title" });
      await page.press("ArrowLeft");
      await page.navigate(`${world.origin}/redirect`);
      const blocked = await witness();
      expect(blocked.pageRequests.filter((request) => request.path === "/fallback")).toHaveLength(0);
      expect(blocked.pageRequests).toEqual(released.pageRequests);
      // Only the app's address bar deliberately enables navigation while paused.
      await user.type({ placeholder: "Enter URL..." }, `${world.origin}/execution-delay`, { replace: true });
      await user.press("Enter");
      await page.see({ text: "Session active" });
      await user.see({ role: "button", label: "Resume browser" });
      expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
      await user.click({ role: "button", label: "Resume browser" });
      expect((await task("observe", { tabId })).text).toContain("Nothing saved");
      expect((await witness()).discovery.callbacks).toBe(0);
      evidence.recordAssertionEvidence("Injected webpage input cannot authorize navigation after takeover", "CDP mouse and keyboard input followed by navigation to the redirect left the destination request count at zero. Explicit app address-bar navigation restored the signed-in page while agent operations remained paused until Resume browser.", true);
    } finally {
      await seed.browserFixtureDiscovery(world.app, world.origin, "release");
    }
  });

  await step("Navigation invalidates site tools; DOM fallback uses a fresh observation in the signed-in tab", async () => {
    const navigation = task("navigate", { tabId, url: `${world.origin}/fallback` });
    await user.click({ role: "button", label: "Allow origin in this tab" });
    expect(await navigation).toMatchObject({ ok: true, tabId });
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
    await user.see({ role: "button", label: "Allow origin in this tab" });
    expect((await witness()).pageRequests.filter((request) => request.path === "/popup")).toEqual([]);
    expect((await witness()).popups).toEqual([]);
    await user.click({ role: "button", label: "Allow origin in this tab" });
    await probe.eventually(witness, { within: 10_000, until: (value) => value.popups.length === 1, label: "the popup GET follows its own navigation consent" });
    expect((await task("observe", { tabId: popup.id })).text).toContain("Session active");
    const secure = await probe.eventually(witness, { within: 10_000, until: (value) => value.privileges.some((item) => item.page === "popup"), label: "the popup reports its isolation" });
    expect(secure).toMatchObject({ popups: [true], signInCount: 1 });
    expect(secure.privileges.find((item) => item.page === "popup")).toEqual({ page: "popup", blocked: true, require: "undefined", process: "undefined", Buffer: "undefined" });
    await user.hover({ role: "button", label: "Select tab: Project popup" });
    await user.click({ role: "button", label: "Close tab: Project popup" });
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
    const otherOpen = agent.browserTask({ sessionId: otherId, operation: "open", args: { url: `${world.origin}/other` } });
    await user.click({ role: "button", label: "Allow origin in this tab" });
    const otherTab = await otherOpen;
    const access = agent.browserTask({ sessionId: otherId, operation: "site_tools", args: { tabId: otherTab.tabId } });
    await user.click({ role: "button", label: "Allow reading this origin" });
    expect((await access).ok).toBe(true);
    expect(await agent.browserTask({ sessionId: otherId, operation: "site_tool", args: { tabId: otherTab.tabId, toolId: ownTool.toolId, input: { confirm: true } } })).toMatchObject({ ok: false, code: "wrong_conversation" });
    const before = await probe.browserState();
    const requests = (await witness()).pageRequests;
    let settled = false;
    const backgroundOpen = task("open", { url: `${world.origin}/background` }).then((result) => { settled = true; return result; });
    await probe.eventually(() => probe.browserState(), { within: 10_000, until: (value) => value.tabs.length === before.tabs.length + 1, label: "the background open allocates a review tab without switching conversations" });
    expect(await probe.browserState()).toMatchObject({ visibleSessionId: before.visibleSessionId, activeTabId: before.activeTabId });
    expect(settled).toBe(false);
    expect((await witness()).pageRequests).toEqual(requests);
    await user.notSee({ role: "button", label: "Allow origin in this tab" });
    expect((await witness()).records).toHaveLength(2);
    await user.click({ text: world.session.title });
    await user.see({ role: "button", label: "Allow origin in this tab" });
    expect((await witness()).pageRequests).toEqual(requests);
    await user.click({ role: "button", label: "Allow origin in this tab" });
    expect(await backgroundOpen).toMatchObject({ ok: true, visible: true });
    expect((await witness()).pageRequests).toEqual([...requests, { path: "/background", signedIn: true }]);
    const ownerTab = (await probe.browserState()).tabs.find((tab) => tab.id === tabId);
    if (!ownerTab) throw new Error("The original tab was lost.");
    const background = await probe.browserState();
    expect(background.visibleSessionId).toBe(sessionId);
    expect(background.activeTabId).not.toBe(tabId);
    expect(background.nativeViews.find((view) => view.tabId === tabId)).toMatchObject({ attached: false, aboveApp: false });
    const actions = [
      { type: "click" }, { type: "fill", text: "must not be entered" }, { type: "key", key: "Enter" }, { type: "scroll", x: 20, y: 20, deltaY: 100 },
    ] satisfies NonNullable<BrowserTaskInput["args"]>["action"][];
    for (const action of actions) {
      const observed = await task("observe", { tabId });
      const ref = observed.elements?.find((element) => element.name === (action.type === "fill" ? "Draft title" : "Save draft"))?.ref;
      if (!ref) throw new Error("Missing hidden page control.");
      expect(await task("act", { tabId, observationId: observed.observationId, action: { ...action, ref } })).toMatchObject({ ok: false, code: "needs_attention", dispatched: false });
    }
    expect(await task("site_tool", { tabId, toolId: ownTool.toolId, input: { confirm: true } })).toMatchObject({ ok: false, code: "needs_attention", dispatched: false });
    await user.notSee({ role: "button", label: "Allow once" });
    expect(await probe.browserState()).toEqual(background);
    expect(await witness()).toMatchObject({ inputValue: "", records: [{ method: "webmcp", count: 1, signedIn: true }, { method: "dom", count: 1, signedIn: true }] });
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
    const native = await probe.browserState();
    expect(native).toMatchObject({ activeTabId: tabId, visibleSessionId: sessionId });
    expect(native.nativeViews.find((view) => view.tabId === tabId)).toMatchObject({ attached: true, aboveApp: true, visible: true, bounds: { width: point.width, height: point.height } });
    const pending = task("act", { tabId, observationId: observed.observationId, action: { type: "click", x: point.x, y: point.y } });
    await user.see({ role: "button", label: "Allow once" });
    expect((await witness()).frameClicks).toBe(0);
    expect((await probe.browserState()).nativeViews.find((view) => view.tabId === tabId)?.visible).toBe(false);
    await user.click({ role: "button", label: "Allow once" });
    expect(await pending).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    const clicked = await probe.eventually(witness, { within: 5_000, until: (value) => value.frameClicks === 1 && value.frameInputs.some((input) => input.type === "click"), label: "the iframe received one visual click" });
    expect(clicked.frameClicks).toBe(1);
    expect(clicked.frameInputs.filter((input) => input.type === "click")).toEqual([expect.objectContaining({ page: "/frame-allowed", target: "BUTTON", trusted: true })]);
    expect((await probe.browserState()).nativeViews.find((view) => view.tabId === tabId)).toMatchObject({ attached: true, aboveApp: true, visible: true });
    expect(await task("act", { tabId, observationId: observed.observationId, action: { type: "click", x: point.x, y: point.y } })).toMatchObject({ ok: false, code: "stale_observation" });
    const fresh = await task("observe", { tabId, includeImage: true });
    expect(fresh.observationId).not.toBe(observed.observationId);
    expect(fresh.image?.data).not.toBe(observed.image?.data);
    expect((await witness()).records).toHaveLength(2);
    evidence.recordAssertionEvidence("Frame permissions and visual fallback preserve isolation", "Nested fallback iframe markup did not grant the undelegated sibling tools. Both cross-origin frames reported no Node globals. The approved PNG-derived click reached the child control once, changed a fresh image, and could not reuse the consumed observation.", true);
  });

  await step("Spoofed page globals and forged policy payloads cannot expose non-origin-keyed callbacks", async () => {
    expect(await task("navigate", { tabId, url: `${world.origin}/origin-policy` })).toMatchObject({ ok: true });
    const reported = await probe.eventually(witness, {
      within: 15_000, until: (value) => value.originPolicyReports.length === 2,
      label: "the hostile frame reports both its explicit opt-out and retained site-keyed document",
    });
    expect(reported.originPolicyReports).toEqual([
      { page: "/origin-policy-opt-out", reason: "origin_agent_cluster_opt_out", nativeOriginAgentCluster: false, spoofedOriginAgentCluster: true, spoofedDomainMatchesHost: true, directOriginKeyed: false, forgedOriginKeyed: false, registration: "SecurityError", execution: "SecurityError" },
      { page: "/origin-policy-spoof", reason: "non_origin_keyed", nativeOriginAgentCluster: false, spoofedOriginAgentCluster: true, spoofedDomainMatchesHost: true, directOriginKeyed: false, forgedOriginKeyed: false, registration: "SecurityError", execution: "SecurityError" },
    ]);
    const listed = await probe.eventually(() => task("site_tools", { tabId }), {
      within: 10_000, until: (value) => !!value.tools?.some((tool) => tool.name === "frame_allowed"),
      label: "normal delegated tools remain available beside the hostile frame",
    });
    expect(listed.tools?.map((tool) => tool.name)).toEqual(["frame_allowed"]);
    await user.notSee({ role: "button", label: "Allow once" });
    expect(await witness()).toMatchObject({ originPolicyCallbacks: 0, records: reported.records });
    evidence.recordAssertionEvidence("Origin-keying decisions do not trust the website's JavaScript world", "Both main-world getters returned eligible values and the page directly supplied forged policy booleans. Native opt-out and retained site-keying still refused registration and execution. A forged modelContext did not enter host discovery; the delegated sibling stayed available and no unsafe callback ran.", true);
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
    const navigation = task("navigate", { tabId, url: `${world.origin}/denied` });
    await user.click({ role: "button", label: "Allow origin in this tab" });
    expect((await navigation).ok).toBe(true);
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
