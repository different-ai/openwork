/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";

import { createClient } from "../../app/lib/opencode";
import { abortSessionSafe } from "../../app/lib/opencode-session";
import type { OpenworkServerClient, OpenworkSessionSnapshot } from "../../app/lib/openwork-server";
import type { ComposerAttachment, ComposerDraft, PromptMode } from "../../app/types";
import { SessionDebugPanel } from "./debug-panel.react";
import { SessionTranscript } from "./message-list.react";
import { deriveSessionRenderModel } from "./transition-controller";
import { getReactQueryClient } from "../kernel/query-client";
import { ReactSessionComposer } from "./composer/composer.react";
import {
  seedSessionState,
  statusKey as reactStatusKey,
  todoKey as reactTodoKey,
  transcriptKey as reactTranscriptKey,
} from "./session-sync";
import { snapshotToUIMessages } from "./usechat-adapter";

type SessionSurfaceProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  developerMode: boolean;
  modelLabel: string;
  onModelClick: () => void;
  onSendDraft: (draft: ComposerDraft) => void;
  onDraftChange: (draft: ComposerDraft) => void;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<import("@opencode-ai/sdk/v2/client").Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<import("../../app/types").SlashCommandOption[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
};

function transcriptToText(messages: UIMessage[]) {
  return messages
    .map((message) => {
      const header = message.role === "user" ? "You" : message.role === "assistant" ? "OpenWork" : message.role;
      const body = message.parts
        .flatMap((part) => {
          if (part.type === "text") return [part.text];
          if (part.type === "reasoning") return [part.text];
          if (part.type === "dynamic-tool") {
            if (part.state === "output-error") return [`[tool:${part.toolName}] ${part.errorText}`];
            if (part.state === "output-available") return [`[tool:${part.toolName}] ${JSON.stringify(part.output)}`];
            return [`[tool:${part.toolName}] ${JSON.stringify(part.input)}`];
          }
          return [];
        })
        .join("\n\n");
      return `${header}\n${body}`.trim();
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function statusLabel(snapshot: OpenworkSessionSnapshot | undefined, busy: boolean) {
  if (busy) return "Running...";
  if (snapshot?.status.type === "busy") return "Running...";
  if (snapshot?.status.type === "retry") return `Retrying: ${snapshot.status.message}`;
  return "Ready";
}

function useSharedQueryState<T>(queryKey: readonly unknown[], fallback: T) {
  const queryClient = getReactQueryClient();
  return useSyncExternalStore(
    (callback) => queryClient.getQueryCache().subscribe(callback),
    () => (queryClient.getQueryData<T>(queryKey) ?? fallback),
    () => fallback,
  );
}

export function SessionSurface(props: SessionSurfaceProps) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<PromptMode>("prompt");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [mentions, setMentions] = useState<Record<string, "agent" | "file">>({});
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [rendered, setRendered] = useState<{ sessionId: string; snapshot: OpenworkSessionSnapshot } | null>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const opencodeClient = useMemo(
    () => createClient(props.opencodeBaseUrl, undefined, { token: props.openworkToken, mode: "openwork" }),
    [props.opencodeBaseUrl, props.openworkToken],
  );

  const snapshotQueryKey = useMemo(
    () => ["react-session-snapshot", props.workspaceId, props.sessionId],
    [props.workspaceId, props.sessionId],
  );
  const transcriptQueryKey = useMemo(
    () => reactTranscriptKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const statusQueryKey = useMemo(
    () => reactStatusKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const todoQueryKey = useMemo(
    () => reactTodoKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );

  const snapshotQuery = useQuery<OpenworkSessionSnapshot>({
    queryKey: snapshotQueryKey,
    queryFn: async () => (await props.client.getSessionSnapshot(props.workspaceId, props.sessionId, { limit: 140 })).item,
    staleTime: 500,
  });

  const currentSnapshot = snapshotQuery.data?.session.id === props.sessionId ? snapshotQuery.data : null;
  const transcriptState = useSharedQueryState<UIMessage[]>(transcriptQueryKey, []);
  const statusState = useSharedQueryState(statusQueryKey, currentSnapshot?.status ?? { type: "idle" as const });
  useSharedQueryState(todoQueryKey, currentSnapshot?.todos ?? []);

  useEffect(() => {
    if (!currentSnapshot) return;
    setRendered({ sessionId: props.sessionId, snapshot: currentSnapshot });
  }, [props.sessionId, currentSnapshot]);

  useEffect(() => {
    hydratedKeyRef.current = null;
    setError(null);
    setSending(false);
    setMode("prompt");
    setAttachments([]);
    setMentions({});
  }, [props.sessionId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    seedSessionState(props.workspaceId, currentSnapshot);
  }, [currentSnapshot, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    const key = `${props.sessionId}:${currentSnapshot.session.time?.updated ?? currentSnapshot.session.time?.created ?? 0}:${currentSnapshot.messages.length}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    seedSessionState(props.workspaceId, currentSnapshot);
  }, [props.sessionId, currentSnapshot, props.workspaceId]);

  const snapshot = currentSnapshot ?? rendered?.snapshot ?? null;
  const liveStatus = statusState ?? snapshot?.status ?? { type: "idle" as const };
  const chatStreaming = sending || liveStatus.type === "busy" || liveStatus.type === "retry";
  const renderedMessages = transcriptState ?? [];
  const model = deriveSessionRenderModel({
    intendedSessionId: props.sessionId,
    renderedSessionId: renderedMessages.length > 0 || snapshotQuery.data ? props.sessionId : rendered?.sessionId ?? null,
    hasSnapshot: Boolean(snapshot) || renderedMessages.length > 0,
    isFetching: snapshotQuery.isFetching || chatStreaming,
    isError: snapshotQuery.isError || Boolean(error),
  });

  const buildDraft = (text: string, nextMode: PromptMode, nextAttachments: ComposerAttachment[]): ComposerDraft => {
    const trimmed = text.trim();
    const slashMatch = trimmed.match(/^\/([^\s]+)\s*(.*)$/);
    const parts: ComposerDraft["parts"] = text.split(/(@[^\s@]+)/).flatMap((segment) => {
      if (!segment) return [] as ComposerDraft["parts"];
      if (segment.startsWith("@")) {
        const value = segment.slice(1);
        const kind = mentions[value];
        if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
      }
      return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
    });
    return {
      mode: nextMode,
      parts,
      attachments: nextAttachments,
      text,
      resolvedText: text,
      command: slashMatch ? { name: slashMatch[1] ?? "", arguments: slashMatch[2] ?? "" } : undefined,
    };
  };

  const handleCopyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToText(renderedMessages));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to copy transcript.");
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || chatStreaming) return;
    setError(null);
    setSending(true);
    try {
      const nextDraft = buildDraft(text, mode, attachments);
      props.onSendDraft(nextDraft);
      setDraft("");
      setAttachments([]);
      props.onDraftChange(buildDraft("", mode, []));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to send prompt.");
      setSending(false);
    }
  };

  const handleAbort = async () => {
    if (!chatStreaming) return;
    setError(null);
    try {
      await abortSessionSafe(opencodeClient, props.sessionId);
      await snapshotQuery.refetch();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to stop run.");
    }
  };

  useEffect(() => {
    if (liveStatus.type === "idle") {
      setSending(false);
    }
  }, [liveStatus.type]);

  useEffect(() => {
    props.onDraftChange(buildDraft(draft, mode, attachments));
  }, [draft, mode, attachments, props]);

  const handleAttachFiles = (files: File[]) => {
    if (!props.attachmentsEnabled) {
      setError(props.attachmentsDisabledReason ?? "Attachments are unavailable.");
      return;
    }
    const next = files.map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      kind: file.type.startsWith("image/") ? "image" as const : "file" as const,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setAttachments((current) => [...current, ...next]);
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((item) => item.id !== id);
    });
  };

  const handleInsertMention = (kind: "agent" | "file", value: string) => {
    setDraft((current) => current.replace(/@([^\s@]*)$/, `@${value} `));
    setMentions((current) => ({ ...current, [value]: kind }));
  };

  const onComposerKeyDown = async (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!event.metaKey && !event.ctrlKey) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    await handleSend();
  };

  return (
    <div className="space-y-5 pb-4">
      {model.transitionState === "switching" ? (
        <div className="flex justify-center px-6">
          <div className="rounded-full border border-dls-border bg-dls-hover/80 px-3 py-1 text-xs text-dls-secondary">
            {model.renderSource === "cache" ? "Switching session from cache..." : "Switching session..."}
          </div>
        </div>
      ) : null}

      {!snapshot && snapshotQuery.isLoading && renderedMessages.length === 0 ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
            <div className="text-sm text-dls-secondary">Loading React session view...</div>
          </div>
        </div>
      ) : (snapshotQuery.isError || error) && !snapshot && renderedMessages.length === 0 ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-xl rounded-3xl border border-red-6/40 bg-red-3/20 px-6 py-5 text-sm text-red-11">
            {error || (snapshotQuery.error instanceof Error ? snapshotQuery.error.message : "Failed to load React session view.")}
          </div>
        </div>
      ) : renderedMessages.length === 0 && snapshot && snapshot.messages.length === 0 ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
            <div className="text-sm text-dls-secondary">No transcript yet.</div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="mx-auto flex w-full max-w-[800px] justify-end px-4">
            <button
              type="button"
              className="rounded-full border border-dls-border bg-dls-hover/60 px-3 py-1 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
              onClick={handleCopyTranscript}
              disabled={renderedMessages.length === 0}
            >
              Copy transcript
            </button>
          </div>
          <SessionTranscript messages={renderedMessages} isStreaming={chatStreaming} developerMode={props.developerMode} />
        </div>
      )}

        <ReactSessionComposer
          draft={draft}
          mentions={mentions}
          onDraftChange={setDraft}
        onSend={handleSend}
        onStop={handleAbort}
        busy={chatStreaming}
        disabled={model.transitionState !== "idle"}
        statusLabel={statusLabel(snapshot ?? undefined, chatStreaming)}
        modelLabel={props.modelLabel}
        onModelClick={props.onModelClick}
        mode={mode}
        onModeChange={setMode}
        attachments={attachments}
        onAttachFiles={handleAttachFiles}
        onRemoveAttachment={handleRemoveAttachment}
        attachmentsEnabled={props.attachmentsEnabled}
        attachmentsDisabledReason={props.attachmentsDisabledReason}
        modelVariantLabel={props.modelVariantLabel}
        modelVariant={props.modelVariant}
        modelBehaviorOptions={props.modelBehaviorOptions}
        onModelVariantChange={props.onModelVariantChange}
        agentLabel={props.agentLabel}
        selectedAgent={props.selectedAgent}
        listAgents={props.listAgents}
        onSelectAgent={props.onSelectAgent}
        listCommands={props.listCommands}
        recentFiles={props.recentFiles}
        searchFiles={props.searchFiles}
        onInsertMention={handleInsertMention}
      />
      {error ? (
        <div className="mx-auto w-full max-w-[800px] px-4">
          <div className="rounded-b-[20px] border border-t-0 border-red-6/30 px-4 py-3 text-sm text-red-11">{error}</div>
        </div>
      ) : null}
      {props.developerMode ? <SessionDebugPanel model={model} snapshot={snapshot} /> : null}
    </div>
  );
}
