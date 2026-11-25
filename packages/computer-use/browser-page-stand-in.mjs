// A small stand-in for a document, shared by the tests of the browser task host. The host's page functions run
// unchanged against it, in their own realm: it has only the controls, text and selectors those functions use.
import vm from "node:vm";

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
export function createPage(calls, { url = "https://app.example/login", title = "Sign in", text = "" } = {}) {
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
