import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runComputerProgram } from "@openwork/computer-use/runtime";
import { createBrowserTaskHost } from "./browser-task.mjs";

test("withheld field values cannot escape through accessible labels", async () => {
  class Input {
    tagName = "INPUT"; parentElement = null; labels = []; isConnected = true; type = "text";
    constructor(value, attributes) { this.value = value; this.attributes = attributes; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute() { return false; }
    matches(selector) { return this.type === "password" && selector.includes('input[type="password"]'); }
    closest() { return null; }
    getBoundingClientRect() { return { x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 }; }
  }
  const email = new Input("owner@example.test", { "aria-label": "Email owner@example.test" });
  const account = new Input("private-reference-123", { "aria-labelledby": "account-caption" });
  const password = new Input("password-must-stay-private", { "aria-label": "Password password-must-stay-private" });
  password.type = "password";
  const long = new Input("long-secret-".repeat(60), {});
  long.attributes["aria-label"] = `Vault ${long.value}`;
  const privateFields = [email, account, password, long];
  const submit = new Input("Continue", {}); submit.type = "submit";
  const checkbox = new Input("on", { "aria-label": "Consent" }); checkbox.type = "checkbox";
  const fields = [...privateFields, submit, checkbox];
  const document = { title: `Profile ${account.value}`, body: { innerText: `Signed in as ${email.value}\nAccount ${account.value}\nPassword ${password.value}\nVault ${long.value}` }, activeElement: email,
    getElementById: id => id === "account-caption" ? { textContent: `Account ${account.value}` } : null,
    querySelectorAll: query => query.startsWith('input[type="password"]') ? fields.filter(field => field.type === "password" || field.attributes.autocomplete === "one-time-code") : fields };
  const context = vm.createContext({ document, HTMLElement: Input, HTMLInputElement: Input,
    HTMLSelectElement: class {}, HTMLTextAreaElement: class {}, HTMLLabelElement: class {},
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance });
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: { isDestroyed: () => false,
    getURL: () => "https://example.com/", executeJavaScriptInIsolatedWorld: async (_world, scripts) => vm.runInContext(scripts[0].code, context) } } };
  const host = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true });
  const observe = () => host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
  const seen = await observe();
  assert.equal(seen.ok, true, JSON.stringify(seen));
  assert.deepEqual(Array.from(seen.elements, element => element.name), ["Email [withheld]", "Account [withheld]", "Password [withheld]", "Vault [withheld]", "Continue", "Consent"]);
  for (const field of privateFields) assert.ok(!JSON.stringify(seen).includes(field.value), "The observation exposed a withheld value");
  const extracted = await host.request({ sessionId: "chat", operation: "extract", args: { tabId: "tab", question: "Which account, password and vault is signed in?" } });
  assert.equal(extracted.ok, true, JSON.stringify(extracted));
  assert.ok(extracted.passages.length > 0 && JSON.stringify(extracted).includes("[withheld]"), JSON.stringify(extracted));
  for (const field of privateFields) assert.ok(!JSON.stringify(extracted).includes(field.value), "Extraction exposed a withheld value");
  checkbox.value = "changed-private-reference";
  const staleCheckbox = await host.request({ sessionId: "chat", operation: "act", args: { tabId: "tab", observationId: seen.observationId,
    action: { type: "set_checked", ref: seen.elements[5].ref, checked: true } } });
  assert.equal(staleCheckbox.code, "stale_observation");
  assert.notEqual(checkbox.checked, true);
  checkbox.value = "on";
  context.__openworkAgentEntered.set(email, email.value);
  const entered = await observe();
  assert.equal(entered.elements[0].name, `Email ${email.value}`);
  assert.equal(entered.elements[0].value, email.value);
  assert.ok(!JSON.stringify(entered).includes(password.value));
  password.type = "text";
  account.attributes.autocomplete = "section-checkout cc-number";
  const protectedImage = await host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab", includeImage: true } });
  assert.equal(protectedImage.code, "sign_in_required", "Payment fields must block capture even without a password field");
});

test("select options keep backing identities private and revalidate before choosing", async () => {
  let events = 0;
  const options = [
    { value: "private-account-001", label: "Personal", selected: true, disabled: false },
    { value: "private-account-002", label: "Work", selected: false, disabled: false },
    { value: "private-account-003", label: "Unavailable", selected: false, disabled: true },
  ];
  class Element {
    tagName = "SELECT"; parentElement = null; isConnected = true; multiple = false; options = options;
    validity = { valid: false }; validationMessage = "private-account-001";
    get value() { return this.selectedOptions[0]?.value ?? ""; }
    get selectedOptions() { return options.filter(option => option.selected); }
    getAttribute(name) { return name === "aria-label" ? "Account" : null; }
    hasAttribute() { return false; }
    matches() { return false; }
    closest() { return null; }
    getBoundingClientRect() { return { x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 }; }
    focus() { document.activeElement = this; }
    dispatchEvent() { events++; }
    contains(element) { return element === this; }
  }
  const select = new Element();
  const document = { title: "Accounts", body: { innerText: "Choose an account" }, activeElement: select,
    getElementById: () => null, elementFromPoint: () => select,
    querySelectorAll: query => query.startsWith('input[type="password"]') ? [] : [select] };
  const context = vm.createContext({ document, HTMLElement: Element, HTMLSelectElement: Element,
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLLabelElement: class {}, HTMLOptGroupElement: class {},
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance, setTimeout, Event });
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: { isDestroyed: () => false,
    getURL: () => "https://example.com/", executeJavaScriptInIsolatedWorld: async (_world, scripts) => vm.runInContext(scripts[0].code, context) } } };
  const host = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true });
  const observe = () => host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
  const act = (seen, value) => host.request({ sessionId: "chat", operation: "act", args: { tabId: "tab", observationId: seen.observationId,
    action: { type: "select", ref: seen.elements[0].ref, values: [value] } } });
  const seen = await observe();
  assert.equal(seen.ok, true, JSON.stringify(seen));
  assert.ok(!JSON.stringify(seen).includes("private-account"));
  const work = seen.elements[0].options.find(option => option.label === "Work").value;
  const chosen = await act(seen, work);
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  assert.equal(select.value, "private-account-002");
  assert.ok(!JSON.stringify(chosen).includes("private-account"));
  const fresh = await observe();
  const blocked = fresh.elements[0].options.find(option => option.disabled).value;
  assert.equal((await act(fresh, blocked)).code, "option_unavailable");
  const stale = await observe();
  const personal = stale.elements[0].options.find(option => option.label === "Personal").value;
  options[0].value = "different-private-identity";
  assert.equal((await act(stale, personal)).code, "stale_observation");
  assert.equal(select.value, "private-account-002");
  let inputChecks = 0;
  const resizingHost = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true,
    beforeInput: async () => { if (++inputChecks === 1) context.innerWidth = 900; } });
  const program = await runComputerProgram({ surface: "browser", code: 'return await tools.ui.select({target:{name:"Account"},option:"Personal"});' }, {
    computer: async () => { throw new Error("Wrong surface"); },
    browser: (operation, args, signal) => resizingHost.request({ sessionId: "chat", operation, args }, { signal }),
  }, new AbortController().signal);
  assert.equal(program.ok, true, JSON.stringify(program));
  assert.equal(select.value, "different-private-identity");
  // Refs survive a layout change: the control is located again and the
  // select goes through on the first input check, without a re-observation.
  assert.equal(inputChecks, 1);
  assert.ok(!JSON.stringify(program).includes("private-identity"));
  options[0].value = "1"; options[0].label = "Plan 1";
  const publicLabel = await observe();
  assert.equal(publicLabel.elements[0].options[0].label, "Plan 1");
  assert.notEqual(publicLabel.elements[0].options[0].value, "1");
  options[0].value = "en"; options[0].label = "English";
  options[1].value = "fr"; options[1].label = "French";
  const languages = await observe();
  assert.equal(languages.elements[0].options[1].label, "French");
  assert.notEqual(languages.elements[0].options[1].value, "fr");
  while (options.length < 201) options.push({ value: `private-account-${options.length}`, label: `Account ${options.length}`, selected: false, disabled: false });
  const truncated = await observe();
  const observed = truncated.elements[0].options;
  assert.equal(observed.length, 200);
  assert.equal(truncated.elements[0].optionsTruncated, true);
  const unseen = `o${Math.max(...observed.map(option => Number(option.value.slice(1)))) + 1}`;
  const priorValue = select.value, priorEvents = events;
  assert.equal((await act(truncated, unseen)).code, "option_unavailable");
  assert.equal(select.value, priorValue);
  assert.equal(events, priorEvents, "An unobserved option must not dispatch page events");
  const refreshed = await observe();
  assert.equal((await act(refreshed, refreshed.elements[0].options[199].value)).ok, true);
  assert.equal(select.value, options[199].value);
});

test("rejected or transformed fills keep unmatched field values withheld", async () => {
  class Input {
    tagName = "INPUT"; parentElement = null; labels = []; isConnected = true; type = "text";
    value = "previously-private-account";
    getAttribute(name) { return name === "aria-label" ? "Account" : null; }
    hasAttribute() { return false; }
    matches() { return false; }
    closest() { return null; }
    contains(element) { return element === this; }
    getBoundingClientRect() { return { x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 }; }
    focus() { document.activeElement = this; }
    select() {}
  }
  const field = new Input();
  let insert = () => {};
  const document = { title: "Profile", body: { innerText: "Account" }, activeElement: field,
    getElementById: () => null, elementFromPoint: () => field, querySelectorAll: () => [field] };
  const context = vm.createContext({ document, HTMLElement: Input, HTMLInputElement: Input,
    HTMLSelectElement: class {}, HTMLTextAreaElement: class {}, HTMLLabelElement: class {},
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance, setTimeout });
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: { isDestroyed: () => false,
    getURL: () => "https://example.com/", insertText: async text => insert(text),
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => vm.runInContext(scripts[0].code, context) } } };
  const host = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true });
  const observe = () => host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
  const fill = async text => {
    const seen = await observe();
    return host.request({ sessionId: "chat", operation: "act", args: { tabId: "tab", observationId: seen.observationId,
      action: { type: "fill", ref: seen.elements[0].ref, text } } });
  };
  const rejected = await fill("requested-account");
  assert.equal(rejected.code, "value_mismatch");
  assert.equal(rejected.control.valueWithheld, true);
  assert.equal(rejected.control.value, undefined);
  assert.ok(!JSON.stringify(rejected).includes(field.value));
  assert.ok(!JSON.stringify(await observe()).includes(field.value));
  insert = () => { field.value = "page-transformed-account"; };
  const transformed = await fill("another-request");
  assert.equal(transformed.code, "value_mismatch");
  assert.equal(transformed.control.valueWithheld, true);
  assert.ok(!JSON.stringify(transformed).includes(field.value));
  assert.ok(!JSON.stringify(await observe()).includes(field.value));
  insert = text => { field.value = text; };
  const accepted = await fill("agent-entered-account");
  assert.equal(accepted.ok, true);
  assert.equal(accepted.control.value, "agent-entered-account");
  assert.equal((await observe()).elements[0].value, "agent-entered-account");
});
