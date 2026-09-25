/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";

const workspaceId = "workspace-composer-identity-recheck";
const sessionId = "session-composer-identity-recheck";
const aliceScope = "cloud:usr_alice:org_ops";
const bobScope = "cloud:usr_bob:org_ops";

function createSnapshot(): OpenworkSessionSnapshot {
  const messageId = `${sessionId}-user-message`;
  return {
    session: {
      id: sessionId,
      slug: sessionId,
      projectID: "project-composer-identity-recheck",
      directory: "/tmp/project-composer-identity-recheck",
      title: "Composer identity recheck",
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
        text: "Earlier message.",
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

test("composer text survives a Cloud identity re-check and still clears across an identity boundary", async () => {
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
    { PlatformProvider, createDefaultPlatform },
    { DenAuthProvider },
    { DesktopConfigProvider },
    { getSessionDraft, SESSION_DRAFT_STORAGE_KEY },
  ] = await Promise.all([
    import("../src/app/lib/openwork-server"),
    import("../src/react-app/domains/connections/cloud-mcp-submit-readiness"),
    import("../src/react-app/domains/session/surface/composer-state-store"),
    import("../src/react-app/infra/query-client"),
    import("../src/react-app/kernel/local-provider"),
    import("../src/react-app/shell/shell-config"),
    import("../src/react-app/kernel/platform"),
    import("../src/react-app/domains/cloud/den-auth-provider"),
    import("../src/react-app/domains/cloud/desktop-config-provider"),
    import("../src/react-app/domains/session/sync/draft-store"),
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
  window.localStorage.removeItem(SESSION_DRAFT_STORAGE_KEY);
  const snapshot = createSnapshot();
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
  const nativeSessionModule = await import("../src/app/lib/opencode-session-native");
  mock.module("@/app/lib/opencode-session-native", () => ({
    ...nativeSessionModule,
    composeNativeSessionHistory: async () => snapshot,
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  queryClient.setQueryData(snapshotKey(workspaceId, sessionId), snapshot);
  const client = createOpenworkServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const platform = createDefaultPlatform();

  const surface = (draftScope: string | null) => (
    <PlatformProvider value={platform}>
    <QueryClientProvider client={queryClient}>
      <DenAuthProvider><DesktopConfigProvider>
      <LocalProvider>
        <ShellConfigProvider>
          <SessionSurface
            client={client}
            workspaceId={workspaceId}
            workspaceRoot="/tmp/project-composer-identity-recheck"
            sessionId={sessionId}
            draftScope={draftScope}
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
      </DesktopConfigProvider></DenAuthProvider>
    </QueryClientProvider>
    </PlatformProvider>
  );
  const editorText = () => container.querySelector('[data-lexical-editor="true"]')?.textContent ?? null;

  try {
    await act(async () => root.render(surface(aliceScope)));
    await waitFor(() => container.querySelector('[contenteditable="true"][data-lexical-editor="true"]') !== null, "the Lexical editor");

    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "typed before the re-check"));
    await waitFor(() => editorText() === "typed before the re-check", "the draft to reach Lexical");
    await waitFor(() => getSessionDraft(aliceScope, workspaceId, sessionId)?.text === "typed before the re-check", "the draft to persist");

    // The verified identity lapses for one round trip: the scope is unresolved
    // but the person is still the same and still typing.
    await act(async () => root.render(surface(null)));
    expect(editorText()).toBe("typed before the re-check");
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "typed before the re-check and during it"));
    await waitFor(() => editorText() === "typed before the re-check and during it", "typing during the re-check to reach Lexical");

    // Identity verified again as the same account and organization.
    await act(async () => root.render(surface(aliceScope)));
    expect(editorText()).toBe("typed before the re-check and during it");
    expect(useComposerStateStore.getState().sessions[sessionId]?.draft).toBe("typed before the re-check and during it");
    await waitFor(
      () => getSessionDraft(aliceScope, workspaceId, sessionId)?.text === "typed before the re-check and during it",
      "the text typed during the re-check to persist once the scope resolves",
    );

    const { startQueuedDraftPersistence } = await import("../src/react-app/domains/session/sync/queued-draft-persistence");
    const { claimQueuedSend, dispatchQueuedDrain } = await import("../src/react-app/domains/session/surface/queued-drain-machine");
    await act(async () => {
      claimQueuedSend(sessionId, "blocked-owner");
      dispatchQueuedDrain(sessionId, { type: "send_error", itemId: "blocked-owner" });
    });
    const stopQueuedPersistence = startQueuedDraftPersistence();
    try {
      await act(async () => useComposerStateStore.getState().appendQueuedDraft(sessionId, {
        mode: "prompt", text: "private queued follow-up", parts: [{ type: "text", text: "private queued follow-up" }], attachments: [],
      }));
      expect(getSessionDraft(aliceScope, workspaceId, sessionId)?.queued).toEqual(["private queued follow-up"]);
      await act(async () => root.render(surface(bobScope)));
      expect(useComposerStateStore.getState().queuedDrafts[sessionId]).toBeUndefined();
      expect(getSessionDraft(aliceScope, workspaceId, sessionId)?.queued).toEqual(["private queued follow-up"]);
      expect(getSessionDraft(bobScope, workspaceId, sessionId)).toBeNull();
    } finally { stopQueuedPersistence(); }
    // A real account boundary still replaces the composer and exposes nothing
    // of the previous person's text.
    await act(async () => root.render(surface(bobScope)));
    await waitFor(() => (editorText() ?? "") === "", "the composer to clear across the identity boundary");
    expect(useComposerStateStore.getState().sessions[sessionId]?.draft ?? "").toBe("");
    expect(getSessionDraft(bobScope, workspaceId, sessionId)).toBeNull();
    expect(getSessionDraft(aliceScope, workspaceId, sessionId)?.text).toBe("typed before the re-check and during it");
  } finally {
    await act(async () => {
      root.unmount();
    });
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {} });
    queryClient.clear();
    container.remove();
    window.localStorage.removeItem(SESSION_DRAFT_STORAGE_KEY);
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
