import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { useShellShortcuts } = await import("../src/react-app/shell/use-shell-shortcuts");
const { isNewSessionShortcut } = await import("../src/react-app/shell/new-session-shortcut");
type Root = import("react-dom/client").Root;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const chord = { key: "n", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

// ---- The pure predicate ----------------------------------------------------

test("Cmd+N on macOS and Ctrl+N elsewhere are the new-session chord", () => {
  expect(isNewSessionShortcut({ ...chord, metaKey: true }, "macos")).toBe(true);
  expect(isNewSessionShortcut({ ...chord, key: "N", metaKey: true }, "macos")).toBe(true);
  expect(isNewSessionShortcut({ ...chord, ctrlKey: true }, "windows")).toBe(true);
  expect(isNewSessionShortcut({ ...chord, ctrlKey: true }, "linux")).toBe(true);
});

test("other modifiers and keys are not the new-session chord", () => {
  expect(isNewSessionShortcut({ ...chord, ctrlKey: true }, "macos")).toBe(false);
  expect(isNewSessionShortcut({ ...chord, metaKey: true }, "windows")).toBe(false);
  expect(isNewSessionShortcut({ ...chord, metaKey: true, shiftKey: true }, "macos")).toBe(false);
  expect(isNewSessionShortcut({ ...chord, metaKey: true, altKey: true }, "macos")).toBe(false);
  expect(isNewSessionShortcut({ ...chord, key: "m", metaKey: true }, "macos")).toBe(false);
  expect(isNewSessionShortcut({ ...chord }, "macos")).toBe(false);
  expect(isNewSessionShortcut({
    ...chord,
    ctrlKey: true,
    altKey: true,
    getModifierState: (key) => key === "AltGraph",
  }, "windows")).toBe(false);
});

// ---- Wired into the shell shortcuts hook ----------------------------------

let root: Root | null = null;
let created = 0;

function Probe() {
  useShellShortcuts({ onCreateNewSession: () => { created += 1; } });
  return null;
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(PlatformProvider, {
      value: { ...createDefaultPlatform(), os: "macos" },
      children: createElement(Probe),
    }));
  });
}

async function pressCmdN(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "n",
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  created = 0;
  document.body.innerHTML = "";
});

test("Cmd+N starts a new session while the composer (contenteditable) has focus", async () => {
  await mount();
  const composer = document.createElement("div");
  composer.contentEditable = "true";
  composer.setAttribute("role", "textbox");
  document.body.append(composer);
  composer.focus();

  const event = await pressCmdN(composer);
  expect(created).toBe(1);
  expect(event.defaultPrevented).toBe(true);
});

test("Cmd+N starts a new session from a plain input and from the page", async () => {
  await mount();
  const input = document.createElement("input");
  document.body.append(input);
  await pressCmdN(input);
  await pressCmdN(document.body);
  expect(created).toBe(2);
});

test("an editor handler that stops propagation cannot swallow Cmd+N", async () => {
  await mount();
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.addEventListener("keydown", (event) => {
    event.stopPropagation();
    event.preventDefault();
  });
  document.body.append(editor);
  await pressCmdN(editor);
  expect(created).toBe(1);
});

test("key repeat does not create a session per repeat", async () => {
  await mount();
  await pressCmdN(document.body);
  const repeated = await pressCmdN(document.body, { repeat: true });
  expect(created).toBe(1);
  expect(repeated.defaultPrevented).toBe(true);
});

test("an open modal dialog keeps Cmd+N", async () => {
  await mount();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  // happy-dom does not lay out; make the dialog count as visible.
  dialog.getClientRects = () => {
    const rects = [new DOMRect(0, 0, 100, 100)];
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
  };
  document.body.append(dialog);
  const event = await pressCmdN(dialog);
  expect(created).toBe(0);
  expect(event.defaultPrevented).toBe(false);
});
