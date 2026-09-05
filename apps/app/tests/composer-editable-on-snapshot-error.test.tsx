/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";

const workspaceId = "workspace-composer-snapshot-error";
const sessionId = "session-composer-snapshot-error";

function createSnapshot(targetSessionId: string, messageText: string): OpenworkSessionSnapshot {
  const messageId = `${targetSessionId}-user-message`;
  return {
    session: {
      id: targetSessionId,
      slug: targetSessionId,
      projectID: "project-composer-snapshot-error",
      directory: "/tmp/project-composer-snapshot-error",
      title: "Composer snapshot error",
      version: "1",
      time: { created: 1, updated: 1 },
    },
    messages: [{
      info: {
        id: messageId,
        sessionID: targetSessionId,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
      },
      parts: [{
        id: `${messageId}-part`,
        sessionID: targetSessionId,
        messageID: messageId,
        type: "text",
        text: messageText,
      }],
    }],
    todos: [],
    status: { type: "idle" },
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

test("the composer stays editable when snapshot refresh fails or the model is unavailable", async () => {
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
  let rejectSnapshot = false;
  let fetchedSnapshot = createSnapshot(sessionId, "Cached transcript remains visible.");
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async () => {
      if (rejectSnapshot) throw new Error("snapshot refresh failed");
      return fetchedSnapshot;
    },
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  const key = snapshotKey(workspaceId, sessionId);
  queryClient.setQueryDefaults(key, { retryDelay: 0 });
  queryClient.setQueryData(key, fetchedSnapshot);
  const client = createOpenworkServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
  const container = document.createElement("div");
  const unavailableContainer = document.createElement("div");
  document.body.append(container, unavailableContainer);
  const root = createRoot(container);
  const unavailableRoot = createRoot(unavailableContainer);
  let sendCount = 0;

  const surface = (targetSessionId: string, modelUnavailable: boolean) => (
    <QueryClientProvider client={queryClient}>
      <LocalProvider>
        <ShellConfigProvider>
          <SessionSurface
            client={client}
            workspaceId={workspaceId}
            workspaceRoot="/tmp/project-composer-snapshot-error"
            sessionId={targetSessionId}
            draftScope="local"
            isControlTarget={false}
            opencodeBaseUrl="http://127.0.0.1:1/opencode"
            openworkToken="test-token"
            developerMode
            modelLabel="Test model"
            onModelClick={() => {}}
            modelPickerOpen={false}
            selectedModel={{ providerID: "test", modelID: "test-model" }}
            resolveModelAvailability={modelUnavailable ? () => ({ status: "unavailable", reason: "model_missing" }) : undefined}
            onModelPickerOpenChange={() => {}}
            onModelChange={() => {}}
            onSendDraft={async () => {
              sendCount += 1;
              return { outcome: "accepted" };
            }}
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
    </QueryClientProvider>
  );

  try {
    await act(async () => root.render(surface(sessionId, false)));
    await waitFor(() => container.textContent?.includes("Cached transcript remains visible.") === true, "the cached transcript");

    rejectSnapshot = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: key });
    });
    await waitFor(() => queryClient.getQueryState(key)?.status === "error", "the failed snapshot query");
    expect(container.querySelector('[contenteditable="true"][data-lexical-editor="true"]')).not.toBeNull();

    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "still typing"));
    await waitFor(
      () => container.querySelector('[data-lexical-editor="true"]')?.textContent === "still typing",
      "the draft to reach Lexical",
    );
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]')?.disabled).toBe(true);
    expect(sendCount).toBe(0);
    expect(container.textContent).toContain("Cached transcript remains visible.");

    const unavailableSessionId = "session-composer-model-unavailable";
    rejectSnapshot = false;
    fetchedSnapshot = createSnapshot(unavailableSessionId, "Unavailable model transcript.");
    queryClient.setQueryData(snapshotKey(workspaceId, unavailableSessionId), fetchedSnapshot);
    await act(async () => unavailableRoot.render(surface(unavailableSessionId, true)));
    await waitFor(
      () => unavailableContainer.querySelector('[contenteditable="true"][data-lexical-editor="true"]') !== null,
      "the unavailable-model Lexical editor",
    );
    expect(unavailableContainer.querySelector<HTMLButtonElement>('button[aria-label="Run task"]')?.disabled).toBe(true);
  } finally {
    await act(async () => {
      root.unmount();
      unavailableRoot.unmount();
    });
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {} });
    queryClient.clear();
    container.remove();
    unavailableContainer.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
