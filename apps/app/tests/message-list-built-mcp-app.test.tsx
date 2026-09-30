/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { createDefaultPlatform, PlatformProvider } from "../src/react-app/kernel/platform";

// Without a live conversation origin the App frame renders this notice, which marks its place.
const APP_MARKER = "This App is missing its conversation origin";

function appPart(id: string, app = { connectionId: "cob_fixture", resourceUri: "ui://openwork/apps/cob_fixture/revisions/cov_fixture/index.html" }): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: id,
    state: "output-available",
    input: { name: `plugin:plg_fixture:${app.connectionId}` },
    output: "Opened Order calculator.",
    callProviderMetadata: { openwork: { mcpResult: {
      content: [{ type: "text", text: "Opened Order calculator." }],
      _meta: { "openwork/mcpApp": { connectionId: app.connectionId, toolName: "open_app", resourceUri: app.resourceUri, arguments: { input: {} } } },
    } } },
  };
}

/** A card of a real App built in OpenWork, at one of its revisions. */
function builtApp(app: string, revision: string) {
  const appId = `cob_01mcpapp${app.repeat(18)}`;
  return { connectionId: appId, resourceUri: `ui://openwork/apps/${appId}/revisions/cov_01mcpapp${revision.repeat(18)}/index.html` };
}

function withoutWindow<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (descriptor?.configurable) Reflect.deleteProperty(globalThis, "window");
  try {
    return run();
  } finally {
    if (descriptor?.configurable) Object.defineProperty(globalThis, "window", descriptor);
  }
}

function renderList(messages: UIMessage[]) {
  return withoutWindow(() => renderToStaticMarkup(
    <PlatformProvider value={createDefaultPlatform()}>
      <MessageListProvider
        workspaceId="ws" sessionId="session" showThinking={true} developerMode={false} displaySuggestions={false}
        providerConnectedCount={1} dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}}
        onForkAtMessage={() => {}} onEditUserMessage={() => {}}
        onMcpReconnect={() => Promise.reject(new Error("unused"))} onMcpReopenAuthorization={() => Promise.resolve()}
      >
        <MessageList messages={messages} status="ready" activityStatus="idle" />
      </MessageListProvider>
    </PlatformProvider>
  ));
}

const user: UIMessage = { id: "user-1", role: "user", metadata: { opencode: { created: 1_000 } }, parts: [{ type: "text", text: "Open the order calculator", state: "done" }] };

function assistant(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", metadata: { opencode: { created: 2_000, completed: 90_000 } }, parts };
}

describe("built MCP App card revisions", () => {
  test("only the newest card of an App built in OpenWork stays live; earlier cards point to it", () => {
    const newerNote = "This App has a newer version below.";
    const markup = renderList([
      user,
      assistant("a-build", [appPart("open-a1", builtApp("a", "1")), { type: "text", text: "Built the calculator.", state: "done" }]),
      { ...user, id: "user-2", parts: [{ type: "text", text: "Make the total bold", state: "done" }] },
      assistant("a-update", [appPart("open-a2", builtApp("a", "2")), appPart("open-b1", builtApp("b", "1")), { type: "text", text: "Updated it.", state: "done" }]),
    ]);
    const count = (text: string) => markup.split(text).length - 1;
    // The updated calculator and the other App are live; the first calculator card points below.
    expect(count(APP_MARKER)).toBe(2);
    expect(count(newerNote)).toBe(1);
    expect(markup.indexOf(newerNote)).toBeLessThan(markup.indexOf("Built the calculator."));
  });

  test("connected Apps with authored-looking URIs keep all their cards live", () => {
    const first = { ...builtApp("a", "1"), connectionId: "emc_provider" };
    const second = { ...builtApp("a", "2"), connectionId: "emc_provider" };
    const markup = renderList([user, assistant("a-first", [appPart("open-a1", first)]),
      { ...user, id: "user-2" }, assistant("a-second", [appPart("open-a2", second)])]);
    expect(markup.split(APP_MARKER).length - 1).toBe(2);
    expect(markup).not.toContain("This App has a newer version below.");
  });
});
