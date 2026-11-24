import { afterAll, afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { useShellShortcuts } = await import("../src/react-app/shell/use-shell-shortcuts");
const {
  createSessionNumberHintReveal,
  SESSION_NUMBER_HINT_REVEAL_DELAY_MS,
} = await import("../src/react-app/shell/session-number-shortcuts");
type Root = import("react-dom/client").Root;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const DELAY = SESSION_NUMBER_HINT_REVEAL_DELAY_MS;

// ---- The reveal controller on its own -------------------------------------

function controller() {
  const changes: boolean[] = [];
  const reveal = createSessionNumberHintReveal({ onChange: (visible) => changes.push(visible) });
  return { reveal, changes };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test("a quick press never reveals the hints", () => {
  const { reveal, changes } = controller();
  reveal.hold();
  jest.advanceTimersByTime(DELAY - 100);
  reveal.release();
  jest.advanceTimersByTime(DELAY * 2);
  expect(reveal.isVisible()).toBe(false);
  expect(changes).toEqual([]);
});

test("a sustained hold reveals the hints once, after the delay", () => {
  const { reveal, changes } = controller();
  reveal.hold();
  jest.advanceTimersByTime(DELAY - 1);
  expect(reveal.isVisible()).toBe(false);
  // Repeated holds (key repeat, DOM refreshes) must not restart the timer.
  reveal.hold();
  jest.advanceTimersByTime(1);
  expect(reveal.isVisible()).toBe(true);
  reveal.hold();
  jest.advanceTimersByTime(DELAY);
  expect(changes).toEqual([true]);
});

test("releasing after the reveal hides the hints immediately", () => {
  const { reveal, changes } = controller();
  reveal.hold();
  jest.advanceTimersByTime(DELAY);
  reveal.release();
  expect(reveal.isVisible()).toBe(false);
  expect(changes).toEqual([true, false]);
});

// ---- Wired into the shell shortcuts hook ----------------------------------

type ShortcutsState = ReturnType<typeof useShellShortcuts>["sessionNumberShortcuts"];
let latest: ShortcutsState | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
const opened: string[] = [];

function Probe() {
  latest = useShellShortcuts({
    onCreateNewSession: () => {},
  }).sessionNumberShortcuts;
  return null;
}

function sessionRow(sessionId: string) {
  const row = document.createElement("div");
  row.dataset.sidebarSessionId = sessionId;
  row.dataset.sidebarSessionWorkspaceId = "ws";
  const button = document.createElement("button");
  button.dataset.sessionTabId = sessionId;
  // happy-dom does not lay out; make the row count as visible.
  button.getClientRects = () => {
    const rects = [new DOMRect(0, 0, 100, 20)];
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
  };
  button.addEventListener("click", () => opened.push(sessionId));
  row.append(button);
  return row;
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host, sessionRow("s1"), sessionRow("s2"));
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(PlatformProvider, {
      value: { ...createDefaultPlatform(), os: "macos" },
      children: createElement(Probe),
    }));
  });
}

async function key(type: "keydown" | "keyup", init: KeyboardEventInit) {
  await act(async () => { window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })); });
}

async function advance(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  latest = null;
  opened.length = 0;
  document.body.innerHTML = "";
});

test("holding Cmd shows the sidebar hints only after the delay; release hides them at once", async () => {
  await mount();
  await key("keydown", { key: "Meta", metaKey: true });
  expect(latest?.modifierHeld).toBe(true);
  expect(latest?.targets).toHaveLength(0);

  await advance(DELAY - 1);
  expect(latest?.targets).toHaveLength(0);
  await advance(1);
  expect(latest?.targets.map((target) => target.digit)).toEqual([1, 2]);

  await key("keyup", { key: "Meta" });
  expect(latest?.targets).toHaveLength(0);
});

test("a quick Cmd press cancels the pending reveal", async () => {
  await mount();
  await key("keydown", { key: "Meta", metaKey: true });
  await advance(200);
  await key("keyup", { key: "Meta" });
  await advance(DELAY * 2);
  expect(latest?.targets).toHaveLength(0);
});

test("Cmd+digit still opens the session before any hint is shown", async () => {
  await mount();
  await key("keydown", { key: "Meta", metaKey: true });
  await key("keydown", { key: "2", metaKey: true });
  expect(opened).toEqual(["s2"]);
  expect(latest?.targets).toHaveLength(0);
});

test("losing window focus cancels a pending reveal and hides visible hints", async () => {
  await mount();
  await key("keydown", { key: "Meta", metaKey: true });
  await advance(200);
  await act(async () => { window.dispatchEvent(new Event("blur")); });
  await advance(DELAY * 2);
  expect(latest?.targets).toHaveLength(0);

  await key("keydown", { key: "Meta", metaKey: true });
  await advance(DELAY);
  expect(latest?.targets).toHaveLength(2);
  await act(async () => { window.dispatchEvent(new Event("blur")); });
  expect(latest?.targets).toHaveLength(0);
});

test("unmounting clears a pending reveal", async () => {
  await mount();
  const setSpy = spyOn(globalThis, "setTimeout");
  const clearSpy = spyOn(globalThis, "clearTimeout");
  try {
    await key("keydown", { key: "Meta", metaKey: true });
    const revealCall = setSpy.mock.calls.findIndex((call) => call[1] === DELAY);
    expect(revealCall).toBeGreaterThanOrEqual(0);
    const handle = setSpy.mock.results[revealCall]?.value;
    await act(async () => root?.unmount());
    root = null;
    expect(clearSpy.mock.calls.some((call) => call[0] === handle)).toBe(true);
  } finally {
    setSpy.mockRestore();
    clearSpy.mockRestore();
  }
});
