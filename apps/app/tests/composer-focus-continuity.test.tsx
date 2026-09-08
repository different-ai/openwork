/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import type { ComposerDraft } from "../src/app/types";
import type { CloudMcpSubmissionResult } from "../src/react-app/domains/connections/cloud-mcp-submit-readiness";

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
    messages: [{
      info: {
        id: "existing-user-message", sessionID: sessionId, role: "user", time: { created: 1 },
        agent: "build", model: { providerID: "test", modelID: "test-model" },
      },
      parts: [{ id: "existing-user-part", sessionID: sessionId, messageID: "existing-user-message", type: "text", text: "Keep this session mounted." }],
    }],
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

test("composer focus and optimistic sends preserve drafts through snapshots and first-message handoff", async () => {
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
  let acceptedMessageId: string | null = null;
  const acceptanceRequests: Request[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.includes(`/session/${sessionId}/message/`)) {
      acceptanceRequests.push(request);
      return acceptedMessageId
        ? Response.json({ info: { id: acceptedMessageId, sessionID: sessionId, role: "user" }, parts: [] })
        : new Response(null, { status: 404 });
    }
    return Response.json({});
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetchStub });
  window.localStorage.setItem("openwork.shell-config", JSON.stringify({ starterCards: false }));
  let fetchedSnapshot = createSnapshot({ type: "busy" }, 1);
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async () => fetchedSnapshot,
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey, transcriptKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const { getQueuedDrainState, resetQueuedDrainForTests } = await import("../src/react-app/domains/session/surface/queued-drain-machine");
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
  let submission = Promise.withResolvers<CloudMcpSubmissionResult>();
  const sentDrafts: ComposerDraft[] = [];

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
                onSendDraft={(value) => {
                  sentDrafts.push(value);
                  return submission.promise;
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

    const send = () => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]');
      if (!button || button.disabled) throw new Error(`Expected an enabled send button: ${container.textContent}`);
      button.click();
      button.click();
    };
    await act(async () => send());
    expect(sentDrafts).toHaveLength(1);
    expect(editor.textContent).toBe("");
    expect(container.textContent).toContain(draft);
    expect(useComposerStateStore.getState().sessions[sessionId]).toBeUndefined();

    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "A newer draft"));
    await act(async () => submission.reject(new Error("Submission unavailable")));
    expect(editor.textContent).toBe("A newer draft");
    expect(container.textContent).not.toContain(draft);
    expect(Object.values(useComposerStateStore.getState().failedDrafts).flat().map((item) => item.draft)).toEqual([draft]);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]).toBeUndefined();

    await act(async () => useComposerStateStore.getState().setDraft(sessionId, ""));
    await act(async () => {
      const restore = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore unsent message");
      expect(restore?.disabled).toBe(false);
      restore?.click();
    });
    expect(editor.textContent).toBe(draft);

    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')?.click());
    await act(async () => send());
    await act(async () => submission.resolve({ outcome: "cancelled", reason: "context_changed" }));
    expect(editor.textContent).toBe(draft);

    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    const { markComposerAutoSend } = await import("../src/react-app/domains/session/surface/composer-auto-send");
    await act(async () => {
      markComposerAutoSend(sessionId);
      useComposerStateStore.getState().setDraft(sessionId, "First message auto-send");
    });
    await waitFor(() => sentDrafts.length === 3, "first-message auto-send");
    expect(editor.textContent).toBe("");
    expect(container.textContent).toContain("First message auto-send");
    const messageId = sentDrafts[2]?.messageId;
    expect(messageId).toStartWith("msg_");
    await act(async () => {
      queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{
        id: messageId,
        role: "user",
        parts: [{ type: "text", text: "First message auto-send" }],
      }]);
      submission.resolve({ outcome: "accepted" });
    });
    expect(editor.textContent).toBe("");
    expect(container.textContent?.split("First message auto-send").length).toBe(2);
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(0);

    const { PromptAdmissionUnknownError } = await import("../src/app/lib/opencode");
    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "Uncertain send"));
    await act(async () => send());
    const uncertainId = sentDrafts[3]?.messageId;
    if (!uncertainId) throw new Error("Expected the canonical draft identity");
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()[0]?.draft.messageId).toBe(uncertainId);
    expect(sentDrafts[3]).not.toHaveProperty("messageID");
    expect(editor.textContent).toBe("");
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "Newer uncertain draft"));
    await act(async () => submission.reject(new PromptAdmissionUnknownError({ messageID: uncertainId })));
    expect(editor.textContent).toBe("Newer uncertain draft");
    expect(getQueuedDrainState(sessionId).phase).toMatchObject({ kind: "admission_unknown", messageID: uncertainId });
    expect(Object.values(useComposerStateStore.getState().failedDrafts).flat()).toHaveLength(0);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]).toBeUndefined();
    await act(async () => queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{
      id: "other-identical-prompt", role: "user", parts: [{ type: "text", text: "Uncertain send" }],
    }]));
    await waitFor(() => container.textContent?.split("Uncertain send").length === 3, "the unrelated same-text turn beside the pending bubble");
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(1);
    const checkAcceptance = () => {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Check acceptance");
      if (!button) throw new Error("Expected the read-only acceptance check");
      button.click();
    };
    await act(async () => checkAcceptance());
    expect(getQueuedDrainState(sessionId).phase.kind).toBe("admission_unknown");
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(1);
    acceptedMessageId = uncertainId;
    await act(async () => checkAcceptance());
    expect(getQueuedDrainState(sessionId).phase.kind).toBe("awaiting_observation");
    for (const request of acceptanceRequests) {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe(`/opencode/session/${sessionId}/message/${uncertainId}`);
      expect(new URL(request.url).searchParams.get("directory")).toBe("/tmp/project-focus-continuity");
    }
    expect(acceptanceRequests).toHaveLength(2);
    await act(async () => queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{
      id: uncertainId, role: "user", parts: [{ type: "text", text: "Uncertain send" }],
    }]));
    await waitFor(() => Object.values(useComposerStateStore.getState().pendingMessages).flat().length === 0, "the exact observed turn to replace the pending bubble");
    expect(editor.textContent).toBe("Newer uncertain draft");
    expect(sentDrafts).toHaveLength(4);

    const { NewTaskComposer } = await import("../src/react-app/domains/session/chat/new-task-composer");
    const creation = Promise.withResolvers<void>();
    let creations = 0;
    let updateHeroDraft = (_text: string) => {};
    function Hero() {
      const [text, setText] = useState("First hero message");
      updateHeroDraft = setText;
      return <NewTaskComposer draft={text} onDraftChange={setText} busy={false} context={null} onRunTask={() => {
        creations++;
        return creation.promise;
      }} />;
    }
    await act(async () => root.render(<LocalProvider><ShellConfigProvider><Hero /></ShellConfigProvider></LocalProvider>));
    await act(async () => send());
    expect(creations).toBe(1);
    expect(container.querySelector('[data-lexical-editor="true"]')?.textContent).toBe("");
    expect(container.querySelector('[data-message-role="user"]')?.textContent).toBe("First hero message");
    await act(async () => updateHeroDraft("Newer hero draft"));
    await act(async () => creation.reject(new Error("Session creation failed")));
    expect(container.querySelector('[data-lexical-editor="true"]')?.textContent).toBe("Newer hero draft");
    expect(container.textContent).toContain("Session creation failed");
    await act(async () => updateHeroDraft(""));
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Clear the current draft to restore the unsent message")?.click();
    });
    expect(container.querySelector('[data-lexical-editor="true"]')?.textContent).toBe("First hero message");
    expect(creations).toBe(1);
  } finally {
    await act(async () => root.unmount());
    resetQueuedDrainForTests();
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {}, pendingMessages: {}, failedDrafts: {} });
    queryClient.clear();
    container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
