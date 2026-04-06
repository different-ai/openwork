/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useQuery } from "@tanstack/react-query";

import type { OpenworkServerClient, OpenworkSessionSnapshot } from "../../app/lib/openwork-server";
import { SessionDebugPanel } from "./debug-panel.react";
import { deriveSessionRenderModel } from "./transition-controller";
import { SessionTranscript } from "./message-list.react";
import { createOpenworkChatTransport, snapshotToUIMessages } from "./usechat-adapter";

type SessionSurfaceProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  developerMode: boolean;
};

function statusLabel(snapshot: OpenworkSessionSnapshot | undefined, busy: boolean) {
  if (busy) return "Running...";
  if (snapshot?.status.type === "busy") return "Running...";
  if (snapshot?.status.type === "retry") return `Retrying: ${snapshot.status.message}`;
  return "Ready";
}

export function SessionSurface(props: SessionSurfaceProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{
    sessionId: string;
    snapshot: OpenworkSessionSnapshot;
  } | null>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const transport = useMemo(
    () =>
      createOpenworkChatTransport({
        baseUrl: props.opencodeBaseUrl,
        openworkToken: props.openworkToken,
        sessionId: props.sessionId,
      }),
    [props.opencodeBaseUrl, props.openworkToken, props.sessionId],
  );
  const chat = useChat({
    id: props.sessionId,
    transport,
    onError(nextError) {
      setError(nextError.message);
    },
    onFinish() {
      void query.refetch();
    },
  });

  const queryKey = useMemo(
    () => ["react-session-snapshot", props.workspaceId, props.sessionId],
    [props.workspaceId, props.sessionId],
  );

  const query = useQuery<OpenworkSessionSnapshot>({
    queryKey,
    queryFn: async () => (await props.client.getSessionSnapshot(props.workspaceId, props.sessionId, { limit: 140 })).item,
    staleTime: 500,
  });

  const currentSnapshot = query.data?.session.id === props.sessionId ? query.data : null;

  useEffect(() => {
    if (!currentSnapshot) return;
    setRendered({ sessionId: props.sessionId, snapshot: currentSnapshot });
  }, [props.sessionId, currentSnapshot]);

  useEffect(() => {
    hydratedKeyRef.current = null;
    setError(null);
  }, [props.sessionId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    const key = `${props.sessionId}:${currentSnapshot.session.time?.updated ?? currentSnapshot.session.time?.created ?? 0}:${currentSnapshot.messages.length}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    chat.setMessages(snapshotToUIMessages(currentSnapshot));
  }, [chat, props.sessionId, currentSnapshot]);

  const snapshot = currentSnapshot ?? rendered?.snapshot ?? null;
  const chatStreaming = chat.status === "submitted" || chat.status === "streaming";
  const model = deriveSessionRenderModel({
    intendedSessionId: props.sessionId,
    renderedSessionId:
      chat.messages.length > 0 || query.data ? props.sessionId : rendered?.sessionId ?? null,
    hasSnapshot: Boolean(snapshot) || chat.messages.length > 0,
    isFetching: query.isFetching || chatStreaming,
    isError: query.isError || chat.status === "error",
  });

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || chatStreaming) return;
    setError(null);
    try {
      await chat.sendMessage({ text });
      setDraft("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to send prompt.");
    }
  };

  const handleAbort = async () => {
    if (!chatStreaming) return;
    setError(null);
    try {
      chat.stop();
      await query.refetch();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to stop run.");
    }
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

      {!snapshot && query.isLoading && chat.messages.length === 0 ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
            <div className="text-sm text-dls-secondary">Loading React session view...</div>
          </div>
        </div>
      ) : (query.isError || chat.status === "error") && !snapshot && chat.messages.length === 0 ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-xl rounded-3xl border border-red-6/40 bg-red-3/20 px-6 py-5 text-sm text-red-11">
            {error || (query.error instanceof Error ? query.error.message : "Failed to load React session view.")}
          </div>
        </div>
      ) : chat.messages.length === 0 && snapshot && snapshot.messages.length === 0 ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
            <div className="text-sm text-dls-secondary">No transcript yet.</div>
          </div>
        </div>
      ) : (
        <SessionTranscript
          messages={chat.messages}
          isStreaming={chatStreaming}
          developerMode={props.developerMode}
        />
      )}

      <div className="mx-auto w-full max-w-[800px] px-4">
        <div className="rounded-[28px] border border-dls-border bg-dls-surface shadow-[var(--dls-card-shadow)]">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={onComposerKeyDown}
            rows={5}
            placeholder="Describe your task..."
            className="min-h-[180px] w-full resize-none bg-transparent px-6 py-5 text-base text-dls-text outline-none placeholder:text-dls-secondary"
            disabled={model.transitionState !== "idle"}
          />
          <div className="flex items-center justify-between gap-3 border-t border-dls-border px-4 py-3">
            <div className="text-xs text-dls-secondary">
              {statusLabel(snapshot ?? undefined, chatStreaming)}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-dls-border px-4 py-2 text-sm text-dls-secondary transition-colors hover:bg-dls-hover disabled:opacity-50"
                onClick={handleAbort}
                disabled={!chatStreaming}
              >
                Stop
              </button>
              <button
                type="button"
                className="rounded-full bg-[var(--dls-accent)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)] disabled:opacity-50"
                onClick={handleSend}
                disabled={chatStreaming || !draft.trim() || model.transitionState !== "idle"}
              >
                Run task
              </button>
            </div>
          </div>
          {error ? (
            <div className="border-t border-red-6/30 px-4 py-3 text-sm text-red-11">{error}</div>
          ) : null}
        </div>
      </div>
      {props.developerMode ? <SessionDebugPanel model={model} snapshot={snapshot} /> : null}
    </div>
  );
}
