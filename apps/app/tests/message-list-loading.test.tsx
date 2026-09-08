/** @jsxImportSource react */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";

import {
  MessageList,
  reconnectingLastConfirmedLabel,
  shouldShowMessageListLoading,
  shouldShowRunReconnecting,
  type RunSyncHealth,
} from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import type { ThreadStatus } from "../src/lib/messages";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { activeDelegatedTasks, hasNoNewActivity, lastTaskProgressAt, transcriptProgress } from "../src/react-app/domains/session/status/session-progress";
import type { TaskToolPart } from "../src/lib/build-in-tools";
import { WorkspaceProvider } from "../src/react-app/shell/workspace-provider";
import * as sessionSync from "../src/react-app/domains/session/sync/session-sync";

const inspectChild = mock((_sessionId: string) => {});

afterEach(() => {
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
  inspectChild.mockClear();
});

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Send this", state: "done" }],
};

function list(messages: UIMessage[], status: ThreadStatus, syncHealth?: RunSyncHealth) {
  return (
    <MessageListProvider
      workspaceId="ws"
      sessionId="session"
      showThinking={true}
      developerMode={false}
      displaySuggestions={false}
      providerConnectedCount={1}
      syncDegraded={syncHealth?.degraded ?? false}
      dispatchAction={() => {}}
      setPrompt={() => {}}
      onRevertToUserMessage={() => {}}
      onForkAtMessage={() => {}}
      onEditUserMessage={() => {}}
      onOpenSubagentSession={inspectChild}
      onMcpReconnect={() => Promise.reject(new Error("unused"))}
      onMcpReopenAuthorization={() => Promise.resolve()}
      onMcpRetry={() => {}}
    >
      <MessageList messages={messages} status={status} activityStatus="thinking" syncHealth={syncHealth} />
    </MessageListProvider>,
  );
}

function renderList(messages: UIMessage[], status: ThreadStatus, syncHealth?: RunSyncHealth) {
  return renderToStaticMarkup(list(messages, status, syncHealth));
}

describe("message-list loading feedback", () => {
  test("acknowledges a submitted message before streaming starts", () => {
    const markup = renderList([userMessage], "submitted");

    expect(markup).toContain("Working 0s");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).not.toContain("animate-spin");
    expect(markup).not.toContain("PaperGrainGradient");
  });

  test("does not duplicate the empty-conversation waiting treatment", () => {
    expect(shouldShowMessageListLoading("submitted", 0)).toBe(false);
  });

  test("keeps the same loading treatment when streaming begins", () => {
    const markup = renderList([userMessage], "streaming");

    expect(markup).toContain("Working 0s");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).not.toContain("animate-spin");
    expect(markup).not.toContain("PaperGrainGradient");
  });

  test("does not duplicate working feedback when a tool row is visible", () => {
    expect(shouldShowMessageListLoading("streaming", 2, true)).toBe(false);
  });
});

const task: TaskToolPart = {
  type: "dynamic-tool", toolName: "task", toolCallId: "delegation", state: "input-available",
  input: { description: "Review project notes", prompt: "PRIVATE TASK PROMPT", subagent_type: "general" },
  callProviderMetadata: { openwork: { childSessionId: "child" } },
};
const delegated: UIMessage = { id: "assistant", role: "assistant", parts: [task] };
const followup: UIMessage = { id: "followup", role: "user", parts: [{ type: "text", text: "What is the update?" }] };

describe("task-linked meaningful progress", () => {
  test("carries old active tasks below the latest user follow-up without a second live card", () => {
    const messages = [userMessage, delegated, followup];
    expect(activeDelegatedTasks(messages)).toEqual([task]);
    const html = renderList(messages, "streaming");
    expect(html).toContain("Running 1 subagent");
    expect(html.indexOf('data-testid="active-subagents"')).toBeGreaterThan(html.indexOf("What is the update?"));
    expect(html.match(/data-subagent-run="delegation"/g)).toHaveLength(1);
    expect(html).toContain('data-subagent-history="delegation"');
    expect(html).not.toContain('data-loading-message="working"');
    expect(html).not.toContain("PRIVATE TASK PROMPT");
  });

  test("deduplicates repeated call versions and removes only explicitly settled delegations", () => {
    expect(activeDelegatedTasks([delegated, delegated, followup])).toEqual([task]);
    const completed: UIMessage = { ...delegated, parts: [{ ...task, state: "output-available", output: "PRIVATE RESULT" }] };
    expect(activeDelegatedTasks([delegated, followup, completed])).toEqual([]);
    const html = renderList([userMessage, completed], "ready");
    expect(html).not.toContain('data-testid="active-subagents"');
    expect(html).toContain("Completed");
    expect(html).not.toContain("PRIVATE RESULT");
  });

  test("does not claim an unobserved child is running after its parent stops", () => {
    const html = renderList([userMessage, delegated, followup], "ready");
    expect(html).toContain("Subagent activity · 1 task");
    expect(html).toContain("Waiting for task result");
    expect(html).not.toContain("Running 1 subagent");
    expect(html).not.toContain("Completed");
  });

  test("busy polls, identical snapshots, user follow-ups and unrelated sessions do not reset silence", async () => {
    const ownedDom = typeof window === "undefined";
    if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const revalidate = spyOn(sessionSync, "revalidateWorkspaceSessionSync").mockResolvedValue(undefined);
    const view = () => <WorkspaceProvider client={null} workspaceId="ws" opencodeBaseUrl="http://localhost/test-engine" selectedWorkspaceRoot="/tmp/test">
      {list([userMessage, delegated, followup], "streaming")}
    </WorkspaceProvider>;
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const store = useSessionActivityStore.getState();
      store.setRunStatus("ws", "session", { type: "busy" });
      store.observeTranscript("ws", "session", [userMessage, delegated]);
      clock.mockReturnValue(62_000);
      store.setRunStatus("ws", "session", { type: "busy" });
      store.seedSessionRun("ws", "session", { type: "busy" }, true, { snapshotStartedAt: 62_000 });
      store.observeTranscript("ws", "session", structuredClone([userMessage, delegated, followup]), true);
      const output: UIMessage = { id: "child-output", role: "assistant", parts: [{ type: "text", text: "PRIVATE OUTPUT" }] };
      store.observeTranscript("other-workspace", "child", [output]);
      store.observeTranscript("ws", "unrelated-child", [output]);
      let records = useSessionActivityStore.getState().recordsByWorkspaceId.ws;
      expect(records.session.runStartedAt).toBe(1_000);
      expect(records.session.lastProgressAt).toBe(1_000);
      expect(lastTaskProgressAt(1_000, [task], records)).toBe(1_000);
      await act(async () => { root.render(view()); });
      let html = container.innerHTML;
      expect(html).toContain('data-loading-message="no-new-activity"');
      expect(html).not.toContain('data-loading-message="working"');
      expect(html).not.toContain('data-testid="session-error-resume"');
      expect(revalidate).toHaveBeenCalledTimes(1);
      expect(revalidate).toHaveBeenCalledWith({ workspaceId: "ws", baseUrl: "http://localhost/test-engine" });
      const inspect = container.querySelector<HTMLButtonElement>('[data-testid="active-subagents"] button');
      if (!inspect) throw new Error("Missing child inspection button");
      await act(async () => { inspect.click(); });
      expect(inspectChild).toHaveBeenCalledTimes(1);
      expect(inspectChild).toHaveBeenCalledWith("child");
      expect(container.querySelectorAll('[data-subagent-history] button')).toHaveLength(0);
      await act(async () => { root.render(view()); });
      expect(revalidate).toHaveBeenCalledTimes(1);
      await act(async () => { store.observeTranscript("ws", "child", [output]); });
      records = useSessionActivityStore.getState().recordsByWorkspaceId.ws;
      expect(lastTaskProgressAt(1_000, [task], records)).toBe(62_000);
      html = container.innerHTML;
      expect(html).not.toContain('data-loading-message="no-new-activity"');
      expect(html).toContain("Running 1 subagent");
      expect(html).not.toContain("PRIVATE OUTPUT");
      expect(html).toContain("Last activity: Response updated");
      clock.mockReturnValue(123_000);
      await act(async () => {
        store.observeTranscript("ws", "child", structuredClone([output]), true);
        // Identical snapshots do not rerender: the ordinary UI tick must warn.
        await new Promise((resolve) => window.setTimeout(resolve, 1_100));
      });
      expect(container.innerHTML).toContain('data-loading-message="no-new-activity"');
      await act(async () => { store.setWaitingRequest("ws", "child", "question", "question-1", true); });
      expect(container.innerHTML).not.toContain('data-loading-message="no-new-activity"');
      expect(container.innerHTML).toContain("Waiting for your answer");
      await act(async () => {
        store.setWaitingRequest("ws", "child", "question", "question-1", false);
        store.setRunStatus("ws", "child", { type: "retry" });
      });
      expect(container.innerHTML).not.toContain('data-loading-message="no-new-activity"');
      expect(container.innerHTML).toContain("Retrying");
      await act(async () => { store.setRunStatus("ws", "child", { type: "idle" }); });
      expect(container.innerHTML).toContain("Subagent activity · 1 task");
      expect(container.innerHTML).not.toContain("Completed");
      expect(container.innerHTML).toContain("Waiting for task result");
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      clock.mockRestore();
      revalidate.mockRestore();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      if (ownedDom) await GlobalRegistrator.unregister();
    }
  });

  test("only content and tool lifecycle changes count, not changing provider metadata", () => {
    const original = transcriptProgress([delegated]);
    expect(transcriptProgress([{ ...delegated, metadata: { opencode: { updated: 999 } } }]).revision).toBe(original.revision);
    expect(transcriptProgress([delegated, followup]).revision).toBe(original.revision);
    const result: UIMessage = { ...delegated, parts: [{ ...task, state: "output-available", output: "PRIVATE RESULT" }] };
    expect(transcriptProgress([result]).revision).not.toBe(original.revision);
    expect(transcriptProgress([result]).label).toBe("Tool result received");
    const reasoning: UIMessage = { id: "reason", role: "assistant", parts: [{ type: "reasoning", text: "PRIVATE REASONING" }] };
    const next = transcriptProgress([delegated, reasoning]);
    expect(next.revision).not.toBe(original.revision);
    expect(JSON.stringify(next)).not.toContain("PRIVATE");
    const response: UIMessage = { id: "response", role: "assistant", parts: [{ type: "text", text: "Already sent" }] };
    const before = transcriptProgress([delegated, response]);
    expect(transcriptProgress([result, response], before.parts).label).toBe("Tool result received");
  });

  test("warns strictly after a minute, preserving authoritative waiting, retry and disconnection", () => {
    const input = { active: true, lastProgressAt: 1_000, now: 61_000 };
    expect(hasNoNewActivity(input)).toBe(false);
    expect(hasNoNewActivity({ ...input, now: 61_001 })).toBe(true);
    expect(hasNoNewActivity({ ...input, now: 120_000, active: false })).toBe(false);
    for (const override of [{ waiting: true }, { retrying: true }, { disconnected: true }]) {
      expect(hasNoNewActivity({ ...input, now: 120_000, ...override })).toBe(false);
    }
  });
});

describe("message-list reconnecting feedback", () => {
  test("replaces the ticking working row when run liveness cannot be validated", () => {
    const markup = renderList([userMessage], "streaming", {
      degraded: true,
      lastConfirmedAt: Date.now() - 1_000,
    });

    expect(markup).toContain('data-loading-message="reconnecting"');
    expect(markup).toContain("Connection lost — reconnecting…");
    expect(markup).not.toContain("Working");
    expect(markup).not.toContain("ow-text-shimmer");
  });

  test("keeps the confident working row while liveness is confirmed", () => {
    const markup = renderList([userMessage], "streaming", {
      degraded: false,
      lastConfirmedAt: Date.now(),
    });

    expect(markup).toContain('data-loading-message="working"');
    expect(markup).not.toContain('data-loading-message="reconnecting"');
  });

  test("names the last confirmed time once the outage is prolonged", () => {
    const markup = renderList([userMessage], "streaming", {
      degraded: true,
      lastConfirmedAt: Date.now() - 3 * 60_000,
    });

    expect(markup).toContain("last update");
  });

  test("stays quiet without an active run even when the stream is degraded", () => {
    expect(shouldShowRunReconnecting("ready", true)).toBe(false);
    expect(shouldShowRunReconnecting("submitted", true)).toBe(true);
    expect(shouldShowRunReconnecting("streaming", true)).toBe(true);
    expect(shouldShowRunReconnecting("retrying", true)).toBe(true);
    expect(shouldShowRunReconnecting("streaming", false)).toBe(false);
  });

  test("only surfaces the last confirmed hint after a meaningful gap", () => {
    const now = 10 * 60_000;
    expect(reconnectingLastConfirmedLabel(null, now)).toBeNull();
    expect(reconnectingLastConfirmedLabel(now - 30_000, now)).toBeNull();
    expect(reconnectingLastConfirmedLabel(now - 3 * 60_000, now)).not.toBeNull();
  });
});
