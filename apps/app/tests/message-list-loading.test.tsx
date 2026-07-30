/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";

import {
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

function renderList(messages: UIMessage[], status: ThreadStatus) {
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
      <MessageList messages={messages} status={status} />
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

  test("keeps the same loading treatment when streaming begins", () => {
    const markup = renderList([userMessage], "streaming");

    expect(markup).toContain("Thinking…");
    expect(markup).not.toContain("Loading…");
  });
});
