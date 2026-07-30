/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";

import {
  hasVisibleStreamingReasoning,
  MessageList,
  shouldShowMessageListLoading,
} from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import type { ThreadStatus } from "../src/lib/messages";

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Send this", state: "done" }],
};

function renderList(
  messages: UIMessage[],
  status: ThreadStatus,
  retryStatus?: React.ComponentProps<typeof MessageList>["retryStatus"],
) {
  return renderToStaticMarkup(
    <MessageListProvider
      workspaceId="ws"
      sessionId="session"
      showThinking={true}
      developerMode={false}
      displaySuggestions={false}
      providerConnectedCount={1}
      dispatchAction={() => {}}
      setPrompt={() => {}}
      onRevertToUserMessage={() => {}}
      onForkAtMessage={() => {}}
      onEditUserMessage={() => {}}
      onMcpReconnect={() => Promise.reject(new Error("unused"))}
      onMcpReopenAuthorization={() => Promise.resolve()}
      onMcpRetry={() => {}}
    >
      <MessageList messages={messages} status={status} retryStatus={retryStatus} />
    </MessageListProvider>,
  );
}

describe("message-list loading feedback", () => {
  test("acknowledges a submitted message before streaming starts", () => {
    const markup = renderList([userMessage], "submitted");

    expect(markup).toContain("Thinking…");
    expect(markup).not.toContain("Loading…");
  });

  test("does not duplicate the empty-conversation waiting treatment", () => {
    expect(shouldShowMessageListLoading("submitted", 0)).toBe(false);
  });

  test("keeps Thinking visible during plain streaming", () => {
    const markup = renderList([userMessage], "streaming");

    expect(markup).toContain("Thinking…");
    expect(markup).not.toContain("Loading…");
  });

  test("uses streaming reasoning as the single Thinking treatment", () => {
    const assistantMessage: UIMessage = {
      id: "assistant-reasoning",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Working this through", state: "streaming" }],
    };
    const messages = [userMessage, assistantMessage];
    const markup = renderList(messages, "streaming");

    expect(hasVisibleStreamingReasoning(messages, true)).toBe(true);
    expect(hasVisibleStreamingReasoning(messages, false)).toBe(false);
    expect(markup.match(/Thinking…/g)).toHaveLength(1);
    expect(markup).toContain("data-reasoning-block");
  });

  test("preserves the active tool label", () => {
    const assistantMessage: UIMessage = {
      id: "assistant-tool",
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolName: "custom_capability",
        toolCallId: "tool-1",
        state: "input-available",
        input: {},
      }],
    };
    const markup = renderList([userMessage, assistantMessage], "streaming");

    expect(markup).toContain("Running custom capability");
    expect(markup).not.toContain("Thinking…");
  });

  test("shows retry feedback without a generic Thinking row", () => {
    const markup = renderList([userMessage], "retrying", {
      type: "retry",
      attempt: 2,
      message: "Temporarily unavailable",
      next: Date.now() + 5_000,
    });

    expect(markup).toContain("Temporarily unavailable");
    expect(markup).toContain("attempt 2");
    expect(markup).not.toContain("Thinking…");
  });

  test("keeps completed Thought history without live feedback", () => {
    const assistantMessage: UIMessage = {
      id: "assistant-complete",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Finished reasoning", state: "done" },
        { type: "text", text: "Complete", state: "done" },
      ],
    };
    const markup = renderList([userMessage, assistantMessage], "ready");

    expect(markup).toContain("Thought");
    expect(markup).not.toContain("Thinking…");
    expect(markup).toContain("Complete");
  });
});
