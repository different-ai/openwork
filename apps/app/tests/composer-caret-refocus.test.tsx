import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LexicalPromptEditor } = await import("../src/react-app/domains/session/surface/composer/editor");
type Handle = import("../src/react-app/domains/session/surface/composer/editor").LexicalPromptEditorHandle;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
const settle = async () => { await act(async () => { await frame(); await frame(); }); };

function placeCaret(root: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode();
  if (!text) throw new Error(`editor has no text: ${root.innerHTML}`);
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

test("coming back from the palette keeps the caret where it was, not at the start", async () => {
  const host = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(host, outside);
  const ref = createRef<Handle>();
  const reactRoot = createRoot(host);
  await act(async () => {
    reactRoot.render(<LexicalPromptEditor ref={ref} value="hello world" mentions={{}} submitDisabled={false} placeholder="" onChange={() => {}} onSubmit={() => {}} />);
  });
  await settle();
  const root = host.querySelector<HTMLElement>("[contenteditable='true']");
  if (!root) throw new Error("editor did not mount");

  root.focus();
  placeCaret(root, 5);
  await settle();
  expect(ref.current?.draftOffsetAtSelection()).toBe(5);

  // The palette takes focus, then hands it back with a programmatic focus that
  // lands the caret at the start.
  outside.focus();
  await settle();
  root.focus();
  placeCaret(root, 0);
  await settle();

  expect(ref.current?.draftOffsetAtSelection()).toBe(5);

  // A click is a choice: clicking at the start of the prompt puts the caret there.
  outside.focus();
  await settle();
  root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  root.focus();
  placeCaret(root, 0);
  await settle();
  expect(ref.current?.draftOffsetAtSelection()).toBe(0);
  await act(async () => { reactRoot.unmount(); });
});

test("after a send clears the prompt, coming back leaves a working caret and the next prompt is kept", async () => {
  const host = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(host, outside);
  const ref = createRef<Handle>();
  const reactRoot = createRoot(host);
  const render = (value: string) => reactRoot.render(<LexicalPromptEditor ref={ref} value={value} mentions={{}} submitDisabled={false} placeholder="" onChange={() => {}} onSubmit={() => {}} />);
  await act(async () => { render("hello world"); });
  await settle();
  const root = host.querySelector<HTMLElement>("[contenteditable='true']");
  if (!root) throw new Error("editor did not mount");
  root.focus();
  placeCaret(root, 11);
  await settle();

  // Send: focus moves to the button, the prompt is cleared, then focus comes back programmatically.
  outside.focus();
  await act(async () => { render(""); });
  await settle();
  root.focus();
  await settle();

  // The caret is valid in the empty prompt, and new text still lands.
  expect(ref.current?.draftOffsetAtSelection() ?? 0).toBe(0);
  ref.current?.insertConnectorAtSelection("Slack");
  await settle();
  expect(root.textContent).toContain("Slack");
  await act(async () => { reactRoot.unmount(); });
});
