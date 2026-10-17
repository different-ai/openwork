import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { BrowserTaskInput } from "@openwork/testkit";
import { browserWithoutPermissionPrompts } from "../worlds/browser-without-permission-prompts.ts";

const test = spec.world(browserWithoutPermissionPrompts, {
  timeout: 420_000,
  resources: {
    surfaces: ["desktop"], services: [],
    nativeReason: "Browser tasks use Electron's native page view and the Take over and Resume browser controls.",
  },
});

test("a conversation completes a changing application form and verifies one submission", async ({ world, user, agent, probe, step, evidence }) => {
  const task = (operation: BrowserTaskInput["operation"], args: BrowserTaskInput["args"] = {}) => agent.browserTask({ sessionId: world.session.sessionId, operation, args });
  const witness = () => probe.browserFixtureState(world.origin);
  let tabId: string;
  const act = async (name: string, action: NonNullable<NonNullable<BrowserTaskInput["args"]>["action"]>) => {
    const seen = await task("observe", { tabId });
    expect(seen.ok).toBe(true);
    const ref = seen.elements?.find(element => element.name === name)?.ref;
    if (!ref) throw new Error(`No observed form control named ${name}.`);
    return task("act", { tabId, observationId: seen.observationId, action: { ...action, ref } });
  };

  await step("before: the application contains old values and has not been submitted", async () => {
    await user.click({ text: world.session.title });
    const opened = await task("open", { url: `${world.origin}/forms` });
    if (!opened.ok || !opened.tabId) throw new Error("The application form did not open.");
    tabId = opened.tabId;
    await user.see({ role: "button", label: "Take over" });
    const seen = await task("observe", { tabId });
    expect(seen.elements?.find(element => element.name === "Company name")).toMatchObject({ value: "Old company", required: true });
    expect(seen.elements?.find(element => element.name === "Country")?.options).toContainEqual({ value: "blocked", label: "Unavailable", selected: false, disabled: true });
    expect(seen.elements?.find(element => element.name === "Business account")?.checked).toBe(false);
    expect((await witness()).formSubmissions).toHaveLength(0);
    evidence.recordAssertionEvidence("The agent can inspect the existing form", "Accessible labels, old values, required fields, checked state and unavailable options are visible; submissions: 0", seen.ok);
    await user.screenshot();
  });

  await step("the conversation replaces values and sees validation while live updates continue", async () => {
    expect(await act("Company name", { type: "fill", text: "Example studio" })).toMatchObject({ ok: true, outcome: "verified", control: { value: "Example studio" } });
    expect(await act("Email", { type: "fill", text: "invalid-address" })).toMatchObject({ ok: true, control: { valid: false } });
    expect(await act("Email", { type: "fill", text: "person@example.test" })).toMatchObject({ ok: true, control: { value: "person@example.test", valid: true } });
    expect(await act("Seats", { type: "fill", text: "42" })).toMatchObject({ ok: true, control: { value: "42" } });
    expect(await act("Start date", { type: "fill", text: "2026-10-20" })).toMatchObject({ ok: true, control: { value: "2026-10-20" } });
    expect(await act("Notes", { type: "fill", text: "" })).toMatchObject({ ok: true, control: { value: "" } });
    expect(await act("Notes", { type: "fill", text: "Café studio\nSecond line" })).toMatchObject({ ok: true, control: { value: "Café studio\nSecond line" } });
    expect(await act("Normalized code", { type: "fill", text: "lowercase" })).toMatchObject({ ok: false, code: "value_mismatch", control: { value: "LOWERCASE" } });
    expect(await act("Normalized code", { type: "fill", text: "READY" })).toMatchObject({ ok: true });
    await user.see({ role: "button", label: "Take over" });
    evidence.recordAssertionEvidence("Field receipts reflect the page's retained values", "Old values replaced; notes cleared and filled with Unicode/multiline text; invalid email exposed; normalized value mismatch reported", (await witness()).formSubmissions.length === 0);
    await user.screenshot();
  });

  await step("the conversation selects options and sets controls without toggling them twice", async () => {
    expect(await act("Country", { type: "select", values: ["blocked"] })).toMatchObject({ ok: false, code: "option_unavailable", dispatched: false });
    expect(await act("Country", { type: "select", values: ["uk"] })).toMatchObject({ ok: true, control: { selectedValues: ["uk"] } });
    expect(await act("Languages", { type: "select", values: ["en", "fr"] })).toMatchObject({ ok: true, control: { selectedValues: ["en", "fr"] } });
    expect(await act("Business account", { type: "set_checked", checked: true })).toMatchObject({ ok: true, dispatched: true, control: { checked: true } });
    expect(await act("Business account", { type: "set_checked", checked: true })).toMatchObject({ ok: true, dispatched: false, control: { checked: true } });
    expect(await act("Tax reference", { type: "fill", text: "EXAMPLE-42" })).toMatchObject({ ok: true });
    expect(await act("Express delivery", { type: "set_checked", checked: true })).toMatchObject({ ok: true, control: { checked: true } });
    expect(await act("Email updates", { type: "set_checked", checked: true })).toMatchObject({ ok: true, control: { checked: true } });
    expect(await act("Office", { type: "click" })).toMatchObject({ ok: true });
    const focused = await task("observe", { tabId });
    expect(await task("act", { tabId, observationId: focused.observationId, action: { type: "key", key: "ArrowDown" } })).toMatchObject({ ok: true });
    expect(await act("Account reference", { type: "fill", text: "changed" })).toMatchObject({ ok: false, code: "not_editable", dispatched: false });
    expect(await act("Unavailable field", { type: "fill", text: "changed" })).toMatchObject({ ok: false, code: "element_disabled", dispatched: false });
    await user.see({ role: "button", label: "Take over" });
    evidence.recordAssertionEvidence("Selections and conditional fields retain the intended state", "Single/multiple options, native/custom checked controls and the conditional tax field are set; repeated set_checked dispatches no click", (await witness()).formSubmissions.length === 0);
    await user.screenshot();
  });

  await step("after: the page saves exactly one application with the requested values", async () => {
    expect(await act("Submit application", { type: "click" })).toMatchObject({ ok: true, dispatched: true });
    const saved = await probe.eventually(witness, { within: 5000, label: "the form records the submission", until: state => state.formSubmissions.length === 1 });
    expect(saved.formSubmissions).toEqual([expect.objectContaining({
      company: "Example studio", email: "person@example.test", seats: "42", start: "2026-10-20",
      notes: "Café studio\nSecond line", country: "uk", languages: ["en", "fr"], business: "on",
      tax: "EXAMPLE-42", delivery: "express", updates: true, office: "Paris", code: "READY",
      ticks: expect.any(Number), events: expect.objectContaining({ input: expect.any(Number), change: expect.any(Number), blur: expect.any(Number) }),
    })]);
    const submission = saved.formSubmissions[0];
    expect(submission?.ticks).toBeGreaterThan(0);
    const seen = await task("observe", { tabId });
    expect(seen.text).toContain("Application saved");
    await user.see({ role: "button", label: "Take over" });
    evidence.recordAssertionEvidence("The page and server agree on one completed application", JSON.stringify(saved.formSubmissions), saved.formSubmissions.length === 1 && seen.text?.includes("Application saved") === true);
    await user.screenshot();
  });
});

test("a conversation uses page controls and website tools without prompts while other conversations stay private", async ({ world, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  const task = (operation: BrowserTaskInput["operation"], args: BrowserTaskInput["args"] = {}) => agent.browserTask({ sessionId, operation, args });
  const witness = () => probe.browserFixtureState(world.origin);
  const prompts = /Allow this agent to use the browser\?|Allow for this session|Allow browser control for this thread\?|Allow browser action\?|Allow website action\?|Allow once|Share result/;

  await step("before: the conversation has no browser page open", async () => {
    await user.click({ text: world.session.title });
    await user.see("composer", { editable: true });
    const state = await probe.browserState();
    expect(state.tabs).toHaveLength(0);
    expect((await witness()).pageRequests).toHaveLength(0);
    evidence.recordAssertionEvidence("No page was opened during setup", `${state.tabs.length} browser tabs`, state.tabs.length === 0);
    await user.screenshot();
  });

  const tabId = await step("after: the requested page opens and lists website tools without a permission prompt", async () => {
    const opened = await task("open", { url: world.origin });
    expect(opened.ok).toBe(true);
    if (!opened.tabId) throw new Error("The browser opened no tab.");
    await user.see({ role: "button", label: "Take over" }, { timeoutMs: 30_000 });
    const state = await probe.browserState();
    expect(state.tabs.find(tab => tab.id === opened.tabId)?.ownerSessionId).toBe(sessionId);
    const requested = await probe.eventually(witness, {
      within: 10_000, label: "the site receives the first navigation",
      until: value => value.pageRequests.some(request => request.path === "/"),
    });
    const listed = await task("site_tools", { tabId: opened.tabId });
    expect(listed.ok).toBe(true);
    expect(listed.tools?.map(tool => tool.name)).toContain("save_draft");
    expect(await probe.text()).not.toMatch(prompts);
    evidence.recordAssertionEvidence("The first browser request reaches the site directly", `${requested.pageRequests.length} page request; website tools available: ${listed.tools?.length ?? 0}`, requested.pageRequests.length === 1 && listed.ok);
    await user.screenshot();
    return opened.tabId;
  });

  await step("page controls fill, type and save without a separate confirmation", async () => {
    const observed = await task("observe", { tabId });
    const inputRef = observed.elements?.find(element => element.name === "Draft title")?.ref;
    if (!inputRef) throw new Error("The page has no observed draft field.");
    expect(await task("act", { tabId, observationId: observed.observationId, action: { type: "fill", ref: inputRef, text: "Draft" } }))
      .toMatchObject({ ok: true, dispatched: true });
    await probe.eventually(witness, { within: 5_000, label: "the field receives the fill", until: value => value.inputValue === "Draft" });
    const filled = await task("observe", { tabId });
    expect(await task("act", { tabId, observationId: filled.observationId, action: { type: "key", key: "Backspace" } }))
      .toMatchObject({ ok: true, dispatched: true });
    await probe.eventually(witness, { within: 5_000, label: "the key reaches the field", until: value => value.inputValue === "Draf" });
    const fresh = await task("observe", { tabId });
    const saveRef = fresh.elements?.find(element => element.name === "Save draft")?.ref;
    if (!saveRef) throw new Error("The page has no observed save button.");
    expect(await task("act", { tabId, observationId: fresh.observationId, action: { type: "click", ref: saveRef } }))
      .toMatchObject({ ok: true, dispatched: true });
    const saved = await probe.eventually(witness, { within: 5_000, label: "the site records the click", until: value => value.records.length === 1 });
    expect(saved.records).toEqual([{ method: "dom", count: 1, signedIn: false }]);
    expect((await task("observe", { tabId })).text).toContain("Saved 1");
    expect(await probe.text()).not.toMatch(prompts);
    await user.see({ role: "button", label: "Take over" });
    evidence.recordAssertionEvidence("The page receives the fill, key and click", `Field: ${saved.inputValue}; recorded saves: ${saved.records.length}`, saved.inputValue === "Draf" && saved.records.length === 1);
    await user.screenshot();
  });

  const toolId = await step("a website tool runs once and returns its result without a sharing prompt", async () => {
    const listed = await task("site_tools", { tabId });
    const save = listed.tools?.find(tool => tool.name === "save_draft");
    if (!save) throw new Error("The website has no save tool.");
    const result = await task("site_tool", { tabId, toolId: save.toolId, input: { confirm: true } });
    expect(result).toMatchObject({ ok: true, dispatched: true, result: { saved: 2, signedIn: false } });
    const saved = await probe.eventually(witness, { within: 5_000, label: "the site records the website tool", until: value => value.records.length === 2 });
    expect(saved.records).toEqual([{ method: "dom", count: 1, signedIn: false }, { method: "webmcp", count: 2, signedIn: false }]);
    const observed = await task("observe", { tabId });
    expect(observed.text).toContain("Saved 2");
    expect(await probe.text()).not.toMatch(prompts);
    await user.see({ role: "button", label: "Take over" });
    evidence.recordAssertionEvidence("The callback result and the page agree", `Recorded saves: ${saved.records.length}; page reports Saved 2`, saved.records.length === 2 && observed.text?.includes("Saved 2") === true);
    await user.screenshot();
    return save.toolId;
  });

  await step("a different conversation cannot read the page or reuse its website tool", async () => {
    const before = await witness();
    const foreign = (operation: BrowserTaskInput["operation"], args: BrowserTaskInput["args"]) => agent.browserTask({ sessionId: world.neighbor.sessionId, operation, args });
    const refused = await foreign("observe", { tabId });
    expect(refused).toMatchObject({ ok: false, code: "wrong_conversation" });
    expect(await foreign("site_tool", { tabId, toolId, input: { confirm: true } }))
      .toMatchObject({ ok: false, code: "wrong_conversation" });
    expect((await witness()).records).toEqual(before.records);
    await user.see({ role: "button", label: "Take over" });
    evidence.recordAssertionEvidence("Removing prompts preserves conversation ownership", `Other conversation: ${refused.code}; recorded saves: ${before.records.length}`, refused.code === "wrong_conversation" && before.records.length === 2);
    await user.screenshot();
  });

  await step("Take over pauses browser tasks and Resume browser restores access without another permission prompt", async () => {
    await user.click({ role: "button", label: "Take over" });
    const paused = await task("observe", { tabId });
    expect(paused).toMatchObject({ ok: false, code: "paused" });
    expect(await task("site_tool", { tabId, toolId, input: { confirm: true } }))
      .toMatchObject({ ok: false, code: "paused" });
    expect((await witness()).records).toHaveLength(2);
    await user.click({ role: "button", label: "Resume browser" });
    const resumed = await task("observe", { tabId });
    expect(resumed).toMatchObject({ ok: true, tabId, text: expect.stringContaining("Saved 2") });
    expect(await probe.text()).not.toMatch(prompts);
    evidence.recordAssertionEvidence("Human takeover remains effective", `Paused: ${paused.code}; resumed: ${resumed.ok}; recorded saves: 2`, paused.code === "paused" && resumed.ok);
    await user.screenshot();
  });
});
