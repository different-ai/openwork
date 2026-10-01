/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { SubagentRunLine } from "../src/components/chat/subagent-run-line";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import type { TaskToolPart } from "../src/lib/build-in-tools";

const registered = typeof window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const noop = () => {};

test("a helper Stop stays pending, reports rejection, and can retry acknowledgement", async () => {
  const workspace = "stop-controls";
  const child = "child";
  const store = useSessionActivityStore.getState();
  store.beginRun(workspace, child, "run", Date.now());
  const part: TaskToolPart = { type: "dynamic-tool", toolName: "task", toolCallId: "stop-call", state: "input-available",
    input: { description: "Inspect fixture", prompt: "Read fixture", subagent_type: "general" },
    callProviderMetadata: { openwork: { childSessionId: child, toolStartedAt: Date.now() } } };
  let pending = Promise.withResolvers<void>();
  const targeted: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <MessageListProvider workspaceId={workspace} sessionId="parent" showThinking displaySuggestions={false} developerMode={false}
        providerConnectedCount={1} dispatchAction={noop} setPrompt={noop} onRevertToUserMessage={noop} onForkAtMessage={noop}
        onEditUserMessage={noop} onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => {}}
        onOpenSubagentSession={noop} onStopSubagentSession={id => { targeted.push(id); return pending.promise; }}>
        <SubagentRunLine part={part} />
      </MessageListProvider>,
    ));
    const stop = () => container.querySelector<HTMLButtonElement>("[data-subagent-stop]")!;
    await act(async () => stop().click());
    expect(targeted).toEqual([child]);
    expect(stop().disabled).toBe(true);
    expect(container.textContent).toContain("Stopping…");
    await act(async () => stop().click());
    expect(targeted).toHaveLength(1);
    await act(async () => pending.reject(new Error("Transport unavailable")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not stop — retry");
    expect(stop().disabled).toBe(false);
    expect(container.textContent).not.toContain("Stopped");
    pending = Promise.withResolvers<void>();
    await act(async () => stop().click());
    expect(targeted).toEqual([child, child]);
    await act(async () => {
      store.markRunStopped(workspace, child);
      store.setRunStatus(workspace, child, "idle");
      pending.resolve();
    });
    expect(container.textContent).toContain("Stopped");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("[data-subagent-stop]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
