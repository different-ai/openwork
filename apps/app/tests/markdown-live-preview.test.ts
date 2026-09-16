import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

await import("../src/components/markdown/markdown-primitive");
GlobalRegistrator.register({ url: "http://localhost/" });
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { markdown, markdownLanguage } = await import("@codemirror/lang-markdown");
const { markdownLivePreview } = await import("../src/react-app/domains/session/artifacts/markdown-live-preview");

const source = [
  "Before the table",
  "",
  "| Name | Details |",
  "| --- | --- |",
  "| **First row** | [**Documentation**](https://example.com/docs) |",
  "| Second row | Select this text |",
  "",
  "After the table",
].join("\n");
const views: InstanceType<typeof EditorView>[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
afterAll(() => GlobalRegistrator.unregister());

function editor() {
  const parent = document.createElement("div");
  parent.style.userSelect = "none";
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: source,
      extensions: [markdown({ base: markdownLanguage }), markdownLivePreview()],
    }),
  });
  views.push(view);
  const element = (selector: string) => {
    const found = view.dom.querySelector(selector);
    if (!(found instanceof HTMLElement)) throw new Error(`Missing ${selector}: ${view.dom.innerHTML}`);
    return found;
  };
  const wrapper = element(".cm-md-table");
  for (const section of wrapper.querySelectorAll("thead, tbody")) {
    Object.defineProperty(section, "rows", { get: () => section.querySelectorAll(":scope > tr") });
  }
  const unchanged = () => {
    expect(view.state.selection.main.anchor).toBe(0);
    expect(view.state.doc.toString()).toBe(source);
    expect(view.dom.querySelector(".cm-md-table")).toBe(wrapper);
  };
  return { view, wrapper, element, unchanged, parent };
}

function mouse(target: Element, type: string, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options });
  target.dispatchEvent(event);
  return event;
}

describe("markdown table interaction ownership", () => {
  test.each([".cm-md-table", "table", "thead", "tbody", "tr"])("leaves non-cell %s presses and clicks to the browser", (selector) => {
    const fixture = editor();
    const target = fixture.element(selector);
    expect(mouse(target, "mousedown").defaultPrevented).toBe(false);
    expect(mouse(target, "mouseup").defaultPrevented).toBe(false);
    expect(mouse(target, "click").defaultPrevented).toBe(false);
    fixture.unchanged();
    expect(fixture.view.hasFocus).toBe(false);
  });

  test.each([
    { button: 1 },
    { button: 2 },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
  ])("does not turn a non-primary or modified gesture into editing: %j", (options) => {
    const fixture = editor();
    const target = fixture.element("td strong");
    for (const type of ["mousedown", "mouseup", "click", "auxclick", "contextmenu"]) {
      expect(mouse(target, type, options).defaultPrevented).toBe(false);
      fixture.unchanged();
    }
    expect(fixture.view.hasFocus).toBe(false);
  });

  test("keeps a nested link available through activation without moving the editor selection", () => {
    const fixture = editor();
    const target = fixture.element("a strong");
    let cancelled: boolean | undefined;
    fixture.parent.addEventListener("click", (event) => {
      cancelled = event.defaultPrevented;
      event.preventDefault();
    });
    expect(mouse(target, "mousedown").defaultPrevented).toBe(false);
    fixture.unchanged();
    mouse(target, "click");
    expect(cancelled).toBe(false);
    fixture.unchanged();
    expect(fixture.view.hasFocus).toBe(false);
  });

  test("preserves a drag selection within a cell instead of replacing its DOM", () => {
    const fixture = editor();
    const cell = fixture.element("tbody tr:last-child td:last-child");
    expect(mouse(cell, "mousedown").defaultPrevented).toBe(false);
    const range = document.createRange();
    range.selectNodeContents(cell);
    document.getSelection()?.addRange(range);
    mouse(cell, "mouseup");
    expect(mouse(cell, "click").defaultPrevented).toBe(false);
    expect(document.getSelection()?.toString()).toBe("Select this text");
    fixture.unchanged();
    expect(getComputedStyle(fixture.wrapper).userSelect).toBe("text");
  });

  test("respects a click already handled by a cell descendant", () => {
    const fixture = editor();
    const target = fixture.element("td strong");
    target.addEventListener("click", (event) => event.preventDefault());
    mouse(target, "click");
    fixture.unchanged();
  });

  test.each([
    { selector: "th", line: 3 },
    { selector: "td strong", line: 5 },
    { selector: "tbody tr:last-child td", line: 6 },
  ])("edits the same source row only after a plain cell click: $line", ({ selector, line }) => {
    const fixture = editor();
    const target = fixture.element(selector);
    expect(mouse(target, "mousedown").defaultPrevented).toBe(false);
    fixture.unchanged();
    mouse(target, "mouseup");
    expect(mouse(target, "click").defaultPrevented).toBe(true);
    expect(fixture.view.state.selection.main.anchor).toBe(fixture.view.state.doc.line(line).from);
    expect(fixture.view.hasFocus).toBe(true);
    expect(fixture.view.dom.querySelector(".cm-md-table")).toBeNull();
    expect(fixture.view.state.doc.toString()).toBe(source);
    fixture.view.dispatch({ selection: { anchor: 0 } });
    expect(fixture.view.dom.querySelector(".cm-md-table")).not.toBeNull();
  });

  test("retains arrow-key entry from both sides of the rendered table", () => {
    const fixture = editor();
    for (const { line, key, target } of [
      { line: 2, key: "ArrowDown", target: 3 },
      { line: 7, key: "ArrowUp", target: 6 },
    ]) {
      fixture.view.dispatch({ selection: { anchor: fixture.view.state.doc.line(line).from } });
      fixture.view.focus();
      expect(fixture.view.dom.querySelector(".cm-md-table")).not.toBeNull();
      fixture.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      expect(fixture.view.state.selection.main.anchor).toBe(fixture.view.state.doc.line(target).from);
      expect(fixture.view.dom.querySelector(".cm-md-table")).toBeNull();
    }
    expect(fixture.view.state.doc.toString()).toBe(source);
  });
});
