/** @jsxImportSource react */
import { expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import {
  appCreationProgress,
  appCreationRuns,
  appPreparation,
} from "../src/react-app/domains/apps/app-creation-progress";
import { AppBuilderStep } from "../src/components/chat/app-builder-step";
import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "../src/react-app/kernel/platform";

const preparationId = "00000000-0000-4000-8000-000000000001";
const prepared = {
  preparationId,
  title: "Bug dashboard",
  tools: [],
  starter: {
    reactSource: "export default function App() { return <main/> }",
    cssSource: "",
  },
  nextSteps: ["Write, check, and open."],
};
function prepare(
  state: DynamicToolUIPart["state"] = "output-available",
): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolCallId: "prepare",
    toolName: "cloud_prepare_app",
    state,
    input: { title: prepared.title },
    output: JSON.stringify(prepared),
  };
}
function build(
  state: DynamicToolUIPart["state"],
  id = "build",
): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolCallId: id,
    toolName: "cloud_create_app",
    state,
    input: { preparationId, title: prepared.title },
    errorText: state === "output-error" ? "Source invalid" : undefined,
  };
}
function runs(parts: DynamicToolUIPart[]) {
  return appCreationRuns([{ id: "assistant", role: "assistant", parts }]);
}
function provider(children: React.ReactNode, syncDegraded = false) {
  return (
    <PlatformProvider value={createDefaultPlatform()}>
      <MessageListProvider
        syncDegraded={syncDegraded}
        workspaceId="ws"
        sessionId="session"
        showThinking
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
        {children}
      </MessageListProvider>
    </PlatformProvider>
  );
}

test("progress follows preparation, streamed source, checking, failure, and actual launch", () => {
  expect(
    appCreationProgress(runs([prepare("input-available")])[0], true),
  ).toMatchObject({ stage: "needs", prepared: false, running: true });
  expect(appCreationProgress(runs([prepare()])[0], true)).toMatchObject({
    stage: "writing",
    prepared: true,
    running: true,
  });
  expect(
    appCreationProgress(runs([prepare(), build("input-streaming")])[0], true),
  ).toMatchObject({ stage: "writing", running: true });
  expect(
    appCreationProgress(runs([prepare(), build("input-available")])[0], true),
  ).toMatchObject({ stage: "checking", running: true });
  expect(
    appCreationProgress(runs([prepare(), build("output-error")])[0], true),
  ).toMatchObject({
    stage: "checking",
    failed: true,
    running: false,
    app: null,
  });
  // A declared output without a matching, verified MCP launch must never say ready.
  expect(
    appCreationProgress(runs([prepare(), build("output-available")])[0], true),
  ).toMatchObject({ unavailable: true, running: false, app: null });
});

test("a paused run has no active dots; retries share a rail and unrelated preparations do not", () => {
  const retry = runs([
    prepare(),
    build("output-error"),
    build("input-available", "retry"),
  ]);
  expect(retry).toHaveLength(1);
  expect(retry[0].builds).toHaveLength(2);
  expect(appCreationProgress(retry[0], true)).toMatchObject({
    stage: "checking",
    failed: false,
    running: true,
  });
  const markup = renderToStaticMarkup(
    provider(<AppBuilderStep run={retry[0]} active={false} />),
  );
  expect(markup).toContain("Paused");
  expect(markup).not.toContain('data-step-status="running"');
  expect(markup).not.toContain('data-step-status="failed"');
  const other = {
    ...build("input-available", "other"),
    input: { preparationId: "00000000-0000-4000-8000-000000000002" },
  };
  expect(runs([prepare(), other])).toHaveLength(2);
  expect(runs([prepare(), build("input-streaming")])).toHaveLength(1);
  expect(
    runs([
      prepare(),
      { ...build("input-streaming"), input: { preparationId: "00000000" } },
    ]),
  ).toHaveLength(1);
});

test("the transcript has one visible creation rail with genuine writing and checking states", () => {
  const parts = [prepare(), build("input-available")];
  const markup = renderToStaticMarkup(
    provider(
      <MessageList
        messages={[
          {
            id: "user",
            role: "user",
            parts: [{ type: "text", text: "Build a dashboard" }],
          },
          { id: "assistant", role: "assistant", parts },
        ]}
        status="streaming"
        activityStatus="thinking"
      />,
    ),
  );
  expect(markup.split("data-app-builder-step").length - 1).toBe(1);
  expect(markup).toContain('data-app-creation-stage="checking"');
  expect(markup).toContain(
    'data-app-creation-step="needs" data-step-status="complete"',
  );
  expect(markup).toContain(
    'data-app-creation-step="writing" data-step-status="complete"',
  );
  expect(markup).toContain(
    'data-app-creation-step="checking" data-step-status="running"',
  );
  expect(markup).toContain(
    'data-app-creation-step="ready" data-step-status="pending"',
  );
});

test("both engine projections preserve preparation and recorded build timing", () => {
  expect(appPreparation(prepare())?.preparationId).toBe(preparationId);
  const part = parseDynamicToolUIPart({
    id: "engine-prepare",
    callID: "prepare",
    type: "tool",
    tool: "cloud_prepare_app",
    sessionID: "session",
    messageID: "assistant",
    state: {
      status: "completed",
      input: { title: prepared.title },
      output: JSON.stringify(prepared),
      title: "Prepare",
      metadata: {
        openworkMcpResult: { content: [], structuredContent: prepared },
      },
      time: { start: 1_000, end: 2_000 },
    },
  });
  expect(part?.callProviderMetadata?.openwork).toMatchObject({
    toolStartedAt: 1_000,
    toolCompletedAt: 2_000,
  });
  expect(part ? appPreparation(part)?.preparationId : null).toBe(preparationId);
  const source = {
    title: prepared.title,
    preparationId,
    reactSource: prepared.starter.reactSource,
  };
  const native = {
    id: "engine-build",
    callID: "build",
    type: "tool",
    tool: "cloud_create_app",
    sessionID: "session",
    messageID: "assistant",
  } satisfies Pick<
    Parameters<typeof parseDynamicToolUIPart>[0],
    "id" | "callID" | "type" | "tool" | "sessionID" | "messageID"
  >;
  expect(
    parseDynamicToolUIPart({
      ...native,
      state: { status: "pending", input: source, raw: "" },
    })?.state,
  ).toBe("input-streaming");
  expect(
    parseDynamicToolUIPart({
      ...native,
      state: {
        status: "running",
        input: source,
        title: "Create",
        metadata: {},
        time: { start: 2_000 },
      },
    })?.state,
  ).toBe("input-available");
  const legacy = runs([build("input-available")])[0];
  expect(appCreationProgress(legacy, true).prepared).toBe(false);
});

test("degraded sync does not claim that creation is still running", () => {
  const markup = renderToStaticMarkup(
    provider(
      <AppBuilderStep
        run={runs([prepare(), build("input-available")])[0]}
        active
      />,
      true,
    ),
  );
  expect(markup).toContain("Reconnecting");
  expect(markup).not.toContain('data-step-status="running"');
});


test("an explicit App request shows actual discovery before preparation and keeps one rail", () => {
  const search: DynamicToolUIPart = { type: "dynamic-tool", toolCallId: "search", toolName: "openwork-cloud_search_capabilities", state: "input-available", input: { query: "Inventory lookup unit price" } };
  const message = { id: "assistant", role: "assistant" as const, parts: [search] };
  expect(appCreationRuns([message])).toHaveLength(0);
  const discovered = appCreationRuns([message], true);
  expect(discovered).toHaveLength(1);
  expect(appCreationProgress(discovered[0], true)).toMatchObject({ stage: "needs", prepared: false, running: true });
  const markup = renderToStaticMarkup(provider(<AppBuilderStep run={discovered[0]} active />));
  expect(markup).toContain("Finding what it needs");
  expect(markup).toContain("Inventory lookup unit price");
  const readyToWrite = appCreationRuns([{ ...message, parts: [search, prepare()] }], true);
  expect(readyToWrite).toHaveLength(1);
  expect(readyToWrite[0].id).toBe("search");
  expect(appCreationProgress(readyToWrite[0], true).stage).toBe("writing");
});
