/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { FieldsResult } from "../src/app/lib/opencode";
import type { NativeSessionOperations, NativeSessionSnapshotTarget } from "../src/app/lib/opencode-session-native";
import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import type { Platform } from "../src/react-app/kernel/platform";

const workspaceId = "workspace-snapshot-owner-flip";
const sessionId = "ses_snapshot_owner_flip";
const v1BaseUrl = "http://127.0.0.1:1/opencode";
const v2BaseUrl = "http://127.0.0.1:1/opencode2";
const transcriptText = "Transcript read from the v2 engine.";

function createSnapshot(): OpenworkSessionSnapshot {
  const messageId = `${sessionId}-user-message`;
  return {
    session: {
      id: sessionId,
      slug: sessionId,
      projectID: "project-snapshot-owner-flip",
      directory: "/tmp/project-snapshot-owner-flip",
      title: "Snapshot owner flip",
      version: "1",
      time: { created: 1, updated: 1 },
    },
    messages: [{
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
      },
      parts: [{
        id: `${messageId}-part`,
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text: transcriptText,
      }],
    }],
    todos: [],
    status: { type: "idle" },
  };
}

function ok<T>(data: T): FieldsResult<T> {
  return { data, request: new Request(v2BaseUrl), response: new Response(null, { status: 200 }) };
}

function notFound(): FieldsResult<never> {
  return {
    error: { code: "session_not_found" },
    request: new Request(v1BaseUrl),
    response: new Response(null, { status: 404 }),
  };
}

const testPlatform: Platform = {
  platform: "desktop",
  capabilities: {
    nativeFilePicker: false,
    revealInFileManager: false,
    terminal: false,
    autoUpdate: false,
    osNotifications: false,
    localRuntimeControl: false,
    desktopBootstrap: false,
  },
  openLink: () => {},
  async restart() {},
  async notify() {},
};

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

// Reload of a v2 session: the surface mounts under the v1 URL before the chat
// routing status resolves, the first owned read 404s on v1 and waits to retry,
// and the routing flip changes the owner while that read is still in flight.
test("a session snapshot read that loses its owner mid-flight is re-read under the new owner", async () => {
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
    { PlatformProvider },
    { ShellConfigProvider },
    sessionNative,
  ] = await Promise.all([
    import("../src/app/lib/openwork-server"),
    import("../src/react-app/domains/connections/cloud-mcp-submit-readiness"),
    import("../src/react-app/domains/session/surface/composer-state-store"),
    import("../src/react-app/infra/query-client"),
    import("../src/react-app/kernel/local-provider"),
    import("../src/react-app/kernel/platform"),
    import("../src/react-app/shell/shell-config"),
    import("../src/app/lib/opencode-session-native"),
  ]);
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  // The owned read with retry is the desktop loopback path.
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", { configurable: true, value: {} });
  document.open();
  document.write("<!doctype html><html><body></body></html>");
  document.close();
  Object.defineProperty(document, "compatMode", { configurable: true, value: "CSS1Compat" });
  const fetchStub = async () => new Response("{}", { headers: { "content-type": "application/json" } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetchStub });
  window.localStorage.setItem("openwork.shell-config", JSON.stringify({ starterCards: false }));

  const readEndpoints: string[] = [];
  const historyWindows: Array<number | undefined> = [];
  let releaseRetry: (() => void) | null = null;
  const snapshot = createSnapshot();
  const operationsFor = (endpoint: { opencodeBaseUrl: string }): NativeSessionOperations => {
    readEndpoints.push(endpoint.opencodeBaseUrl);
    const v2 = endpoint.opencodeBaseUrl === v2BaseUrl;
    return {
      get: async () => (v2 ? ok(snapshot.session) : notFound()),
      messages: async (_sessionId, limit) => {
        historyWindows.push(limit);
        return v2 ? ok(snapshot.messages) : notFound();
      },
      todo: async () => (v2 ? ok(snapshot.todos) : notFound()),
      status: async () => ok({}),
      delete: async () => ok(true),
    };
  };
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  // The empty-session hero and the run-mode menu need the desktop config tree, which this test does not mount.
  const taskSuggestions = await import("../src/components/chat/task-suggestions");
  mock.module("@/components/chat/task-suggestions", () => ({ ...taskSuggestions, TaskSuggestions: () => null }));
  mock.module("../src/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
  // Bind the real implementation first: mocking rewires the loaded module's live bindings.
  const composeWithRetry = sessionNative.composeNativeSessionHistoryWithRetry;
  mock.module("@/app/lib/opencode-session-native", () => ({
    ...sessionNative,
    composeNativeSessionHistoryWithRetry: (
      expectedOwner: string,
      readCurrentTarget: () => NativeSessionSnapshotTarget,
      options: { signal?: AbortSignal },
    ) => composeWithRetry(expectedOwner, readCurrentTarget, options, {
      createOperations: operationsFor,
      // The first (v1) read parks here until the test flips the owner.
      waitForSnapshotRetry: (_delayMs, signal) => new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        releaseRetry = resolve;
      }),
    }),
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  const key = snapshotKey(workspaceId, sessionId);
  const client = createOpenworkServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const surface = (opencodeBaseUrl: string) => (
    <QueryClientProvider client={queryClient}>
      <PlatformProvider value={testPlatform}>
      <LocalProvider>
        <ShellConfigProvider>
          <SessionSurface
            client={client}
            workspaceId={workspaceId}
            workspaceRoot="/tmp/project-snapshot-owner-flip"
            sessionId={sessionId}
            draftScope="local"
            isControlTarget={false}
            opencodeBaseUrl={opencodeBaseUrl}
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
      </PlatformProvider>
    </QueryClientProvider>
  );

  try {
    await act(async () => root.render(surface(v1BaseUrl)));
    await waitFor(() => releaseRetry !== null, "the v1 read to 404 and park before its retry");
    expect(readEndpoints).toEqual([v1BaseUrl]);

    // Routing status resolves: the same session is now owned by /opencode2.
    await act(async () => root.render(surface(v2BaseUrl)));
    await act(async () => { releaseRetry?.(); });

    await waitFor(() => container.textContent?.includes(transcriptText) === true
      && queryClient.getQueryState(key)?.status === "success", "the full transcript read under the v2 owner");
    expect(queryClient.getQueryState(key)?.status).toBe("success");
    expect(queryClient.getQueryState(key)?.error).toBeNull();
    expect(container.textContent).not.toContain("owner changed");
    // The new owner's preview paints before its separate uncapped history read.
    // The abandoned owner must never retry or populate either result.
    expect(readEndpoints).toEqual([v1BaseUrl, v2BaseUrl, v2BaseUrl]);
    expect(historyWindows).toEqual([24, 24, undefined]);
  } finally {
    await act(async () => root.unmount());
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {} });
    queryClient.clear();
    container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
