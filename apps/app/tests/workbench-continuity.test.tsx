/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { DynamicToolUIPart } from "ai";

GlobalRegistrator.register();
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
// The actual panel library needs nonzero geometry. This is a component test,
// not a browser layout/anchoring measurement.
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.hasAttribute("data-panel")) return 1200 * Number(this.style.flexGrow || 100) / 100;
    return this.hasAttribute("data-separator") ? 1 : 1200;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
// Happy DOM does not implement this ARIA reflection used by the panel library.
Object.defineProperty(HTMLElement.prototype, "ariaDisabled", {
  configurable: true, get(this: HTMLElement) { return this.getAttribute("aria-disabled"); },
});
Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.hasAttribute("data-separator") || this.id === "workbench-secondary") {
      return document.getElementById("workbench-primary")?.offsetWidth ?? 600;
    }
    return 0;
  },
});
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value(this: HTMLElement) { return new DOMRect(this.offsetLeft, 0, this.offsetWidth, this.offsetHeight); },
});

const { WorkbenchPanelGroup, PRIMARY_PANEL_ID, SECONDARY_PANEL_ID } = await import("../src/react-app/domains/session/chat/workbench-panel-group");
const { ResizablePanel, ResizableHandle } = await import("../src/components/ui/resizable");
const { MessageListProvider } = await import("../src/components/chat/message-list-provider");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { ReasoningBlock } = await import("../src/components/chat/reasoning-block");
const { ToolAggregateGroup } = await import("../src/components/chat/tool-aggregate-group");
const { useWorkbenchUiState, MAX_WORKBENCH_DISCLOSURES, MAX_WORKBENCH_SPLIT_RATIOS } = await import("../src/react-app/domains/session/chat/workbench-ui-state");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  useWorkbenchUiState.setState({ disclosures: new Map(), splitRatios: new Map() });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function element(selector: string) {
  const node = container.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}
const click = async (selector: string) => act(async () => element(selector).click());

function panels(owner: string | null, split: boolean, primary: ReactNode, primaryVisible = true) {
  return <WorkbenchPanelGroup owner={owner} primaryVisible={primaryVisible} secondaryVisible={split}>
    {primaryVisible ? <ResizablePanel id={PRIMARY_PANEL_ID} minSize="320px">{primary}</ResizablePanel> : null}
    {split ? <>
      {primaryVisible ? <ResizableHandle /> : null}
      <ResizablePanel id={SECONDARY_PANEL_ID} minSize="320px"><div>Secondary</div></ResizablePanel>
    </> : null}
  </WorkbenchPanelGroup>;
}

test("the mounted primary survives split toggles with its draft, focus, selection and scroll; divider returns", async () => {
  let mounts = 0;
  let unmounts = 0;
  function Primary() {
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return <div data-primary-scroll><textarea defaultValue="unsent primary draft" /><p>Selected answer text</p></div>;
  }
  const render = async (split: boolean) => act(async () => root.render(panels("owner-a", split, <Primary />)));
  await render(false);
  const primary = element("[data-primary-scroll]");
  const input = container.querySelector("textarea")!;
  input.focus();
  input.setSelectionRange(2, 8);
  primary.scrollTop = 247;
  await render(true);
  expect(element("[data-primary-scroll]")).toBe(primary);
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(8);
  expect(primary.scrollTop).toBe(247);
  expect(Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow)).toBe(50);
  await act(async () => element("[data-separator]").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  const resized = Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow);
  expect(resized).toBeGreaterThan(50);
  for (let i = 0; i < 3; i++) {
    await render(false);
    expect(Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow)).toBe(100);
    expect(container.querySelector(`#${SECONDARY_PANEL_ID}`)).toBeNull();
    await render(true);
    expect(Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow)).toBe(resized);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("unsent primary draft");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(8);
    expect(primary.scrollTop).toBe(247);
  }
  expect(mounts).toBe(1);
  expect(unmounts).toBe(0);
  const answer = element("p").firstChild!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(answer, 0);
  range.setEnd(answer, 8);
  selection.removeAllRanges();
  selection.addRange(range);
  await render(false);
  await render(true);
  expect(selection.toString()).toBe("Selected");
  expect(selection.anchorNode).toBe(answer);
  expect(element("[data-primary-scroll]")).toBe(primary);
});

test("pointer divider resize returns incidental focus without stealing keyboard divider focus", async () => {
  await act(async () => root.render(panels("owner", true, <textarea defaultValue="draft" />)));
  const input = container.querySelector("textarea")!;
  input.focus();
  input.setSelectionRange(1, 3);
  const separator = element("[data-separator]");
  await act(async () => {
    separator.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", clientX: 600, clientY: 100, button: 0, buttons: 1 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 700, clientY: 100, buttons: 1 }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", clientX: 700, clientY: 100 }));
  });
  expect(Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow)).toBeGreaterThan(50);
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(1);
  expect(input.selectionEnd).toBe(3);
  await act(async () => {
    separator.focus();
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  });
  expect(document.activeElement).toBe(separator);
  const outside = document.createElement("div");
  outside.tabIndex = 0;
  outside.setAttribute("data-separator", "");
  document.body.append(outside);
  await act(async () => {
    input.focus();
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 1400 }));
    outside.focus();
    outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 1400 }));
  });
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

test("split ratio is owner-isolated, bounded and restored after unmount, including single-pane mobile transitions", async () => {
  const render = async (owner: string | null, split = true, primaryVisible = true) => act(async () => root.render(panels(owner, split, <div>Primary</div>, primaryVisible)));
  await render("principal-a/org-a/endpoint-a/workspace-a");
  await act(async () => element("[data-separator]").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  const ratio = Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow);
  for (const foreign of ["principal-b/org-a/endpoint-a/workspace-a", "principal-a/org-b/endpoint-a/workspace-a", "principal-a/org-a/endpoint-b/workspace-a", "principal-a/org-a/endpoint-a/workspace-b", null]) {
    await render(foreign);
    expect(Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow)).toBe(50);
  }
  await render("principal-a/org-a/endpoint-a/workspace-a", true, false);
  expect(Number(element(`#${SECONDARY_PANEL_ID}`).style.flexGrow)).toBe(100);
  await render("principal-a/org-a/endpoint-a/workspace-a");
  expect(Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow)).toBe(ratio);
  await act(async () => root.render(null));
  await render("principal-a/org-a/endpoint-a/workspace-a");
  expect(Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow)).toBe(ratio);
  await act(async () => {
    for (let i = 0; i < MAX_WORKBENCH_SPLIT_RATIOS; i++) useWorkbenchUiState.getState().setSplitRatio(`other-${i}`, 65);
  });
  expect(useWorkbenchUiState.getState().splitRatios.size).toBe(MAX_WORKBENCH_SPLIT_RATIOS);
  await act(async () => root.render(null));
  await render("principal-a/org-a/endpoint-a/workspace-a");
  expect(Number(element(`#${PRIMARY_PANEL_ID}`).style.flexGrow)).toBe(50);
});

function Provider({ owner, children }: { owner: string | null; children: ReactNode }) {
  return <PlatformProvider value={createDefaultPlatform()}><MessageListProvider uiStateOwner={owner} workspaceId="workspace" sessionId="session"
    showThinking developerMode={false} displaySuggestions={false} providerConnectedCount={1}
    dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onForkAtMessage={() => {}}
    onEditUserMessage={() => {}} onMcpReconnect={async () => { throw new Error("unused"); }}
    onMcpReopenAuthorization={async () => {}} onMcpRetry={() => {}}>{children}</MessageListProvider></PlatformProvider>;
}
const command: DynamicToolUIPart = {
  type: "dynamic-tool", toolName: "bash", toolCallId: "call", state: "output-error",
  input: { command: "git status", description: "Inspect files" }, errorText: "Command failed",
};
function disclosures(owner: string | null, message = "message-a") {
  return <Provider owner={owner}>
    <ReasoningBlock disclosureKey={JSON.stringify(["reasoning", message, 0])} text="Reasoning body not stored" isStreaming={false} />
    <ToolAggregateGroup messageId={message} parts={[command]} thoughts={[{ afterIndex: 1, text: "Nested thought", isStreaming: false }]} />
  </Provider>;
}

test("reasoning and nested command/error/thought disclosures return on A-B-A without leaking owner, message or detail", async () => {
  const render = async (owner: string | null, message = "message-a") => act(async () => root.render(disclosures(owner, message)));
  await render("owner-a/session-a");
  await click("[data-reasoning-block] button");
  await click("[data-tool-aggregate] > button");
  await click('[data-tool-aggregate-detail="command"]');
  expect(element('[data-tool-aggregate-detail="error"]').getAttribute("aria-expanded")).toBe("false");
  await click('[data-tool-aggregate-detail="error"]');
  await click("[data-tool-aggregate-thought] button");
  // An owner change without remount must not show the previous owner's state.
  await render("owner-b/session-a");
  expect(element("[data-reasoning-block] button").getAttribute("aria-expanded")).toBe("false");
  expect(element("[data-tool-aggregate] > button").getAttribute("aria-expanded")).toBe("false");
  await act(async () => root.render(null));
  await render("owner-a/session-a");
  for (const selector of ["[data-reasoning-block] button", "[data-tool-aggregate] > button", '[data-tool-aggregate-detail="command"]', '[data-tool-aggregate-detail="error"]', "[data-tool-aggregate-thought] button"]) {
    expect(element(selector).getAttribute("aria-expanded")).toBe("true");
  }
  for (const [owner, message] of [["owner-a/session-a", "message-b"], ["owner-a/session-b", "message-a"]]) {
    await render(owner, message);
    expect(element("[data-reasoning-block] button").getAttribute("aria-expanded")).toBe("false");
    expect(element("[data-tool-aggregate] > button").getAttribute("aria-expanded")).toBe("false");
    await click("[data-tool-aggregate] > button");
    expect(element('[data-tool-aggregate-detail="command"]').getAttribute("aria-expanded")).toBe("false");
  }
  await render("owner-a/session-a");
  await click("[data-reasoning-block] button");
  await act(async () => root.render(null));
  await render("owner-a/session-a");
  expect(element("[data-reasoning-block] button").getAttribute("aria-expanded")).toBe("false");
  expect([...useWorkbenchUiState.getState().disclosures.values()].every((value) => typeof value === "boolean")).toBe(true);
});

test("cache eviction preserves mounted reasoning, aggregate details and focus but forgets an unmounted return", async () => {
  await act(async () => root.render(disclosures("owner-a")));
  await click("[data-reasoning-block] button");
  await click("[data-tool-aggregate] > button");
  await click('[data-tool-aggregate-detail="command"]');
  const reasoning = element("[data-reasoning-block] button");
  const aggregate = element("[data-tool-aggregate] > button");
  const detail = element('[data-tool-aggregate-detail="command"]');
  const retainedKeys = [...useWorkbenchUiState.getState().disclosures.keys()];
  for (const focused of [reasoning, detail]) {
    await act(async () => {
      focused.focus();
      for (let i = 0; i < MAX_WORKBENCH_DISCLOSURES; i++) {
        useWorkbenchUiState.getState().setDisclosure(`other-${i}`, true);
      }
    });
    expect(useWorkbenchUiState.getState().disclosures.size).toBe(MAX_WORKBENCH_DISCLOSURES);
    expect(retainedKeys.every((key) => !useWorkbenchUiState.getState().disclosures.has(key))).toBe(true);
    for (const node of [reasoning, aggregate, detail]) {
      expect(node.isConnected).toBe(true);
      expect(node.getAttribute("aria-expanded")).toBe("true");
    }
    expect(document.activeElement).toBe(focused);
    // An unrelated render must not turn a cache miss into an explicit close.
    await act(async () => root.render(disclosures("owner-a")));
    expect(element('[data-tool-aggregate-detail="command"]')).toBe(detail);
    expect(reasoning.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(focused);
  }
  await act(async () => root.render(null));
  await act(async () => root.render(disclosures("owner-a")));
  expect(element("[data-reasoning-block] button").getAttribute("aria-expanded")).toBe("false");
  expect(element("[data-tool-aggregate] > button").getAttribute("aria-expanded")).toBe("false");
  await click("[data-tool-aggregate] > button");
  expect(element('[data-tool-aggregate-detail="command"]').getAttribute("aria-expanded")).toBe("false");
});

test("mounted copies synchronize explicit choices even when the restoration entry is evicted in the same batch", async () => {
  await act(async () => root.render(<>
    <div data-copy="first">{disclosures("owner-shared")}</div>
    <div data-copy="second">{disclosures("owner-shared")}</div>
    <div data-copy="foreign">{disclosures("owner-foreign")}</div>
  </>));
  for (const selector of ["[data-reasoning-block] button", "[data-tool-aggregate] > button"]) {
    await click(`[data-copy="first"] ${selector}`);
    expect(element(`[data-copy="second"] ${selector}`).getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      element(`[data-copy="second"] ${selector}`).click();
      for (let i = 0; i < MAX_WORKBENCH_DISCLOSURES; i++) {
        useWorkbenchUiState.getState().setDisclosure(`other-${i}`, true);
      }
    });
    for (const copy of ["first", "second", "foreign"]) {
      expect(element(`[data-copy="${copy}"] ${selector}`).getAttribute("aria-expanded")).toBe("false");
    }
    await click(`[data-copy="second"] ${selector}`);
    expect(element(`[data-copy="first"] ${selector}`).getAttribute("aria-expanded")).toBe("true");
    expect(element(`[data-copy="foreign"] ${selector}`).getAttribute("aria-expanded")).toBe("false");
  }
});

test("disclosure eviction and unverified ownership fall back closed on return", async () => {
  await act(async () => root.render(disclosures("owner-a")));
  await click("[data-reasoning-block] button");
  await click("[data-tool-aggregate] > button");
  await click('[data-tool-aggregate-detail="command"]');
  await act(async () => root.render(null));
  await act(async () => {
    for (let i = 0; i < MAX_WORKBENCH_DISCLOSURES; i++) useWorkbenchUiState.getState().setDisclosure(`other-${i}`, true);
  });
  expect(useWorkbenchUiState.getState().disclosures.size).toBe(MAX_WORKBENCH_DISCLOSURES);
  await act(async () => root.render(disclosures("owner-a")));
  expect(element("[data-reasoning-block] button").getAttribute("aria-expanded")).toBe("false");
  expect(element("[data-tool-aggregate] > button").getAttribute("aria-expanded")).toBe("false");
  await click("[data-tool-aggregate] > button");
  expect(element('[data-tool-aggregate-detail="command"]').getAttribute("aria-expanded")).toBe("false");
  await act(async () => root.render(disclosures(null)));
  await click("[data-reasoning-block] button");
  const entries = useWorkbenchUiState.getState().disclosures;
  await act(async () => root.render(null));
  await act(async () => root.render(disclosures(null)));
  expect(element("[data-reasoning-block] button").getAttribute("aria-expanded")).toBe("false");
  expect(useWorkbenchUiState.getState().disclosures).toBe(entries);
});

test("show-more and a later call's details return without expanding sibling calls", async () => {
  const parts = Array.from({ length: 10 }, (_, index): DynamicToolUIPart => ({ ...command, toolCallId: `call-${index}` }));
  const render = async () => act(async () => root.render(<Provider owner="owner-many">
    <ToolAggregateGroup messageId="message-many" parts={parts} />
  </Provider>));
  await render();
  await click("[data-tool-aggregate] > button");
  expect(container.querySelectorAll("[data-tool-aggregate-row]").length).toBe(8);
  const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show 2 more");
  if (!more) throw new Error("Missing show-more control");
  await act(async () => more.click());
  const lastCommand = container.querySelectorAll<HTMLElement>('[data-tool-aggregate-detail="command"]')[9]!;
  await act(async () => lastCommand.click());
  await act(async () => root.render(null));
  await render();
  expect(container.querySelectorAll("[data-tool-aggregate-row]").length).toBe(10);
  const commands = container.querySelectorAll('[data-tool-aggregate-detail="command"]');
  expect(commands[9]!.getAttribute("aria-expanded")).toBe("true");
  expect(commands[0]!.getAttribute("aria-expanded")).toBe("false");
});
