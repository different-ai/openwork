/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Send this", state: "done" }],
};

function renderList(messages: UIMessage[], status: ThreadStatus, syncHealth?: RunSyncHealth) {
  return renderToStaticMarkup(
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
      onMcpReconnect={() => Promise.reject(new Error("unused"))}
      onMcpReopenAuthorization={() => Promise.resolve()}
      onMcpRetry={() => {}}
    >
      <MessageList messages={messages} status={status} syncHealth={syncHealth} />
    </MessageListProvider>,
  );
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
