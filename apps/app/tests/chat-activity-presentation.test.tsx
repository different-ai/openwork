/** @jsxImportSource react */
import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";
import { CapabilityCallLine, TechnicalDetailsPanel } from "../src/components/chat/capability-call-line";
import { CodeModeTool } from "../src/components/chat/code-mode-tool";
import { ReasoningBlock } from "../src/components/chat/reasoning-block";

const registered = typeof window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

test("reasoning without text uses a quiet live label and trustworthy duration", () => {
  expect(renderToStaticMarkup(<ReasoningBlock text="" isStreaming startedAt={1_000} />)).toContain("Thinking…");
  const settled = renderToStaticMarkup(<ReasoningBlock text="" isStreaming={false} startedAt={1_000} endedAt={3_000} />);
  expect(settled).toContain("Thought for 2s");
  expect(settled).not.toContain("ow-text-shimmer");
  expect(settled).not.toContain("<button");
  const invalid = renderToStaticMarkup(<ReasoningBlock text="" isStreaming={false} startedAt={NaN} endedAt={3_000} />);
  expect(invalid).not.toContain("Thought for");
});

test("folding live Code Mode moves visible shimmer to its summary and keeps results disclosed", async () => {
  const outer: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "outer", state: "input-available", input: {} };
  const completed: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "first",
    state: "output-available", input: { name: "mcp:fixture:list_channels" }, output: { privateFixture: "CAPTURED_RESULT" } };
  const running: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "second",
    state: "input-available", input: { name: "mcp:fixture:read_history" } };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CodeModeTool part={outer} calls={[completed, running]} lifecycle="running" connectors={[]} />));
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-code-mode-call="outer"] > button')!;
    expect(toggle().querySelector(".ow-text-shimmer")).toBeNull();
    expect(container.textContent).not.toContain("CAPTURED_RESULT");
    await act(async () => toggle().click());
    expect(toggle().querySelector(".ow-text-shimmer")).not.toBeNull();
    await act(async () => toggle().click());
    expect(toggle().querySelector(".ow-text-shimmer")).toBeNull();
    const details = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === "Listed channels. Show technical details");
    expect(details).toBeDefined();
    await act(async () => details!.click());
    expect(container.textContent).toContain("CAPTURED_RESULT");
    expect(container.textContent).not.toContain("The result was not recorded");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});


test("a restored connected action keeps its native elapsed time, then freezes at completion", async () => {
  const ticks: (() => void)[] = [];
  const interval = spyOn(window, "setInterval").mockImplementation(handler => {
    if (typeof handler === "function") ticks.push(() => handler());
    return 123;
  });
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability",
    toolCallId: "native-duration", state: "input-available", input: { name: "mcp:fixture:list_channels" },
    callProviderMetadata: { openwork: { toolStartedAt: 1_000 }, opencode: { partId: "native-part" } } };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    setSystemTime(7_000);
    await act(async () => root.render(<CapabilityCallLine part={part} shimmer />));
    expect(container.querySelector(".tabular-nums")?.textContent).toBe("6s");
    expect(container.querySelector("pre")).toBeNull();
    setSystemTime(11_000);
    await act(async () => ticks.forEach(tick => tick()));
    expect(container.querySelector(".tabular-nums")?.textContent).toBe("10s");
    const completed: DynamicToolUIPart = { ...part, state: "output-available", output: "Done",
      callProviderMetadata: { openwork: { toolStartedAt: 1_000, toolEndedAt: 5_500 } } };
    await act(async () => root.render(<CapabilityCallLine part={completed} shimmer />));
    expect(container.querySelector(".tabular-nums")?.textContent).toBe("4.5s");
    expect(container.querySelector(".ow-text-shimmer")).toBeNull();
    const unknown: DynamicToolUIPart = { ...part, toolCallId: "missing-native-duration",
      callProviderMetadata: { openwork: { timingUnavailable: true } } };
    await act(async () => root.render(<CapabilityCallLine part={unknown} />));
    expect(container.querySelector(".tabular-nums")).toBeNull();
  } finally {
    await act(async () => root.unmount()); container.remove(); interval.mockRestore(); setSystemTime();
  }
});

test("copying an action preserves its identity and captured output; clipboard denial offers retry", async () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability",
    toolCallId: "copied-invocation", state: "output-available", input: { name: "mcp:fixture:list_channels", body: { limit: 3 } },
    output: { channels: ["fixture"], preview: "[Result truncated by OpenWork]" },
    callProviderMetadata: { openwork: { resultTruncated: true } } };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const write = spyOn(navigator.clipboard, "writeText");
  try {
    write.mockRejectedValueOnce(new Error("denied"));
    await act(async () => root.render(<TechnicalDetailsPanel part={part} />));
    const copy = () => container.querySelector<HTMLButtonElement>('[aria-label="Copy technical details"]')!;
    await act(async () => copy().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    expect(copy().textContent).not.toContain("Copied");
    await act(async () => copy().click());
    expect(copy().textContent).toContain("Copied");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(JSON.parse(await navigator.clipboard.readText())).toEqual({ toolName: part.toolName,
      toolCallId: part.toolCallId, input: part.input, output: part.output, resultTruncated: true });
  } finally {
    await act(async () => root.unmount()); container.remove(); write.mockRestore();
  }
});
