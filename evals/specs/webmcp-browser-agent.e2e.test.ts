import { expect } from "vitest";
import { browserConversation, browserImageTarget, spec } from "@openwork/testkit";
import type { BrowserTaskInput, BrowserTaskReply } from "@openwork/testkit";
import { browserWebMcpWorld, setBrowserEnabled, setBrowserPolicy } from "../worlds/browser-webmcp.ts";
import { attachBuiltinTab, browserTabHandle } from "../worlds/browser-panel.ts";

const test = spec.world(browserWebMcpWorld);

test("a conversation is allowed once, then signs in, uses site tools and page controls without more prompts, with isolation and recovery", async ({ world, seed, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  const task = (operation: BrowserTaskInput["operation"], args: BrowserTaskInput["args"] = {}) => agent.browserTask({ sessionId, operation, args });
  const promptText = /Allow this agent to use the browser\?|Allow for this session|Allow browser control for this thread\?|Allow browser action\?|Allow website action\?|Allow once|Share result/;
  const resumeObservation = async (includeImage = false, siblingTabId?: string) => {
    await user.click({ role: "button", label: "Resume browser" });
    if (siblingTabId) expect(await task("observe", { tabId: siblingTabId })).toMatchObject({ ok: true, tabId: siblingTabId });
    const observed = await task("observe", { tabId: listed.tabId, includeImage });
    expect(await probe.text()).not.toMatch(promptText);
    return observed;
  };
  const witness = () => probe.browserFixtureState(world.origin);
  const act = async (args: BrowserTaskInput["args"]) => {
    const result = await task("act", args);
    expect(await probe.text()).not.toMatch(promptText);
    return result;
  };
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

  const listed = await step("One session allow gates the first GET, then discovery needs no other prompt", async () => {
    expect((await probe.browserState()).tabs).toEqual([]);
    expect(await witness()).toMatchObject({ pageRequests: [], signInCount: 0, records: [], sessionReads: 0 });
    await prompt("Open the controlled project page and discover its website tools.");
    await user.see({ text: "Allow this agent to use the browser?" });
    expect((await witness()).pageRequests).toEqual([]);
    await user.click({ role: "button", label: "Allow for this session" });
    const completed = await probe.eventually(async () => {
      expect(await probe.text()).not.toMatch(promptText);
      return conversation();
    }, {
      within: 60_000, until: (value) => value.calls.length === 3 && value.calls.every((call) => call.status === "completed") && !!value.answer,
      label: "the discovery turn completes through the engine without asking for permission",
    });
    const mounted = await probe.browserState();
    expect(mounted.tabs).toHaveLength(1);
    expect(mounted.tabs[0]).toMatchObject({ id: mounted.activeTabId, ownerSessionId: sessionId });
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
  // Resolve the already-open exact tab for trusted human sign-in, without a new GET.
  const handle = browserTabHandle(await agent.run("browser.open_url", { url: `${world.origin}/`, provider: "builtin" }));
  expect(handle.tabId).toBe(tabId);
  await using site = await attachBuiltinTab(world.app, handle.targetId);
  expect((await witness()).pageRequests).toEqual([{ path: "/", signedIn: false }]);
  await step("The first document applies its external stylesheet without a reload", async () => {
    const styled = await probe.eventually(witness, {
      within: 10_000, until: (value) => value.stylesheetReports.length === 1,
      label: "the first document reports its computed heading color after load",
    });
    expect(styled.stylesheetReports).toEqual([{ documentId: "1", path: "/", color: "rgb(23, 87, 131)" }]);
    expect(styled.stylesheetRequests).toEqual(["1"]);
    expect(styled.pageRequests).toEqual([{ path: "/", signedIn: false }]);
    await user.notSee({ text: "This page may be incomplete." });
  });
  const save = listed.tools.find((tool) => tool.name === "save_draft");
  if (!save) throw new Error("No concrete save tool.");

  await step("Denied and closed pending opens contact no destination and release their blank tabs", async () => {
    const before = await probe.browserState();
    const requests = (await witness()).pageRequests;
    for (const decision of ["deny", "close"]) {
      const deniedSessionId = await agent.createSession(`Refused browser ${decision}`);
      const pending = agent.browserTask({ sessionId: deniedSessionId, operation: "open", args: { url: `${world.origin}/navigation-${decision}` } });
      await user.see({ text: "Allow this agent to use the browser?" });
      await user.see({ role: "button", label: "Allow for this session" });
      const state = await probe.browserState();
      const blank = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (!blank) throw new Error("The pending open has no review tab.");
      expect(state.tabs).toHaveLength(before.tabs.length + 1);
      expect(blank).toMatchObject({ ownerSessionId: deniedSessionId, label: "New tab" });
      expect((await witness()).pageRequests).toEqual(requests);
      if (decision === "deny") await user.click({ role: "button", label: "Deny" });
      else {
        await user.hover({ role: "button", label: `Select tab: ${blank.label}` });
        await user.click({ role: "button", label: `Close tab: ${blank.label}` });
      }
      const result = await pending;
      expect(result).toMatchObject({ ok: false, dispatched: false, mayHaveChangedState: false });
      // Closing the tab dismisses the question; only Deny is reported as a denial.
      expect(result.code).toBe(decision === "deny" ? "user_denied" : "canceled");
      await probe.eventually(() => probe.browserState(), { within: 5_000, until: (value) => value.tabs.length === before.tabs.length, label: "the refused open releases its blank tab" });
      expect((await probe.browserState()).tabs).toEqual(before.tabs);
      expect((await witness()).pageRequests).toEqual(requests);
    }
  });

  await user.click({ text: world.session.title });
  await step("The session allow covers another tab and allowed cross-origin redirects", async () => {
    const requests = (await witness()).pageRequests;
    const localhost = `http://localhost:${new URL(world.origin).port}`;
    const opened = await task("open", { url: `${world.origin}/redirect` });
    expect(opened).toMatchObject({ ok: true, visible: true, url: `${localhost}/fallback` });
    expect((await witness()).pageRequests).toEqual([...requests, { path: "/fallback", signedIn: false }]);
    expect((await probe.browserState()).tabs.find((tab) => tab.id === opened.tabId)?.ownerSessionId).toBe(sessionId);
    expect(await task("navigate", { tabId: opened.tabId, url: `${localhost}/localhost-approved` })).toMatchObject({ ok: true, tabId: opened.tabId });
    expect((await witness()).pageRequests).toEqual([...requests, { path: "/fallback", signedIn: false }, { path: "/localhost-approved", signedIn: false }]);
    expect(await task("site_tools", { tabId: opened.tabId })).toMatchObject({ ok: true, tabId: opened.tabId });
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
    const resumed = await resumeObservation(true);
    expect(resumed).toMatchObject({ ok: true, tabId });
    expect(resumed.text).toContain("Session active");
    expect(resumed.image?.data.length).toBeGreaterThan(100);
    evidence.recordAssertionEvidence("Explicit in-tab sign-in survives human takeover and resume", "The initial GET and filled-but-unsubmitted form recorded zero sign-ins. Only trusted form submission established the fixture session. Paused operations were refused; Resume browser returned the same owned tab with Session active and no permission prompt.", true);
  });

  await step("Invalid input never invokes a website callback", async () => {
    expect(await task("site_tool", { tabId, toolId: save.toolId, input: { confirm: false } })).toMatchObject({ ok: false, code: "invalid_input" });
    expect((await witness()).records).toEqual([]);
  });

  await step("A website tool runs and returns its result without another prompt, then the engine observes completion", async () => {
    await prompt("Save the controlled draft with its website tool, then verify the saved result in the page.");
    const completed = await probe.eventually(async () => {
      expect(await probe.text()).not.toMatch(promptText);
      return conversation();
    }, {
      within: 60_000, until: (value) => value.calls.length === 5 && value.calls.every((call) => call.status === "completed") && value.answer === "Saved the draft and verified Saved 1 in the page.",
      label: "the engine runs the save and verifies it in a new observation",
    });
    expect(completed.calls.slice(3).map((call) => call.name)).toEqual(["webmcp_call_tool", "browser_observe"]);
    expect(completed.calls[3].output).toMatchObject({ ok: true, dispatched: true, outcome: "callback_returned_verify_outcome", result: { saved: 1, signedIn: true } });
    expect(completed.calls[4].output).toMatchObject({ ok: true, tabId });
    expect(completed.calls[4].output?.text).toContain("Saved 1");
    expect(await witness()).toMatchObject({ signInCount: 1, records: [{ method: "webmcp", count: 1, signedIn: true }], model: { receivedSaveResult: true, observedSaved: true } });
    evidence.recordAssertionEvidence("A website tool runs once with no prompt and success still needs an observation", "The fixture recorded exactly one authenticated save. The model received the tool result directly, and browser_observe verified Saved 1 before the final answer. No browser permission card appeared.", true);
  });

  await step("Takeover cancels a running callback and rejects new writes until human resume", async () => {
    const sibling = await task("open", { url: `${world.origin}/takeover-sibling` });
    expect(sibling).toMatchObject({ ok: true });
    if (!sibling.tabId || sibling.tabId === tabId) throw new Error("The sibling open did not create a distinct tab.");
    await user.click({ role: "button", label: "Select tab: Project home" });
    const slow = listed.tools.find((tool) => tool.name === "slow_save");
    if (!slow) throw new Error("Missing cancellation fixture tool.");
    const pending = task("site_tool", { tabId, toolId: slow.toolId });
    await probe.eventually(witness, { within: 10_000, until: (value) => value.signals.includes("started"), label: "the callback started" });
    await user.click({ role: "button", label: "Take over" });
    expect(await pending).toMatchObject({ ok: false, mayHaveChangedState: true });
    const canceled = await probe.eventually(witness, { within: 10_000, until: (value) => value.signals.includes("canceled"), label: "the callback received cancellation" });
    expect(canceled.signals).toEqual(["started", "canceled"]);
    expect(canceled.records).toHaveLength(1);
    expect(await task("site_tool", { tabId, toolId: save.toolId, input: { confirm: true } })).toMatchObject({ ok: false, code: "paused" });
    expect(await task("observe", { tabId: sibling.tabId })).toMatchObject({ ok: false, code: "paused" });
    expect(await task("open", { url: `${world.origin}/new` })).toMatchObject({ ok: false, code: "paused" });
    expect((await resumeObservation(false, sibling.tabId)).text).toContain("Saved 1");
    expect((await task("observe", { tabId: sibling.tabId })).text).toContain("Session active");
    await user.hover({ role: "button", label: "Select tab: Project takeover-sibling" });
    await user.click({ role: "button", label: "Close tab: Project takeover-sibling" });
    expect(await witness()).toMatchObject({ signInCount: 1, signals: ["started", "canceled"], records: [{ method: "webmcp", count: 1, signedIn: true }] });
  });

  await step("Takeover during execution-time discovery prevents a callback from starting after the delay is released", async () => {
    const requests = (await witness()).pageRequests;
    expect(await task("navigate", { tabId, url: `${world.origin}/execution-delay` })).toMatchObject({ ok: true });
    expect((await witness()).pageRequests).toEqual([...requests, { path: "/execution-delay", signedIn: true }]);
    const tools = await task("site_tools", { tabId });
    const delayed = tools.tools?.find((tool) => tool.name === "delayed_save");
    if (!delayed) throw new Error("Missing delayed-discovery tool.");
    // Hold the getTools revalidation that runs inside the call itself.
    await seed.browserFixtureDiscovery(world.app, world.origin, "hold");
    try {
      const pending = task("site_tool", { tabId, toolId: delayed.toolId });
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
      expect(blocked.pageRequests.filter((request) => request.path === "/fallback")).toEqual(released.pageRequests.filter((request) => request.path === "/fallback"));
      expect(blocked.pageRequests).toEqual(released.pageRequests);
      // Only the app's address bar deliberately enables navigation while paused.
      await user.type({ placeholder: "Enter URL..." }, `${world.origin}/execution-delay`, { replace: true });
      await user.press("Enter");
      await page.see({ text: "Session active" });
      await user.see({ role: "button", label: "Resume browser" });
      expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
      expect((await resumeObservation()).text).toContain("Nothing saved");
      expect((await witness()).discovery.callbacks).toBe(0);
      evidence.recordAssertionEvidence("Injected webpage input cannot authorize navigation after takeover", "CDP mouse and keyboard input followed by navigation to the redirect left destination requests unchanged. Explicit app address-bar navigation restored the signed-in page while agent operations remained paused until Resume browser.", true);
    } finally {
      await seed.browserFixtureDiscovery(world.app, world.origin, "release");
    }
  });

  await step("Navigation invalidates site tools; a DOM click dispatches without a prompt", async () => {
    const requests = (await witness()).pageRequests;
    expect(await task("navigate", { tabId, url: `${world.origin}/fallback` })).toMatchObject({ ok: true, tabId });
    expect(await task("site_tool", { tabId, toolId: save.toolId, input: { confirm: true } })).toMatchObject({ ok: false, code: "stale_tool" });
    expect((await task("site_tools", { tabId })).tools).toEqual([]);
    const observed = await task("observe", { tabId, includeImage: true });
    expect(observed.text).toContain("Session active");
    expect(observed.image?.data.length).toBeGreaterThan(100);
    const ref = observed.elements?.find((element) => element.name === "Save draft")?.ref;
    if (!ref) throw new Error("Missing observed Save draft control.");
    expect((await witness()).records).toHaveLength(1);
    expect(await act({ tabId, observationId: observed.observationId, action: { type: "click", ref } })).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    expect(await task("act", { tabId, observationId: observed.observationId, action: { type: "click", ref } })).toMatchObject({ ok: false, code: "stale_observation" });
    const fresh = await probe.eventually(() => task("observe", { tabId }), { within: 5_000, until: (value) => value.text?.includes("Saved 1") === true, label: "the page visibly completes its DOM save" });
    expect(fresh.observationId).not.toBe(observed.observationId);
    expect(fresh.text).toContain("Saved 1");
    const state = await probe.eventually(witness, { within: 5_000, until: (value) => value.records.length === 2, label: "the fixture records the DOM save" });
    expect(state.records).toEqual([{ method: "webmcp", count: 1, signedIn: true }, { method: "dom", count: 1, signedIn: true }]);
    expect(state.signInCount).toBe(1);
    expect(state.pageRequests).toEqual([...requests, { path: "/fallback", signedIn: true }]);
  });

  await step("Fill, key and real wheel scrolling dispatch without prompts", async () => {
    const observed = await task("observe", { tabId });
    expect(observed).toMatchObject({ ok: true, scroll: { x: 0, y: 0 } });
    const ref = observed.elements?.find((element) => element.name === "Draft title")?.ref;
    if (!ref) throw new Error("Missing observed Draft title control.");
    expect(await act({ tabId, observationId: observed.observationId, action: { type: "fill", ref, text: "A" } })).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    await probe.eventually(witness, { within: 5_000, until: (value) => value.inputValue === "A", label: "the fill reaches the visible field" });
    const filled = await task("observe", { tabId });
    expect(await act({ tabId, observationId: filled.observationId, action: { type: "key", key: "Backspace" } })).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    await probe.eventually(witness, { within: 5_000, until: (value) => value.inputValue === "", label: "the key clears the focused field" });
    const before = await task("observe", { tabId });
    if (!before.scroll) throw new Error("Observation omitted the real scroll position.");
    const initialY = before.scroll.y;
    expect(await task("act", { tabId, observationId: before.observationId, action: { type: "scroll", x: 20, y: 20, deltaY: 400 } })).toMatchObject({ ok: true, dispatched: true });
    expect(await task("act", { tabId, observationId: before.observationId, action: { type: "scroll", x: 20, y: 20, deltaY: 400 } })).toMatchObject({ ok: false, code: "stale_observation", dispatched: false });
    const down = await probe.eventually(() => task("observe", { tabId }), {
      within: 5_000, until: (value) => value.ok && value.scroll !== undefined && value.scroll.y >= initialY + 400,
      label: "one positive wheel dispatch settles the real page down before the next fresh action",
    });
    if (!down.scroll) throw new Error("Observation omitted the downward scroll position.");
    expect(down.scroll.y).toBeGreaterThan(initialY);
    expect(down.scroll.x).toBe(0);
    const downY = down.scroll.y;
    expect(await task("act", { tabId, observationId: down.observationId, action: { type: "scroll", x: 20, y: 20, deltaY: -400 } })).toMatchObject({ ok: true, dispatched: true });
    const up = await probe.eventually(() => task("observe", { tabId }), {
      within: 5_000, until: (value) => value.ok && value.scroll?.y === initialY,
      label: "one negative wheel dispatch settles the real page up without replay",
    });
    expect(up.scroll?.y).toBeLessThan(downY);
    expect(up.scroll?.x).toBe(0);
    expect((await witness()).records).toHaveLength(2);
  });

  await step("Image-derived input opens an owned popup without losing sign-in or exposing Node", async () => {
    const observed = await task("observe", { tabId, includeImage: true });
    const point = browserImageTarget(observed.image);
    expect(point.pixels).toBeGreaterThan(200);
    expect((await witness()).popups).toEqual([]);
    expect(await act({ tabId, observationId: observed.observationId, action: { type: "click", x: point.x, y: point.y } })).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    const state = await probe.eventually(() => probe.browserState(), { within: 10_000, until: (value) => !!value.activeTabId && value.activeTabId !== tabId, label: "the owned popup becomes active" });
    const popup = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!popup) throw new Error("No owned popup.");
    expect(popup.ownerSessionId).toBe(sessionId);
    await probe.eventually(witness, { within: 10_000, until: (value) => value.popups.length === 1, label: "the popup GET loads without a prompt" });
    expect((await witness()).pageRequests.filter((request) => request.path === "/popup")).toEqual([{ path: "/popup", signedIn: true }]);
    expect((await task("observe", { tabId: popup.id })).text).toContain("Session active");
    const secure = await probe.eventually(witness, { within: 10_000, until: (value) => value.privileges.some((item) => item.page === "popup"), label: "the popup reports its isolation" });
    expect(secure).toMatchObject({ popups: [true], signInCount: 1 });
    expect(secure.privileges.find((item) => item.page === "popup")).toEqual({ page: "popup", blocked: true, require: "undefined", process: "undefined", Buffer: "undefined" });
    await user.hover({ role: "button", label: "Select tab: Project popup" });
    await user.click({ role: "button", label: "Close tab: Project popup" });
    expect(await task("observe", { tabId: popup.id })).toMatchObject({ ok: false, code: "tab_closed" });
    evidence.recordAssertionEvidence("Popup ownership, inherited sign-in, and isolation are independently witnessed", "The PNG-derived click opened the popup without a prompt, and popup navigation and reading needed none either. Its request carried the existing session without another sign-in. Hostile popup features exposed no Node globals and could not read the controlled cross-origin response.", true);
  });

  await step("Foreign conversations cannot inspect a tab or reuse its tool handles", async () => {
    expect((await task("navigate", { tabId, url: `${world.origin}/` })).ok).toBe(true);
    const own = await task("site_tools", { tabId });
    const ownTool = own.tools?.find((tool) => tool.name === "save_draft");
    if (!ownTool) throw new Error("Missing fresh owner tool handle.");
    await user.click({ role: "button", label: "Take over" });
    expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
    await user.click({ role: "button", label: "Resume browser" });
    const otherId = await agent.createSession("Separate browser task");
    const operations: BrowserTaskInput["operation"][] = ["observe", "site_tools", "site_tool"];
    for (const operation of operations) {
      expect(await agent.browserTask({ sessionId: otherId, operation, args: { tabId, toolId: ownTool.toolId, input: { confirm: true } } })).toMatchObject({ ok: false, code: "wrong_conversation" });
    }
    const otherRequests = (await witness()).pageRequests;
    const otherOpen = agent.browserTask({ sessionId: otherId, operation: "open", args: { url: `${world.origin}/other` } });
    // The allow belongs to one session; another session asks for itself once.
    await user.see({ text: "Allow this agent to use the browser?" });
    expect((await witness()).pageRequests).toEqual(otherRequests);
    await user.click({ role: "button", label: "Allow for this session" });
    const otherTab = await otherOpen;
    expect(otherTab).toMatchObject({ ok: true });
    expect((await witness()).pageRequests).toEqual([...otherRequests, { path: "/other", signedIn: true }]);
    expect((await agent.browserTask({ sessionId: otherId, operation: "site_tools", args: { tabId: otherTab.tabId } })).ok).toBe(true);
    expect(await agent.browserTask({ sessionId: otherId, operation: "site_tool", args: { tabId: otherTab.tabId, toolId: ownTool.toolId, input: { confirm: true } } })).toMatchObject({ ok: false, code: "wrong_conversation" });
    await user.click({ text: world.session.title });
    expect(await probe.text()).not.toMatch(promptText);
    const ownerTab = (await probe.browserState()).tabs.find((tab) => tab.id === tabId);
    if (!ownerTab) throw new Error("The original tab was lost.");
    const requests = (await witness()).pageRequests;
    const opened = await task("open", { url: `${world.origin}/background` });
    expect(opened).toMatchObject({ ok: true });
    expect((await witness()).pageRequests).toEqual([...requests, { path: "/background", signedIn: true }]);
    const background = await probe.browserState();
    expect(background.visibleSessionId).toBe(sessionId);
    expect(background.activeTabId).not.toBe(tabId);
    expect(background.nativeViews.find((view) => view.tabId === tabId)).toMatchObject({ attached: false, aboveApp: false });
    // The original tab is now off screen; it still accepts input, and nothing asks the user to select it.
    const hidden = await task("observe", { tabId });
    const titleRef = hidden.elements?.find((element) => element.name === "Draft title")?.ref;
    if (!titleRef) throw new Error("Missing hidden page control.");
    expect(await act({ tabId, observationId: hidden.observationId, action: { type: "fill", ref: titleRef, text: "B" } })).toMatchObject({ ok: true, dispatched: true });
    await probe.eventually(witness, { within: 5_000, until: (value) => value.inputValue === "B", label: "the hidden tab receives the fill" });
    const typed = await task("observe", { tabId });
    expect(await act({ tabId, observationId: typed.observationId, action: { type: "key", key: "Backspace" } })).toMatchObject({ ok: true, dispatched: true });
    await probe.eventually(witness, { within: 5_000, until: (value) => value.inputValue === "", label: "the hidden tab receives the key" });
    expect(await probe.browserState()).toMatchObject({ visibleSessionId: background.visibleSessionId, activeTabId: background.activeTabId });
    expect(await witness()).toMatchObject({ records: [{ method: "webmcp", count: 1, signedIn: true }, { method: "dom", count: 1, signedIn: true }] });
    await user.click({ role: "button", label: `Select tab: ${ownerTab.label}` });
  });

  await step("Frame delegation follows actual child frames, with image-only controls still usable", async () => {
    expect((await task("navigate", { tabId, url: `${world.origin}/frames` })).ok).toBe(true);
    const policy = await probe.eventually(witness, { within: 10_000, until: (value) => value.framePolicyReports.length === 2, label: "both same-origin frames finish their container-policy checks" });
    expect(policy.framePolicyReports.sort((a, b) => a.page.localeCompare(b.page))).toEqual([
      { page: "/frame-same-allowed", registration: "registered", execution: "not_requested" },
      { page: "/frame-same-denied", registration: "NotAllowedError", execution: "NotAllowedError" },
    ]);
    expect(policy.frameToolCalls).toEqual([]);
    const frames = await probe.eventually(() => task("site_tools", { tabId }), { within: 15_000, until: (value) => ["frame_allowed", "frame_same_allowed"].every((name) => value.tools?.some((tool) => tool.name === name)), label: "the delegated and allowed same-origin frames register their tools" });
    expect(frames.tools?.map((tool) => tool.name).sort()).toEqual(["frame_allowed", "frame_same_allowed"]);
    const sameOriginTool = frames.tools?.find((tool) => tool.name === "frame_same_allowed");
    if (!sameOriginTool) throw new Error("Missing allowed same-origin frame tool.");
    expect(sameOriginTool.origin).toBe(world.origin);
    const state = await probe.eventually(witness, { within: 10_000, until: (value) => value.privileges.filter((item) => item.page.startsWith("/frame-")).length === 4, label: "all four frames report their isolation" });
    expect(state.privileges.filter((item) => item.page.startsWith("/frame-")).sort((a, b) => a.page.localeCompare(b.page))).toEqual([
      { page: "/frame-allowed", require: "undefined", process: "undefined", Buffer: "undefined" },
      { page: "/frame-denied", require: "undefined", process: "undefined", Buffer: "undefined" },
      { page: "/frame-same-allowed", require: "undefined", process: "undefined", Buffer: "undefined" },
      { page: "/frame-same-denied", require: "undefined", process: "undefined", Buffer: "undefined" },
    ]);
    expect(await task("site_tool", { tabId, toolId: sameOriginTool.toolId })).toMatchObject({ ok: true, dispatched: true, result: { ok: true } });
    expect((await witness()).frameToolCalls).toEqual(["/frame-same-allowed"]);
    const observed = await task("observe", { tabId, includeImage: true });
    expect(observed.elements?.some((element) => element.name === "Frame action")).toBe(false);
    const point = browserImageTarget(observed.image, [238, 111, 18]);
    const native = await probe.browserState();
    expect(native).toMatchObject({ activeTabId: tabId, visibleSessionId: sessionId });
    expect(native.nativeViews.find((view) => view.tabId === tabId)).toMatchObject({ attached: true, aboveApp: true, visible: true, bounds: { width: point.width, height: point.height } });
    expect((await witness()).frameClicks).toBe(0);
    expect(await act({ tabId, observationId: observed.observationId, action: { type: "click", x: point.x, y: point.y } })).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified" });
    const clicked = await probe.eventually(witness, { within: 5_000, until: (value) => value.frameClicks === 1 && value.frameInputs.some((input) => input.type === "click"), label: "the iframe received one visual click" });
    expect(clicked.frameClicks).toBe(1);
    expect(clicked.frameInputs.filter((input) => input.type === "click")).toEqual([expect.objectContaining({ page: "/frame-allowed", target: "BUTTON", trusted: true })]);
    expect((await probe.browserState()).nativeViews.find((view) => view.tabId === tabId)).toMatchObject({ attached: true, aboveApp: true, visible: true });
    expect(await task("act", { tabId, observationId: observed.observationId, action: { type: "click", x: point.x, y: point.y } })).toMatchObject({ ok: false, code: "stale_observation" });
    const fresh = await task("observe", { tabId, includeImage: true });
    expect(fresh.observationId).not.toBe(observed.observationId);
    expect(fresh.image?.data).not.toBe(observed.image?.data);
    expect((await witness()).records).toHaveLength(2);
    evidence.recordAssertionEvidence("Frame permissions and visual fallback preserve isolation", "Nested fallback iframe markup did not grant the undelegated sibling tools. Explicit same-origin denial blocked registration and execution without a callback; the allowed same-origin tool ran once and returned its result. All four frames reported no Node globals. The PNG-derived click reached the child control once, changed a fresh image, and could not reuse the consumed observation.", true);
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
    expect((await task("observe", { tabId })).text).toContain("Session active");
    await user.click({ role: "button", label: "Take over" });
    await user.see({ role: "button", label: "Resume browser" }, { timeoutMs: 5_000 });
    expect(await task("observe", { tabId })).toMatchObject({ ok: false, code: "paused" });
    expect(await witness()).toMatchObject({ records: before.records, popups: before.popups, pageRequests: before.pageRequests });
    expect((await resumeObservation()).text).toContain("Nothing saved");
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
    const warning = "This page may be incomplete. Your organization's policy blocked a browser request.";
    await user.see({ text: warning });
    const incomplete = await probe.eventually(witness, {
      within: 10_000, until: (value) => value.stylesheetReports.at(-1)?.documentId === String(value.pageRequests.length),
      label: "the allowed document finishes loading despite its blocked external stylesheet",
    });
    expect(incomplete.stylesheetReports.at(-1)).toEqual({ documentId: String(incomplete.pageRequests.length), path: "/allowed", color: "rgb(0, 0, 0)" });
    expect(incomplete.stylesheetRequests).toEqual(before.stylesheetRequests);
    // Reuse the owned page; isolate upload enforcement from origin enforcement.
    await policy(null, true);
    await user.see({ text: warning });
    expect(await witness()).toMatchObject({
      pageRequests: incomplete.pageRequests, stylesheetRequests: incomplete.stylesheetRequests, stylesheetReports: incomplete.stylesheetReports,
    });
    // Restoring policy must not silently retry the failed resource; reload explicitly.
    await user.click({ role: "button", label: "Reload page" });
    const recovered = await probe.eventually(witness, {
      within: 10_000, until: (value) => value.stylesheetReports.at(-1)?.documentId === String(incomplete.pageRequests.length + 1),
      label: "a new document in the same tab applies the now-allowed stylesheet",
    });
    const documentId = String(incomplete.pageRequests.length + 1);
    expect(recovered.stylesheetReports.at(-1)).toEqual({ documentId, path: "/allowed", color: "rgb(23, 87, 131)" });
    expect(recovered.stylesheetRequests).toEqual([...incomplete.stylesheetRequests, documentId]);
    expect(recovered.pageRequests).toEqual([...incomplete.pageRequests, { path: "/allowed", signedIn: true }]);
    expect(await probe.browserState()).toMatchObject({ activeTabId: tabId, visibleSessionId: sessionId });
    await user.notSee({ text: "This page may be incomplete." });
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
