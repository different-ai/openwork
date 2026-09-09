/** @jsxImportSource react */
import { expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import type { ComposerAttachment, ComposerDraft } from "../src/app/types";
import type { CloudMcpSubmissionResult } from "../src/react-app/domains/connections/cloud-mcp-submit-readiness";
import type {
  NewTaskComposerContext,
  NewTaskComposerHandoff,
} from "../src/react-app/domains/session/chat/new-task-composer";

const workspaceId = "workspace-focus-continuity";
const sessionId = "session-focus-continuity";

function createSnapshot(status: SessionStatus, updated: number, id = sessionId): OpenworkSessionSnapshot {
  return {
    session: {
      id,
      slug: id,
      projectID: "project-focus-continuity",
      directory: "/tmp/project-focus-continuity",
      title: "Focus continuity",
      version: "1",
      time: { created: 1, updated },
    },
    messages: [{
      info: {
        id: "existing-user-message", sessionID: id, role: "user", time: { created: 1 },
        agent: "build", model: { providerID: "test", modelID: "test-model" },
      },
      parts: [{ id: "existing-user-part", sessionID: id, messageID: "existing-user-message", type: "text", text: "Keep this session mounted." }],
    }],
    todos: [],
    status,
  };
}

function newTaskComposerContext(draftOwnerKey: string): NewTaskComposerContext {
  return {
    client: null,
    workspaceId: null,
    draftOwnerKey,
    selectedModel: { providerID: "test", modelID: "test-model" },
    modelPickerOpen: false,
    onModelPickerOpenChange: () => {},
    onModelChange: () => {},
    modelVariantLabel: "Default",
    modelVariant: null,
    onModelVariantChange: () => {},
    agentLabel: "OpenWork",
    selectedAgent: null,
    listAgents: async () => [],
    onSelectAgent: () => {},
    listCommands: async () => [],
    searchFiles: async () => [],
    isRemoteWorkspace: false,
    isSandboxWorkspace: false,
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

test("composer focus, pending stops, and optimistic sends preserve drafts through snapshots and first-message handoff", async () => {
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
  const nativePromptTexts: string[] = [];
  const nativeMessages: { id: string; role: "user"; text: string }[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === `/opencode2/api/session/${sessionId}/prompt`) {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") throw new Error("Expected a native text prompt");
      nativePromptTexts.push(body.text);
      return new Response(null, { status: 204 });
    }
    if (path === `/opencode2/api/session/${sessionId}/message`) return Response.json({ data: nativeMessages });
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
  const otherSessionId = `${sessionId}-other`;
  const otherSnapshot = createSnapshot({ type: "busy" }, 1, otherSessionId);
  const interruptionModule = await import("../src/app/lib/opencode-interruption");
  let interruption = Promise.withResolvers<void>();
  const interrupt = mock((..._args: Parameters<typeof interruptionModule.interruptSessionTurn>) => interruption.promise);
  mock.module("@/app/lib/opencode-interruption", () => ({
    ...interruptionModule,
    interruptSessionTurn: interrupt,
  }));
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async (_target: unknown, id: string) => id === otherSessionId ? otherSnapshot : fetchedSnapshot,
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
  let prepareSubmission: ((text?: string) => void) | undefined;
  const revokePreview = spyOn(URL, "revokeObjectURL");

  const renderSurface = (opencodeBaseUrl = "http://127.0.0.1:1/opencode", activeSessionId = sessionId) => root.render(
        <QueryClientProvider client={queryClient}>
          <LocalProvider>
            <ShellConfigProvider>
              <SessionSurface
                client={client}
                workspaceId={workspaceId}
                workspaceRoot="/tmp/project-focus-continuity"
                sessionId={activeSessionId}
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
                onSendDraft={(value, _sessionId, onPrepared) => {
                  sentDrafts.push(value);
                  prepareSubmission = onPrepared;
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
  const renderSession = (activeSessionId = sessionId) => renderSurface(undefined, activeSessionId);
  try {
    await act(async () => renderSurface());
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

    // Hold both async boundaries: idle alone must not release Stop's feedback.
    let snapshotRefresh = Promise.withResolvers<void>();
    const refetch = spyOn(queryClient, "refetchQueries").mockImplementation(() => snapshotRefresh.promise);
    const stop = () => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
      if (!button || button.disabled) throw new Error("Expected an enabled Stop button");
      button.click();
      button.click();
    };
    const expectStopping = () => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Stopping…"]');
      expect(button?.disabled).toBe(true);
      expect(button?.getAttribute("aria-busy")).toBe("true");
      expect(button?.querySelector("svg.lucide-loader-circle.animate-spin")).not.toBeNull();
      expect(container.querySelector('button[aria-label="Run task"]')).toBeNull();
      expect(container.querySelector('[data-lexical-editor="true"]')?.getAttribute("contenteditable")).toBe("true");
    };
    const escape = () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await act(async () => stop());
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt.mock.calls[0]).toEqual([
      "http://127.0.0.1:1/opencode", expect.anything(), sessionId, "/tmp/project-focus-continuity",
      { admissionUnknown: false, onStopped: expect.any(Function) },
    ]);
    expectStopping();
    await act(async () => { escape(); });
    await act(async () => { escape(); });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
    await act(async () => {
      fetchedSnapshot = createSnapshot({ type: "idle" }, 2);
      queryClient.setQueryData(snapshotKey(workspaceId, sessionId), fetchedSnapshot);
    });
    await waitFor(() => container.textContent?.includes("status: idle") === true, "idle while Stop is pending");
    expectStopping();
    await act(async () => interruption.resolve());
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenLastCalledWith({ queryKey: snapshotKey(workspaceId, sessionId), exact: true });
    expectStopping();
    expect(container.querySelector('[data-lexical-editor="true"]')).toBe(editor);
    expect(editor.textContent).toBe(draft);
    await act(async () => snapshotRefresh.resolve());
    expect(container.querySelector('button[aria-label="Stopping…"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]')?.disabled).toBe(false);
    expect(container.querySelector('button[aria-busy="true"]')).toBeNull();

    await act(async () => {
      fetchedSnapshot = createSnapshot({ type: "busy" }, 3);
      queryClient.setQueryData(snapshotKey(workspaceId, sessionId), fetchedSnapshot);
    });
    await waitFor(() => container.querySelector('button[aria-label="Stop"]') !== null, "Stop on the next busy turn");
    interruption = Promise.withResolvers<void>();
    await act(async () => stop());
    expect(interrupt).toHaveBeenCalledTimes(2);
    await act(async () => { escape(); });
    await act(async () => interruption.reject(new Error("Stop unavailable")));
    expect(container.textContent).toContain("Stop unavailable");
    expect(container.textContent).not.toContain("Hit Escape again to stop the agent");
    expect(container.querySelector('button[aria-label="Stopping…"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')?.disabled).toBe(false);
    expect(refetch).toHaveBeenCalledTimes(1);
    interruption = Promise.withResolvers<void>();
    await act(async () => { escape(); });
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Hit Escape again to stop the agent");
    await act(async () => { escape(); });
    expect(interrupt).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain("Stop unavailable");
    expectStopping();

    // Re-render without a key so pending owners share the same mounted surface.
    const originalInterruption = interruption;
    snapshotRefresh = Promise.withResolvers<void>();
    await act(async () => {
      queryClient.setQueryData(snapshotKey(workspaceId, otherSessionId), otherSnapshot);
      renderSession(otherSessionId);
    });
    // Seed after first-render hydration, just as for the original session.
    await act(async () => useComposerStateStore.getState().setDraft(otherSessionId, "Other session draft"));
    await waitFor(
      () => container.querySelector('[data-lexical-editor="true"]')?.textContent === "Other session draft",
      "the other session draft to reach Lexical",
    );
    expect(container.querySelector('button[aria-label="Stopping…"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')?.disabled).toBe(false);
    interruption = Promise.withResolvers<void>();
    await act(async () => stop());
    expect(interrupt).toHaveBeenCalledTimes(4);
    expect(interrupt.mock.calls[3]?.[2]).toBe(otherSessionId);
    expectStopping();
    await act(async () => originalInterruption.resolve());
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(refetch).toHaveBeenLastCalledWith({ queryKey: snapshotKey(workspaceId, sessionId), exact: true });
    expectStopping();
    await act(async () => renderSession());
    expectStopping();
    await act(async () => snapshotRefresh.resolve());
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')?.disabled).toBe(false);
    await act(async () => renderSession(otherSessionId));
    expectStopping();
    expect(container.querySelector('[data-lexical-editor="true"]')?.textContent).toBe("Other session draft");
    await act(async () => interruption.reject(new Error("Other session Stop unavailable")));
    expect(container.textContent).toContain("Other session Stop unavailable");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')?.disabled).toBe(false);
    await act(async () => renderSession());
    expect(container.textContent).not.toContain("Other session Stop unavailable");
    expect(container.querySelector('[data-lexical-editor="true"]')).toBe(editor);
    expect(editor.textContent).toBe(draft);
    expect(refetch).toHaveBeenCalledTimes(2);
    refetch.mockRestore();
    editor.focus();

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
    const attachment: ComposerAttachment = { id: "image-ready", name: "photo.png", mimeType: "image/png", size: 3, kind: "image",
      file: new File(["png"], "photo.png", { type: "image/png" }), previewUrl: URL.createObjectURL(new Blob(["png"], { type: "image/png" })) };
    await act(async () => {
      useComposerStateStore.getState().setAttachments(sessionId, [attachment]);
      useComposerStateStore.getState().setDraft(sessionId, "[attachment image-ready]");
    });
    await act(async () => send());
    expect(sentDrafts).toHaveLength(1);
    expect(editor.textContent).toBe("");
    expect(useComposerStateStore.getState().sessions[sessionId]).toBeUndefined();
    expect(container.querySelector("[data-attachment-id]")).toBeNull();
    expect(container.querySelector('[data-message-role="user"] img[alt="photo.png"]')?.getAttribute("src")).toBe(attachment.previewUrl);
    expect(container.querySelector('[data-attachment-status="uploading"]')).not.toBeNull();
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(1);
    expect(revokePreview).not.toHaveBeenCalledWith(attachment.previewUrl);
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(sentDrafts).toHaveLength(1);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]).toBeUndefined();
    await act(async () => submission.reject(new Error("Image preparation failed")));
    expect(useComposerStateStore.getState().sessions[sessionId]?.draft).toBe("[attachment image-ready]");
    expect(useComposerStateStore.getState().sessions[sessionId]?.attachments).toEqual([attachment]);
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(0);
    expect(Object.values(useComposerStateStore.getState().failedDrafts).flat()).toHaveLength(0);
    expect(revokePreview).not.toHaveBeenCalledWith(attachment.previewUrl);

    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')?.click());
    await act(async () => send());
    expect(prepareSubmission).toBeFunction();
    await act(async () => prepareSubmission?.());
    expect(editor.textContent).toBe("");
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(1);
    await act(async () => submission.resolve({ outcome: "cancelled", reason: "context_changed" }));
    expect(useComposerStateStore.getState().sessions[sessionId]?.draft).toBe("[attachment image-ready]");
    expect(useComposerStateStore.getState().sessions[sessionId]?.attachments).toEqual([attachment]);

    // A message-created or text-only acknowledgement must not take the preview away.
    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    await act(async () => send());
    const imageMessageId = sentDrafts[2]?.messageId;
    if (!imageMessageId) throw new Error("Expected an image-only message identity");
    await act(async () => {
      prepareSubmission?.();
      submission.resolve({ outcome: "accepted" });
      queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{ id: imageMessageId, role: "user", parts: [] }]);
    });
    const imageRows = () => container.querySelectorAll(`[data-message-id="${imageMessageId}"]`);
    await waitFor(() => Object.values(useComposerStateStore.getState().pendingMessages).flat()
      .some((item) => item.serverMessageId === imageMessageId), "the message-created acknowledgement to reconcile");
    expect(imageRows()).toHaveLength(1);
    expect(imageRows()[0]?.querySelector('img[alt="photo.png"]')?.getAttribute("src")).toBe(attachment.previewUrl);
    expect(revokePreview).not.toHaveBeenCalledWith(attachment.previewUrl);
    await act(async () => queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{
      id: imageMessageId, role: "user", parts: [{ type: "text", text: "Image acknowledged" }],
    }]));
    await waitFor(() => imageRows()[0]?.textContent?.includes("Image acknowledged") === true, "the text-only acknowledgement to render");
    expect(imageRows()).toHaveLength(1);
    expect(imageRows()[0]?.querySelector('img[alt="photo.png"]')?.getAttribute("src")).toBe(attachment.previewUrl);
    expect(revokePreview).not.toHaveBeenCalledWith(attachment.previewUrl);
    await act(async () => queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{
      id: imageMessageId, role: "user", parts: [
        { type: "text", text: "Image path acknowledged" },
        { type: "file", filename: "photo.png", mediaType: "image/png", url: "file:///tmp/photo.png" },
      ],
    }]));
    await waitFor(() => imageRows()[0]?.textContent?.includes("Image path acknowledged") === true, "the unusable image path acknowledgement to render");
    expect(imageRows()[0]?.querySelectorAll("img")).toHaveLength(1);
    expect(imageRows()[0]?.querySelector("img")?.getAttribute("src")).toBe(attachment.previewUrl);
    expect(revokePreview).not.toHaveBeenCalledWith(attachment.previewUrl);
    const serverImageUrl = "data:image/jpeg;base64,cG5n";
    await act(async () => queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{
      id: imageMessageId, role: "user", parts: [{ type: "file", filename: "photo.jpg", mediaType: "image/jpeg", url: serverImageUrl }],
    }]));
    await waitFor(() => imageRows()[0]?.querySelector("img")?.getAttribute("src") === serverImageUrl, "the server image to replace the local preview");
    expect(imageRows()).toHaveLength(1);
    expect(imageRows()[0]?.querySelector("img")?.getAttribute("src")).toBe(serverImageUrl);
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(0);
    expect(revokePreview).toHaveBeenCalledWith(attachment.previewUrl);
    expect(sentDrafts).toHaveLength(3);
    await act(async () => {
      useComposerStateStore.getState().setAttachments(sessionId, []);
      useComposerStateStore.getState().setDraft(sessionId, draft);
    });
    sentDrafts.length = 0;
    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
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
    const restoredRun = container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]');
    expect(container.textContent).toContain("Submission unavailable");
    expect(restoredRun?.disabled).toBe(false);
    expect(sentDrafts).toHaveLength(1);
    expect(editor.textContent).toBe(draft);

    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')?.click());
    await act(async () => send());
    await act(async () => submission.resolve({ outcome: "cancelled", reason: "context_changed" }));
    expect(editor.textContent).toBe(draft);

    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    const { composerAutoSendScopeKey, markComposerAutoSend } = await import("../src/react-app/domains/session/surface/composer-auto-send");
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

    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    const scopedFile = new File(["scoped image"], "scoped.png", { type: "image/png" });
    const scopedAttachment: ComposerAttachment = {
      id: "scoped-image",
      name: "scoped.png",
      mimeType: "image/png",
      size: scopedFile.size,
      kind: "image",
      file: scopedFile,
      previewUrl: URL.createObjectURL(scopedFile),
    };
    const submittedComposer = {
      draft: "First [pasted text handoff][attachment scoped-image]",
      attachments: [scopedAttachment],
      mentions: {},
      pasteParts: [{ id: "submitted-paste", label: "handoff", text: "submitted body", lines: 1 }],
      revertMessageId: null,
    };
    const continuationFile = new File(["newer image"], "continuation.png", { type: "image/png" });
    const continuationAttachment: ComposerAttachment = { ...scopedAttachment, id: "continuation-image", name: continuationFile.name,
      file: continuationFile, previewUrl: URL.createObjectURL(continuationFile) };
    const continuationComposer = {
      draft: "Continuation B[attachment continuation-image]",
      attachments: [continuationAttachment],
      mentions: {},
      pasteParts: [{ id: "continuation-paste", label: "handoff", text: "wrong continuation metadata", lines: 1 }],
      revertMessageId: null,
    };
    await act(async () => {
      markComposerAutoSend(sessionId, {
        scopeKey: composerAutoSendScopeKey({
          draftScope: "local",
          opencodeBaseUrl: "http://127.0.0.1:1/opencode",
          workspaceId,
          sessionId,
        }),
        composer: submittedComposer,
      });
      useComposerStateStore.setState((state) => ({
        sessions: { ...state.sessions, [sessionId]: continuationComposer },
      }));
    });
    await waitFor(() => sentDrafts.length === 5, "scoped first-message auto-send");
    expect(sentDrafts[4]?.resolvedText).toBe("First submitted body");
    expect(editor.textContent).toContain("Continuation B");
    expect(useComposerStateStore.getState().sessions[sessionId]).toBe(continuationComposer);
    const scopedPendingRows = () => [...container.querySelectorAll('[data-message-role="user"]')]
      .filter((row) => row.textContent?.includes("First submitted body"));
    expect(scopedPendingRows()).toHaveLength(1);
    expect(scopedPendingRows()[0]?.querySelector('img[alt="scoped.png"]')?.getAttribute("src")).toBe(scopedAttachment.previewUrl);
    expect(editor.querySelector('[data-attachment-status="uploading"]')).toBeNull();
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(1);
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "Continuation B before preparation[attachment continuation-image]"));
    expect(editor.textContent).toContain("Continuation B before preparation");
    const continuationBeforePreparation = useComposerStateStore.getState().sessions[sessionId];
    expect(prepareSubmission).toBeFunction();
    await act(async () => prepareSubmission?.());
    expect(useComposerStateStore.getState().sessions[sessionId]).toBe(continuationBeforePreparation);
    expect(scopedPendingRows()).toHaveLength(1);
    expect(Object.values(useComposerStateStore.getState().pendingMessages).flat()).toHaveLength(1);
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "Continuation B after preparation[attachment continuation-image]"));
    expect(editor.textContent).toContain("Continuation B after preparation");
    const continuationAfterPreparation = useComposerStateStore.getState().sessions[sessionId];
    await act(async () => submission.reject(new Error("Scoped submission unavailable")));
    expect(editor.textContent).toContain("Continuation B after preparation");
    expect(useComposerStateStore.getState().sessions[sessionId]).toBe(continuationAfterPreparation);
    expect(continuationAfterPreparation?.attachments).toEqual([continuationAttachment]);
    expect(revokePreview).not.toHaveBeenCalledWith(scopedAttachment.previewUrl);
    expect(revokePreview).not.toHaveBeenCalledWith(continuationAttachment.previewUrl);
    expect(Object.values(useComposerStateStore.getState().failedDrafts).flat().map((item) => item.draft)).toEqual([
      "First [pasted text handoff][attachment scoped-image]",
    ]);
    expect(Object.values(useComposerStateStore.getState().failedDrafts).flat()[0]?.attachments[0]?.file).toBe(scopedFile);
    await act(async () => {
      useComposerStateStore.getState().setDraft(sessionId, "");
      useComposerStateStore.getState().setAttachments(sessionId, []);
    });
    await act(async () => {
      const restore = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore unsent message");
      expect(restore?.disabled).toBe(false);
      restore?.click();
    });
    expect(useComposerStateStore.getState().sessions[sessionId]?.attachments[0]?.file).toBe(scopedFile);

    // The unchanged hero now hands off an empty continuation, not its submitted chips.
    submission = Promise.withResolvers<CloudMcpSubmissionResult>();
    await act(async () => {
      markComposerAutoSend(sessionId, {
        scopeKey: composerAutoSendScopeKey({ draftScope: "local", opencodeBaseUrl: "http://127.0.0.1:1/opencode", workspaceId, sessionId }),
        composer: submittedComposer,
      });
      useComposerStateStore.getState().clearSession(sessionId);
    });
    await waitFor(() => sentDrafts.length === 6, "unchanged hero attachment handoff");
    expect(editor.textContent).toBe("");
    expect(container.querySelector("[data-attachment-id]")).toBeNull();
    expect(scopedPendingRows()).toHaveLength(1);
    await act(async () => prepareSubmission?.());
    expect(useComposerStateStore.getState().sessions[sessionId]).toBeUndefined();
    await act(async () => submission.reject(new Error("Unchanged hero submission failed")));
    expect(useComposerStateStore.getState().sessions[sessionId]?.attachments[0]?.file).toBe(scopedFile);
    expect(useComposerStateStore.getState().sessions[sessionId]?.draft).toBe(submittedComposer.draft);
    expect(Object.values(useComposerStateStore.getState().failedDrafts).flat()).toHaveLength(0);
    expect(revokePreview).not.toHaveBeenCalledWith(scopedAttachment.previewUrl);

    // Native v2 returns admission without an ID and normalizes user turns to text only.
    const { createClientV2, v2PromptText } = await import("../src/app/lib/opencode-v2-adapter");
    const { draftToParts } = await import("../src/react-app/domains/session/sync/draft-parts");
    const { snapshotToUIMessages } = await import("../src/react-app/domains/session/sync/usechat-adapter");
    const nativeBaseUrl = "http://127.0.0.1:1/opencode2";
    const nativeClient = createClientV2(nativeBaseUrl, "/tmp/project-focus-continuity", {});
    const nativeOwner = composerAutoSendScopeKey({ draftScope: "local", opencodeBaseUrl: nativeBaseUrl, workspaceId, sessionId });
    const nativePending = () => useComposerStateStore.getState().pendingMessages[nativeOwner] ?? [];
    const nativeRow = (id: string) => container.querySelector(`[data-message-id="${id}"]`);
    const refreshNativeTranscript = async () => {
      const result = await nativeClient.session.messages({ sessionID: sessionId });
      if (result.error || !result.data) throw new Error("Expected native transcript data");
      expect(result.data.every((message) => message.parts.every((part) => part.type === "text"))).toBe(true);
      const nativeSnapshot: OpenworkSessionSnapshot = {
        ...createSnapshot({ type: "idle" }, 10),
        messages: result.data.map(({ info, parts }) => ({
          info: { id: info.id, sessionID: info.sessionID, role: "user", time: info.time,
            agent: "build", model: { providerID: "test", modelID: "test-model" } },
          parts,
        })),
      };
      await act(async () => queryClient.setQueryData(transcriptKey(workspaceId, sessionId), snapshotToUIMessages(nativeSnapshot)));
    };
    nativeMessages.push({ id: "native-historical", role: "user", text: "Historical attachment" });
    await refreshNativeTranscript();
    await act(async () => {
      useComposerStateStore.getState().clearSession(sessionId);
      renderSurface(nativeBaseUrl);
    });
    await waitFor(() => nativeRow("native-historical") !== null, "the native history before attachment sends");
    const nativeAttachments = ["first", "second"].map((id): ComposerAttachment => {
      const file = new File([id], "native:photo?.png", { type: "image/jpeg" });
      return { id, name: file.name, mimeType: file.type, size: file.size, kind: "image", file, previewUrl: URL.createObjectURL(file) };
    });
    const uploadedPaths: string[] = [];
    const nativeDrafts: ComposerDraft[] = [];
    for (const attachment of nativeAttachments) {
      submission = Promise.withResolvers<CloudMcpSubmissionResult>();
      await act(async () => {
        useComposerStateStore.getState().setAttachments(sessionId, [attachment]);
        useComposerStateStore.getState().setDraft(sessionId, `[attachment ${attachment.id}]`);
      });
      await act(async () => send());
      const submitted = sentDrafts.at(-1);
      if (!submitted?.messageId) throw new Error("Expected a native image submission");
      nativeDrafts.push(submitted);
      expect(nativeRow(submitted.messageId)?.querySelector("img")?.getAttribute("src")).toBe(attachment.previewUrl);
      expect(editor.textContent).toBe("");
      const parts = await draftToParts(submitted, "/tmp/project-focus-continuity", sessionId, {
        workspaceId,
        client: { uploadInbox: async (_workspace, file, options) => {
          if (!options?.path) throw new Error("Expected a scoped attachment upload path");
          uploadedPaths.push(options.path);
          return { ok: true, path: options.path, bytes: file.size };
        } },
      });
      expect(parts.some((part) => part.type === "file" && part.filename === "native_photo_.jpg")).toBe(true);
      await act(async () => prepareSubmission?.(v2PromptText(parts)));
      const admitted = await nativeClient.session.promptAsync({
        sessionID: sessionId, messageID: submitted.messageId, parts,
        model: { providerID: "test", modelID: "test-model" },
      });
      expect(admitted.response.status).toBe(204);
      await act(async () => submission.resolve({ outcome: "accepted" }));
    }
    expect(uploadedPaths).toHaveLength(2);
    expect(nativePromptTexts).toHaveLength(2);
    expect(nativePromptTexts[0]).not.toBe(nativePromptTexts[1]);
    expect(nativePending()).toHaveLength(2);
    expect(nativePending().map((item) => item.preparedText)).toEqual(nativePromptTexts);
    const firstText = nativePromptTexts[0];
    const secondText = nativePromptTexts[1];
    if (!firstText || !secondText) throw new Error("Expected exact native prompt bodies");
    // Neither an already-known ID nor similar text may take ownership of a preview.
    nativeMessages[0] = { id: "native-historical", role: "user", text: firstText };
    nativeMessages.push({ id: "native-unrelated", role: "user", text: `${firstText}\nA different turn` });
    await refreshNativeTranscript();
    await waitFor(() => nativeRow("native-unrelated") !== null, "the unrelated native turn");
    expect(nativePending().every((item) => !item.serverMessageId)).toBe(true);
    expect(nativeRow("native-historical")?.querySelector("img")).toBeNull();
    expect(nativeRow("native-unrelated")?.querySelector("img")).toBeNull();

    // Observe the sibling first: equal filenames must not make the first upload claim it.
    nativeMessages.push({ id: "native-second", role: "user", text: secondText });
    await refreshNativeTranscript();
    await waitFor(() => nativePending()[1]?.serverMessageId === "native-second", "the second upload's exact text-only acknowledgement");
    expect(nativePending()[0]?.serverMessageId).toBeUndefined();
    expect(nativeRow("native-second")?.querySelector("img")?.getAttribute("src")).toBe(nativeAttachments[1]?.previewUrl);
    nativeMessages.push({ id: "native-first", role: "user", text: firstText });
    await refreshNativeTranscript();
    await waitFor(() => nativePending()[0]?.serverMessageId === "native-first", "the first upload's exact text-only acknowledgement");
    expect(nativeRow("native-first")?.querySelector("img")?.getAttribute("src")).toBe(nativeAttachments[0]?.previewUrl);
    expect(container.querySelectorAll('[data-message-role="user"] img')).toHaveLength(2);
    for (const submitted of nativeDrafts) expect(nativeRow(submitted.messageId ?? "")).toBeNull();
    for (const attachment of nativeAttachments) expect(revokePreview).not.toHaveBeenCalledWith(attachment.previewUrl);
    expect(nativePending()).toHaveLength(2);
    const firstNativeMessage = nativeMessages.find((message) => message.id === "native-first");
    if (!firstNativeMessage) throw new Error("Expected the acknowledged native image turn");
    firstNativeMessage.text = "Native user text normalized";
    await refreshNativeTranscript();
    await waitFor(() => nativeRow("native-first")?.textContent?.includes("Native user text normalized") === true, "the pinned native acknowledgement after its text changes");
    expect(nativeRow("native-first")?.querySelector("img")?.getAttribute("src")).toBe(nativeAttachments[0]?.previewUrl);
    expect(container.querySelectorAll('[data-message-role="user"] img')).toHaveLength(2);
    expect(nativePending().map((item) => item.serverMessageId)).toEqual(["native-first", "native-second"]);
    expect(sentDrafts).toHaveLength(8);

    const { NewTaskComposer } = await import("../src/react-app/domains/session/chat/new-task-composer");
    let creation = Promise.withResolvers<void>();
    let creations = 0;
    let capturedHandoff: NewTaskComposerHandoff | null = null;
    let updateHeroDraft = (_text: string) => {};
    let updateDraftOwner = (_owner: string) => {};
    function Hero() {
      const [text, setText] = useState("First hero message");
      const [draftOwner, setDraftOwner] = useState("owner-a");
      updateHeroDraft = setText;
      updateDraftOwner = setDraftOwner;
      return <NewTaskComposer draft={text} onDraftChange={setText} busy={false} context={newTaskComposerContext(draftOwner)} onRunTask={(_resolved, _attachments, handoff) => {
        creations++;
        capturedHandoff = handoff ?? null;
        return creation.promise;
      }} />;
    }
    await act(async () => root.render(<LocalProvider><ShellConfigProvider><Hero /></ShellConfigProvider></LocalProvider>));
    await act(async () => send());
    expect(creations).toBe(1);
    expect(container.querySelector('[data-lexical-editor="true"]')?.textContent).toBe("");
    expect(container.querySelector('[data-message-role="user"]')?.textContent).toBe("First hero message");
    await act(async () => updateHeroDraft("Newer hero draft"));
    expect(capturedHandoff?.getContinuation().draft).toBe("Newer hero draft");
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
    creation = Promise.withResolvers<void>();
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
      if (!input) throw new Error("Expected the attachment input");
      Object.defineProperty(input, "files", { configurable: true, value: [attachment.file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => send());
    expect(creations).toBe(2);
    expect(container.querySelector('[data-lexical-editor="true"]')?.textContent).toBe("");
    expect(container.querySelector('[data-message-role="user"]')?.textContent).toContain("First hero message");
    expect(container.querySelector('[data-message-role="user"] img[alt="photo.png"]')).not.toBeNull();
    expect(container.querySelector("[data-attachment-id]")).toBeNull();
    expect(capturedHandoff?.getContinuation()).toEqual({ draft: "", attachments: [], mentions: {}, pasteParts: [], revertMessageId: null });
    expect(capturedHandoff?.submitted.attachments[0]?.file).toBe(attachment.file);
    await act(async () => creation.reject(new Error("Image session creation failed")));
    expect(container.querySelector('[data-lexical-editor="true"]')?.textContent).toContain("First hero message");
    expect(container.querySelector('[data-attachment-id]')).not.toBeNull();

    creation = Promise.withResolvers<void>();
    await act(async () => send());
    const attachmentHandoff = capturedHandoff;
    if (!attachmentHandoff) throw new Error("Expected the attachment handoff");
    const heroPreview = attachmentHandoff.submitted.attachments[0]?.previewUrl;
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
      if (!input) throw new Error("Expected the continuation attachment input");
      Object.defineProperty(input, "files", { configurable: true, value: [continuationFile] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const heroContinuation = attachmentHandoff.getContinuation();
    expect(heroContinuation.attachments[0]?.file).toBe(continuationFile);
    await act(async () => creation.reject(new Error("Hero upload unavailable")));
    expect(attachmentHandoff.getContinuation()).toEqual(heroContinuation);
    expect(container.querySelector('[data-attachment-id]')?.getAttribute("title")).toBe("continuation.png");
    expect(revokePreview).not.toHaveBeenCalledWith(heroPreview);
    expect(container.textContent).toContain("Clear the current draft to restore the unsent message");
    expect(creations).toBe(3);

    await act(async () => updateDraftOwner("owner-b"));
    await waitFor(
      () => container.querySelector('[data-lexical-editor="true"]')?.textContent === "",
      "the next draft owner to start empty after attachment recovery",
    );
    creation = Promise.withResolvers<void>();
    await act(async () => updateHeroDraft("Owner B submission"));
    await act(async () => send());
    expect(creations).toBe(4);
    const ownerBHandoff = capturedHandoff;
    if (!ownerBHandoff) throw new Error("Expected the owner B handoff");
    await act(async () => updateHeroDraft("Owner B continuation"));
    expect(ownerBHandoff.getContinuation().draft).toBe("Owner B continuation");
    await act(async () => updateDraftOwner("owner-c"));
    await waitFor(
      () => container.querySelector('[data-lexical-editor="true"]')?.textContent === "",
      "the new draft owner to start empty",
    );
    await act(async () => updateHeroDraft("Foreign owner draft"));
    expect(ownerBHandoff.getContinuation().draft).toBe("Owner B continuation");
    await act(async () => creation.resolve());
    expect(container.querySelector('[data-lexical-editor="true"]')?.textContent).toBe("Foreign owner draft");
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
