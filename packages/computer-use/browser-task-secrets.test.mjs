// The task host's side of secret handles: what `fill_secret` checks before anything is typed, what
// it types, and what the model can and cannot read afterwards. The page functions of the host run
// unchanged, in their own realm, against a small stand-in for the document.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { createBrowserSecrets } from "./browser-secrets.mjs";
import { createBrowserTaskHost } from "./browser-task.mjs";

const SITE = "https://app.example";
const OTHER = "https://other.example";
const SESSION = "s1";
const TAB = "tab-1";
// Made up for the test; its characters differ in every encoding a page can echo it in.
const VALUE = "not-a-real-secret/+ &42";
const VALUE_BASE64 = Buffer.from(VALUE, "utf8").toString("base64");
const VALUE_URL = encodeURIComponent(VALUE);
const HANDOFF = /browser_handoff/;

function matchesCompound(element, compound) {
  let rest = compound.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    if (element.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    const attribute = /^\[([\w-]+)(?:([*^]?=)["']([^"']*)["'](?:\s+i)?)?\]/.exec(rest);
    const not = /^:not\(([^()]*)\)/.exec(rest);
    const disabled = /^:disabled/.exec(rest);
    const named = /^[#.][\w-]+/.exec(rest);
    const part = attribute ?? not ?? disabled ?? named;
    if (!part) throw new Error(`The stand-in document does not understand the selector ${compound}`);
    if (attribute) {
      const actual = element.getAttribute(attribute[1]);
      if (actual === null) return false;
      if (attribute[2] === "=" && actual !== attribute[3]) return false;
      if (attribute[2] === "*=" && !actual.toLowerCase().includes(attribute[3].toLowerCase())) return false;
      if (attribute[2] === "^=" && !actual.startsWith(attribute[3])) return false;
    }
    if (not && matchesCompound(element, not[1])) return false;
    if (disabled && element.disabled !== true) return false;
    if (named && !(named[0][0] === "#" && element.getAttribute("id") === named[0].slice(1))) return false;
    rest = rest.slice(part[0].length);
  }
  return true;
}

class HTMLElement {
  constructor(page, tagName, attributes = {}, extra = {}) {
    this.page = page;
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.parentElement = null;
    this.scrollHeight = 24; this.clientHeight = 24; this.scrollTop = 0;
    this.text = "";
    Object.assign(this, extra);
  }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  get id() { return this.attributes.id ?? ""; }
  get isConnected() { return this.page.elements.includes(this); }
  get isContentEditable() { return ["", "true"].includes(this.attributes.contenteditable); }
  get innerText() { return typeof this.text === "function" ? this.text() : this.text; }
  get textContent() { return this.innerText; }
  matches(selector) { return selector.split(",").some((compound) => matchesCompound(this, compound)); }
  closest(selector) { return this.matches(selector) ? this : null; }
  contains(other) { return other === this; }
  getBoundingClientRect() {
    const x = 20, y = 20 + 40 * this.page.elements.indexOf(this), width = 300, height = 24;
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  }
  getClientRects() { return [this.getBoundingClientRect()]; }
  focus() {
    this.page.calls.push(`focus:${this.getAttribute("aria-label")}`);
    this.page.document.activeElement = this;
    this.onfocus?.(this);
  }
  scrollIntoView() {}
  dispatchEvent() { return true; }
}
class HTMLInputElement extends HTMLElement {
  constructor(page, attributes, extra) {
    super(page, "input", attributes, { value: "", readOnly: false, required: false, labels: [], validity: { valid: true }, validationMessage: "", ...extra });
  }
  get type() { return this.attributes.type ?? "text"; }
  select() { this.page.calls.push("select"); this.selected = true; }
}
class HTMLTextAreaElement extends HTMLElement {
  constructor(page, attributes, extra) {
    super(page, "textarea", attributes, { value: "", readOnly: false, required: false, labels: [], validity: { valid: true }, validationMessage: "", ...extra });
  }
  get type() { return "textarea"; }
  select() { this.page.calls.push("select"); this.selected = true; }
}
class HTMLSelectElement extends HTMLElement {}
class HTMLLabelElement extends HTMLElement {}
class HTMLOptGroupElement extends HTMLElement {}

/** One document: a list of controls, the text it shows and a realm for the host's page functions. */
function createPage(calls, { url = `${SITE}/login`, title = "Sign in", text = "" } = {}) {
  const page = { calls, url, title, text, elements: [], scripts: [], document: null, context: null, beforeScript: null };
  page.document = {
    activeElement: null, readyState: "complete",
    get title() { return page.title; },
    body: { get innerText() { return typeof page.text === "function" ? page.text() : page.text; } },
    querySelectorAll: (selector) => page.elements.filter((element) => element.matches(selector)),
    querySelector: (selector) => page.elements.find((element) => element.matches(selector)) ?? null,
    getElementById: (id) => page.elements.find((element) => id && element.id === id) ?? null,
    elementFromPoint: (x, y) => page.elements.findLast((element) => {
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    }) ?? null,
    getSelection: () => null,
  };
  page.context = vm.createContext({ document: page.document, HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLLabelElement, HTMLOptGroupElement,
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance, setTimeout,
    MutationObserver: class { observe() {} }, Node: { ELEMENT_NODE: 1 }, Event: class { constructor(type) { this.type = type; } } });
  page.input = (label, type, extra = {}) => { const element = new HTMLInputElement(page, { type, "aria-label": label, ...extra.attributes }, extra); page.elements.push(element); return element; };
  page.textarea = (label, extra = {}) => { const element = new HTMLTextAreaElement(page, { "aria-label": label }, extra); page.elements.push(element); return element; };
  page.element = (tag, attributes, extra = {}) => { const element = new HTMLElement(page, tag, attributes, extra); page.elements.push(element); return element; };
  return page;
}

/**
 * A conversation with one tab on a sign-in page, the real secret store and a host wired to both.
 * `calls` lists, in order, what the host asked of the person, the store, the page and the browser.
 */
function world({ flag = true, withStore = true, origins = [SITE], kind = "password", url, text, approve = async () => true, arm = async () => true,
  approveSecret = "default", approveCredential, runSiteTool, siteTools } = {}) {
  const calls = [];
  const core = createBrowserSecrets();
  const secret = core.add({ sessionId: SESSION, label: "Example login", kind, origins, value: VALUE });
  const state = { flag, redacting: true, network: [] };
  const secrets = { ...core,
    describe(...args) { calls.push("describe"); return core.describe(...args); },
    issue(input) { calls.push("issue"); return core.issue(input); },
    redact: (value) => state.redacting ? core.redact(value) : value,
    redactor: () => state.redacting ? core.redactor() : { span: 0, redact: (value) => value, redactText: (text, limit) => limit === undefined ? text : text.slice(0, limit) } };
  const page = createPage(calls, { url, text });
  const typed = () => calls.filter((call) => Array.isArray(call) && call[0] === "insertText").map((call) => call[1]);
  const contents = {
    isDestroyed: () => false, isLoading: () => false,
    getURL: () => page.url, getTitle: () => page.title,
    async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
      page.scripts.push(code);
      page.beforeScript?.();
      return structuredClone(await vm.runInContext(code, page.context));
    },
    async insertText(text) {
      calls.push(["insertText", text]);
      const element = page.document.activeElement;
      if (!element || !("value" in element)) return;
      const kept = element.accepts ? element.accepts(text) : text;
      element.value = element.selected ? kept : element.value + kept;
      element.selected = false;
      element.oninput?.(element);
    },
    async sendInputEvent(event) {
      if (event.type !== "keyDown") return;
      calls.push(`key:${event.keyCode}`);
      page.document.activeElement?.onkey?.(event.keyCode);
    },
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
    siteTools: siteTools ?? (async () => ({ ok: true, tools: [] })), runSiteTool: runSiteTool ?? (async () => ({ ok: true })),
    ...(approveCredential ? { approveCredential } : {}),
    ...(withStore ? { secrets } : {}),
    secretsEnabled: () => state.flag,
    ...(approveSecret === "default" ? { approveSecret: async (sessionId, request, signal) => { calls.push("approve"); state.asked = { sessionId, request, signal }; return approve(request); } }
      : approveSecret ? { approveSecret } : {}),
    armSecretSwap: async (armed) => { calls.push("arm"); assert.equal(armed, tab); return arm(); },
  });
  const request = (operation, args = {}) => host.request({ sessionId: SESSION, operation, args });
  /** What the host's interception does with a request the page makes. */
  const send = (body, { to = `${SITE}/session`, method = "POST" } = {}) => {
    const decision = core.rewrite({ tabId: TAB, url: to, method, headers: { "Content-Type": "application/json" }, body: Buffer.from(JSON.stringify(body)), bodyComplete: true, resourceType: "XHR" });
    state.network.push({ to, sent: decision.action === "continue" ? (decision.body ?? Buffer.from(JSON.stringify(body))).toString("utf8") : null });
  };
  return { calls, core, secret, state, page, tab, host, request, send, typed,
    observe: (args = {}) => request("observe", { mode: "interactive", ...args }),
    async act(actions, extra = {}) {
      const observation = await request("observe", { mode: "interactive" });
      assert.equal(observation.ok, true);
      return request("act", { observationId: observation.observationId, actions, ...extra });
    } };
}
const refOf = (observation, name) => observation.elements.find((element) => element.name === name)?.ref;
const holds = (value, text) => JSON.stringify(value).includes(text);
/** Neither the value, in the encodings a page can echo, nor any placeholder that was typed. */
function assertClean(value, typed = []) {
  for (const hidden of [VALUE, VALUE_BASE64, VALUE_URL, JSON.stringify(VALUE).slice(1, -1), ...typed]) assert.ok(!holds(value, hidden), "a result held a secret or its placeholder");
}

test("with the flag off, fill_secret is unavailable, tells the agent to hand off, and lists nothing", async () => {
  for (const options of [{ flag: false }, { withStore: false }]) {
    const { page, act, calls, typed, observe } = world(options);
    const field = page.input("Password", "password");
    const receipt = await act([{ type: "fill_secret", ref: "e1", secretRef: "sec_anything" }]);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.failedStep.code, "secrets_unavailable");
    assert.match(receipt.failedStep.error, HANDOFF);
    assert.deepEqual(typed(), []);
    assert.equal(field.value, "");
    assert.ok(!calls.includes("approve") && !calls.includes("arm") && !calls.some((call) => String(call).startsWith("focus")));
    const observation = await observe();
    assert.ok(!("availableSecrets" in observation) && !("secrets" in observation));
  }
});

test("a flag that cannot be read, or that answers anything but true, is off", async () => {
  for (const flag of [() => { throw new Error("no answer"); }, async () => { throw new Error("no answer"); }, () => "on", async () => 1]) {
    const scene = world();
    Object.defineProperty(scene.state, "flag", { get: flag });
    scene.page.input("Password", "password");
    const receipt = await scene.act([{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }]);
    assert.equal(receipt.failedStep.code, "secrets_unavailable");
    assert.ok(!("availableSecrets" in await scene.observe()));
    assert.deepEqual(scene.typed(), []);
  }
  const asynchronous = world();
  Object.defineProperty(asynchronous.state, "flag", { get: async () => true });
  asynchronous.page.input("Password", "password");
  assert.equal((await asynchronous.act([{ type: "fill_secret", ref: "e1", secretRef: asynchronous.secret.secretRef }])).ok, true);
});

test("an observation lists the saved secrets of a page's site by handle, name and kind only", async () => {
  const allowed = world();
  allowed.page.input("Password", "password");
  const listed = await allowed.observe();
  assert.deepEqual(listed.availableSecrets, [{ secretRef: allowed.secret.secretRef, label: "Example login", kind: "password" }]);
  assertClean(listed);
  const elsewhere = world({ url: `${OTHER}/login` });
  elsewhere.page.input("Password", "password");
  assert.ok(!("availableSecrets" in await elsewhere.observe()));
});

test("fill_secret takes a ref and a handle and nothing else", async () => {
  const { page, act, secret, typed, calls } = world();
  page.input("Password", "password");
  const secretRef = secret.secretRef;
  for (const action of [{ type: "fill_secret", ref: "e1", secretRef, text: VALUE }, { type: "fill_secret", ref: "e1", secretRef, text: "" }, { type: "fill_secret", ref: "e1", secretRef, value: "x" },
    { type: "fill_secret", ref: "e1" }, { type: "fill_secret", secretRef }, { type: "fill_secret", ref: "e1", secretRef: "" }, { type: "fill_secret", ref: "e1", secretRef: 7 },
    { type: "fill_secret", ref: "e1", secretRef: "s".repeat(129) }]) {
    const receipt = await act([action]);
    assert.equal(receipt.code, "invalid_action");
    assert.equal(receipt.dispatched, false);
    assertClean(receipt);
  }
  assert.deepEqual(typed(), []);
  assert.ok(!calls.includes("approve"));
});

test("an unknown handle is refused before the person is asked", async () => {
  const { page, act, calls, typed } = world();
  page.input("Password", "password");
  const receipt = await act([{ type: "fill_secret", ref: "e1", secretRef: "sec_0000000000000000000000" }]);
  assert.equal(receipt.failedStep.code, "unknown_secret");
  assert.deepEqual(receipt.failedStep, { index: 0, type: "fill_secret", ref: "e1", secretRef: "sec_0000000000000000000000", code: "unknown_secret", error: receipt.error });
  assert.ok(!calls.includes("approve") && !calls.includes("arm"));
  assert.deepEqual(typed(), []);
});

test("a secret of another conversation is unknown", async () => {
  const { page, act, core, calls } = world();
  page.input("Password", "password");
  const foreign = core.add({ sessionId: "s2", label: "Other conversation", kind: "password", origins: [SITE], value: "another-made-up-value" });
  const receipt = await act([{ type: "fill_secret", ref: "e1", secretRef: foreign.secretRef }]);
  assert.equal(receipt.failedStep.code, "unknown_secret");
  assert.ok(!calls.includes("approve"));
});

test("on a site the secret is not allowed for, no approval is asked and nothing is typed", async () => {
  const { page, act, calls, typed, secret } = world({ url: `${OTHER}/login` });
  page.input("Password", "password");
  const receipt = await act([{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }]);
  assert.equal(receipt.failedStep.code, "secret_not_allowed_here");
  assert.match(receipt.failedStep.error, HANDOFF);
  assert.ok(!calls.includes("approve") && !calls.includes("arm"));
  assert.deepEqual(typed(), []);
});

test("a secret goes only into a text-like input or a textarea", async () => {
  const { page, act, calls, typed, secret, state } = world();
  page.input("Amount", "number");
  page.input("Day", "date");
  page.element("div", { contenteditable: "true", "aria-label": "Note" });
  page.input("Locked", "text", { readOnly: true });
  for (const ref of ["e1", "e2", "e3", "e4"]) {
    const receipt = await act([{ type: "fill_secret", ref, secretRef: secret.secretRef }]);
    assert.equal(receipt.failedStep.code, "not_editable", ref);
  }
  assert.ok(!calls.includes("approve"));
  assert.deepEqual(typed(), []);
  const area = page.textarea("Token");
  const receipt = await act([{ type: "fill_secret", ref: "e5", secretRef: secret.secretRef }]);
  assert.equal(receipt.ok, true);
  assert.equal(state.asked.request.field, "textarea");
  assert.deepEqual(typed(), [area.value]);
});

test("without a way to ask, or when the person declines, nothing is typed and interception is never armed", async () => {
  const unasked = world({ approveSecret: null });
  unasked.page.input("Password", "password");
  const refused = await unasked.act([{ type: "fill_secret", ref: "e1", secretRef: unasked.secret.secretRef }]);
  assert.equal(refused.failedStep.code, "sign_in_required");
  assert.deepEqual(unasked.typed(), []);
  assert.ok(!unasked.calls.includes("arm"));

  const declined = world({ approve: async () => false });
  const field = declined.page.input("Password", "password");
  const receipt = await declined.act([{ type: "fill_secret", ref: "e1", secretRef: declined.secret.secretRef }]);
  assert.equal(receipt.failedStep.code, "credential_declined");
  assert.equal(receipt.dispatched, false);
  assert.deepEqual(declined.typed(), []);
  assert.equal(field.value, "");
  assert.ok(declined.calls.includes("approve") && !declined.calls.includes("arm") && !declined.calls.includes("issue") && !declined.calls.includes("focus:Password"));

  // Anything but a plain yes is a no.
  const vague = world({ approve: async () => "yes" });
  vague.page.input("Password", "password");
  assert.equal((await vague.act([{ type: "fill_secret", ref: "e1", secretRef: vague.secret.secretRef }])).failedStep.code, "credential_declined");
  assert.deepEqual(vague.typed(), []);
});

test("the person is asked about the exact origin, the secret's name and kind, and the field's real type", async () => {
  const { page, act, state, secret } = world();
  page.input("Password", "password");
  await act([{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }]);
  assert.equal(state.asked.sessionId, SESSION);
  assert.deepEqual(state.asked.request, { site: SITE, label: "Example login", kind: "password", field: "password" });
  assert.ok(state.asked.signal instanceof AbortSignal);
});

test("a page that moves while the person decides gets nothing", async () => {
  const moves = [
    (page) => { page.url = `${OTHER}/login`; },
    (page) => { page.url = `${SITE}/elsewhere`; },
    (_page, tab) => { tab.webMcpRevision += 1; },
  ];
  for (const move of moves) {
    const scene = world({ approve: async () => { move(scene.page, scene.tab); return true; } });
    const field = scene.page.input("Password", "password");
    const receipt = await scene.act([{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }]);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "stale_observation");
    assert.deepEqual(scene.typed(), []);
    assert.equal(field.value, "");
    assert.ok(!scene.calls.includes("arm") && !scene.calls.includes("issue") && !scene.calls.includes("focus:Password"));
    assert.deepEqual(scene.core.status(SESSION, TAB), []);
  }
  // The answer came back to the same page, which leaves while the field is looked at once more.
  const late = world({ approve: async () => { late.page.beforeScript = () => { late.page.url = `${OTHER}/login`; }; return true; } });
  late.page.input("Password", "password");
  const receipt = await late.act([{ type: "fill_secret", ref: "e1", secretRef: late.secret.secretRef }]);
  assert.equal(receipt.code, "stale_observation");
  assert.deepEqual(late.typed(), []);
  assert.ok(!late.calls.includes("arm") && !late.calls.includes("focus:Password"));
});

test("a secret removed, or the flag turned off, while the person decides is not typed", async () => {
  const removed = world({ approve: async () => removed.core.remove(SESSION, removed.secret.secretRef) });
  removed.page.input("Password", "password");
  const receipt = await removed.act([{ type: "fill_secret", ref: "e1", secretRef: removed.secret.secretRef }]);
  assert.equal(receipt.failedStep.code, "unknown_secret");
  assert.deepEqual(removed.typed(), []);
  assert.ok(!removed.calls.includes("arm") && !removed.calls.includes("issue"));

  const off = world({ approve: async () => { off.state.flag = false; return true; } });
  off.page.input("Password", "password");
  assert.equal((await off.act([{ type: "fill_secret", ref: "e1", secretRef: off.secret.secretRef }])).failedStep.code, "secrets_unavailable");
  assert.deepEqual(off.typed(), []);
  assert.ok(!off.calls.includes("arm"));
});

test("a field the page retyped or replaced while the person decides is stale", async () => {
  const retyped = world({ approve: async () => { retyped.page.elements[0].attributes.type = "text"; return true; } });
  retyped.page.input("Password", "password");
  const first = await retyped.act([{ type: "fill_secret", ref: "e1", secretRef: retyped.secret.secretRef }]);
  assert.equal(first.failedStep.code, "stale_element");
  assert.deepEqual(retyped.typed(), []);
  assert.ok(!retyped.calls.includes("arm"));

  const replaced = world({ approve: async () => { replaced.page.elements.length = 0; replaced.page.input("Password", "password"); return true; } });
  replaced.page.input("Password", "password");
  const second = await replaced.act([{ type: "fill_secret", ref: "e1", secretRef: replaced.secret.secretRef }]);
  assert.equal(second.failedStep.code, "stale_element");
  assert.deepEqual(replaced.typed(), []);
  assert.equal(replaced.page.elements[0].value, "");
});

test("nothing is typed unless every request of the tab is being intercepted", async () => {
  for (const arm of [async () => false, async () => "armed", async () => { throw new Error("no debugger"); }]) {
    const scene = world({ arm });
    const field = scene.page.input("Password", "password");
    const receipt = await scene.act([{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }]);
    assert.equal(receipt.failedStep.code, "secrets_unavailable");
    assert.match(receipt.failedStep.error, HANDOFF);
    assert.deepEqual(scene.typed(), []);
    assert.equal(field.value, "");
    assert.ok(!scene.calls.includes("issue") && !scene.calls.includes("focus:Password"));
  }
  // Interception that is gone by the time the field has focus stops the step before a placeholder exists.
  let asked = 0;
  const lost = world({ arm: async () => ++asked === 1 });
  lost.page.input("Password", "password");
  const receipt = await lost.act([{ type: "fill_secret", ref: "e1", secretRef: lost.secret.secretRef }]);
  assert.equal(receipt.failedStep.code, "secrets_unavailable");
  assert.deepEqual(lost.typed(), []);
  assert.ok(!lost.calls.includes("issue"));
  assert.deepEqual(lost.core.status(SESSION, TAB), []);
});

test("a page that leaves when the field takes focus gets nothing", async () => {
  const scene = world();
  scene.page.input("Password", "password", { onfocus: () => { scene.page.url = `${OTHER}/landing`; } });
  const receipt = await scene.act([{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }]);
  assert.equal(receipt.code, "page_changed");
  assert.deepEqual(scene.typed(), []);
  assert.ok(!scene.calls.includes("issue"));
  assert.equal(scene.calls.filter((call) => call === "arm").length, 1);
});

test("the happy path asks, rechecks, arms, focuses, issues and types a placeholder, in that order", async () => {
  const { page, act, calls, typed, secret, core, observe, request } = world();
  page.input("Email", "email");
  const field = page.input("Password", "password");
  const receipt = await act([{ type: "fill", ref: "e1", text: "person@app.example" }, { type: "fill_secret", ref: "e2", secretRef: secret.secretRef }]);
  assert.equal(receipt.ok, true);
  const order = calls.slice(calls.indexOf("describe")).map((call) => Array.isArray(call) ? call[0] : call);
  assert.deepEqual(order, ["describe", "approve", "describe", "arm", "focus:Password", "select", "arm", "issue", "insertText"]);
  const [, placeholder] = typed();
  assert.match(placeholder, /^[A-Za-z0-9]{32}$/);
  assert.notEqual(placeholder, VALUE);
  assert.equal(field.value, placeholder);
  assert.deepEqual(receipt.steps, [{ i: 0, type: "fill", ref: "e1", outcome: "verified" }, { i: 1, type: "fill_secret", ref: "e2", secretRef: secret.secretRef, outcome: "verified" }]);
  assert.deepEqual(receipt.secrets, [{ secretRef: secret.secretRef, ref: "e2", state: "pending" }]);
  assert.ok(!("secrets" in receipt.observation) && !("secretsNext" in receipt.observation));
  assertClean(receipt, [placeholder]);
  // The field is listed as filled and never read back; the agent's own text still is.
  const password = receipt.observation.elements.find((element) => element.name === "Password");
  assert.deepEqual([password.filled, password.valueWithheld, "value" in password], [true, true, false]);
  assert.equal(receipt.observation.elements.find((element) => element.name === "Email").value, "person@app.example");
  // The value never reaches the page: only the placeholder does, and only to be typed and compared.
  assert.ok(!page.scripts.some((code) => code.includes(VALUE)));
  assert.equal(page.scripts.filter((code) => code.includes(placeholder)).length, 1);
  assert.ok(!holds(calls, VALUE));
  assert.deepEqual(core.status(SESSION, TAB), [{ secretRef: secret.secretRef, ref: "e2", state: "pending" }]);
  // A full observation and an extract of the page do not read it back either.
  page.text = () => `Welcome back\nPassword field holds ${field.value}`;
  assertClean(await observe({ mode: "full" }), [placeholder]);
  assertClean(await request("extract", { question: "password field holds" }), [placeholder]);
});

test("a document that received a secret takes no more images, whatever the field's type", async () => {
  const { page, act, observe, secret } = world({ kind: "token" });
  page.input("Access token", "text");
  assert.equal((await observe({ includeImage: true })).image.mimeType, "image/png");
  const receipt = await act([{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }]);
  assert.equal(receipt.ok, true);
  assert.equal((await observe({ includeImage: true })).code, "credential_on_screen");
});

test("a tab that received a secret takes no more images on any later page, even with the secret removed, until it closes", async () => {
  const { page, act, observe, secret, core, host } = world({ kind: "token" });
  page.input("Access token", "text");
  assert.equal((await act([{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }])).ok, true);
  // The form's answer is a new document with no field at all, which shows the token back. Nothing in it says
  // a secret was entered: only the host remembers.
  page.elements.length = 0;
  page.context.__openworkCredentialEntered = undefined;
  page.context.__openworkBrowserRefs = undefined;
  page.url = `${SITE}/welcome`;
  page.text = `Your token is ${VALUE}`;
  core.documentChanged(TAB);
  assert.equal((await observe({ mode: "full" })).text, "Your token is [secret]");
  for (const after of ["navigation", "removal"]) {
    if (after === "removal") core.remove(SESSION, secret.secretRef);
    const refused = await observe({ includeImage: true });
    assert.deepEqual([refused.ok, refused.code, "image" in refused], [false, "credential_on_screen", false], after);
  }
  host.invalidate(TAB, { closed: true });
  assert.equal((await observe({ includeImage: true })).image.mimeType, "image/png");
});

test("a single action returns the fill receipt without any value", async () => {
  const { page, request, observe, secret, typed } = world();
  page.input("Password", "password");
  const observation = await observe();
  const receipt = await request("act", { observationId: observation.observationId, action: { type: "fill_secret", ref: "e1", secretRef: secret.secretRef } });
  assert.deepEqual(receipt, { ok: true, dispatched: true, mayHaveChangedState: true, outcome: "verified", retrySafe: false, tabId: TAB, ref: "e1", secretRef: secret.secretRef, next: "observe",
    secrets: [{ secretRef: secret.secretRef, ref: "e1", state: "pending" }] });
  assertClean(receipt, typed());
  const refused = await request("act", { observationId: (await observe()).observationId, action: { type: "fill_secret", ref: "e1", secretRef: "sec_0000000000000000000000" } });
  assert.equal(refused.code, "unknown_secret");
  assert.match(refused.error, HANDOFF);
});

test("a field that does not keep the placeholder fails the step and stops the batch", async () => {
  const { page, act, secret, typed, calls } = world({ kind: "code" });
  page.input("Code", "text", { accepts: (text) => text.replace(/\D/g, "").slice(0, 6) });
  page.element("button", { "aria-label": "Continue" });
  const receipt = await act([{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }, { type: "click", ref: "e2" }]);
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.steps, [{ i: 0, type: "fill_secret", ref: "e1", secretRef: secret.secretRef, outcome: "failed" }]);
  assert.deepEqual([receipt.completed, receipt.failed, receipt.skipped], [0, 1, 1]);
  assert.deepEqual(receipt.failedStep, { index: 0, type: "fill_secret", ref: "e1", secretRef: secret.secretRef, outcome: "failed", code: "value_mismatch", error: receipt.error });
  assert.match(receipt.error, HANDOFF);
  assert.ok(!calls.includes("click"));
  assertClean(receipt, typed());
});

test("a page that copies the placeholder into its text and empties the field shows the agent neither", async () => {
  const scene = world();
  scene.page.input("Password", "password", { oninput: (field) => { scene.copied = field.value; field.value = ""; } });
  scene.page.element("div", { role: "status" }, { text: () => `You typed ${scene.copied ?? "nothing"}` });
  scene.page.text = () => `Sign in\nYou typed ${scene.copied ?? "nothing"}`;
  const receipt = await scene.act([{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }], { request_id: "attempt-1" });
  const [placeholder] = scene.typed();
  assert.equal(scene.copied, placeholder);
  assert.equal(receipt.steps[0].outcome, "failed");
  assert.deepEqual(receipt.observation.status, ["You typed [secret placeholder]"]);
  const read = await scene.observe({ mode: "full" });
  assert.match(read.text, /You typed \[secret placeholder\]/);
  assert.deepEqual((await scene.request("extract", { question: "What was typed?" })).passages, ["You typed [secret placeholder]"]);
  assertClean([receipt, read], [placeholder]);
});

test("the receipt kept for a request_id, and its replay, hold neither the value nor the placeholder", async () => {
  const { page, request, observe, secret, typed, state, calls } = world();
  const field = page.input("Password", "password");
  // The page shows what the server once echoed, and mirrors the field into its status line.
  page.element("div", { role: "status" }, { text: () => `Last sign-in used ${VALUE} and ${VALUE_BASE64}` });
  page.element("output", {}, { text: () => `Field mirror: ${field.value}` });
  const observation = await observe();
  const args = { observationId: observation.observationId, actions: [{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }], request_id: "attempt-1" };
  const receipt = await request("act", args);
  assert.equal(receipt.ok, true);
  const [placeholder] = typed();
  assert.equal(receipt.request_id, "attempt-1");
  assert.ok(holds(receipt.observation.status, "[secret]"));
  assertClean(receipt, [placeholder]);
  // What was stored is already clean: the replay is read with redaction switched off.
  state.redacting = false;
  const replay = await request("act", args);
  state.redacting = true;
  assert.deepEqual(replay, receipt);
  assertClean(replay, [placeholder]);
  assert.deepEqual(typed(), [placeholder]);
  assert.equal(calls.filter((call) => call === "approve").length, 1);
  const conflict = await request("act", { ...args, actions: [{ type: "fill_secret", ref: "e1", secretRef: "sec_0000000000000000000000" }] });
  assert.equal(conflict.code, "request_conflict");
});

test("Enter in the secret's field is not asked about again; text typed into a password field still is", async () => {
  const asked = [];
  const scene = world({ approveCredential: async (_sessionId, request) => { asked.push(request); return true; } });
  scene.page.input("Password", "password");
  scene.page.input("Confirm password", "password");
  const receipt = await scene.act([{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }, { type: "key", key: "Enter", ref: "e1" }]);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.steps.map((step) => step.outcome), ["verified", "settled"]);
  assert.equal(scene.calls.filter((call) => call === "approve").length, 1);
  assert.deepEqual(asked, []);
  assert.ok(scene.calls.includes("key:Enter"));
  const typedToo = await scene.act([{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }, { type: "fill", ref: "e2", text: "typed-by-the-agent" }]);
  assert.equal(typedToo.ok, true);
  assert.deepEqual(asked, [{ site: SITE }]);
  assert.equal(scene.calls.filter((call) => call === "approve").length, 2);
});

test("a key is not sent once the page has left the site the secret was confirmed for", async () => {
  const scene = world();
  scene.page.input("Password", "password", { oninput: () => { scene.left = true; } });
  scene.page.input("Search", "search", { onfocus: () => { if (scene.left) scene.page.url = `${OTHER}/landing`; } });
  const receipt = await scene.act([{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }, { type: "key", key: "Enter", ref: "e2" }]);
  assert.equal(receipt.skippedBecause, "page_changed");
  assert.ok(!scene.calls.includes("key:Enter"));
});

test("fill types its text literally, even a handle or a placeholder, and asks nothing about secrets", async () => {
  const { page, act, calls, typed, secret, core } = world();
  const note = page.input("Note", "text");
  const search = page.input("Search", "search");
  const { placeholder } = core.issue({ sessionId: SESSION, secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e9" });
  const receipt = await act([{ type: "fill", ref: "e1", text: secret.secretRef }, { type: "fill", ref: "e2", text: `find ${placeholder}` }]);
  assert.equal(receipt.ok, true);
  assert.deepEqual(typed(), [secret.secretRef, `find ${placeholder}`]);
  assert.equal(note.value, secret.secretRef);
  assert.equal(search.value, `find ${placeholder}`);
  assert.ok(!calls.includes("approve") && !calls.includes("arm") && !calls.includes("issue") && !calls.includes("describe"));
  // The handle is the agent's to read; a placeholder is not, wherever it came from.
  assert.equal(receipt.observation.elements.find((element) => element.name === "Note").value, secret.secretRef);
  assert.equal(receipt.observation.elements.find((element) => element.name === "Search").value, "find [secret placeholder]");
});

test("a submit that carries the placeholder is swapped by the host and reported as sent", async () => {
  const { page, act, secret, send, state, typed } = world();
  // A page reports what is typed before anything is submitted: that says nothing about the secret.
  const field = page.input("Password", "password", { oninput: () => send({ event: "field_changed" }) });
  page.element("button", { "aria-label": "Sign in" }, { onclick: () => send({ password: field.value }) });
  const receipt = await act([{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }, { type: "click", ref: "e2" }]);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.secrets, [{ secretRef: secret.secretRef, ref: "e1", state: "sent", sentTo: [SITE] }]);
  assert.doesNotMatch(receipt.next, HANDOFF);
  assert.deepEqual(state.network.map((request) => request.sent), [JSON.stringify({ event: "field_changed" }), JSON.stringify({ password: VALUE })]);
  assertClean(receipt, typed());
});

test("a submit that does not carry the placeholder is reported as not sent, with a hand-off", async () => {
  const { page, act, observe, request, secret, send, typed } = world();
  const field = page.input("Password", "password", { oninput: () => send({ event: "field_changed" }) });
  // The page hashes what was typed, so the placeholder never leaves it.
  page.element("button", { "aria-label": "Sign in" }, { onclick: () => send({ digest: `sha256-of-${field.value.length}-characters` }) });
  const filled = await act([{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }]);
  assert.deepEqual(filled.secrets, [{ secretRef: secret.secretRef, ref: "e1", state: "pending" }]);
  assert.doesNotMatch(filled.next, HANDOFF);
  const receipt = await request("act", { observationId: filled.observation.observationId, actions: [{ type: "click", ref: "e2" }] });
  const undelivered = [{ secretRef: secret.secretRef, ref: "e1", state: "not_sent", reason: "left_without_secret" }];
  assert.deepEqual(receipt.secrets, undelivered);
  assert.match(receipt.next, HANDOFF);
  assert.match(receipt.next, /not_sent/);
  const observation = await observe();
  assert.deepEqual(observation.secrets, undelivered);
  assert.match(observation.secretsNext, HANDOFF);
  // A refused action on that tab says so too.
  const refused = await request("act", { observationId: observation.observationId, actions: [{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef, text: "x" }] });
  assert.equal(refused.code, "invalid_action");
  assert.deepEqual(refused.secrets, undelivered);
  assert.match(refused.next, HANDOFF);
  assertClean([receipt, observation, refused], typed());
});

test("a placeholder sent to another site stays a placeholder and is reported as not sent", async () => {
  const { page, act, secret, send, state, typed } = world();
  const field = page.input("Password", "password");
  page.element("button", { "aria-label": "Sign in" }, { onclick: () => send({ password: field.value }, { to: `${OTHER}/collect` }) });
  const receipt = await act([{ type: "fill_secret", ref: "e1", secretRef: secret.secretRef }, { type: "click", ref: "e2" }]);
  assert.deepEqual(receipt.secrets, [{ secretRef: secret.secretRef, ref: "e1", state: "not_sent", reason: "other_origin" }]);
  assert.match(receipt.next, HANDOFF);
  assert.deepEqual(state.network.map((request) => request.sent), [JSON.stringify({ password: typed()[0] })]);
  assert.ok(!holds(state.network, VALUE));
  assertClean(receipt, typed());
});

test("an observation whose page text echoes the value, in any encoding, is redacted", async () => {
  for (const flag of [true, false]) {
    const text = `Signed in.\nRaw: ${VALUE}\nBase64: ${VALUE_BASE64}\nBasic: ${Buffer.from(`person:${VALUE}`).toString("base64")}\nAddress: /next?token=${VALUE_URL}\nJSON: ${JSON.stringify({ token: VALUE })}`;
    const { page, observe } = world({ flag, text });
    page.title = `Welcome ${VALUE}`;
    page.input("Search", "search", { attributes: { placeholder: VALUE } });
    page.element("div", { role: "alert" }, { text: `Rejected ${VALUE_URL}` });
    for (const args of [{ includeText: true }, { mode: "full" }]) {
      const observation = await observe(args);
      assert.equal(observation.ok, true);
      assertClean(observation);
      assert.match(observation.text, /Raw: \[secret\]\nBase64: \[secret\]/);
      assert.equal(observation.title, "Welcome [secret]");
    }
  }
});

test("a secret echoed across a cut is redacted whole before the cut, in every text of an observation", async () => {
  const head = VALUE.slice(0, 5);
  const before = (limit) => "x".repeat(limit - 5);
  const { page, observe, request, core } = world({ text: `${before(16_000)}${VALUE}` });
  page.title = `${before(300)}${VALUE}`;
  page.input(`${before(120)}${VALUE}`, "search");
  page.input("Described", "search", { attributes: { "aria-describedby": "note", id: "described" } });
  page.element("span", { id: "note" }, { text: `${before(200)}${VALUE}` });
  page.element("div", { role: "status" }, { text: `${before(300)}${VALUE_URL}` });
  page.element("p", {}, { text: `${before(200)}${VALUE_BASE64}` });
  for (const args of [{ includeText: true }, { mode: "full" }]) {
    const observation = await observe(args);
    assert.equal(observation.ok, true);
    for (const hidden of [head, VALUE_URL.slice(0, 5), VALUE_BASE64.slice(0, 5)]) assert.ok(!holds(observation, hidden), "the start of an echoed secret was left at a cut");
    assert.equal(observation.title, `${before(300)}[secret]`);
    assert.equal(observation.text, `${before(16_000)}[secret]`);
  }
  // A secret that begins past the cut is simply cut off, and nothing is read back longer than before.
  page.title = `${"x".repeat(300)}${VALUE}`;
  assert.equal((await observe({ mode: "full" })).title, "x".repeat(300));
  assert.equal((await request("tabs")).tabs[0].title, "x".repeat(300));
  // The page is given a number of characters to read past each cut, and nothing of any secret.
  assert.ok(page.scripts.every((code) => !code.includes(VALUE)));
  assert.ok(core.redactor().span >= VALUE.length * 11 && page.scripts.some((code) => code.includes(`"reach":${core.redactor().span}`)));
});

test("a secret that begins and ends with spaces is found before any text is trimmed", async () => {
  const spaced = "  fake spaced value \t";
  const { page, observe, request, core } = world({ text: spaced });
  core.add({ sessionId: SESSION, label: "Spaced", kind: "token", origins: [SITE], value: spaced });
  page.input(spaced, "search");
  page.element("div", { role: "status" }, { text: spaced });
  page.element("div", { role: "alert" }, { text: " \n " });
  page.element("button", { "aria-label": "  Continue  " });
  for (const args of [{ includeText: true }, { mode: "full" }]) {
    const observation = await observe(args);
    assert.ok(!holds(observation, "fake spaced"), "what was left of a trimmed secret was read back");
    assert.equal(observation.text, "[secret]");
    assert.equal(observation.elements[0].name, "[secret]");
    assert.ok(observation.elements.some((element) => element.name === "Continue"));
    if (!args.mode) assert.deepEqual(observation.status, ["[secret]"]);
  }
  const extracted = await request("extract", { question: "fake spaced value" });
  assert.deepEqual([extracted.passages, extracted.pageChars], [[], 8]);
  // Names are still matched as the agent reads them.
  assert.equal((await observe({ query: { name: "continue" } })).elements.length, 1);
});

test("a spaced secret echoed in the text a field refers to is found before it is trimmed", async () => {
  const spaced = "  fake spaced value \t";
  const { page, observe, core } = world();
  core.add({ sessionId: SESSION, label: "Spaced", kind: "token", origins: [SITE], value: spaced });
  page.input("Unnamed", "search", { attributes: { type: "search", "aria-labelledby": "label", "aria-describedby": "note", "aria-errormessage": "error", "aria-invalid": "true" } });
  for (const id of ["label", "note", "error"]) page.element("span", { id }, { text: spaced });
  page.input("Fallback", "search", { attributes: { type: "search", "aria-label": "Fallback", "aria-labelledby": "blank" } });
  page.element("span", { id: "blank" }, { text: " \n " });
  for (const args of [{}, { mode: "full" }]) {
    const observation = await observe(args);
    assert.ok(!holds(observation, "fake spaced"), "the inside of a trimmed secret was read back");
    const [field, fallback] = observation.elements;
    assert.equal(field.name, "[secret]");
    // A reference to blank text names nothing, as before.
    assert.equal(fallback.name, "Fallback");
  }
});

test("after the person removes a secret, a new request still reads none of what the site shows back of it", async () => {
  const echo = { ok: true, result: { echoed: VALUE, encoded: [VALUE_BASE64, VALUE_URL] } };
  const { request, observe, page, core, secret } = world({ runSiteTool: async () => echo, text: `Your token is ${VALUE}` });
  page.input("Search", "search");
  page.title = `Signed in with ${VALUE}`;
  assert.equal(core.remove(SESSION, secret.secretRef), true);
  // Every operation here begins after the removal.
  const results = [await request("site_tool", { toolId: "t1", input: {} }), await observe({ mode: "full" }), await request("extract", { question: "token" }), await request("tabs")];
  assertClean(results);
  assert.deepEqual(results[0].result, { echoed: "[secret]", encoded: ["[secret]", "[secret]"] });
  assert.equal(results[1].text, "Your token is [secret]");
  assert.equal(results[3].tabs[0].title, "Signed in with [secret]");
  assert.equal(results[1].availableSecrets, undefined);
  core.clear();
  assertClean([await request("site_tool", { toolId: "t1", input: {} }), await observe({ mode: "full" })]);
});

test("an extract chooses, cuts and counts only what is left after redaction", async () => {
  const long = `${"word ".repeat(117)}${VALUE} token`;
  const { request, page } = world({ text: `${VALUE}\nreference ${long}` });
  page.input("Search", "search");
  // A page that shows only the secret has the same length whatever the secret's.
  assert.equal((await request("extract", { question: "reference" })).pageChars, `[secret]\nreference ${"word ".repeat(117)}[secret] token`.length);
  // A long line is cut at 600 characters: the secret that crosses the cut is gone before it.
  const cut = await request("extract", { question: "reference token" });
  assert.ok(cut.passages[0].endsWith("word [secr…") && !holds(cut, VALUE.slice(0, 5)));
  // Words of the secret itself match no line: asking for them does not confirm a guess.
  assert.deepEqual((await request("extract", { question: "real 42" })).passages, []);
});

test("an extract whose passages echo the value is redacted", async () => {
  const { request, page } = world({ text: `Account\nYour token is ${VALUE}\nEncoded token: ${VALUE_BASE64}\nToken link: https://app.example/t?x=${VALUE_URL}` });
  page.input("Search", "search");
  const result = await request("extract", { question: "What is the token?" });
  assert.equal(result.ok, true);
  assert.equal(result.passages.length > 0, true);
  assert.ok(holds(result.passages, "[secret]"));
  assertClean(result);
});

test("site tools, their results, tab titles and coded errors that echo the value are redacted", async () => {
  const echo = { ok: true, dispatched: true, result: { echoed: VALUE, nested: [VALUE_BASE64, { [`key ${VALUE}`]: VALUE_URL }] } };
  const { request, page } = world({ runSiteTool: async () => echo, siteTools: async () => ({ ok: true, tools: [{ toolId: "t1", description: `Use ${VALUE}` }] }) });
  page.input("Search", "search");
  page.title = `Inbox for ${VALUE}`;
  const ran = await request("site_tool", { toolId: "t1", input: {} });
  assert.deepEqual(ran, { ok: true, dispatched: true, result: { echoed: "[secret]", nested: ["[secret]", { "key [secret]": "[secret]" }] } });
  assert.equal(echo.result.echoed, VALUE);
  const listed = await request("site_tools");
  assert.equal(listed.tools[0].description, "Use [secret]");
  const tabs = await request("tabs");
  assert.equal(tabs.tabs[0].title, "Inbox for [secret]");
  assertClean([ran, listed, tabs]);

  const failing = world({ runSiteTool: async () => { throw Object.assign(new Error(`The site answered ${VALUE}`), { code: "site_tool_failed" }); } });
  failing.page.input("Search", "search");
  const failed = await failing.request("site_tool", { toolId: "t1", input: {} });
  assert.equal(failed.code, "site_tool_failed");
  assert.equal(failed.error, "The site answered [secret]");
  assertClean(failed);
});

test("a request_id is reserved before anything is awaited: the same id in another tab at the same moment is refused", async () => {
  const calls = [];
  const pages = new Map(["tab-1", "tab-2"].map((tabId) => [tabId, createPage(calls)]));
  const tabs = new Map([...pages].map(([tabId, page]) => [tabId, { tabId, webMcpRevision: 1, webMcpToolCount: 0, view: { webContents: {
    isDestroyed: () => false, isLoading: () => false, getURL: () => page.url, getTitle: () => page.title,
    executeJavaScriptInIsolatedWorld: async (_world, [{ code }]) => structuredClone(await vm.runInContext(code, page.context)),
    async insertText(text) { calls.push([tabId, text]); page.document.activeElement.value = text; },
    sendInputEvent: async () => {}, captureObservation: async () => Buffer.from("stand-in image"),
    debugger: { isAttached: () => true, attach() {}, detach() {}, on() {}, removeListener() {}, sendCommand: async () => {} } } } }]));
  let waiting = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const host = createBrowserTaskHost({ getTab: (id) => tabs.get(id) ?? null, tabsFor: () => [...tabs.values()], ownerOf: (id) => tabs.has(id) ? SESSION : null, activeFor: () => "tab-1",
    isVisible: () => true, openTab: async () => { throw new Error("This test opens no tab."); }, navigate: async () => {}, allowed: async () => true, enabled: () => true, changed: () => {},
    siteTools: async () => ({ ok: true, tools: [] }), runSiteTool: async () => ({ ok: true }),
    // Both requests are held here, after the id was looked up and before anything is typed.
    beforeInput: async () => { waiting++; await gate; } });
  const act = async (tabId, text) => {
    pages.get(tabId).input("Name", "text");
    const observation = await host.request({ sessionId: SESSION, operation: "observe", args: { tabId, mode: "interactive" } });
    return () => host.request({ sessionId: SESSION, operation: "act", args: { tabId, observationId: observation.observationId, request_id: "same-id", actions: [{ type: "fill", ref: "e1", text }] } });
  };
  const [first, second] = [await act("tab-1", "first"), await act("tab-2", "second")];
  const running = [first(), second()];
  for (let turn = 0; turn < 50 && waiting < 1; turn++) await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const [one, two] = await Promise.all(running);
  assert.deepEqual([one.ok, two.ok, two.code, two.dispatched], [true, false, "request_conflict", false]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call)), [["tab-1", "first"]]);
  assert.equal(waiting, 1, "the second request never reached the page");
  // The first receipt is the one kept, and the refused request left nothing behind.
  assert.deepEqual(await first(), one);
  assert.equal((await second()).code, "request_conflict");
  assert.deepEqual(calls.filter((call) => Array.isArray(call)), [["tab-1", "first"]]);
});
