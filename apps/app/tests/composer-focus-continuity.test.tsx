/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";

const workspaceId = "workspace-focus-continuity";
const sessionId = "session-focus-continuity";

function createSnapshot(status: SessionStatus, updated: number): OpenworkSessionSnapshot {
  return {
    session: {
      id: sessionId,
      slug: sessionId,
      projectID: "project-focus-continuity",
      directory: "/tmp/project-focus-continuity",
      title: "Focus continuity",
      version: "1",
      time: { created: 1, updated },
    },
    messages: [],
    todos: [],
    status,
  };
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("a same-session snapshot swap preserves Lexical focus and draft text", async () => {
  const require = createRequire(import.meta.url);
  // Bun's isolated test loader cycles Lexical's ESM entries; use their real CJS entries before the app imports the editor.
  for (const moduleId of [
    "lexical",
    "@lexical/react/LexicalComposer.js",
    "@lexical/react/LexicalPlainTextPlugin.js",
    "@lexical/react/LexicalContentEditable.js",
    "@lexical/react/LexicalErrorBoundary.js",
    "@lexical/react/LexicalOnChangePlugin.js",
    "@lexical/react/LexicalHistoryPlugin.js",
    "@lexical/react/LexicalComposerContext.js",
  ]) {
    const moduleExports = require(moduleId);
    mock.module(moduleId, () => moduleExports);
  }
  const [
    { createOpenworkServerClient },
    { IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE },
    { useComposerStateStore },
    { getReactQueryClient },
    { LocalProvider },
    { ShellConfigProvider },
  ] = await Promise.all([
    import("../src/app/lib/openwork-server"),
    import("../src/react-app/domains/connections/cloud-mcp-submit-readiness"),
    import("../src/react-app/domains/session/surface/composer-state-store"),
    import("../src/react-app/infra/query-client"),
    import("../src/react-app/kernel/local-provider"),
    import("../src/react-app/shell/shell-config"),
  ]);
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  document.open();
  document.write("<!doctype html><html><body></body></html>");
  document.close();
  Object.defineProperty(document, "compatMode", { configurable: true, value: "CSS1Compat" });
  const fetchStub = async () => new Response("{}", { headers: { "content-type": "application/json" } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetchStub });
  window.localStorage.setItem("openwork.shell-config", JSON.stringify({ starterCards: false }));
  let fetchedSnapshot = createSnapshot({ type: "busy" }, 1);
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async () => fetchedSnapshot,
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey, transcriptKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  queryClient.setQueryData(snapshotKey(workspaceId, sessionId), createSnapshot({ type: "busy" }, 1));
  queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{
    id: "existing-user-message",
    role: "user",
    parts: [{ type: "text", text: "Keep this session mounted." }],
  }]);
  const client = createOpenworkServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const draft = "Keep this draft while the task finishes";

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LocalProvider>
            <ShellConfigProvider>
              <SessionSurface
                client={client}
                workspaceId={workspaceId}
                workspaceRoot="/tmp/project-focus-continuity"
                sessionId={sessionId}
                draftScope="local"
                isControlTarget={false}
                opencodeBaseUrl="http://127.0.0.1:1/opencode"
                openworkToken="test-token"
                developerMode
                modelLabel="Test model"
                onModelClick={() => {}}
                modelPickerOpen={false}
                selectedModel={{ providerID: "test", modelID: "test-model" }}
                onModelPickerOpenChange={() => {}}
                onModelChange={() => {}}
                onSendDraft={async () => ({ outcome: "accepted" })}
                cloudMcpSubmissionState={IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE}
                onOpenConnect={() => {}}
                onDraftChange={() => {}}
                attachmentsEnabled={false}
                attachmentsDisabledReason="Not needed in this test"
                modelVariantLabel="Default"
                modelVariant={null}
                onModelVariantChange={() => {}}
                agentLabel="OpenWork"
                selectedAgent={null}
                listAgents={async () => []}
                onSelectAgent={() => {}}
                listCommands={async () => []}
                recentFiles={[]}
                searchFiles={async () => []}
                isRemoteWorkspace
                isSandboxWorkspace={false}
                providerConnectedCount={1}
              />
            </ShellConfigProvider>
          </LocalProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(
      () => container.querySelector('[contenteditable="true"][data-lexical-editor="true"]') !== null,
      "the Lexical editor",
    );
    await act(async () => {
      useComposerStateStore.getState().setDraft(sessionId, draft);
    });
    await waitFor(
      () => container.querySelector('[data-lexical-editor="true"]')?.textContent === draft,
      "the draft to reach Lexical",
    );
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"]');
    if (!editor) throw new Error("Expected the Lexical editor");
    editor.focus();
    expect(document.activeElement).toBe(editor);

    await act(async () => {
      fetchedSnapshot = createSnapshot({ type: "idle" }, 2);
      queryClient.setQueryData(snapshotKey(workspaceId, sessionId), createSnapshot({ type: "idle" }, 2));
    });
    await waitFor(() => container.textContent?.includes("status: idle") === true, "the refreshed session snapshot");

    expect(container.querySelector('[data-lexical-editor="true"]')).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(editor.textContent).toBe(draft);
  } finally {
    await act(async () => root.unmount());
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {} });
    queryClient.clear();
    container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
