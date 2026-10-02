/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { BuiltAppPreviewSync } from "../src/react-app/domains/apps/built-app-chat-preview";
import { AppBuilderStep } from "../src/components/chat/app-builder-step";
import {
  appCreationProgress,
  appCreationRuns,
} from "../src/react-app/domains/apps/app-creation-progress";
import { builtAppSummary } from "../src/react-app/domains/apps/built-mcp-app-model";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const appId = `cob_0${"a".repeat(25)}`;
const pluginId = `plg_0${"b".repeat(25)}`;
const client = createOpenworkServerClient({ baseUrl: "http://localhost:8787" });
function builder(
  id: string,
  revision: string,
  toolName = "cloud_create_app",
): DynamicToolUIPart {
  const revisionId = `cov_0${revision.repeat(25)}`;
  const resourceUri = `ui://openwork/apps/${appId}/revisions/${revisionId}/index.html`;
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId: id,
    input: { title: "Order calculator" },
    state: "output-available",
    output: "App ready",
    callProviderMetadata: {
      openwork: {
        mcpResult: {
          content: [{ type: "text", text: "App ready" }],
          structuredContent: {
            app: {
              appId,
              pluginId,
              revisionId,
              title: "Order calculator",
              description: null,
              textFallback: "Calculator",
              resourceUri,
              toolName: "open_app",
              serverPath: `/mcp/agent/connections/${appId}`,
              tools: [],
            },
          },
          _meta: {
            "openwork/mcpApp": {
              connectionId: appId,
              resourceUri,
              toolName: "open_app",
              arguments: { input: {} },
            },
          },
        },
      },
    },
  };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  usePanelTabStore.setState({ sessions: {} });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  await GlobalRegistrator.unregister();
});
async function render(
  parts: DynamicToolUIPart[],
  active: boolean,
  engine: "v1" | "v2" = "v1",
  readOnly = false,
  progress = false,
) {
  const messages: UIMessage[] = [{ id: "assistant", role: "assistant", parts }];
  await act(async () =>
    root.render(
      <MessageListProvider
        client={client}
        mcpAppEngine={engine}
        workspaceId="workspace"
        sessionId="session"
        readOnly={readOnly}
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
        <BuiltAppPreviewSync messages={messages} active={active}>
        {progress ? <AppBuilderStep run={appCreationRuns(messages)[0]} active={active} /> : null}
        </BuiltAppPreviewSync>
      </MessageListProvider>,
    ),
  );
}
test("a finished creation collapses to one line and can reveal its completed steps", async () => {
  await render([builder("create", "1")], false, "v1", false, true);
  const disclosure = container.querySelector<HTMLButtonElement>('[aria-expanded="false"]');
  expect(disclosure?.textContent).toContain("Created “Order calculator”");
  expect(disclosure?.textContent).toContain("4 steps");
  expect(container.querySelector("ol")?.parentElement?.hidden).toBe(true);
  await act(async () => disclosure?.click());
  expect(container.querySelector("ol")?.parentElement?.hidden).toBe(false);
  expect(container.querySelectorAll('[data-step-status="complete"]')).toHaveLength(4);
});
for (const engine of ["v1", "v2"] as const)
  test(`${engine}: a result finishing with the run opens once and an edit updates the same pane`, async () => {
    const created = builder("create", "1");
    await render([], false, engine);
    await render(
      [
        {
          ...created,
          state: "input-available",
          output: undefined,
          callProviderMetadata: undefined,
        },
      ],
      true,
      engine,
    );
    expect(
      usePanelTabStore.getState().sessions.session?.tabs ?? [],
    ).toHaveLength(0);
    await render([created], false, engine);
    expect(usePanelTabStore.getState().sessions.session?.tabs).toHaveLength(1);
    expect(usePanelTabStore.getState().sessions.session?.tabs[0]).toMatchObject(
      {
        type: "mcp-app",
        part: created,
        origin: { engine, workspaceId: "workspace", sessionId: "session" },
      },
    );
    const edited = builder("edit", "2", "cloud_update_app");
    await render([created, edited], true, engine);
    expect(usePanelTabStore.getState().sessions.session?.tabs).toHaveLength(1);
    expect(usePanelTabStore.getState().sessions.session?.tabs[0]).toMatchObject(
      { part: edited },
    );
    usePanelTabStore.getState().closeTab("session", `mcp-app:${appId}`);
    await render([created, edited], false, engine);
    expect(usePanelTabStore.getState().sessions.session?.tabs).toHaveLength(0);
    await render([created, edited], false, engine, false, true);
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes("Open preview"))?.click());
    expect(usePanelTabStore.getState().sessions.session?.tabs).toHaveLength(1);
    expect(usePanelTabStore.getState().sessions.session?.tabs[0]).toMatchObject({ part: edited });
  });
test("opening history and read-only runs do not take over the pane", async () => {
  await render([builder("old", "1")], false);
  expect(usePanelTabStore.getState().sessions.session?.tabs ?? []).toHaveLength(
    0,
  );
  await render([builder("old", "1"), builder("new", "2")], true, "v1", true);
  expect(usePanelTabStore.getState().sessions.session?.tabs ?? []).toHaveLength(
    0,
  );
});
test("failed and mismatched MCP results cannot open an App", () => {
  const part = builder("failed", "1");
  expect(builtAppSummary(part)).not.toBeNull();
  expect(
    builtAppSummary({ ...part, toolName: "cloud_execute_capability" }),
  ).toBeNull();
  expect(
    builtAppSummary({ ...part, state: "output-error", errorText: "failed" }),
  ).toBeNull();
  const result = part.callProviderMetadata?.openwork?.mcpResult;
  expect(
    builtAppSummary({
      ...part,
      callProviderMetadata: {
        openwork: { mcpResult: { ...result, isError: true } },
      },
    }),
  ).toBeNull();
  expect(
    builtAppSummary({
      ...part,
      callProviderMetadata: {
        openwork: {
          mcpResult: {
            ...result,
            structuredContent: { app: { appId: "wrong" } },
          },
        },
      },
    }),
  ).toBeNull();
});

test("only a successful matching launch completes the creation rail", () => {
  const part = builder("create-ready", "1");
  const [run] = appCreationRuns([
    { id: "assistant", role: "assistant", parts: [part] },
  ]);
  expect(appCreationProgress(run, false)).toMatchObject({
    stage: "ready",
    running: false,
    app: { appId },
  });
});
