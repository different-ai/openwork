/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";

import { createClient, unwrap } from "../../../../app/lib/opencode";
import { abortSessionSafe } from "../../../../app/lib/opencode-session";
import type {
  OpenworkServerClient,
  OpenworkSessionSnapshot,
} from "../../../../app/lib/openwork-server";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  McpServerEntry,
  McpStatusMap,
  SkillCard,
} from "../../../../app/types";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "../../../shell/app-inspector";
import { getReactQueryClient } from "../../../infra/query-client";
import { ReactSessionComposer } from "./composer/composer";
import { DevProfiler } from "../../../shell/dev-profiler";
import { OwDotTicker } from "../../../shell/dot-ticker";
import { useReactRenderWatchdog } from "../../../shell/react-render-watchdog";
import type { ReactComposerNotice } from "./composer/notice";
import { SessionDebugPanel } from "./debug-panel";
import { SessionTranscript } from "./message-list";
import { deriveSessionRenderModel } from "../sync/transition-controller";
import { useSessionScrollController } from "./scroll-controller";
import {
  seedSessionState,
  statusKey as reactStatusKey,
  todoKey as reactTodoKey,
  transcriptKey as reactTranscriptKey,
} from "../sync/session-sync";
import { snapshotToUIMessages } from "../sync/usechat-adapter";

export type SessionSurfaceProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
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
  listCommands: () => Promise<import("../../../../app/types").SlashCommandOption[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onUploadInboxFiles?: ((files: File[], options?: { notify?: boolean }) => void | Promise<unknown>) | null;
  onOpenSettingsSection?: ((section: "commands" | "skills" | "mcps") => void) | undefined;
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

function messageHasVisibleAssistantOutput(message: UIMessage) {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

function AssistantWaitingCard() {
  return (
    <div className="flex justify-start py-2" role="status" aria-live="polite">
      <div className="inline-flex items-center gap-3 rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-[12px] text-dls-secondary">
        <OwDotTicker size="sm" />
        <span>Thinking</span>
      </div>
    </div>
  );
}

function revokeAttachmentPreview(attachment: { previewUrl?: string | undefined }) {
  if (!attachment.previewUrl) return;
  URL.revokeObjectURL(attachment.previewUrl);
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
  const [awaitingAssistantBaseline, setAwaitingAssistantBaseline] = useState<number | null>(null);
  const [rendered, setRendered] = useState<{ sessionId: string; snapshot: OpenworkSessionSnapshot } | null>(null);
  const [toolSkills, setToolSkills] = useState<SkillCard[]>([]);
  const [toolMcpServers, setToolMcpServers] = useState<McpServerEntry[]>([]);
  const [toolMcpStatus, setToolMcpStatus] = useState<string | null>(null);
  const [toolMcpStatuses, setToolMcpStatuses] = useState<McpStatusMap>({});
  const hydratedKeyRef = useRef<string | null>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  attachmentsRef.current = attachments;
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

  useEffect(() => {
    return () => {
      const queryClient = getReactQueryClient();
      queryClient.removeQueries({ queryKey: snapshotQueryKey, exact: true });
      queryClient.removeQueries({ queryKey: transcriptQueryKey, exact: true });
      queryClient.removeQueries({ queryKey: statusQueryKey, exact: true });
      queryClient.removeQueries({ queryKey: todoQueryKey, exact: true });
    };
  }, [snapshotQueryKey, transcriptQueryKey, statusQueryKey, todoQueryKey]);

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
    setAwaitingAssistantBaseline(null);
    // Clear draft + attachments + mentions on session change so typed text
    // doesn't bleed across sessions (and across workspaces). The sessionId
    // effectively changes when the workspace changes too because the route
    // navigates to the remembered session id for that workspace.
    setDraft("");
    setAttachments((current) => {
      current.forEach(revokeAttachmentPreview);
      return [];
    });
    setMentions({});
    setPasteParts([]);
    setNotice(null);
  }, [props.sessionId]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Publish a composer inspector slice so external drivers can read draft
  // state, attachments, mentions, and sending status from the running app.
  useEffect(() => {
    const dispose = publishInspectorSlice("composer", () => ({
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      draft,
      draftLength: draft.length,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
      })),
      mentions,
      pasteParts: pasteParts.map((part) => ({
        id: part.id,
        label: part.label,
        lines: part.lines,
      })),
      sending,
      error,
      hasNotice: Boolean(notice),
    }));
    return dispose;
  }, [
    attachments,
    draft,
    error,
    mentions,
    notice,
    pasteParts,
    props.sessionId,
    props.workspaceId,
    sending,
  ]);

  useEffect(() => {
    recordInspectorEvent("session.mounted", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
    });
  }, [props.sessionId, props.workspaceId]);

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
  const assistantOutputAfterAwaitStart = useMemo(() => {
    if (awaitingAssistantBaseline === null) return false;
    return renderedMessages
      .slice(awaitingAssistantBaseline)
      .some(messageHasVisibleAssistantOutput);
  }, [awaitingAssistantBaseline, renderedMessages]);
  const showAssistantWaitState = awaitingAssistantBaseline !== null && !assistantOutputAfterAwaitStart;
  useReactRenderWatchdog("SessionSurface", {
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    messageCount: renderedMessages.length,
    liveStatus: liveStatus.type,
    sending,
    pendingSessionLoad,
    showAssistantWaitState,
    hasSnapshot: Boolean(snapshot),
  });

  useEffect(() => {
    if (!pendingSessionLoad) {
      setShowDelayedLoading(false);
      return;
    }
    const id = window.setTimeout(() => setShowDelayedLoading(true), 2000);
    return () => window.clearTimeout(id);
  }, [pendingSessionLoad]);

  useEffect(() => {
    if (awaitingAssistantBaseline === null) return;
    if (assistantOutputAfterAwaitStart) {
      setAwaitingAssistantBaseline(null);
      return;
    }
    if (sending || liveStatus.type !== "idle" || renderedMessages.length <= awaitingAssistantBaseline) return;
    const id = window.setTimeout(() => setAwaitingAssistantBaseline(null), 1200);
    return () => window.clearTimeout(id);
  }, [assistantOutputAfterAwaitStart, awaitingAssistantBaseline, liveStatus.type, renderedMessages.length, sending]);

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
    if (!text && attachments.length === 0) return;
    // Intentionally allow sending while the assistant is still streaming.
    // OpenCode accepts follow-up user turns mid-run and queues them; if the
    // backend can't accept the follow-up it'll surface an error via the
    // catch below. This restores the "append a prompt while it's still
    // talking" behavior that the Solid composer had.
    setError(null);
    setSending(true);
    setAwaitingAssistantBaseline(renderedMessages.length);
    try {
      const nextDraft = buildDraft(text, attachments);
      await props.onSendDraft(nextDraft);
      setDraft("");
      attachments.forEach(revokeAttachmentPreview);
      setAttachments([]);
      props.onDraftChange(buildDraft("", []));
      setSending(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to send prompt.");
      setAwaitingAssistantBaseline(null);
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

  const listSkills = async (): Promise<SkillCard[]> => {
    const response = await props.client.listSkills(props.workspaceId, { includeGlobal: true });
    const next = (response.items ?? []).map((skill) => ({
      name: skill.name,
      path: skill.path,
      description: skill.description,
      trigger: skill.trigger,
    } satisfies SkillCard));
    setToolSkills(next);
    return next;
  };

  const listMcp = async (): Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }> => {
    const response = await props.client.listMcp(props.workspaceId);
    const servers = (response.items ?? []).map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
    } satisfies McpServerEntry));

    let statuses: McpStatusMap = {};
    try {
      if (props.workspaceRoot.trim()) {
        statuses = unwrap(await opencodeClient.mcp.status({ directory: props.workspaceRoot.trim() })) as McpStatusMap;
      }
    } catch {
      statuses = {};
    }

    const status = servers.length ? null : "No MCP servers loaded.";
    setToolMcpServers(servers);
    setToolMcpStatuses(statuses);
    setToolMcpStatus(status);
    return { servers, statuses, status };
  };

  const handleUploadInboxFiles = async (files: File[], options?: { notify?: boolean }) => {
    const input = files.filter(Boolean);
    if (!input.length) return;
    try {
      const results = await Promise.all(input.map((file) => props.client.uploadInbox(props.workspaceId, file)));
      if (options?.notify !== false) {
        const summary = results.map((item) => item.path.split("/").filter(Boolean).slice(-1)[0] ?? item.path).join(", ");
        setNotice({
          title: input.length === 1 ? "Uploaded to the shared folder." : `Uploaded ${input.length} files to the shared folder.`,
          description: summary || undefined,
          tone: "success",
        });
      }
      return results;
    } catch (nextError) {
      setNotice({
        title: nextError instanceof Error ? nextError.message : "Shared folder upload failed",
        tone: "warning",
      });
      throw nextError;
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sessionScroll = useSessionScrollController({
    selectedSessionId: props.sessionId,
    renderedMessages,
    containerRef: scrollRef,
    contentRef,
  });

  return (
    <DevProfiler id="SessionSurface">
    <div className="flex h-full min-h-0 flex-col">
      {model.transitionState === "switching" && showDelayedLoading ? (
        <div className="flex justify-center px-6 pt-4">
          <div className="rounded-full border border-dls-border bg-dls-hover/80 px-3 py-1 text-xs text-dls-secondary">
            {model.renderSource === "cache" ? "Switching session from cache..." : "Switching session..."}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onWheel={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchStart={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchMove={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            sessionScroll.markScrollGesture(event.currentTarget);
          }}
          onScroll={sessionScroll.handleScroll}
          className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-4 sm:px-5"
        >
          {/* Chat column: tighter than the composer (800px) so messages
               keep a comfortable reading width and don't feel "too big". */}
          <div ref={contentRef} className="mx-auto w-full max-w-[720px]">
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
            ) : renderedMessages.length === 0 && showAssistantWaitState ? (
              <div className="px-6 py-12">
                <AssistantWaitingCard />
              </div>
            ) : renderedMessages.length === 0 && snapshot && snapshot.messages.length === 0 ? (
              null
            ) : (
              <DevProfiler id="SessionTranscript">
                <>
                  <SessionTranscript
                    messages={renderedMessages}
                    isStreaming={chatStreaming}
                    developerMode={props.developerMode}
                    scrollElement={() => scrollRef.current}
                  />
                  {showAssistantWaitState ? <AssistantWaitingCard /> : null}
                </>
              </DevProfiler>
            )}
          </div>
        </div>
        {!sessionScroll.isAtBottom || sessionScroll.topClippedMessageId ? (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 justify-center">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface/95 p-1 shadow-[var(--dls-card-shadow)] backdrop-blur-md">
              {sessionScroll.topClippedMessageId ? (
                <button
                  type="button"
                  className="rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover"
                  onClick={() => {
                    sessionScroll.jumpToStartOfMessage("smooth");
                  }}
                >
                  Jump to start
                </button>
              ) : null}
              {!sessionScroll.isAtBottom ? (
                <button
                  type="button"
                  className="rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover"
                  onClick={() => {
                    sessionScroll.jumpToLatest("smooth");
                  }}
                >
                  Jump to latest
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-dls-border/70 px-0 pb-3 pt-3">
        <DevProfiler id="SessionComposer">
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
        listSkills={listSkills}
        skills={toolSkills}
        listMcp={listMcp}
        mcpServers={toolMcpServers}
        mcpStatus={toolMcpStatus}
        mcpStatuses={toolMcpStatuses}
        onOpenSettingsSection={props.onOpenSettingsSection}
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
          onUploadInboxFiles={props.onUploadInboxFiles ?? handleUploadInboxFiles}
        />
        </DevProfiler>
      </div>
      {error ? (
        <div className="mx-auto w-full max-w-[800px] px-4">
          <div className="rounded-b-[20px] border border-t-0 border-red-6/30 px-4 py-3 text-sm text-red-11">{error}</div>
        </div>
      ) : null}
      {props.developerMode ? <SessionDebugPanel model={model} snapshot={snapshot} /> : null}
    </div>
    </DevProfiler>
  );
}
