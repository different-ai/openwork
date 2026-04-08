/** @jsxImportSource react */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";

import { createClient } from "../../app/lib/opencode";
import { abortSessionSafe } from "../../app/lib/opencode-session";
import type { OpenworkServerClient, OpenworkSessionSnapshot } from "../../app/lib/openwork-server";
import type { ComposerAttachment, ComposerDraft, ComposerPart } from "../../app/types";
import { SessionDebugPanel } from "./debug-panel.react";
import { SessionTranscript } from "./message-list.react";
import { deriveSessionRenderModel } from "./transition-controller";
import { getReactQueryClient } from "../kernel/query-client";
import { ReactSessionComposer } from "./composer/composer.react";
import type { ReactComposerNotice } from "./composer/notice.react";

const AUTO_SCROLL_THRESHOLD_PX = 64;
const scrollPositionBySession = new Map<string, number>();

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= AUTO_SCROLL_THRESHOLD_PX;
}
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
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onUploadInboxFiles?: ((files: File[], options?: { notify?: boolean }) => void | Promise<unknown>) | null;
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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [mentions, setMentions] = useState<Record<string, "agent" | "file">>({});
  const [pasteParts, setPasteParts] = useState<Array<{ id: string; label: string; text: string; lines: number }>>([]);
  const [notice, setNotice] = useState<ReactComposerNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);
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
    setShowDelayedLoading(false);
    setAttachments([]);
    setMentions({});
    setPasteParts([]);
    setNotice(null);
  }, [props.sessionId]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(id);
  }, [notice]);

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
  const pendingSessionLoad = !snapshot && snapshotQuery.isLoading && renderedMessages.length === 0;

  useEffect(() => {
    if (!pendingSessionLoad) {
      setShowDelayedLoading(false);
      return;
    }
    const id = window.setTimeout(() => setShowDelayedLoading(true), 2000);
    return () => window.clearTimeout(id);
  }, [pendingSessionLoad]);

  const model = deriveSessionRenderModel({
    intendedSessionId: props.sessionId,
    renderedSessionId: renderedMessages.length > 0 || snapshotQuery.data ? props.sessionId : rendered?.sessionId ?? null,
    hasSnapshot: Boolean(snapshot) || renderedMessages.length > 0,
    isFetching: snapshotQuery.isFetching,
    isError: snapshotQuery.isError || Boolean(error),
  });

  const buildDraft = (text: string, nextAttachments: ComposerAttachment[]): ComposerDraft => {
    const trimmed = text.trim();
    const slashMatch = trimmed.match(/^\/([^\s]+)\s*(.*)$/);
    const parts: ComposerPart[] = text.split(/(\[pasted text [^\]]+\]|@[^\s@]+)/).flatMap((segment) => {
      if (!segment) return [] as ComposerDraft["parts"];
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch) {
        const target = pasteParts.find((item) => item.label === pasteMatch[1]);
        if (target) {
          return [{ type: "paste", id: target.id, label: target.label, text: target.text, lines: target.lines }];
        }
      }
      if (segment.startsWith("@")) {
        const value = segment.slice(1);
        const kind = mentions[value];
        if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
      }
      return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
    });
    return {
      mode: "prompt",
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
      const nextDraft = buildDraft(text, attachments);
      props.onSendDraft(nextDraft);
      setDraft("");
      setAttachments([]);
      props.onDraftChange(buildDraft("", []));
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
    props.onDraftChange(buildDraft(draft, attachments));
  }, [draft, attachments, pasteParts, props]);

  const handleAttachFiles = (files: File[]) => {
    if (!props.attachmentsEnabled) {
      setNotice({ title: props.attachmentsDisabledReason ?? "Attachments are unavailable.", tone: "warning" });
      return;
    }
    const oversized = files.filter((file) => file.size > 25 * 1024 * 1024);
    const accepted = files.filter((file) => file.size <= 25 * 1024 * 1024);
    if (oversized.length) {
      setNotice({
        title: oversized.length === 1 ? `${oversized[0]?.name ?? "File"} is too large` : `${oversized.length} files are too large`,
        description: "Files over 25 MB were skipped.",
        tone: "warning",
      });
    }
    if (!accepted.length) return;
    const next = accepted.map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      kind: file.type.startsWith("image/") ? "image" as const : "file" as const,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setAttachments((current) => [...current, ...next]);
    setNotice({
      title: next.length === 1 ? `Attached ${next[0]?.name ?? "file"}` : `Attached ${next.length} files`,
      tone: "success",
    });
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

  const handlePasteText = (text: string) => {
    const id = `paste-${Math.random().toString(36).slice(2)}`;
    const label = `${id.slice(-4)} · ${text.split(/\r?\n/).length} lines`;
    setPasteParts((current) => [...current, { id, label, text, lines: text.split(/\r?\n/).length }]);
    setDraft((current) => `${current}[pasted text ${label}]`);
  };

  const handleRevealPastedText = (id: string) => {
    const part = pasteParts.find((item) => item.id === id);
    if (!part) return;
    setNotice({
      title: `Pasted text · ${part.label}`,
      description: part.text.slice(0, 800),
      tone: "info",
    });
  };

  const handleRemovePastedText = (id: string) => {
    setPasteParts((current) => {
      const target = current.find((item) => item.id === id);
      if (!target) return current;
      setDraft((draftValue) => draftValue.replace(`[pasted text ${target.label}]`, ""));
      return current.filter((item) => item.id !== id);
    });
  };

  const handleUnsupportedFileLinks = (links: string[]) => {
    if (!links.length) return;
    setDraft((current) => `${current}${current && !current.endsWith("\n") ? "\n" : ""}${links.join("\n")}`);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const previousSessionIdRef = useRef(props.sessionId);
  const messageCountRef = useRef(renderedMessages.length);

  // Save scroll position when leaving a session
  useEffect(() => {
    const previousId = previousSessionIdRef.current;
    if (previousId !== props.sessionId) {
      const el = scrollRef.current;
      if (el) scrollPositionBySession.set(previousId, el.scrollTop);
      previousSessionIdRef.current = props.sessionId;
    }
  }, [props.sessionId]);

  // Restore scroll position or scroll to bottom on session change
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = scrollPositionBySession.get(props.sessionId);
    if (saved !== undefined) {
      el.scrollTop = saved;
      shouldAutoScrollRef.current = isNearBottom(el);
    } else {
      el.scrollTop = el.scrollHeight;
      shouldAutoScrollRef.current = true;
    }
    setShowScrollToBottom(!shouldAutoScrollRef.current);
  }, [props.sessionId]);

  // Auto-follow during streaming / new messages
  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [renderedMessages.length, chatStreaming]);

  // Also auto-follow when message count changes during streaming
  useEffect(() => {
    if (renderedMessages.length !== messageCountRef.current) {
      messageCountRef.current = renderedMessages.length;
      if (shouldAutoScrollRef.current) {
        const el = scrollRef.current;
        if (el) {
          requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
          });
        }
      }
    }
  }, [renderedMessages.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    if (near && !shouldAutoScrollRef.current) {
      shouldAutoScrollRef.current = true;
    } else if (!near && shouldAutoScrollRef.current) {
      shouldAutoScrollRef.current = false;
    }
    setShowScrollToBottom(!shouldAutoScrollRef.current);
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    if (event.deltaY < 0) {
      shouldAutoScrollRef.current = false;
      setShowScrollToBottom(true);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {model.transitionState === "switching" && showDelayedLoading ? (
        <div className="flex justify-center px-6 pt-4">
          <div className="rounded-full border border-dls-border bg-dls-hover/80 px-3 py-1 text-xs text-dls-secondary">
            {model.renderSource === "cache" ? "Switching session from cache..." : "Switching session..."}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel} className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain space-y-4 px-3 py-4 sm:px-5">
      {showDelayedLoading && pendingSessionLoad ? (
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
        <SessionTranscript messages={renderedMessages} isStreaming={chatStreaming} developerMode={props.developerMode} />
      )}
      </div>
      {showScrollToBottom ? (
        <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 justify-center">
          <button
            type="button"
            onClick={scrollToBottom}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-dls-border/60 bg-dls-surface px-3 py-1.5 text-xs text-dls-secondary shadow-sm transition-colors hover:border-dls-border hover:text-dls-text"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            Scroll to bottom
          </button>
        </div>
      ) : null}
      </div>

      <div className="shrink-0 border-t border-dls-border/70 px-0 pb-3 pt-3">
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
        notice={notice}
        onNotice={setNotice}
        onPasteText={handlePasteText}
        onUnsupportedFileLinks={handleUnsupportedFileLinks}
        pastedText={pasteParts}
        onRevealPastedText={handleRevealPastedText}
        onRemovePastedText={handleRemovePastedText}
        isRemoteWorkspace={props.isRemoteWorkspace}
          isSandboxWorkspace={props.isSandboxWorkspace}
          onUploadInboxFiles={props.onUploadInboxFiles}
        />
      </div>
      {error ? (
        <div className="mx-auto w-full max-w-[800px] px-4">
          <div className="rounded-b-[20px] border border-t-0 border-red-6/30 px-4 py-3 text-sm text-red-11">{error}</div>
        </div>
      ) : null}
      {props.developerMode ? <SessionDebugPanel model={model} snapshot={snapshot} /> : null}
    </div>
  );
}
