import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { DynamicToolUIPart } from "ai";

import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { OpenWorkSessionCreateTool } from "../src/components/tools/openwork-session-create";

const noop = () => {};

function sessionCreatePart(): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "openwork_session_create",
    toolCallId: "call-create-sessions",
    state: "output-available",
    input: {
      sessions: [
        { title: "Dolphin research", prompt: "Research dolphins." },
        { title: "Banana research", prompt: "Research bananas." },
        { title: "Apple pie research", prompt: "Research apple pies." },
      ],
    },
    output: JSON.stringify({
      ok: true,
      workspaceId: "workspace-a",
      workspace: "Research",
      created: [
        { sessionId: "session-dolphins", title: "Dolphin research", started: true, route: "/workspace/workspace-a/session/session-dolphins" },
        { sessionId: "session-bananas", title: "Banana research", started: true, route: "/workspace/workspace-a/session/session-bananas" },
        { sessionId: "session-apple-pies", title: "Apple pie research", started: true, route: "/workspace/workspace-a/session/session-apple-pies" },
      ],
      failures: [],
    }),
  };
}

describe("OpenWorkSessionCreateTool", () => {
  test("renders named created-chat rows with an Open chat action for each session", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
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
          <OpenWorkSessionCreateTool part={sessionCreatePart()} />
        </MessageListProvider>
      </MemoryRouter>,
    );

    expect(html).toContain("data-openwork-session-create-card");
    expect(html).toContain('data-created-session-count="3"');
    expect(html).toContain("Dolphin research");
    expect(html).toContain("Banana research");
    expect(html).toContain("Apple pie research");
    expect(html.match(/data-open-created-session=/g)).toHaveLength(3);
    expect(html).toContain("Open chat");
    expect(html).toContain('data-open-created-session="session-dolphins"');
  });
});
