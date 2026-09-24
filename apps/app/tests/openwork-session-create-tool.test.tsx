import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { TechnicalDetailsPanel } from "../src/components/chat/capability-call-line";
import { getToolActivityLabel } from "../src/lib/tool-activity";
import { createDefaultPlatform, PlatformProvider } from "../src/react-app/kernel/platform";

const noop = () => {};

function renderPart(part: DynamicToolUIPart) {
  return renderToStaticMarkup(
    <PlatformProvider value={createDefaultPlatform()}>
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
      >
        <MessageList messages={[{ id: "history", role: "assistant", parts: [part] }]} status="ready" />
      </MessageListProvider>
    </PlatformProvider>,
  );
}

const retiredTools = [
  {
    toolName: "openwork_session_create",
    input: { sessions: [{ title: "Research", prompt: "Research the topic." }] },
    output: {
      ok: true, workspaceId: "workspace-a", workspace: "Research",
      created: [{ sessionId: "session-research", title: "Research", started: true, route: "/workspace/workspace-a/session/session-research" }],
      failures: [],
    },
  },
  {
    toolName: "openwork_visualization",
    input: { id: "design", title: "Research layout", revision: 1, sections: [] },
    output: { id: "design", title: "Research layout", revision: 1, sections: [{ title: "Header", blocks: [{ kind: "text", label: "Hello" }] }] },
  },
  ...["request_env_var", "env_var_request"].map(toolName => ({
    toolName, input: { key: "FIXTURE_TOKEN", label: "Fixture token", followUpPrompt: "Continue setup" }, output: { requested: true },
  })),
  {
    toolName: "openwork_execute",
    input: { id: "session.create", args: { title: "Research" } },
    output: { ok: true, id: "session.create", result: { sessionId: "session-research" } },
  },
];

describe("retired desktop tool UI history", () => {
  test.each(retiredTools)("$toolName keeps its generic tool line and inspectable result", ({ toolName, input, output }) => {
    for (const value of [output, JSON.stringify(output), "malformed historical output", null]) {
      const part: DynamicToolUIPart = {
        type: "dynamic-tool", toolName, toolCallId: "historical-call", state: "output-available", input, output: value,
      };
      const html = renderPart(part);
      expect(html).toContain(`data-capability-call="${toolName}"`);
      for (const marker of ["data-openwork-session-create-card", "data-open-created-session", "visualization-card", "Save token", "Apply changes", "Continue setup", "Open chat", "Preview size"]) {
        expect(html).not.toContain(marker);
      }
      const details = renderToStaticMarkup(<TechnicalDetailsPanel part={part} />);
      expect(details).toContain("historical-call");
      if (typeof value === "string") expect(details).toContain(value.startsWith("{") ? "&quot;" : value);
    }
  });

  test.each(retiredTools)("$toolName failures remain generic and inspectable", ({ toolName, input }) => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName, toolCallId: "failed-history", state: "output-error", input, errorText: "Historical call failed",
    };
    expect(renderPart(part)).toContain(`data-capability-call="${toolName}"`);
    expect(renderToStaticMarkup(<TechnicalDetailsPanel part={part} />)).toContain("Historical call failed");
  });

  test.each(["request_env_var", "env_var_request"])("%s uses generic activity without env-var input parsing", toolName => {
    expect(getToolActivityLabel({
      type: "dynamic-tool", toolName, toolCallId: "activity", state: "input-available", input: { key: 123 },
    })).toBe(`Running ${toolName.replaceAll("_", " ")}`);
  });

  test("question rendering remains a built-in tool instead of a generic capability", () => {
    const html = renderPart({
      type: "dynamic-tool", toolName: "question", toolCallId: "question", state: "output-available",
      input: { questions: [{ header: "Choose scope", question: "Which scope?", options: [{ label: "Current", description: "Current workspace" }] }] },
      output: "Current",
    });
    expect(html).toContain("Choose scope");
    expect(html).toContain("Answered");
    expect(html).not.toContain('data-capability-call="question"');
  });
});
