/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { createDefaultPlatform, PlatformProvider } from "../src/react-app/kernel/platform";
import type { ChatConnectionDecisionBinding } from "../src/react-app/domains/session/surface/mcp-chat-reconnect";

function bashPart(id: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}`, description: "run" },
    output: "ok",
  };
}

function editPart(id: string, filePath: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "edit",
    toolCallId: id,
    state: "output-available",
    input: { filePath, oldString: "a", newString: "b" },
    output: "ok",
  };
}

/**
 * Other test files stub `globalThis.window` and can leak it into a shared
 * bun test worker. Static SSR rendering must not see a partial window stub
 * (components probe it for addEventListener), so hide it for the render.
 */
function withoutWindow<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (descriptor?.configurable) {
    Reflect.deleteProperty(globalThis, "window");
  }
  try {
    return run();
  } finally {
    if (descriptor?.configurable) {
      Object.defineProperty(globalThis, "window", descriptor);
    }
  }
}

function renderList(messages: UIMessage[], readOnly = false, options: {
  uiStateOwner?: string;
  getConnectionDecision?: (toolCallId: string) => ChatConnectionDecisionBinding | null;
} = {}) {
  return withoutWindow(() => renderToStaticMarkup(
    <PlatformProvider value={createDefaultPlatform()}>
    <MessageListProvider
      readOnly={readOnly}
      workspaceId="ws"
      sessionId="session"
      uiStateOwner={options.uiStateOwner}
      getConnectionDecision={options.getConnectionDecision}
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
    >
      <MessageList messages={messages} status="ready" activityStatus="idle" />
    </MessageListProvider>
    </PlatformProvider>
  ));
}

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  metadata: { opencode: { created: 1_000 } },
  parts: [{ type: "text", text: "do the thing", state: "done" }],
};

describe("finished turn step fold (single OpenCode message per turn)", () => {
  test.each([false, true])("resolved reply is always visible on the work rail, with folded steps: %s", (folded) => {
    const assistant: UIMessage = {
      id: "resolved-reply", role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 80_000,
        replyModel: { modelID: "served-witness", providerID: "provider", name: "Served witness", resolved: true } } },
      parts: [...(folded ? [bashPart("one"), bashPart("two"), bashPart("three"), bashPart("four"), bashPart("five")] : []),
        { type: "text", text: "Final answer", state: "done" }],
    };
    const markup = renderList([userMessage, assistant]);
    expect(markup).toContain('data-testid="completed-work-rail"');
    expect(markup).toContain("Worked for 1m 19s");
    expect(markup).toContain('data-testid="reply-model"');
    expect(markup.indexOf('data-testid="reply-model"')).toBeLessThan(markup.indexOf("Final answer"));
    expect(markup.match(/data-testid="reply-model"/g)).toHaveLength(1);
    const unresolved = { ...assistant, metadata: { opencode: { replyModel: { modelID: "requested-model", providerID: "provider" } } } };
    expect(renderList([userMessage, unresolved])).not.toContain('data-testid="reply-model"');
  });

  test.each([true, false])("unfinished idle tools are quiet in read-only=%s current and history views", (readOnly) => {
    const assistant: UIMessage = {
      id: "unfinished-assistant", role: "assistant",
      parts: [{
        type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "unfinished-probe",
        state: "input-available", input: { name: "mcp:emc_probe:*" },
      }],
    };
    for (const messages of [[userMessage, assistant], [userMessage, assistant, { ...userMessage, id: "later-user" }]]) {
      const markup = renderList(messages, readOnly);
      expect(markup).toContain("status unavailable");
      expect(markup).not.toContain("Task interrupted");
      expect(markup).not.toContain("Retry to continue");
      expect(markup).not.toContain("animate-spin");
      expect(markup).not.toContain("ow-text-shimmer");
    }
  });
  test("folds interleaved steps into a 'Worked for …' line and keeps the answer", () => {
    const assistant: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 80_000 } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "planning the change", state: "done" },
        bashPart("c1"),
        editPart("c2", "/repo/src/a.ts"),
        { type: "text", text: "Now checking the result:", state: "done" },
        bashPart("c3"),
        bashPart("c4"),
        bashPart("c5"),
        { type: "text", text: "Everything passed — the change is in.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // 79 seconds of work between created and completed.
    expect(markup).toContain("Worked for 1m 19s");
    // The answer stays visible outside the fold.
    expect(markup).toContain("Everything passed — the change is in.");
  });

  test("a short turn stays inline with one aggregate line", () => {
    const assistant: UIMessage = {
      id: "assistant-2",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 5_000 } },
      parts: [
        { type: "step-start" },
        bashPart("c1"),
        editPart("c2", "/repo/src/a.ts"),
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    expect(markup).not.toContain("Worked for");
    // Both calls merge into one aggregate summary line.
    expect(markup).toContain("Edited 1 file, ran command");
    expect(markup).toContain("Done.");
  });

  test("reasoning between calls stays one aggregate line that advertises its thought", () => {
    const assistant: UIMessage = {
      id: "assistant-3",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 4_000 } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "first", state: "done" },
        bashPart("c1"),
        { type: "reasoning", text: "second", state: "done" },
        bashPart("c2"),
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // No thought/command ladder: the run is ONE aggregate line…
    expect(markup).toContain("Ran 2 commands");
    // …that counts the thought it carries.
    expect(markup).toContain("1 thought");

    // The turn-opening thought still renders as its own line above the run.
    const openingThought = markup.indexOf("Thought");
    const run = markup.indexOf("Ran 2 commands");
    expect(openingThought).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(openingThought);
  });
});

describe("native connection card in the transcript", () => {
  const stripeStatus = {
    name: "mcp:emc_stripe:*", kind: "connection_status", status: "needs_connection",
    connectionStatus: {
      version: 1, kind: "connection_action", source: "openwork-cloud", connectionId: "emc_stripe", connectionName: "Stripe",
      authType: "oauth", credentialMode: "per_member", state: "needs_connection", actor: "member",
      message: "You haven't connected your Stripe account yet.",
      action: { type: "connect", label: "Connect Stripe", surface: "openwork_your_connections", retry: "search_capabilities" },
    },
  };
  const discovery: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_search_capabilities", toolCallId: "call_stripe_discovery",
    state: "output-available", input: { query: "Stripe weekly revenue growth", type: "mcp", limit: 10 }, output: { matches: [stripeStatus] },
  };
  const stripeAction = {
    schemaVersion: "1", connectionId: "emc_stripe", connectionName: "Stripe", state: "needs_connection", actor: "member",
    message: "Connect Stripe to continue.", action: { type: "connect", label: "Connect Stripe", surface: "openwork_your_connections" },
  };
  const statusProbe: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call_stripe_status",
    state: "output-available", input: { name: "mcp:emc_stripe:*" },
    output: { connectionAction: stripeAction },
  };
  const owner = "account/session";
  const binding = (toolCallId: string): ChatConnectionDecisionBinding => ({
    request: { requestId: "que_stripe", owner, sessionId: "session", turnId: userMessage.id, toolCallId, connectionId: "emc_stripe" },
    isPending: () => true, respond: async () => {},
  });
  const turn = (...parts: DynamicToolUIPart[]): UIMessage[] => [userMessage, { id: "assistant-connection", role: "assistant", parts }];
  const cards = (markup: string) => markup.match(/data-testid="desktop-connection-card"/g)?.length ?? 0;

  test("an execute_capability connection report always renders the native card", () => {
    const markup = renderList(turn(statusProbe));
    expect(cards(markup)).toBe(1);
    expect(markup).toContain("Connect Stripe");
    expect(markup).not.toContain('data-capability-call="openwork-cloud_execute_capability"');
    expect(markup).not.toContain("text-destructive");
  });

  test("ordinary discovery stays a quiet sentence line until the native question binds to it", () => {
    const quiet = renderList(turn(discovery));
    expect(cards(quiet)).toBe(0);
    expect(quiet).toContain('data-capability-call="openwork-cloud_search_capabilities"');
    expect(quiet).toContain("Searched your connections");
    expect(quiet).not.toContain(">Authenticate</button>");

    const otherCall = renderList(turn(discovery), false, { uiStateOwner: owner, getConnectionDecision: id => id === "another-call" ? binding("another-call") : null });
    expect(cards(otherCall)).toBe(0);
    expect(otherCall).toContain('data-capability-call="openwork-cloud_search_capabilities"');

    const bound = renderList(turn(discovery), false, { uiStateOwner: owner, getConnectionDecision: id => id === discovery.toolCallId ? binding(discovery.toolCallId) : null });
    expect(cards(bound)).toBe(1);
    expect(bound).toContain("Connect Stripe to continue");
    expect(bound).toContain(">Skip</button>");
    expect(bound).toContain(">Authenticate</button>");
    expect(bound).not.toContain('data-capability-call="openwork-cloud_search_capabilities"');
    expect(bound).not.toContain("Checking connection request");
  });

  test("a bound discovery card is read-only in history", () => {
    const markup = renderList(turn(discovery), true, { uiStateOwner: owner, getConnectionDecision: id => id === discovery.toolCallId ? binding(discovery.toolCallId) : null });
    expect(cards(markup)).toBe(1);
    const card = /<section data-testid="desktop-connection-card"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
    expect(card).toContain("Connect Stripe");
    expect(card).not.toContain("<button");
  });

  const connectSearch: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_search_capabilities", toolCallId: "call_stripe_connect_search",
    state: "output-available", input: { query: "Stripe", intent: "connect" },
    output: { matches: [stripeStatus], connectionAction: stripeAction },
  };
  const searchLine = 'data-capability-call="openwork-cloud_search_capabilities"';
  const executeLine = 'data-capability-call="openwork-cloud_execute_capability"';

  test("two reports of one connection in a turn render one card on the latest report", () => {
    const markup = renderList(turn(connectSearch, statusProbe));
    expect(cards(markup)).toBe(1);
    // The earlier explicit-connect search stays a quiet sentence line…
    expect(markup).toContain(searchLine);
    expect(markup).toContain("Searched your connections");
    // …and the later status probe hosts the card.
    expect(markup).not.toContain(executeLine);
    expect(markup).toContain("Connect Stripe");
  });

  test("a pending decision bound to the first report pins the card there", () => {
    const markup = renderList(turn(discovery, statusProbe), false, {
      uiStateOwner: owner,
      getConnectionDecision: id => id === discovery.toolCallId ? binding(discovery.toolCallId) : null,
    });
    expect(cards(markup)).toBe(1);
    expect(markup).not.toContain(searchLine);
    expect(markup).toContain(">Authenticate</button>");
    expect(markup).toContain("Connect Stripe to continue");
    // The unbound later report is an ordinary sentence line.
    expect(markup).toContain(executeLine);
  });

  test("two different connections in one turn render two cards", () => {
    const notionProbe: DynamicToolUIPart = {
      ...statusProbe, toolCallId: "call_notion_status", input: { name: "mcp:emc_notion:*" },
      output: { connectionAction: {
        schemaVersion: "1", connectionId: "emc_notion", connectionName: "Notion", state: "needs_connection", actor: "member",
        message: "Connect Notion to continue.", action: { type: "connect", label: "Connect Notion", surface: "openwork_your_connections" },
      } },
    };
    const markup = renderList(turn(statusProbe, notionProbe));
    expect(cards(markup)).toBe(2);
    expect(markup).toContain("Connect Stripe");
    expect(markup).toContain("Connect Notion");
    expect(markup).not.toContain(executeLine);
  });

  test("an answered reserved connection question never renders as a tool row", () => {
    const reservedQuestion: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "question", toolCallId: "call_connection_question", state: "output-available",
      input: { questions: [{
        header: "Connection", question: "Connect Stripe to continue?", multiple: false,
        options: [{ label: "Authenticate", description: "Connect this account to continue." }, { label: "Skip", description: "Continue without this connection." }],
      }] },
      output: "User has answered your questions: \"Connect Stripe to continue?\"=\"Authenticate\". You can now continue with the user's answers in mind.",
    };
    const markup = renderList(turn(statusProbe, reservedQuestion));
    expect(cards(markup)).toBe(1);
    expect(markup).not.toContain("Connection Answered");
    expect(markup).not.toContain("Answered");
    expect(markup).not.toContain("User has answered");
    expect(markup).not.toContain("call_connection_question");

    const ordinaryQuestion: DynamicToolUIPart = {
      ...reservedQuestion, toolCallId: "call_plain_question",
      input: { questions: [{
        header: "Approach", question: "Which approach should I take?", multiple: false,
        options: [{ label: "Fast", description: "Ship now." }, { label: "Careful", description: "Add tests first." }],
      }] },
      output: "User has answered your questions: \"Which approach should I take?\"=\"Careful\".",
    };
    const plain = renderList(turn(ordinaryQuestion));
    expect(plain).toContain("Approach");
    expect(plain).toContain("Answered");
  });

  test("read-only history keeps one card per connection", () => {
    const history = [...turn(connectSearch, statusProbe), { ...userMessage, id: "later-user" }];
    const markup = renderList(history, true);
    expect(cards(markup)).toBe(1);
    expect(markup).toContain(searchLine);
    expect(markup).not.toContain(executeLine);
    const card = /<section data-testid="desktop-connection-card"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
    expect(card).not.toContain("<button");
  });
});
