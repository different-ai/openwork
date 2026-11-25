// The task host's side of `fill_from`: the agent names a command, or a name the person pastes the value under, the
// person approves it for the page's site, and the host runs the command and types what it printed, or types what
// was pasted. What is checked before anything runs, what is typed, and that nothing the model can read afterwards
// holds the value. The page functions run unchanged against a stand-in document.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { createPage } from "./browser-page-stand-in.mjs";
import { createBrowserSecrets } from "./browser-secrets.mjs";
import { createBrowserTaskHost } from "./browser-task.mjs";

const SITE = "https://app.example";
const OTHER = "https://other.example";
const SESSION = "s1";
const TAB = "tab-1";
// Made up for the test; the first differs in every encoding a page can echo it in.
const PASSWORD = "made-up pass/+ &42";
const CODE = "735102";
const READ_PASSWORD = ["op", "read", "op://Private/Example/password"];
const READ_CODE = ["/opt/homebrew/bin/bw", "get", "totp", "example.com"];
const HANDOFF = /browser_handoff/;
// What the person pastes into the card, also made up.
const PASTED = "pasted by hand/+ &77";
const ASK = "Example password";

/**
 * A conversation with one tab on a sign-in page and a host that can fill from commands. `answers` maps a command,
 * joined by spaces, to what running it gives; `calls` lists what the host asked of the person, the runner, the page
 * and the browser, in order. `approve` is the person: true is a plain yes with nothing pasted, false a no, and
 * anything else is given to the host as it is, such as `pasting([...])`.
 */
function world({ flag = true, withStore = true, withRunner = true, withApproval = true, url, text, approve = async () => true, approveCredential,
  answers = { [READ_PASSWORD.join(" ")]: { ok: true, value: PASSWORD }, [READ_CODE.join(" ")]: { ok: true, value: CODE } } } = {}) {
  const calls = [];
  const core = createBrowserSecrets();
  const state = { flag, asked: [], answers, notes: [], note: /** @type {(() => void) | null} */ (null) };
  const page = createPage(calls, { url, text });
  const typed = () => calls.filter((call) => Array.isArray(call) && call[0] === "insertText").map((call) => call[1]);
  const ran = () => calls.filter((call) => Array.isArray(call) && call[0] === "run").map((call) => call[1]);
  const given = () => calls.filter((call) => Array.isArray(call) && call[0] === "run").map((call) => call[2]);
  const contents = {
    isDestroyed: () => false, isLoading: () => false,
    getURL: () => page.url, getTitle: () => page.title,
    async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
      page.scripts.push(code);
      return structuredClone(await vm.runInContext(code, page.context));
    },
    async insertText(value) {
      calls.push(["insertText", value]);
      const element = page.document.activeElement;
      if (!element || !("value" in element)) return;
      const kept = element.accepts ? element.accepts(value) : value;
      element.value = element.selected ? kept : element.value + kept;
      element.selected = false;
    },
    async sendInputEvent(event) { if (event.type === "keyDown") calls.push(`key:${event.keyCode}`); },
    captureObservation: async () => Buffer.from("stand-in image"),
    debugger: { isAttached: () => true, attach() {}, detach() {}, on() {}, removeListener() {},
      async sendCommand(method, params) {
        if (method !== "Input.dispatchMouseEvent" || params.type !== "mousePressed") return;
        calls.push("click");
        page.document.elementFromPoint(params.x, params.y)?.onclick?.();
      } },
  };
  const tab = { tabId: TAB, webMcpRevision: 1, webMcpToolCount: 0, view: { webContents: contents } };
  const host = createBrowserTaskHost({
    getTab: (id) => id === TAB ? tab : null, tabsFor: (sessionId) => sessionId === SESSION ? [tab] : [], ownerOf: (id) => id === TAB ? SESSION : null,
    activeFor: () => TAB, isVisible: () => true, openTab: async () => { throw new Error("This test opens no tab."); }, navigate: async () => {},
    allowed: async () => true, enabled: () => true, changed: () => {},
    siteTools: async () => ({ ok: true, tools: [] }), runSiteTool: async () => ({ ok: true }),
    ...(approveCredential ? { approveCredential } : {}),
    ...(withStore ? { secrets: core } : {}),
    valuesEnabled: () => typeof state.flag === "function" ? state.flag() : state.flag,
    noteValueFill: (sessionId, fill) => { state.notes.push({ sessionId, ...fill }); state.note?.(); },
    ...(withApproval ? { approveValues: async (sessionId, request, signal) => { calls.push("approve"); state.asked.push({ sessionId, request, signal }); 
      const answer = await approve(request);
      return answer === true ? { approved: true, values: request.fills.map(() => null), keep: request.fills.map(() => false) }
        : answer === false ? { approved: false, values: [], keep: [] } : answer;
    } } : {}),
    ...(withRunner ? { runValueCommand: async (command, signal, unlock) => {
      calls.push(["run", command, unlock]);
      assert.ok(signal instanceof AbortSignal);
      const answer = state.answers[command.join(" ")] ?? { ok: false, code: "command_not_found" };
      return typeof answer === "function" ? answer(unlock) : answer;
    } } : {}),
  });
  const request = (operation, args = {}) => host.request({ sessionId: SESSION, operation, args });
  return { calls, core, state, page, tab, host, request, typed, ran, given,
    observe: (args = {}) => request("observe", { mode: "interactive", ...args }),
    async act(actions, extra = {}) {
      const observation = await request("observe", { mode: "interactive" });
      assert.equal(observation.ok, true);
      return request("act", { observationId: observation.observationId, actions, ...extra });
    } };
}
const holds = (value, hidden) => JSON.stringify(value).includes(hidden);
/** No value a command printed, in the encodings a page can echo. */
function assertClean(value, hiddenValues = [PASSWORD, CODE]) {
  for (const hidden of hiddenValues) {
    for (const form of [hidden, Buffer.from(hidden, "utf8").toString("base64"), encodeURIComponent(hidden), JSON.stringify(hidden).slice(1, -1)]) {
      assert.ok(!holds(value, form), "a result held what a command printed");
    }
  }
}
const fromCommand = (ref, command) => ({ type: "fill_from", ref, command });
const fromPerson = (ref, ask = ASK) => ({ type: "fill_from", ref, ask });
// A vault that answers only when its session key is in the environment, as Bitwarden's does. All made up.
const KEY = "made-up session key/+ &==99";
const UNLOCK = { env: "BW_SESSION", ask: "Bitwarden session key" };
const KEY_PLACE = { site: "command:/opt/homebrew/bin/bw", label: "BW_SESSION Bitwarden session key" };
const KEY_ROW = { unlock: "BW_SESSION", program: "/opt/homebrew/bin/bw", ask: "Bitwarden session key" };
const BW_PASSWORD = ["/opt/homebrew/bin/bw", "get", "password", "example.com"];
const unlocked = (ref, command, unlock = UNLOCK) => ({ type: "fill_from", ref, command, unlock });
const locked = (value) => (unlock) => unlock?.BW_SESSION === KEY ? { ok: true, value } : { ok: false, code: "command_failed", exitCode: 1, detail: `Vault is locked. Session ${unlock?.BW_SESSION ?? "missing"}` };
const vault = { [BW_PASSWORD.join(" ")]: locked(PASSWORD), [READ_CODE.join(" ")]: locked(CODE) };
/** A yes with these values pasted, one place per field of the card, keeping the ones marked. */
const pasting = (values, keep = values.map(() => false)) => ({ approved: true, values, keep });

test("with the flag off, or without a store, a runner or a way to ask, fill_from runs nothing and says to hand off", async () => {
  for (const options of [{ flag: false }, { flag: "true" }, { flag: () => { throw new Error("unreadable"); } }, { withStore: false }, { withRunner: false }, { withApproval: false }]) {
    const { page, act, calls, typed, ran, observe } = world(options);
    page.input("Password", "password");
    assert.ok(!("privateValues" in await observe()));
    const receipt = await act([fromCommand("e1", READ_PASSWORD)]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "values_unavailable", false]);
    assert.match(receipt.error, HANDOFF);
    assert.deepEqual([typed(), ran(), calls.includes("approve")], [[], [], false]);
  }
});

test("an observation says a field can be filled from a command only on an https page", async () => {
  const secure = world();
  secure.page.input("Password", "password");
  assert.equal((await secure.observe()).privateValues, "fill_from");
  assert.equal((await secure.observe({ mode: "full" })).privateValues, "fill_from");
  const plain = world({ url: "http://app.example/login" });
  plain.page.input("Password", "password");
  assert.ok(!("privateValues" in await plain.observe()));
});

test("fill_from takes a ref and exactly one of a command and a name to ask under, and nothing else", async () => {
  const { page, act, calls, typed, ran } = world();
  for (let index = 0; index < 7; index++) page.input(`Field ${index}`, "text");
  for (const action of [
    { type: "fill_from", command: READ_PASSWORD },
    { type: "fill_from", ref: "e1" },
    { type: "fill_from", ref: "e1", command: READ_PASSWORD.join(" ") },
    { type: "fill_from", ref: "e1", command: [] },
    { type: "fill_from", ref: "e1", command: ["./op", "read"] },
    { type: "fill_from", ref: "e1", command: ["sh", "-c", "op read x\n| cat"] },
    { type: "fill_from", ref: "e1", command: READ_PASSWORD, text: "typed instead" },
    { type: "fill_from", ref: "e1", command: READ_PASSWORD, secretRef: "sec_0000000000000000000000" },
    { type: "fill_from", ref: "e1", command: READ_PASSWORD, env: { BW_SESSION: "x" } },
    { type: "fill_from", ref: "e1", command: READ_PASSWORD, ask: ASK },
    { type: "fill_from", ask: ASK },
    { type: "fill_from", ref: "e1", ask: "" },
    { type: "fill_from", ref: "e1", ask: " padded " },
    { type: "fill_from", ref: "e1", ask: "x".repeat(81) },
    { type: "fill_from", ref: "e1", ask: "two\nlines" },
    { type: "fill_from", ref: "e1", ask: "hidden\u202Eorder" },
    { type: "fill_from", ref: "e1", ask: ["Example", "password"] },
    { type: "fill_from", ref: "e1", ask: ASK, text: PASTED },
    { type: "fill_from", ref: "e1", ask: ASK, value: PASTED },
    { type: "fill_from", ref: "e1", ask: ASK, kept: true },
  ]) {
    const receipt = await act([action]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "invalid_action", false], JSON.stringify(action));
  }
  const many = await act(Array.from({ length: 7 }, (_, index) => fromCommand(`e${index + 1}`, READ_PASSWORD)));
  assert.deepEqual([many.ok, many.code], [false, "invalid_action"]);
  assert.match(many.error, /at most 6/);
  assert.deepEqual([typed(), ran(), calls.includes("approve")], [[], [], false]);
});

test("a page that is not https gets nothing, and the person is not asked", async () => {
  const { page, act, calls, typed, ran } = world({ url: "http://app.example/login" });
  page.input("Password", "password");
  const receipt = await act([fromCommand("e1", READ_PASSWORD)]);
  assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "site_not_secure", false]);
  assert.match(receipt.error, HANDOFF);
  assert.deepEqual([typed(), ran(), calls.includes("approve")], [[], [], false]);
});

test("a value goes only into an editable text-like or number field, and the person is not asked about any other", async () => {
  const { page, act, calls, typed, ran } = world();
  page.input("Remember me", "checkbox");
  page.input("Birthday", "date");
  page.input("Locked", "text", { readOnly: true });
  page.element("button", { "aria-label": "Continue" });
  for (const ref of ["e1", "e2", "e3", "e4"]) {
    const receipt = await act([fromCommand(ref, READ_PASSWORD)]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "not_editable", false], ref);
  }
  const unknown = await act([fromCommand("e9", READ_PASSWORD)]);
  assert.deepEqual([unknown.ok, unknown.code], [false, "stale_element"]);
  assert.deepEqual([typed(), ran(), calls.includes("approve")], [[], [], false]);
});

test("every command of a call is on one card, asked before anything is sent; each value is fetched at its own step", async () => {
  const { page, act, calls, state, typed, core, observe, request } = world();
  page.input("Email", "email");
  const password = page.input("Password", "password");
  const code = page.input("Code", "number");
  const receipt = await act([{ type: "fill", ref: "e1", text: "person@app.example" }, fromCommand("e2", READ_PASSWORD), fromCommand("e3", READ_CODE)]);
  assert.equal(receipt.ok, true);
  assert.equal(state.asked.length, 1);
  assert.equal(state.asked[0].sessionId, SESSION);
  assert.deepEqual(state.asked[0].request, { site: SITE, fills: [{ field: "password", command: READ_PASSWORD }, { field: "number", command: READ_CODE }] });
  const order = calls.map((call) => Array.isArray(call) ? call[0] : call);
  assert.deepEqual(order, ["approve", "focus:Email", "select", "insertText", "run", "focus:Password", "select", "insertText", "run", "focus:Code", "select", "insertText"]);
  assert.deepEqual(typed(), ["person@app.example", PASSWORD, CODE]);
  assert.deepEqual([password.value, code.value], [PASSWORD, CODE]);
  assert.deepEqual(receipt.steps, [{ i: 0, type: "fill", ref: "e1", outcome: "verified" }, { i: 1, type: "fill_from", ref: "e2", outcome: "verified" }, { i: 2, type: "fill_from", ref: "e3", outcome: "verified" }]);
  assertClean(receipt);
  // Each field is listed as filled and never read back; the agent's own text still is.
  for (const name of ["Password", "Code"]) {
    const shown = receipt.observation.elements.find((element) => element.name === name);
    assert.deepEqual([shown.filled, "value" in shown], [true, false], name);
  }
  assert.equal(receipt.observation.elements.find((element) => element.name === "Email").value, "person@app.example");
  // A value is not a saved secret: nothing lists it, and nothing reports on it.
  assert.deepEqual([core.list(SESSION), core.status(SESSION, TAB)], [[], []]);
  assert.ok(!("secrets" in receipt) && !("availableSecrets" in receipt.observation));
  // Whatever the site shows back afterwards, in a full observation or an extract, is replaced.
  page.text = () => `Signed in with ${password.value} and ${Buffer.from(PASSWORD, "utf8").toString("base64")}. Your code was ${code.value}.`;
  const full = await observe({ mode: "full" });
  assertClean(full);
  assert.equal(full.text, "Signed in with [withheld] and [secret]. Your code was [withheld].");
  assertClean(await request("extract", { question: "signed in with" }));
});

test("when the person declines, no command runs and no step of the call is sent", async () => {
  const { page, act, typed, ran, state } = world({ approve: async () => false });
  const email = page.input("Email", "email");
  page.input("Password", "password");
  const receipt = await act([{ type: "fill", ref: "e1", text: "person@app.example" }, fromCommand("e2", READ_PASSWORD)]);
  assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "credential_declined", false]);
  assert.equal(state.asked.length, 1);
  assert.deepEqual([typed(), ran(), email.value], [[], [], ""]);
});

test("an answer that is not exactly yes is a no", async () => {
  for (const answer of [undefined, null, 1, "yes", { allowed: true }, { approved: 1, values: [null], keep: [false] }, { approved: "true", values: [PASTED] }]) {
    const { page, act, ran } = world({ approve: async () => answer });
    page.input("Password", "password");
    assert.equal((await act([fromCommand("e1", READ_PASSWORD)])).code, "credential_declined");
    assert.deepEqual(ran(), []);
  }
});

test("a single action returns the fill receipt without the value or the command", async () => {
  const { page, request, observe } = world();
  page.input("Password", "password");
  const observation = await observe();
  const receipt = await request("act", { observationId: observation.observationId, action: fromCommand("e1", READ_PASSWORD) });
  assert.deepEqual(receipt, { ok: true, dispatched: true, mayHaveChangedState: true, outcome: "verified", retrySafe: false, tabId: TAB, ref: "e1", next: "observe" });
});

test("a command that fails says why in words of its own, never in what it printed, and nothing is typed", async () => {
  const cases = [
    [{ ok: false, code: "command_not_found" }, "command_not_found", /not installed/],
    [{ ok: false, code: "command_timeout" }, "command_timeout", /unlock/],
    [{ ok: false, code: "command_empty" }, "command_empty", /printed nothing/],
    [{ ok: false, code: "command_output_unusable" }, "command_output_unusable", /not one short text value/],
    [{ ok: false, code: "command_failed", exitCode: 1, detail: "Vault is locked." }, "command_failed", /^The command failed \(exit code 1\): Vault is locked\. Nothing was typed\./],
    [{ ok: false, code: "command_failed", exitCode: 2, detail: "no item" }, "command_failed", /^The command failed \(exit code 2\): no item\. Nothing was typed\./],
    [{ ok: false, code: "command_failed" }, "command_failed", /^The command failed\. Nothing was typed\./],
    [{ ok: false, code: "made_up_code", value: PASSWORD }, "command_failed", /^The command failed\. Nothing was typed\./],
    [undefined, "command_failed", /^The command failed\./],
    [{ ok: "yes", value: PASSWORD }, "command_failed", /^The command failed\./],
  ];
  for (const [answer, code, words] of cases) {
    const { page, act, typed } = world({ answers: { [READ_PASSWORD.join(" ")]: () => answer } });
    const field = page.input("Password", "password");
    const receipt = await act([fromCommand("e1", READ_PASSWORD)]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, code, false], JSON.stringify(answer));
    assert.match(receipt.error, words);
    assert.deepEqual([typed(), field.value], [[], ""]);
    assertClean(receipt);
  }
});

test("in a batch, a failed command stops at its step: earlier steps stay done and later ones are skipped", async () => {
  const { page, act, typed, ran } = world({ answers: { [READ_PASSWORD.join(" ")]: { ok: true, value: PASSWORD }, [READ_CODE.join(" ")]: { ok: false, code: "command_failed", exitCode: 1, detail: "Not logged in" } } });
  page.input("Password", "password");
  page.input("Code", "text");
  page.element("button", { "aria-label": "Continue" });
  const receipt = await act([fromCommand("e1", READ_PASSWORD), fromCommand("e2", READ_CODE), { type: "click", ref: "e3" }]);
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.steps, [{ i: 0, type: "fill_from", ref: "e1", outcome: "verified" }]);
  assert.deepEqual([receipt.completed, receipt.failed, receipt.skipped], [1, 1, 1]);
  assert.deepEqual(receipt.failedStep, { index: 1, type: "fill_from", ref: "e2", code: "command_failed", error: receipt.error });
  assert.match(receipt.error, /Not logged in\./);
  assert.deepEqual([typed(), ran()], [[PASSWORD], [READ_PASSWORD, READ_CODE]]);
  assertClean(receipt);
});

test("what a later command says of an earlier value is replaced before the agent reads it", async () => {
  const { page, act } = world({ answers: { [READ_PASSWORD.join(" ")]: { ok: true, value: PASSWORD }, [READ_CODE.join(" ")]: { ok: false, code: "command_failed", exitCode: 1, detail: `no code for ${PASSWORD}` } } });
  page.input("Password", "password");
  page.input("Code", "text");
  const receipt = await act([fromCommand("e1", READ_PASSWORD), fromCommand("e2", READ_CODE)]);
  assert.equal(receipt.code, "command_failed");
  assert.match(receipt.error, /no code for \[secret\]/);
  assertClean(receipt);
});

test("a value too short to tell from ordinary text, too long, or of several lines for a one-line field is not typed", async () => {
  for (const [value, type] of [["123", "text"], ["x".repeat(4097), "text"], ["first\nsecond", "password"], ["first\rsecond", "text"]]) {
    const { page, act, typed } = world({ answers: { [READ_PASSWORD.join(" ")]: { ok: true, value } } });
    page.input("Field", type);
    const receipt = await act([fromCommand("e1", READ_PASSWORD)]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "value_unusable", false], JSON.stringify(value.slice(0, 20)));
    assert.deepEqual(typed(), []);
    if (value.length >= 4 && value.length <= 4096) assertClean(receipt, [value]);
  }
  const lines = world({ answers: { [READ_PASSWORD.join(" ")]: { ok: true, value: "first line\nsecond line" } } });
  const notes = lines.page.textarea("Recovery codes");
  assert.equal((await lines.act([fromCommand("e1", READ_PASSWORD)])).ok, true);
  assert.equal(notes.value, "first line\nsecond line");
});

test("a field that does not keep what was typed fails the step, stops the batch, and still shows nothing", async () => {
  const { page, act, calls } = world();
  page.input("Code", "text", { accepts: (value) => value.slice(0, 1) });
  page.element("button", { "aria-label": "Continue" });
  const receipt = await act([fromCommand("e1", READ_CODE), { type: "click", ref: "e2" }]);
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.steps, [{ i: 0, type: "fill_from", ref: "e1", outcome: "failed" }]);
  assert.deepEqual([receipt.completed, receipt.failed, receipt.skipped], [0, 1, 1]);
  assert.deepEqual(receipt.failedStep, { index: 0, type: "fill_from", ref: "e1", outcome: "failed", code: "value_mismatch", error: receipt.error });
  assert.match(receipt.error, HANDOFF);
  assert.ok(!calls.includes("click"));
  assertClean(receipt);
});

test("a page that moves while the person decides gets nothing, and no command runs", async () => {
  for (const move of [(scene) => { scene.page.url = `${OTHER}/login`; }, (scene) => { scene.page.url = `${SITE}/elsewhere`; }, (scene) => { scene.tab.webMcpRevision++; }]) {
    const scene = world({ approve: async () => { move(scene); return true; } });
    scene.page.input("Password", "password");
    const receipt = await scene.act([fromCommand("e1", READ_PASSWORD)]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "page_changed", false]);
    assert.deepEqual([scene.typed(), scene.ran()], [[], []]);
  }
});

test("the flag turned off while the person decides stops the fill before the command runs", async () => {
  const scene = world({ approve: async () => { scene.state.flag = false; return true; } });
  scene.page.input("Password", "password");
  const receipt = await scene.act([fromCommand("e1", READ_PASSWORD)]);
  assert.deepEqual([receipt.ok, receipt.code], [false, "values_unavailable"]);
  assert.deepEqual([scene.typed(), scene.ran()], [[], []]);
});

test("a field the page retyped while the person decides, or while the command ran, is stale", async () => {
  const deciding = world({ approve: async () => { deciding.page.elements[0].attributes.type = "text"; return true; } });
  deciding.page.input("Password", "password");
  const first = await deciding.act([fromCommand("e1", READ_PASSWORD)]);
  assert.equal(first.ok, false);
  assert.deepEqual([deciding.typed(), deciding.ran()], [[], []]);

  const running = world();
  running.page.input("Password", "password");
  running.state.answers[READ_PASSWORD.join(" ")] = () => { running.page.elements[0].attributes.type = "text"; return { ok: true, value: PASSWORD }; };
  const second = await running.act([fromCommand("e1", READ_PASSWORD)]);
  assert.equal(second.ok, false);
  assert.deepEqual(running.typed(), []);
  assertClean(second);
});

test("a page that leaves while the command runs, or when the field takes focus, gets nothing", async () => {
  const running = world();
  running.page.input("Password", "password");
  running.state.answers[READ_PASSWORD.join(" ")] = () => { running.page.url = `${OTHER}/landing`; return { ok: true, value: PASSWORD }; };
  const first = await running.act([fromCommand("e1", READ_PASSWORD)]);
  assert.equal(first.ok, false);
  assert.deepEqual(running.typed(), []);
  assertClean(first);

  const focusing = world();
  focusing.page.input("Password", "password", { onfocus: () => { focusing.page.url = `${OTHER}/landing`; } });
  const second = await focusing.act([fromCommand("e1", READ_PASSWORD)]);
  assert.deepEqual([second.ok, second.code], [false, "page_changed"]);
  assert.deepEqual(focusing.typed(), []);
});

test("a page that moves the keyboard to another field when this one takes focus gets nothing", async () => {
  const scene = world();
  scene.page.input("Password", "password", { onfocus: () => { scene.page.document.activeElement = scene.page.elements[1]; } });
  scene.page.input("Search", "text");
  const receipt = await scene.act([fromCommand("e1", READ_PASSWORD)]);
  assert.deepEqual([receipt.ok, receipt.code], [false, "stale_element"]);
  assert.deepEqual([scene.typed(), scene.page.elements[1].value], [[], ""]);
});

test("a tab that was filled from a command takes no more images, on this page or a later one, until it closes", async () => {
  const { page, act, observe, host } = world();
  page.input("Access token", "text");
  assert.equal((await observe({ includeImage: true })).image.mimeType, "image/png");
  assert.equal((await act([fromCommand("e1", READ_PASSWORD)])).ok, true);
  assert.equal((await observe({ includeImage: true })).code, "credential_on_screen");
  page.elements.length = 0;
  page.context.__openworkCredentialEntered = undefined;
  page.context.__openworkBrowserRefs = undefined;
  page.url = `${SITE}/welcome`;
  page.text = `Your token is ${PASSWORD}`;
  assert.equal((await observe({ mode: "full" })).text, "Your token is [secret]");
  const refused = await observe({ includeImage: true });
  assert.deepEqual([refused.ok, refused.code, "image" in refused], [false, "credential_on_screen", false]);
  host.invalidate(TAB, { closed: true });
  assert.equal((await observe({ includeImage: true })).image.mimeType, "image/png");
});

test("Enter in the filled field is not asked about again; text the agent types into a password field still is", async () => {
  const asked = [];
  const { page, act, calls } = world({ approveCredential: async (_sessionId, request) => { asked.push(request); return true; } });
  page.input("Password", "password");
  const receipt = await act([fromCommand("e1", READ_PASSWORD), { type: "key", ref: "e1", key: "Enter" }]);
  assert.equal(receipt.ok, true);
  assert.deepEqual(asked, []);
  assert.deepEqual(receipt.steps.map((step) => step.outcome), ["verified", "settled"]);
  assert.ok(calls.includes("key:Enter"));
  await act([{ type: "fill", ref: "e1", text: "typed by the agent" }]);
  assert.deepEqual(asked, [{ site: SITE }]);
});

test("the receipt kept for a request_id, and its replay, hold nothing a command printed, and the command is not run twice", async () => {
  const { page, request, observe, ran } = world();
  page.input("Password", "password");
  const observation = await observe();
  const args = { observationId: observation.observationId, request_id: "fill-once", actions: [fromCommand("e1", READ_PASSWORD), { type: "key", ref: "e1", key: "Tab" }] };
  const first = await request("act", args);
  assert.equal(first.ok, true);
  const replay = await request("act", args);
  assert.deepEqual(replay.steps, first.steps);
  assertClean([first, replay]);
  assert.deepEqual(ran(), [READ_PASSWORD]);
});

test("fill_secret does not take a number field, and fill types a command's words literally", async () => {
  const { page, act, typed, ran } = world();
  page.input("Code", "number");
  page.input("Notes", "text");
  const core = await act([{ type: "fill_secret", ref: "e1", secretRef: "sec_0000000000000000000000" }]);
  assert.equal(core.ok, false);
  const literal = await act([{ type: "fill", ref: "e2", text: READ_PASSWORD.join(" ") }]);
  assert.equal(literal.ok, true);
  assert.deepEqual([typed(), ran()], [[READ_PASSWORD.join(" ")], []]);
});

test("a value the person is asked for is typed from what they pasted: no command runs, and nothing read afterwards holds it", async () => {
  const { page, act, calls, state, typed, ran, core, observe, request } = world({ approve: async () => pasting([PASTED]) });
  const field = page.input("Password", "password");
  const receipt = await act([fromPerson("e1")]);
  assert.equal(receipt.ok, true);
  assert.deepEqual(state.asked.map((asked) => asked.request), [{ site: SITE, fills: [{ field: "password", ask: ASK }] }]);
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ["approve", "focus:Password", "select", "insertText"]);
  assert.deepEqual([typed(), ran(), field.value], [[PASTED], [], PASTED]);
  assert.deepEqual(receipt.steps, [{ i: 0, type: "fill_from", ref: "e1", outcome: "verified" }]);
  assertClean(receipt, [PASTED]);
  const shown = receipt.observation.elements.find((element) => element.name === "Password");
  assert.deepEqual([shown.filled, "value" in shown], [true, false]);
  // Pasted once: it is not a saved secret and is not kept, so the next fill asks for it again.
  assert.deepEqual([core.list(SESSION), core.listKept(SESSION)], [[], []]);
  page.text = () => `Signed in with ${field.value} and ${encodeURIComponent(PASTED)}.`;
  const full = await observe({ mode: "full" });
  assertClean(full, [PASTED]);
  assert.equal(full.text, "Signed in with [withheld] and [secret].");
  assertClean(await request("extract", { question: "signed in with" }), [PASTED]);
  assert.equal((await observe({ includeImage: true })).code, "credential_on_screen");
});

test("commands and asked values share one card, and each is entered at its own step", async () => {
  const { page, act, calls, state, typed, ran } = world({ approve: async () => pasting([null, PASTED, null]) });
  page.input("Email", "email");
  page.input("Password", "password");
  page.input("Code", "number");
  const receipt = await act([fromCommand("e1", ["pass", "show", "example/email"]), fromPerson("e2"), fromCommand("e3", READ_CODE)]);
  assert.equal(receipt.ok, false);
  // The first command is not installed: the call stops there, before the pasted value is typed.
  assert.deepEqual([receipt.code, typed()], ["command_not_found", []]);
  assert.match(receipt.error, /fill_from with ask instead of command/);
  assert.doesNotMatch(receipt.error, /browser_handoff/);
  assertClean(receipt, [PASTED]);

  state.answers["pass show example/email"] = { ok: true, value: "person@app.example" };
  const again = await act([fromCommand("e1", ["pass", "show", "example/email"]), fromPerson("e2"), fromCommand("e3", READ_CODE)]);
  assert.equal(again.ok, true);
  assert.deepEqual(state.asked.at(-1).request, { site: SITE, fills: [{ field: "email", command: ["pass", "show", "example/email"] }, { field: "password", ask: ASK }, { field: "number", command: READ_CODE }] });
  assert.deepEqual(calls.slice(calls.lastIndexOf("approve")).map((call) => Array.isArray(call) ? call[0] : call),
    ["approve", "run", "focus:Email", "select", "insertText", "focus:Password", "select", "insertText", "run", "focus:Code", "select", "insertText"]);
  assert.deepEqual([typed(), ran().slice(1)], [["person@app.example", PASTED, CODE], [["pass", "show", "example/email"], READ_CODE]]);
  assertClean(again, [PASTED, CODE, "person@app.example"]);
});

test("a value pasted in place of a command is typed, and the command does not run", async () => {
  const { page, act, typed, ran, core } = world({ approve: async () => pasting([PASTED, null], [true, false]) });
  const password = page.input("Password", "password");
  page.input("Code", "number");
  const receipt = await act([fromCommand("e1", READ_PASSWORD), fromCommand("e2", READ_CODE)]);
  assert.equal(receipt.ok, true);
  assert.deepEqual([typed(), ran(), password.value], [[PASTED, CODE], [READ_CODE], PASTED]);
  // Keeping is for a value asked for by name; one pasted over a command is used once.
  assert.deepEqual(core.listKept(SESSION), []);
  assertClean(receipt, [PASTED, CODE]);
});

test("a value kept for this chat is listed as kept on the next card, and typed with a plain yes", async () => {
  const answers = [pasting([PASTED], [true]), true, pasting(["another one pasted"], [false]), true];
  const { page, act, state, typed, ran, core } = world({ approve: async () => answers.shift() });
  const field = page.input("Password", "password");
  assert.equal((await act([fromPerson("e1")])).ok, true);
  assert.deepEqual(core.listKept(SESSION), [{ site: SITE, label: ASK }]);
  assert.equal((await act([fromPerson("e1")])).ok, true);
  assert.deepEqual(state.asked.at(-1).request, { site: SITE, fills: [{ field: "password", ask: ASK, kept: true }] });
  assert.deepEqual(typed(), [PASTED, PASTED]);
  // Pasting a different one uses it for this fill and leaves the kept one alone.
  const third = await act([fromPerson("e1")]);
  assert.equal(third.ok, true);
  assert.deepEqual([typed().at(-1), field.value], ["another one pasted", "another one pasted"]);
  assertClean(third, [PASTED, "another one pasted"]);
  assert.equal((await act([fromPerson("e1")])).ok, true);
  assert.equal(typed().at(-1), PASTED);
  // Another name for it is another value: nothing kept, so it has to be pasted.
  const other = await act([fromPerson("e1", "Example passphrase")]);
  assert.deepEqual(state.asked.at(-1).request.fills, [{ field: "password", ask: "Example passphrase" }]);
  assert.equal(other.code, "credential_declined");
  assert.deepEqual(ran(), []);
});

test("a kept value is for its site and its conversation alone, and ends with the conversation", async () => {
  const { page, act, state, core, observe } = world({ approve: async () => pasting([PASTED], [true]) });
  page.input("Password", "password");
  assert.equal((await act([fromPerson("e1")])).ok, true);
  assert.equal(core.kept({ sessionId: SESSION, site: SITE, label: ASK }), PASTED);
  assert.equal(core.kept({ sessionId: "another chat", site: SITE, label: ASK }), null);
  assert.equal(core.kept({ sessionId: SESSION, site: OTHER, label: ASK }), null);
  core.clearSession(SESSION);
  assert.equal(core.kept({ sessionId: SESSION, site: SITE, label: ASK }), null);
  await act([fromPerson("e1")]);
  assert.deepEqual(state.asked.at(-1).request.fills, [{ field: "password", ask: ASK }]);
  // What it was is still never read back.
  page.text = () => `Echo ${PASTED}`;
  const full = await observe({ mode: "full" });
  assert.equal(full.text, "Echo [withheld]");
  assertClean(full, [PASTED]);
});

test("a kept value removed while the person decides is not typed", async () => {
  const answers = [pasting([PASTED], [true])];
  const scene = world({ approve: async () => answers.shift() ?? (scene.core.forget({ sessionId: SESSION, site: SITE, label: ASK }), true) });
  scene.page.input("Password", "password");
  assert.equal((await scene.act([fromPerson("e1")])).ok, true);
  const receipt = await scene.act([fromPerson("e1")]);
  assert.deepEqual([receipt.ok, receipt.code], [false, "pasted_unusable"]);
  assert.deepEqual(scene.typed(), [PASTED]);
  assertClean(receipt, [PASTED]);
});

test("a yes that brings no value for a field that was asked for is a no", async () => {
  for (const answer of [true, pasting([null]), pasting([]), { approved: true }, pasting([7]), pasting([{ toString: () => PASTED }])]) {
    const { page, act, typed, ran } = world({ approve: async () => answer });
    page.input("Password", "password");
    const receipt = await act([fromPerson("e1")]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "credential_declined", false], JSON.stringify(answer));
    assert.deepEqual([typed(), ran()], [[], []]);
  }
});

test("a pasted value that cannot be typed stops the call: no command runs in its place, and no kept value is used", async () => {
  for (const [value, type] of [["123", "text"], ["x".repeat(4097), "text"], ["first\nsecond", "password"], ["first\rsecond", "text"]]) {
    for (const action of [fromPerson("e2"), fromCommand("e2", READ_PASSWORD)]) {
      const { page, act, typed, ran, core } = world({ approve: async () => pasting([null, value], [false, true]) });
      const email = page.input("Email", "email");
      page.input("Field", type);
      const receipt = await act([fromCommand("e1", READ_CODE), action]);
      assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "pasted_unusable", false], JSON.stringify(value.slice(0, 20)));
      assert.deepEqual([typed(), ran(), email.value, core.listKept(SESSION)], [[], [], "", []]);
      if (value.length >= 4 && value.length <= 4096) assertClean(receipt, [value]);
    }
  }
  const lines = world({ approve: async () => pasting(["first line\nsecond line"]) });
  const notes = lines.page.textarea("Recovery codes");
  assert.equal((await lines.act([fromPerson("e1", "Recovery codes")])).ok, true);
  assert.equal(notes.value, "first line\nsecond line");
});

test("a page that moves while the person pastes gets nothing", async () => {
  for (const move of [(scene) => { scene.page.url = `${OTHER}/login`; }, (scene) => { scene.tab.webMcpRevision++; }]) {
    const scene = world({ approve: async () => { move(scene); return pasting([PASTED]); } });
    scene.page.input("Password", "password");
    const receipt = await scene.act([fromPerson("e1")]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "page_changed", false]);
    assert.deepEqual(scene.typed(), []);
    assertClean(receipt, [PASTED]);
  }
  const focusing = world({ approve: async () => pasting([PASTED]) });
  focusing.page.input("Password", "password", { onfocus: () => { focusing.page.url = `${OTHER}/landing`; } });
  const second = await focusing.act([fromPerson("e1")]);
  assert.deepEqual([second.ok, second.code], [false, "page_changed"]);
  assert.deepEqual(focusing.typed(), []);
});

test("a replayed request types the pasted value once and asks once", async () => {
  const { page, request, observe, typed, state } = world({ approve: async () => pasting([PASTED]) });
  page.input("Password", "password");
  const observation = await observe();
  const args = { observationId: observation.observationId, request_id: "paste-once", actions: [fromPerson("e1"), { type: "key", ref: "e1", key: "Tab" }] };
  const first = await request("act", args);
  assert.equal(first.ok, true);
  const replay = await request("act", args);
  assert.deepEqual(replay.steps, first.steps);
  assertClean([first, replay], [PASTED]);
  assert.deepEqual([typed(), state.asked.length], [[PASTED], 1]);
});

test("an unlock goes only with a command, names one safe variable and a name to ask under, and nothing else", async () => {
  const { page, act, calls, typed, ran } = world();
  page.input("Password", "password");
  page.input("Code", "number");
  for (const action of [
    { type: "fill_from", ref: "e1", ask: ASK, unlock: UNLOCK },
    unlocked("e1", BW_PASSWORD, "BW_SESSION"),
    unlocked("e1", BW_PASSWORD, { env: "BW_SESSION" }),
    unlocked("e1", BW_PASSWORD, { env: "PATH", ask: "Path" }),
    unlocked("e1", BW_PASSWORD, { env: "LD_PRELOAD", ask: "Library" }),
    unlocked("e1", BW_PASSWORD, { env: "BW SESSION", ask: "Key" }),
    unlocked("e1", BW_PASSWORD, { ...UNLOCK, value: KEY }),
    unlocked("e1", BW_PASSWORD, { ...UNLOCK, command: ["bw", "unlock", "--raw"] }),
    unlocked("e1", BW_PASSWORD, [UNLOCK]),
  ]) {
    const receipt = await act([action]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "invalid_action", false], JSON.stringify(action));
  }
  // One program reads one variable under one name, so the person is asked for each key once.
  const two = await act([unlocked("e1", BW_PASSWORD), unlocked("e2", READ_CODE, { env: "BW_SESSION", ask: "Another name" })]);
  assert.deepEqual([two.ok, two.code, two.dispatched], [false, "invalid_action", false]);
  assert.match(two.error, /same ask/);
  assert.deepEqual([typed(), ran(), calls.includes("approve")], [[], [], false]);
});

test("a command that needs a key gets the one the person pasted, in its environment for that run, and nothing read afterwards holds it", async () => {
  const { page, act, state, typed, ran, given, core, observe } = world({ answers: vault, approve: async () => pasting([null, null, KEY]) });
  const password = page.input("Password", "password");
  page.input("Code", "number");
  const receipt = await act([unlocked("e1", BW_PASSWORD), unlocked("e2", READ_CODE)]);
  assert.equal(receipt.ok, true);
  // Both commands read the same key: it is listed once, after the fields, with the program it is for.
  assert.deepEqual(state.asked.map((asked) => asked.request), [{ site: SITE, fills: [
    { field: "password", command: BW_PASSWORD, needs: "BW_SESSION" }, { field: "number", command: READ_CODE, needs: "BW_SESSION" }, KEY_ROW] }]);
  assert.deepEqual([ran(), given()], [[BW_PASSWORD, READ_CODE], [{ BW_SESSION: KEY }, { BW_SESSION: KEY }]]);
  assert.deepEqual([typed(), password.value], [[PASSWORD, CODE], PASSWORD]);
  assert.deepEqual(receipt.steps.map((step) => step.outcome), ["verified", "verified"]);
  assertClean(receipt, [KEY, PASSWORD, CODE]);
  // Pasted once: nothing is kept unless the person says so.
  assert.deepEqual(core.listKept(SESSION), []);
  page.text = () => `The page echoes ${KEY} and ${encodeURIComponent(KEY)}.`;
  const full = await observe({ mode: "full" });
  assertClean(full, [KEY]);
  assert.equal(full.text, "The page echoes [secret] and [secret].");
});

test("a command without an unlock gets no variable, also when another on the card has one", async () => {
  const { page, act, given, state } = world({ answers: { ...vault, [READ_PASSWORD.join(" ")]: { ok: true, value: PASSWORD } }, approve: async () => pasting([null, null, KEY]) });
  page.input("Password", "password");
  page.input("Code", "number");
  assert.equal((await act([fromCommand("e1", READ_PASSWORD), unlocked("e2", READ_CODE)])).ok, true);
  assert.deepEqual(state.asked[0].request.fills, [{ field: "password", command: READ_PASSWORD }, { field: "number", command: READ_CODE, needs: "BW_SESSION" }, KEY_ROW]);
  assert.deepEqual(given(), [undefined, { BW_SESSION: KEY }]);
});

test("a key kept for this chat is listed as kept, belongs to its program and not to a site, and is used with a plain yes", async () => {
  const answers = [pasting([null, KEY], [false, true]), true, true];
  const { page, act, state, typed, given, core } = world({ answers: { ...vault, "bw get password example.com": locked("other program") }, approve: async () => answers.shift() });
  page.input("Password", "password");
  assert.equal((await act([unlocked("e1", BW_PASSWORD)])).ok, true);
  assert.deepEqual(core.listKept(SESSION), [KEY_PLACE]);
  assert.equal(core.kept({ sessionId: SESSION, ...KEY_PLACE }), KEY);
  assert.equal(core.kept({ sessionId: "another chat", ...KEY_PLACE }), null);

  page.url = `${OTHER}/login`;
  const second = await act([unlocked("e1", BW_PASSWORD)]);
  assert.equal(second.ok, true);
  // On another site the same program finds its key: the card still appears, with nothing to paste.
  assert.deepEqual(state.asked.at(-1).request, { site: OTHER, fills: [{ field: "password", command: BW_PASSWORD, needs: "BW_SESSION" }, { ...KEY_ROW, kept: true }] });
  assert.deepEqual([typed(), given()], [[PASSWORD, PASSWORD], [{ BW_SESSION: KEY }, { BW_SESSION: KEY }]]);
  assertClean(second, [KEY, PASSWORD]);

  // Another program by the same name, or the same program under another name for the key, has no key kept.
  const other = await act([unlocked("e1", ["bw", "get", "password", "example.com"])]);
  assert.deepEqual(state.asked.at(-1).request.fills.at(-1), { unlock: "BW_SESSION", program: "bw", ask: "Bitwarden session key" });
  assert.deepEqual([other.ok, other.code, other.dispatched], [false, "credential_declined", false]);
  assert.equal(given().length, 2);
});

test("a yes that brings no key for a command that needs one is a no, and nothing runs", async () => {
  for (const answer of [true, pasting([null, null]), pasting([null]), pasting([null, 7])]) {
    const { page, act, typed, ran } = world({ answers: vault, approve: async () => answer });
    page.input("Password", "password");
    const receipt = await act([unlocked("e1", BW_PASSWORD)]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "credential_declined", false], JSON.stringify(answer));
    assert.deepEqual([typed(), ran()], [[], []]);
  }
});

test("a key is not needed when the field of every command that reads it was pasted instead", async () => {
  const { page, act, typed, ran, core } = world({ answers: vault, approve: async () => pasting([PASTED, null]) });
  page.input("Password", "password");
  const receipt = await act([unlocked("e1", BW_PASSWORD)]);
  assert.equal(receipt.ok, true);
  assert.deepEqual([typed(), ran(), core.listKept(SESSION)], [[PASTED], [], []]);
  assertClean(receipt, [PASTED]);
});

test("a key that cannot be given to a command stops the call before anything runs or is typed", async () => {
  for (const key of ["abc", "x".repeat(4097), "two\nlines", "carriage\rreturn"]) {
    const { page, act, typed, ran, core } = world({ answers: vault, approve: async () => pasting([null, null, key], [false, false, true]) });
    page.input("Email", "email");
    page.input("Password", "password");
    const receipt = await act([fromCommand("e1", READ_PASSWORD), unlocked("e2", BW_PASSWORD)]);
    assert.deepEqual([receipt.ok, receipt.code, receipt.dispatched], [false, "unlock_unusable", false], JSON.stringify(key.slice(0, 20)));
    assert.deepEqual([typed(), ran(), core.listKept(SESSION)], [[], [], []]);
    if (key.length >= 4 && key.length <= 4096) assertClean(receipt, [key]);
  }
});

test("a kept key removed while the person decides is not used, and the command does not run", async () => {
  const answers = [pasting([null, KEY], [false, true])];
  const scene = world({ answers: vault, approve: async () => answers.shift() ?? (scene.core.forget({ sessionId: SESSION, ...KEY_PLACE }), true) });
  scene.page.input("Password", "password");
  assert.equal((await scene.act([unlocked("e1", BW_PASSWORD)])).ok, true);
  const receipt = await scene.act([unlocked("e1", BW_PASSWORD)]);
  assert.deepEqual([receipt.ok, receipt.code], [false, "unlock_unusable"]);
  assert.deepEqual([scene.typed(), scene.ran().length], [[PASSWORD], 1]);
  assertClean(receipt, [KEY]);
});

test("a key the vault no longer takes fails the step in words that hold no key, and says to ask again", async () => {
  const stale = "made-up key that ran out/+ 31";
  const { page, act, typed, given } = world({ answers: vault, approve: async () => pasting([null, stale]) });
  page.input("Password", "password");
  const receipt = await act([unlocked("e1", BW_PASSWORD)]);
  assert.deepEqual([receipt.ok, receipt.code], [false, "command_failed"]);
  assert.match(receipt.error, /Vault is locked/);
  assert.match(receipt.error, /use the same fill_from once more/);
  assert.deepEqual([typed(), given()], [[], [{ BW_SESSION: stale }]]);
  // The vault's own complaint repeated the key; what the agent reads does not.
  assertClean(receipt, [stale]);
});

test("a refusal from the person's settings or their organization is returned in its own words, and nothing runs or is typed", async () => {
  const refused = { code: "value_command_blocked", error: "Your organization's agent permissions block getting a private value from the command `op read` (Everyone). Nothing was run or typed." };
  const { page, act, typed, ran, state } = world({ approve: async () => ({ approved: false, values: [], keep: [], refused }) });
  const email = page.input("Email", "email");
  page.input("Password", "password");
  const receipt = await act([{ type: "fill", ref: "e1", text: "person@app.example" }, fromCommand("e2", READ_PASSWORD)]);
  assert.deepEqual([receipt.ok, receipt.code, receipt.error, receipt.dispatched], [false, refused.code, refused.error, false]);
  assert.deepEqual([typed(), ran(), email.value, state.notes], [[], [], "", []]);
  // A refusal never turns a yes into a no, and one that is not a code and a sentence is a plain no.
  for (const answer of [{ approved: false, values: [], keep: [], refused: { code: 4, error: "x" } }, { approved: false, refused: "blocked" }]) {
    const other = world({ approve: async () => answer });
    other.page.input("Password", "password");
    assert.equal((await other.act([fromCommand("e1", READ_PASSWORD)])).code, "credential_declined");
  }
  const allowed = world({ approve: async () => ({ approved: true, values: [null], keep: [false], refused }) });
  allowed.page.input("Password", "password");
  assert.equal((await allowed.act([fromCommand("e1", READ_PASSWORD)])).ok, true);
});

test("each fill is noted with its site, field, source and result, never its value or its command's arguments", async () => {
  const { page, act, state, core } = world({ approve: async () => pasting([null, PASTED, null], [false, true, false]) });
  page.input("Password", "password");
  page.input("Account", "text");
  page.input("Code", "number", { accepts: (value) => value.slice(0, 1) });
  const receipt = await act([fromCommand("e1", READ_PASSWORD), fromPerson("e2", "Account number"), fromCommand("e3", READ_CODE)]);
  assert.equal(receipt.ok, false);
  assert.deepEqual(state.notes, [
    { sessionId: SESSION, site: SITE, field: "password", source: "command", program: "op", result: "filled" },
    { sessionId: SESSION, site: SITE, field: "text", source: "paste", result: "filled" },
    { sessionId: SESSION, site: SITE, field: "number", source: "command", program: "/opt/homebrew/bin/bw", result: "value_mismatch" },
  ]);
  assertClean(state.notes, [PASSWORD, PASTED, CODE, "op://Private", "totp"]);
  assert.deepEqual(core.listAllKept(), [{ sessionId: SESSION, site: SITE, label: "Account number" }]);

  // What was kept is typed with a plain yes and noted as kept; a command that fails is noted by its code.
  state.notes.length = 0;
  const again = world({ answers: {} });
  again.core.keep({ sessionId: SESSION, site: SITE, label: "Account number", value: PASTED });
  again.page.input("Account", "text");
  again.page.input("Password", "password");
  await again.act([fromPerson("e1", "Account number"), fromCommand("e2", READ_PASSWORD)]);
  assert.deepEqual(again.state.notes.map((note) => [note.source, note.program, note.result]), [["kept", undefined, "filled"], ["command", "op", "command_not_found"]]);
});

test("a note that throws changes nothing about the fill", async () => {
  const { page, act, state, typed } = world();
  state.note = () => { throw new Error("The list is full."); };
  page.input("Password", "password");
  const receipt = await act([fromCommand("e1", READ_PASSWORD)]);
  assert.deepEqual([receipt.ok, typed()], [true, [PASSWORD]]);
});
