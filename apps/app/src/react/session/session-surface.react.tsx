/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { createClient, unwrap } from "../../app/lib/opencode";
import { abortSessionSafe } from "../../app/lib/opencode-session";
import type { OpenworkServerClient, OpenworkSessionMessage, OpenworkSessionSnapshot } from "../../app/lib/openwork-server";
import { SessionDebugPanel } from "./debug-panel.react";
import { deriveSessionRenderModel } from "./transition-controller";

type SessionSurfaceProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  developerMode: boolean;
};

function partText(part: Record<string, unknown>) {
  if (typeof part.text === "string" && part.text.trim()) return part.text.trim();
  if (typeof part.reasoning === "string" && part.reasoning.trim()) return part.reasoning.trim();
  try {
    return JSON.stringify(part, null, 2);
  } catch {
    return "[unsupported part]";
  }
}

function roleLabel(role: string) {
  if (role === "user") return "You";
  if (role === "assistant") return "OpenWork";
  return role;
}

function statusLabel(snapshot: OpenworkSessionSnapshot | undefined, busy: boolean) {
  if (busy) return "Running...";
  if (snapshot?.status.type === "busy") return "Running...";
  if (snapshot?.status.type === "retry") return `Retrying: ${snapshot.status.message}`;
  return "Ready";
}

function MessageCard(props: { message: OpenworkSessionMessage }) {
  const role = props.message.info.role;
  const bubbleClass =
    role === "user"
      ? "border-blue-6/35 bg-blue-3/25 text-gray-12"
      : "border-dls-border bg-dls-surface text-gray-12";

  return (
    <article className={`mx-auto flex w-full max-w-[760px] ${role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={`w-full rounded-[24px] border px-5 py-4 shadow-[var(--dls-card-shadow)] ${bubbleClass}`}>
        <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-dls-secondary">
          {roleLabel(role)}
        </div>
        <div className="space-y-3">
          {props.message.parts.map((part) => (
            <div key={part.id} className="text-sm leading-7 whitespace-pre-wrap break-words">
              {partText(part as Record<string, unknown>)}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export function SessionSurface(props: SessionSurfaceProps) {
  const [draft, setDraft] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{
    sessionId: string;
    snapshot: OpenworkSessionSnapshot;
  } | null>(null);

  const opencodeClient = useMemo(
    () => createClient(props.opencodeBaseUrl, undefined, { token: props.openworkToken, mode: "openwork" }),
    [props.opencodeBaseUrl, props.openworkToken],
  );

  const queryKey = useMemo(
    () => ["react-session-snapshot", props.workspaceId, props.sessionId],
    [props.workspaceId, props.sessionId],
  );

  const query = useQuery<OpenworkSessionSnapshot>({
    queryKey,
    queryFn: async () => (await props.client.getSessionSnapshot(props.workspaceId, props.sessionId, { limit: 140 })).item,
    staleTime: 500,
    refetchInterval: (current) =>
      actionBusy || current.state.data?.status.type === "busy" || current.state.data?.status.type === "retry"
        ? 800
        : false,
  });

  useEffect(() => {
    if (!query.data) return;
    setRendered({ sessionId: props.sessionId, snapshot: query.data });
  }, [props.sessionId, query.data]);

  const snapshot = query.data ?? rendered?.snapshot ?? null;
  const model = deriveSessionRenderModel({
    intendedSessionId: props.sessionId,
    renderedSessionId: query.data ? props.sessionId : rendered?.sessionId ?? null,
    hasSnapshot: Boolean(snapshot),
    isFetching: query.isFetching,
    isError: query.isError,
  });

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || actionBusy) return;
    setActionBusy(true);
    setError(null);
    try {
      unwrap(
        await opencodeClient.session.promptAsync({
          sessionID: props.sessionId,
          parts: [{ type: "text", text }],
        }),
      );
      setDraft("");
      await query.refetch();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to send prompt.");
    } finally {
      setActionBusy(false);
    }
  };

  const handleAbort = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    setError(null);
    try {
      await abortSessionSafe(opencodeClient, props.sessionId);
      await query.refetch();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to stop run.");
    } finally {
      setActionBusy(false);
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

      {!snapshot && query.isLoading ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
            <div className="text-sm text-dls-secondary">Loading React session view...</div>
          </div>
        </div>
      ) : query.isError && !snapshot ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-xl rounded-3xl border border-red-6/40 bg-red-3/20 px-6 py-5 text-sm text-red-11">
            {query.error instanceof Error ? query.error.message : "Failed to load React session view."}
          </div>
        </div>
      ) : snapshot && snapshot.messages.length === 0 ? (
        <div className="px-6 py-16">
          <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
            <div className="text-sm text-dls-secondary">No transcript yet.</div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {snapshot?.messages.map((message) => (
            <MessageCard key={message.info.id} message={message} />
          ))}
        </div>
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
              {statusLabel(snapshot ?? undefined, actionBusy)}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-dls-border px-4 py-2 text-sm text-dls-secondary transition-colors hover:bg-dls-hover disabled:opacity-50"
                onClick={handleAbort}
                disabled={actionBusy || snapshot?.status.type !== "busy"}
              >
                Stop
              </button>
              <button
                type="button"
                className="rounded-full bg-[var(--dls-accent)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)] disabled:opacity-50"
                onClick={handleSend}
                disabled={actionBusy || !draft.trim() || model.transitionState !== "idle"}
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
