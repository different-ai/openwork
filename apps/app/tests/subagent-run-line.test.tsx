import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { SubagentRunLine, subagentRunActivity } from "../src/components/chat/subagent-run-line";
import { SubagentOverview } from "../src/components/chat/subagent-overview";
import type { TaskToolPart } from "../src/lib/build-in-tools";
import { activeDelegatedTasks } from "../src/react-app/domains/session/status/session-progress";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

const noop = () => {};

function taskPart(state: "input-streaming" | "output-available", childSessionId?: string): TaskToolPart {
  const input = {
    description: "Build isolated Azure repro",
    prompt: "Reproduce the Azure failure in isolation.",
    subagent_type: "executor-deep",
  };

  const callProviderMetadata = childSessionId ? { openwork: { childSessionId } } : undefined;

  return state === "output-available"
    ? {
        type: "dynamic-tool",
        toolName: "task",
        toolCallId: "call-subagent",
        state,
        input,
        output: "Completed the reproduction.",
        callProviderMetadata,
      }
    : {
        type: "dynamic-tool",
        toolName: "task",
        toolCallId: "call-subagent",
        state,
        input,
        callProviderMetadata,
      };
}

function render(part: TaskToolPart): string {
  return renderToStaticMarkup(
    <MessageListProvider
      workspaceId="workspace-a"
      sessionId="session-origin"
      showThinking={false}
      developerMode={false}
      displaySuggestions={false}
      providerConnectedCount={1}
      dispatchAction={noop}
      setPrompt={noop}
      onRevertToUserMessage={noop}
      onForkAtMessage={noop}
      onEditUserMessage={noop}
      onMcpReconnect={async () => "connected"}
      onMcpReopenAuthorization={async () => {}}
      onMcpRetry={noop}
    >
      <SubagentRunLine part={part} />
    </MessageListProvider>,
  );
}

describe("SubagentRunLine", () => {
  test("uses a text shimmer instead of a spinner while the subagent is running", () => {
    const html = render(taskPart("input-streaming"));

    expect(html).toContain('data-subagent-activity="shimmer"');
    expect(html).toContain("ow-text-shimmer");
    expect(html).toContain("Build isolated Azure repro");
    expect(html).toContain("Working 0s");
    expect(html).not.toContain("animate-spin");
  });

  test("settles to a static completed treatment", () => {
    const html = render(taskPart("output-available"));

    expect(html).toContain('data-subagent-activity="completed"');
    expect(html).toContain("Completed");
    expect(html).not.toContain("ow-text-shimmer");
    expect(html).not.toContain("animate-spin");
  });

  test("prioritizes a blocked permission over the running treatment", () => {
    expect(subagentRunActivity({
      permissionPending: true,
      inFlight: true,
      failed: false,
    })).toBe("waiting-permission");
  });

  test("keeps a blocked permission ahead of a lost connection, which only downgrades the running treatment", () => {
    expect(subagentRunActivity({
      permissionPending: true,
      syncDegraded: true,
      inFlight: true,
      failed: false,
    })).toBe("waiting-permission");
    expect(subagentRunActivity({
      permissionPending: false,
      syncDegraded: true,
      inFlight: true,
      failed: false,
    })).toBe("reconnecting");
  });

  test("silence is not completion and cannot replace waiting, retrying, or disconnected status", () => {
    const input = { permissionPending: false, inFlight: true, failed: false, noNewActivity: true };
    expect(subagentRunActivity(input)).toBe("no-new-activity");
    expect(subagentRunActivity({ ...input, questionPending: true })).toBe("waiting-question");
    expect(subagentRunActivity({ ...input, retrying: true })).toBe("retrying");
    expect(subagentRunActivity({ ...input, syncDegraded: true })).toBe("reconnecting");
    expect(subagentRunActivity({ ...input, inFlight: false })).toBe("completed");
  });

  test("shows static uncertainty for a restored task whose native start is absent", () => {
    const part = {
      ...taskPart("input-streaming"),
      toolCallId: "call-unknown-start",
      callProviderMetadata: { opencode: { partId: "part-unknown-start" } },
    };
    const html = render(part);
    expect(html).toContain('data-subagent-activity="waiting-start"');
    expect(html).toContain("Waiting for task update");
    expect(html).not.toContain("Working 0s");
    expect(html).not.toContain("ow-text-shimmer");
  });
});

describe("subagent overview", () => {
  afterEach(() => {
    useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
  });

  const first = taskPart("input-streaming", "child-first");
  const second: TaskToolPart = {
    ...taskPart("input-streaming", "child-second"),
    toolCallId: "call-second",
    input: { description: "Review project notes", prompt: "PRIVATE SECOND PROMPT", subagent_type: "general" },
  };

  test("keeps the overview quiet when there are no pending delegations", () => {
    expect(renderToStaticMarkup(<SubagentOverview tasks={[]} workspaceId="workspace-a" parentActive={false} />)).toBe("");
  });

  test("expands a deduplicated list, opens the exact child, and removes only settled tasks without disturbing a draft", async () => {
    const ownedDom = typeof window === "undefined";
    if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const openChild = mock((_id: string) => {});
    const view = (parts: TaskToolPart[], owner = "parent") => (
      <>
        <SubagentOverview key={owner} tasks={activeDelegatedTasks([{ id: "answer", role: "assistant", parts }])}
          workspaceId="workspace-a" parentActive onOpenSubagentSession={openChild} />
        <textarea defaultValue="Keep my follow-up" />
      </>
    );
    function toggle() {
      const button = container.querySelector<HTMLButtonElement>('[data-testid="subagent-overview-toggle"]');
      if (!button) throw new Error("Missing subagent overview disclosure");
      return button;
    }
    try {
      await act(async () => root.render(view([first, first, second])));
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(toggle().getAttribute("aria-label")).toBe("Show 2 subagents");
      expect(container.querySelectorAll("[data-subagent-run]")).toHaveLength(0);
      const draft = container.querySelector("textarea");
      if (!draft) throw new Error("Missing follow-up draft");
      draft.value = "Keep my edited follow-up";
      await act(async () => toggle().click());
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelectorAll("[data-subagent-run]")).toHaveLength(2);
      expect(container.textContent).not.toContain("PRIVATE SECOND PROMPT");
      expect(container.textContent).not.toContain("Reproduce the Azure failure in isolation.");
      const childButton = container.querySelector<HTMLButtonElement>('[data-subagent-session-id="child-second"] button');
      if (!childButton) throw new Error("Missing second subagent");
      await act(async () => childButton.click());
      expect(openChild).toHaveBeenCalledTimes(1);
      expect(openChild).toHaveBeenCalledWith("child-second");
      expect(container.querySelector("textarea")).toBe(draft);
      expect(draft.value).toBe("Keep my edited follow-up");
      const settled: TaskToolPart = { ...first, state: "output-available", output: "PRIVATE RESULT" };
      await act(async () => root.render(view([first, second, settled])));
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(toggle().getAttribute("aria-label")).toBe("Hide 1 subagent");
      expect(container.querySelectorAll("[data-subagent-run]")).toHaveLength(1);
      expect(container.querySelector('[data-subagent-session-id="child-second"]')).not.toBeNull();
      expect(container.textContent).not.toContain("PRIVATE RESULT");
      await act(async () => root.render(view([second], "different-parent")));
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      await act(async () => root.render(view([], "different-parent")));
      expect(container.querySelector('[data-testid="subagent-overview"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      if (ownedDom) await GlobalRegistrator.unregister();
    }
  });

  test("surfaces input needs while collapsed and preserves each child's status and workspace isolation", async () => {
    const ownedDom = typeof window === "undefined";
    if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const view = (syncDegraded = false) => <SubagentOverview tasks={[first, second]} workspaceId="workspace-a"
      parentActive={false} syncDegraded={syncDegraded} onOpenSubagentSession={noop} />;
    try {
      const store = useSessionActivityStore.getState();
      store.setWaitingRequest("other-workspace", "child-first", "permission", "foreign-ask", true);
      store.setWaitingRequest("workspace-a", "unrelated-child", "question", "unrelated-ask", true);
      await act(async () => root.render(view()));
      expect(container.textContent).not.toContain("needs input");
      await act(async () => store.setWaitingRequest("workspace-a", "child-first", "question", "ask-first", true));
      expect(container.textContent).toContain("1 needs input");
      const toggle = container.querySelector<HTMLButtonElement>('[data-testid="subagent-overview-toggle"]');
      if (!toggle) throw new Error("Missing subagent overview disclosure");
      expect(toggle.getAttribute("aria-describedby")).toBe(container.querySelector('[role="status"]')?.id);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await act(async () => toggle.click());
      expect(container.querySelector('[data-subagent-session-id="child-first"]')?.getAttribute("data-subagent-activity")).toBe("waiting-question");
      expect(container.querySelector('[data-subagent-session-id="child-second"]')?.getAttribute("data-subagent-activity")).toBe("waiting-result");
      expect(container.textContent).not.toContain("Completed");
      await act(async () => root.render(view(true)));
      expect(container.textContent).toContain("1 needs input");
      expect(container.querySelector('[data-subagent-session-id="child-first"]')?.getAttribute("data-subagent-activity")).toBe("waiting-question");
      expect(container.querySelector('[data-subagent-session-id="child-second"]')?.getAttribute("data-subagent-activity")).toBe("reconnecting");
      await act(async () => store.setWaitingRequest("workspace-a", "child-first", "question", "ask-first", false));
      expect(toggle.textContent).toContain("Reconnecting");
      await act(async () => {
        store.setRunStatus("workspace-a", "child-second", { type: "retry" });
        root.render(view());
      });
      expect(container.querySelector('[data-subagent-session-id="child-second"]')?.getAttribute("data-subagent-activity")).toBe("retrying");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      if (ownedDom) await GlobalRegistrator.unregister();
    }
  });
});
