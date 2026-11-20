// Defensive review regressions. Every assertion describes the safe behaviour, including defects
// not fixed yet. Values are deliberately fake; assertion failures never print a value or placeholder.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { createBrowserSecrets, decidePausedRequest } from "./browser-secrets.mjs";
import { createBrowserTaskHost } from "./browser-task.mjs";

const SITE = "https://app.example";
const OTHER = "https://other.example";
const SESSION = "review-session";
const TAB = "review-tab";
const VALUE = "fake-Review-123+/ &é";

function seeded(value = VALUE, options = {}, origins = [SITE]) {
  const clock = { at: 1_000_000 };
  const secrets = createBrowserSecrets({ now: () => clock.at, ...options });
  const secret = secrets.add({ sessionId: SESSION, label: "Example login", kind: "password", origins, value });
  const issue = (ref = "e1", tabId = TAB) => secrets.issue({ sessionId: SESSION, secretRef: secret.secretRef, tabId, origin: origins[0], ref }).placeholder;
  return { secrets, secret, clock, issue, placeholder: issue(), value };
}
const request = (body, extra = {}) => ({ tabId: TAB, url: `${SITE}/login`, method: "POST", resourceType: "XHR", headers: { "Content-Type": "application/json" }, body: Buffer.from(body), bodyComplete: true, ...extra });
const json = (placeholder, extra = {}) => request(JSON.stringify({ password: placeholder }), extra);
const clean = (output, hidden) => assert.ok(!JSON.stringify(output).includes(hidden), "readback must not contain protected characters");
const multipart = (placeholder, boundary) => request(`--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${placeholder}\r\n--${boundary}--\r\n`, { headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });

for (const [name, url] of [
  ["a trailing dot", "https://app.example./login"],
  ["a different port", "https://app.example:8443/login"],
  ["userinfo naming the allowed host", "https://app.example@other.example/login"],
  ["a subdomain", "https://login.app.example/login"],
  ["an insecure scheme", "http://app.example/login"],
  ["a blob URL embedding the allowed origin", "blob:https://app.example/id"],
  ["an IPv6 address", "https://[::1]/login"],
]) test(`a value is never placed in a request to an origin distinguished by ${name}`, () => {
  const { secrets, placeholder, value } = seeded();
  const result = secrets.rewrite(json(placeholder, { url }));
  assert.equal(result.body, undefined);
  clean(result, value);
});

test("canonical case and a default HTTPS port do not widen the destination origin", () => {
  const { secrets, placeholder, value } = seeded();
  const result = secrets.rewrite(json(placeholder, { url: "https://APP.example:443/login" }));
  assert.ok(result.body?.equals(Buffer.from(JSON.stringify({ password: value }))));
});

test("internationalised origins compare using their canonical punycode origin", () => {
  const origin = new URL("https://é.example").origin;
  const { secrets, placeholder, value } = seeded(VALUE, {}, [origin]);
  const result = secrets.rewrite(json(placeholder, { url: "https://é.example/login" }));
  assert.ok(result.body?.equals(Buffer.from(JSON.stringify({ password: value }))));
  assert.equal(secrets.rewrite(json(placeholder, { url: "https://e.example/login" })).body, undefined);
});

test("the default store never accepts the test-only loopback HTTP exception", () => {
  const { secrets } = seeded();
  for (const origin of ["http://localhost:4010", "http://127.0.0.1:4010", "http://[::1]:4010"]) {
    assert.throws(() => secrets.add({ sessionId: SESSION, label: "Local example", kind: "password", origins: [origin], value: VALUE }), { code: "invalid_secret" });
  }
});

test("placeholders in URL fragments and mixed percent escapes prevent every swap", () => {
  const { secrets, placeholder } = seeded();
  const escaped = [...placeholder].map((char, index) => index % 2 ? `%${char.charCodeAt(0).toString(16)}` : char).join("");
  for (const suffix of [`#${placeholder}`, `?p=${escaped}`, `#${encodeURIComponent(escaped)}`]) {
    assert.deepEqual(secrets.rewrite(json(placeholder, { url: `${SITE}/login${suffix}` })), { action: "continue" });
  }
});

test("Cookie Origin Host and Referer never receive substituted values", () => {
  const { secrets, placeholder, value } = seeded();
  const result = secrets.rewrite(json(placeholder, { headers: { "Content-Type": "application/json", Cookie: placeholder, Origin: placeholder, Host: placeholder } }));
  assert.ok(result.body?.includes(JSON.stringify(value).slice(1, -1)));
  assert.equal(result.headers, undefined);
  assert.deepEqual(secrets.rewrite(json(placeholder, { headers: { "Content-Type": "application/json", Referer: `${SITE}/${placeholder}`, Authorization: placeholder } })), { action: "continue" });
});

test("two handles in one request are independently restricted to their allow-lists", () => {
  const { secrets, placeholder, value } = seeded();
  const second = secrets.add({ sessionId: SESSION, label: "Other example", kind: "token", origins: [SITE, OTHER], value: "fake-other-review-value" });
  const p2 = secrets.issue({ sessionId: SESSION, secretRef: second.secretRef, tabId: TAB, origin: SITE, ref: "e2" }).placeholder;
  const result = secrets.rewrite(request(JSON.stringify({ a: placeholder, b: p2 }), { url: `${OTHER}/collect` }));
  assert.ok(result.body?.equals(Buffer.from(JSON.stringify({ a: placeholder, b: "fake-other-review-value" }))));
  clean(result.body?.toString(), value);
});

test("a split placeholder in complete CDP body entries is substituted only after all bytes are joined", async () => {
  const { secrets, placeholder, value } = seeded();
  const body = Buffer.from(JSON.stringify({ password: placeholder }));
  const split = 20;
  const result = await decidePausedRequest(secrets, TAB, { requestId: "r1", resourceType: "XHR", request: {
    url: `${SITE}/login`, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true,
    postDataEntries: [body.subarray(0, split), body.subarray(split)].map((bytes) => ({ bytes: bytes.toString("base64") })),
  } });
  assert.equal(result.method, "Fetch.continueRequest");
  assert.ok(Buffer.from(result.params.postData ?? "", "base64").equals(Buffer.from(JSON.stringify({ password: value }))));
});

test("invalid JSON BOM non-UTF-8 and incomplete visible bodies fail without a partial swap", () => {
  const { secrets, placeholder } = seeded();
  for (const req of [request(`\ufeff{"p":"${placeholder}"}`), request(`{"p":"${placeholder}"`),
    json(placeholder, { headers: { "Content-Type": "application/json; charset=utf-16" } }),
    json(placeholder, { bodyComplete: false }), request(`${"[".repeat(20_000)}"${placeholder}"${"]".repeat(20_000)}`)]) {
    assert.deepEqual(secrets.rewrite(req), { action: "fail" });
  }
});

test("duplicate JSON keys and special property names preserve the parsed structure without prototype mutation", () => {
  const { secrets, placeholder, value } = seeded();
  const result = secrets.rewrite(request(`{"p":"${placeholder}","p":"${placeholder}","__proto__":{"p":"${placeholder}"}}`));
  assert.equal(result.action, "continue");
  const parsed = JSON.parse(result.body.toString());
  assert.ok(parsed.p === value && Object.getOwnPropertyDescriptor(parsed, "__proto__").value.p === value);
  assert.equal(Object.prototype.p, undefined);
});

test("a cross-origin redirect carrying an already substituted body is blocked while its entry is live", () => {
  const { secrets, placeholder } = seeded();
  const first = secrets.rewrite(json(placeholder));
  assert.deepEqual(secrets.rewrite(request(first.body, { url: `${OTHER}/collect` })), { action: "fail" });
});

test("a delayed redirect cannot carry a substituted body away after placeholder expiry", async () => {
  const { secrets, placeholder, clock } = seeded(VALUE, { placeholderTtlMs: 100 });
  const first = secrets.rewrite(json(placeholder));
  clock.at += 101;
  const result = await decidePausedRequest(secrets, TAB, { requestId: "redirect", request: {
    url: `${OTHER}/collect`, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true, postData: first.body.toString(),
  } });
  assert.equal(result.method, "Fetch.failRequest", "expiry must not release protection of an in-flight rewritten request");
});

test("no amount of waiting releases a redirect of a rewritten request, named by the browser or not", async () => {
  for (const named of [true, false]) {
    const { secrets, placeholder, clock } = seeded(VALUE, { placeholderTtlMs: 100 });
    const body = JSON.stringify({ password: placeholder });
    const first = named
      ? await decidePausedRequest(secrets, TAB, { requestId: "first", networkId: "chain", request: { url: `${SITE}/login`, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true, postData: body } })
      : { params: { postData: secrets.rewrite(json(placeholder)).body.toString("base64") } };
    const rewritten = Buffer.from(first.params.postData, "base64").toString();
    assert.ok(rewritten.includes(JSON.stringify(VALUE).slice(1, -1)));
    // Far past the placeholder's life and past any timer a guard could have had.
    for (const waited of [121_000, 600_000, 86_400_000]) {
      clock.at += waited;
      assert.equal(secrets.live(TAB), false);
      assert.equal(secrets.guarded(TAB), true, "the host must keep seeing the tab's requests");
      for (const redirect of [{ redirectedRequestId: "first" }, { networkId: "chain" }]) {
        const result = await decidePausedRequest(secrets, TAB, { requestId: `late-${waited}`, ...(named ? redirect : {}), request: {
          url: `${OTHER}/collect`, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true, postData: rewritten } });
        assert.equal(result.method, "Fetch.failRequest", "a server may answer with a redirect as late as it likes");
      }
    }
  }
});

test("with requests named by the browser, a page's own cross-origin request is never judged by what it holds", async () => {
  const { secrets, placeholder, value } = seeded();
  const paused = (requestId, url, postData, extra = {}) => decidePausedRequest(secrets, TAB, { requestId, networkId: `net-${requestId}`, ...extra,
    request: { url, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true, postData } });
  const first = await paused("first", `${SITE}/login`, JSON.stringify({ password: placeholder }));
  const rewritten = Buffer.from(first.params.postData, "base64").toString();
  // The exact rewritten body, a right guess and a wrong guess all get the same answer: the page learns nothing.
  const answers = [];
  for (const [index, guess] of [rewritten, JSON.stringify({ password: value }), value, JSON.stringify({ password: "fake-wrong-guess" })].entries()) answers.push((await paused(`probe-${index}`, `${OTHER}/probe`, guess)).method);
  assert.deepEqual(new Set(answers), new Set(["Fetch.continueRequest"]));
  assert.equal((await paused("hop", `${OTHER}/collect`, rewritten, { redirectedRequestId: "first" })).method, "Fetch.failRequest");
});

test("a rewritten body the browser sends again on reload is still followed to its redirect", async () => {
  for (const lineage of ["redirectedRequestId", "networkId"]) {
    const { secrets, secret, placeholder, clock } = seeded();
    const paused = (requestId, url, postData, extra = {}) => decidePausedRequest(secrets, TAB, { requestId, networkId: `net-${requestId}`, ...extra,
      request: { url, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true, postData } });
    const first = await paused("first", `${SITE}/login`, JSON.stringify({ password: placeholder }));
    const rewritten = Buffer.from(first.params.postData, "base64").toString();
    secrets.remove(SESSION, secret.secretRef);
    clock.at += 86_400_000;
    // The reload is a new request with new names that follows nothing; it holds the value and no placeholder.
    assert.deepEqual(await paused("reload", `${SITE}/login`, rewritten), { method: "Fetch.continueRequest", params: { requestId: "reload" } });
    const redirect = lineage === "networkId" ? { networkId: "net-reload" } : { networkId: undefined, redirectedRequestId: "reload" };
    assert.equal((await paused("moved", `${OTHER}/collect`, rewritten, redirect)).method, "Fetch.failRequest", "the resent body must not follow a redirect elsewhere");
    // A request the page makes to another origin is still its own, whatever it holds.
    assert.equal((await paused("own", `${OTHER}/collect`, rewritten)).method, "Fetch.continueRequest");
  }
});

test("reissuing the same field cannot forget the redirect protection of a previously substituted body", () => {
  const { secrets, placeholder, issue } = seeded();
  const first = secrets.rewrite(json(placeholder));
  issue();
  assert.equal(secrets.rewrite(request(first.body, { url: `${OTHER}/collect` })).action, "fail", "old in-flight requests remain protected when a field is filled again");
});

test("an unreadable cross-origin follow-up body fails closed after the tab has sent a substituted request", async () => {
  const { secrets, placeholder } = seeded();
  secrets.rewrite(json(placeholder));
  const result = await decidePausedRequest(secrets, TAB, { requestId: "unreadable-redirect", request: {
    url: `${OTHER}/collect`, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true,
  } }, { readBody: async () => { throw new Error("body unavailable"); } });
  assert.equal(result.method, "Fetch.failRequest", "an unreadable browser-owned body may already hold the value");
});

test("cross-origin request acceptance does not act as a dictionary oracle after a secret was sent", () => {
  const { secrets, placeholder, value } = seeded();
  secrets.rewrite(json(placeholder));
  const guessed = secrets.rewrite(request(value, { url: `${OTHER}/probe`, headers: { "Content-Type": "text/plain" } }));
  const wrong = secrets.rewrite(request("fake-incorrect-review-guess", { url: `${OTHER}/probe`, headers: { "Content-Type": "text/plain" } }));
  assert.equal(guessed.action, wrong.action, "page-authored probes must not expose whether their guessed body contains a secret");
});

test("multipart request acceptance does not reveal whether a guessed substring occurs in a secret", () => {
  const { secrets, placeholder } = seeded("fake-boundary-probe");
  const present = secrets.rewrite(multipart(placeholder, "probe"));
  const absent = secrets.rewrite(multipart(placeholder, "neverPresent"));
  assert.equal(present.action, absent.action, "a page-selected boundary must not become a secret-substring oracle");
});

test("overlapping occurrences leave no reconstructable secret suffix in redacted text", () => {
  const { secrets } = seeded("fakefake");
  assert.ok(/^(\[secret\])+$/.test(secrets.redactText("fakefakefake")), "the union of overlapping matches must be removed");
});

test("numeric HTML entities and mixed-case hex are redacted at string boundaries", () => {
  const { secrets, value } = seeded();
  const decimal = [...value].map((char) => `&#${char.codePointAt(0)};`).join("");
  const hex = Buffer.from(value).toString("hex").split("").map((char, index) => index % 2 ? char.toUpperCase() : char).join("");
  assert.ok(secrets.redactText(decimal) === "[secret]");
  assert.ok(secrets.redactText(hex) === "[secret]");
});

test("UTF-8 echoed through a Latin-1 document cannot return recoverable secret bytes", () => {
  const { secrets, value } = seeded();
  const mojibake = Buffer.from(value, "utf8").toString("latin1");
  assert.ok(secrets.redactText(mojibake) === "[secret]", "misdecoded UTF-8 must not bypass redaction");
});

test("line-wrapped base64 at every byte alignment is redacted with and without padding", () => {
  const { secrets, value } = seeded();
  for (const prefix of ["", "x", "xy"]) for (const encoding of ["base64", "base64url"]) for (const padded of [true, false]) {
    let encoded = Buffer.from(`${prefix}${value}`).toString(encoding);
    if (!padded) encoded = encoded.replace(/=+$/, "");
    const wrapped = encoded.match(/.{1,4}/g).join("\r\n");
    assert.ok(secrets.redactText(wrapped).includes("[secret]"), "line wrapping must not make recoverable base64 invisible");
  }
});

test("a page cannot reveal an issued placeholder by hex-encoding it", () => {
  const { secrets, placeholder } = seeded();
  const encoded = Buffer.from(placeholder).toString("hex");
  assert.ok(secrets.redactText(encoded) !== encoded, "encoded placeholder readback must be withheld");
});

test("retired placeholders are withheld across repeated navigation loss and close notifications", () => {
  const { secrets, placeholder, clock } = seeded();
  secrets.documentChanged(TAB);
  secrets.interceptionLost(TAB);
  secrets.documentChanged(TAB);
  secrets.tabClosed(TAB);
  clock.at += 700_000;
  assert.equal(secrets.live(TAB), false);
  assert.deepEqual(secrets.status(SESSION, TAB), []);
  assert.ok(secrets.redactText(placeholder) === "[secret placeholder]");
});

test("another tab or conversation cannot reuse a handle or its issued placeholder", () => {
  const { secrets, secret, placeholder, issue } = seeded();
  issue("e1", "other-tab");
  assert.equal(secrets.describe("other-session", secret.secretRef), null);
  assert.deepEqual(secrets.status("other-session", TAB), []);
  assert.throws(() => secrets.issue({ sessionId: "other-session", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e2" }), { code: "unknown_secret" });
  assert.equal(secrets.rewrite(json(placeholder, { tabId: "other-tab" })).body, undefined);
});

// A minimal DOM in its own realm, following browser-task-secrets.test.mjs. The real host's page
// functions run unchanged; hooks model events fired by an untrusted page while the host waits.
function matches(element, compound) {
  let rest = compound.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) { if (element.tagName.toLowerCase() !== tag[0].toLowerCase()) return false; rest = rest.slice(tag[0].length); }
  while (rest) {
    const attr = /^\[([\w-]+)(?:([*^]?=)["']([^"']*)["'](?:\s+i)?)?\]/.exec(rest);
    const not = /^:not\(([^()]*)\)/.exec(rest);
    const disabled = /^:disabled/.exec(rest);
    const named = /^[#.][\w-]+/.exec(rest);
    const part = attr ?? not ?? disabled ?? named;
    if (!part) throw new Error("unsupported stand-in selector");
    if (attr) {
      const actual = element.getAttribute(attr[1]);
      if (actual === null || attr[2] === "=" && actual !== attr[3]
        || attr[2] === "*=" && !actual.toLowerCase().includes(attr[3].toLowerCase())
        || attr[2] === "^=" && !actual.startsWith(attr[3])) return false;
    }
    if (not && matches(element, not[1]) || disabled && element.disabled !== true || named && !(named[0][0] === "#" && element.id === named[0].slice(1))) return false;
    rest = rest.slice(part[0].length);
  }
  return true;
}
class HTMLElement {
  constructor(page, tag, attrs = {}) { this.page = page; this.tagName = tag.toUpperCase(); this.attributes = attrs; this.parentElement = null; this.text = ""; this.scrollHeight = 24; this.clientHeight = 24; this.scrollTop = 0; }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  get id() { return this.attributes.id ?? ""; }
  get isConnected() { return this.page.elements.includes(this); }
  get isContentEditable() { return false; }
  get innerText() { return typeof this.text === "function" ? this.text() : this.text; }
  get textContent() { return this.innerText; }
  matches(selector) { return selector.split(",").some((part) => matches(this, part)); }
  closest(selector) { return this.matches(selector) ? this : null; }
  contains(element) { return element === this; }
  getBoundingClientRect() { const x = 20, y = 20 + 40 * this.page.elements.indexOf(this); return { x, y, width: 300, height: 24, left: x, top: y, right: x + 300, bottom: y + 24 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  focus() { this.page.document.activeElement = this; this.onfocus?.(); }
  scrollIntoView() {}
  dispatchEvent() { return true; }
}
class HTMLInputElement extends HTMLElement {
  constructor(page, label, type) { super(page, "input", { type, "aria-label": label }); this.value = ""; this.readOnly = false; this.required = false; this.labels = []; this.validity = { valid: true }; this.validationMessage = ""; }
  get type() { return this.attributes.type; }
  select() { this.selected = true; }
}
class HTMLTextAreaElement extends HTMLElement {}
class HTMLSelectElement extends HTMLElement {}
class HTMLLabelElement extends HTMLElement {}
class HTMLOptGroupElement extends HTMLElement {}

function world() {
  const { secrets, secret } = seeded();
  secrets.tabClosed(TAB);
  const page = { url: `${SITE}/login`, title: "Example", text: "", elements: [], document: null, context: null };
  const typed = [];
  const hooks = { arms: 0, approvals: 0, arm: async () => true, approve: async () => true, siteTool: async () => ({ ok: true }) };
  page.document = {
    activeElement: null, readyState: "complete", get title() { return page.title; },
    body: { get innerText() { return typeof page.text === "function" ? page.text() : page.text; } },
    querySelectorAll: (selector) => page.elements.filter((element) => element.matches(selector)),
    querySelector: (selector) => page.elements.find((element) => element.matches(selector)) ?? null,
    getElementById: (id) => page.elements.find((element) => id && element.id === id) ?? null,
    elementFromPoint: (x, y) => page.elements.findLast((element) => { const r = element.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }) ?? null,
    getSelection: () => null,
  };
  page.context = vm.createContext({ document: page.document, HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLLabelElement, HTMLOptGroupElement,
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance, setTimeout,
    MutationObserver: class { observe() {} }, Node: { ELEMENT_NODE: 1 }, Event: class {} });
  const contents = {
    isDestroyed: () => false, isLoading: () => false, getURL: () => page.url, getTitle: () => page.title,
    executeJavaScriptInIsolatedWorld: async (_world, [{ code }]) => structuredClone(await vm.runInContext(code, page.context)),
    async insertText(text) { typed.push(text); const element = page.document.activeElement; if (element) { element.value = element.selected ? text : element.value + text; element.selected = false; element.oninput?.(); } },
    sendInputEvent: async () => {}, captureObservation: async () => Buffer.from("stand-in image"),
    debugger: { isAttached: () => true, attach() {}, detach() {}, on() {}, removeListener() {}, sendCommand: async () => {} },
  };
  const tab = { tabId: TAB, webMcpRevision: 1, webMcpToolCount: 0, view: { webContents: contents } };
  const host = createBrowserTaskHost({ getTab: (id) => id === TAB ? tab : null, tabsFor: () => [tab], ownerOf: () => SESSION, activeFor: () => TAB,
    isVisible: () => true, openTab: async () => tab, navigate: async (_tab, url) => { page.url = url; }, allowed: async () => true, enabled: () => true, changed: () => {},
    siteTools: async () => ({ ok: true, tools: [] }), runSiteTool: async () => hooks.siteTool(),
    secrets, secretsEnabled: () => true, approveCredential: async () => true, approveSecret: async () => { hooks.approvals++; return hooks.approve(); },
    armSecretSwap: async () => { hooks.arms++; return hooks.arm(hooks.arms); },
  });
  const call = (operation, args = {}) => host.request({ sessionId: SESSION, operation, args });
  const input = (label, type = "password") => { const element = new HTMLInputElement(page, label, type); page.elements.push(element); return element; };
  const observe = (args = {}) => call("observe", { mode: "interactive", ...args });
  const act = async (ref = "e1", extra = {}) => { const observation = await observe(); assert.equal(observation.ok, true); return call("act", { observationId: observation.observationId, actions: [{ type: "fill_secret", ref, secretRef: secret.secretRef }], ...extra }); };
  return { secrets, secret, page, typed, hooks, tab, contents, call, input, observe, act };
}

test("a field retyped by its focus handler receives nothing until it is approved again", async () => {
  const scene = world();
  const field = scene.input("Password");
  field.onfocus = () => { field.attributes.type = "text"; };
  await scene.act();
  assert.equal(scene.typed.length, 0, "the post-focus field must still be the field type approved by the person");
});

test("focus moved while interception is rechecked cannot type into an unapproved field", async () => {
  const scene = world();
  scene.input("Password");
  const other = scene.input("Unapproved text field", "text");
  let sent = false;
  other.oninput = () => { sent = Boolean(scene.secrets.rewrite(json(other.value)).body); };
  scene.hooks.arm = async (count) => { if (count === 2) other.focus(); return true; };
  await scene.act();
  assert.ok(scene.typed.length === 0 && !sent, "a focus race must not create a usable secret placeholder in another field");
});

test("a denied secret request never focuses issues or types even with a saved typed-credential approval", async () => {
  const scene = world();
  const field = scene.input("Password");
  scene.hooks.approve = async () => false;
  const result = await scene.act();
  assert.equal(result.failedStep.code, "credential_declined");
  assert.equal(scene.typed.length, 0);
  assert.equal(scene.hooks.arms, 0);
  assert.equal(field.value, "");
});

test("an untrusted site-tool image-shaped value cannot opt out of host redaction", async () => {
  const scene = world();
  scene.input("Password");
  scene.hooks.siteTool = async () => ({ ok: true, result: { image: { data: `iVBORw0KGgo${VALUE}` } } });
  clean(await scene.call("site_tool", { toolId: "example" }), VALUE);
});

test("an echoed secret is redacted before a tab title is truncated", async () => {
  const scene = world();
  scene.page.title = `${"x".repeat(295)}${VALUE}`;
  const result = await scene.call("tabs");
  clean(result, VALUE.slice(0, 5));
});

test("an echoed secret is redacted before an accessible name is truncated", async () => {
  const scene = world();
  scene.input(`${"x".repeat(115)}${VALUE}`, "text");
  const result = await scene.observe();
  clean(result, VALUE.slice(0, 5));
});

test("removing a secret while a site-tool response is in flight does not disclose its raw echoed value", async () => {
  const scene = world();
  scene.input("Password");
  scene.hooks.siteTool = async () => { scene.secrets.remove(SESSION, scene.secret.secretRef); return { ok: true, result: { echoed: VALUE } }; };
  clean(await scene.call("site_tool", { toolId: "example" }), VALUE);
});

test("raw values placeholders and coded errors pass through redaction including replayed receipts", async () => {
  const scene = world();
  const field = scene.input("Password");
  const status = new HTMLElement(scene.page, "div", { role: "status" });
  status.text = () => `${VALUE} ${field.value}`;
  scene.page.elements.push(status);
  const observation = await scene.observe();
  const args = { observationId: observation.observationId, actions: [{ type: "fill_secret", ref: "e1", secretRef: scene.secret.secretRef }], request_id: "review-request" };
  const first = await scene.call("act", args);
  assert.equal(first.ok, true);
  const replay = await scene.call("act", args);
  assert.deepEqual(first, replay);
  assert.equal(scene.typed.length, 1);
  assert.equal(scene.hooks.approvals, 1);
  clean([first, replay], VALUE);
  clean([first, replay], scene.typed[0]);
  scene.hooks.siteTool = async () => { throw Object.assign(new Error(VALUE), { code: "example_error" }); };
  clean(await scene.call("site_tool", { toolId: "example" }), VALUE);
});
