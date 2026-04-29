/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";

import { Button } from "../../../design-system/button";
import { createSessionAuditStore, type AuditEntry } from "../sync/session-audit-store";
import { downloadSessionAuditJson } from "./session-audit-export";

type SessionAuditTimelineProps = {
  opencodeBaseUrl: string;
  openworkToken: string;
  sessionId: string;
  transcriptMessages?: UIMessage[];
  onClose: () => void;
};

function entryIcon(entry: AuditEntry): string {
  if (entry.source === "tool") return "🔧";
  if (entry.source === "pty") return "🖥️";
  return "⚠️";
}

function statusBadgeClass(status: AuditEntry["status"]): string {
  if (status === "running") return "border-blue-7/35 bg-blue-3/25 text-blue-11";
  if (status === "completed") return "border-green-7/35 bg-green-3/25 text-green-11";
  if (status === "error") return "border-red-7/35 bg-red-3/25 text-red-11";
  return "border-gray-6 bg-gray-3/50 text-gray-10";
}

function statusLabel(status: AuditEntry["status"]): string {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  return "pending";
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  const ss = `${date.getSeconds()}`.padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function deriveEntriesFromTranscript(sessionId: string, messages: UIMessage[] | undefined): AuditEntry[] {
  if (!messages?.length) return [];
  const entries: AuditEntry[] = [];
  let index = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      index += 1;
      const state = part.state;
      let status: AuditEntry["status"] = "running";
      let outputSummary = "";
      if (state === "output-available") {
        status = "completed";
        outputSummary = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
      } else if (state === "output-error") {
        status = "error";
        outputSummary = part.errorText;
      }
      const inputSummary = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
      entries.push({
        id: `fallback:${sessionId}:${message.id}:${part.toolCallId ?? index}`,
        source: "tool",
        sessionId,
        timestamp: Date.now() + index,
        title: part.toolName || "Tool",
        status,
        inputSummary,
        outputSummary,
        toolName: part.toolName || "Tool",
        callId: part.toolCallId || undefined,
      });
    }
  }
  return entries;
}

export function SessionAuditTimeline(props: SessionAuditTimelineProps) {
  const store = useMemo(
    () =>
      createSessionAuditStore({
        opencodeBaseUrl: props.opencodeBaseUrl,
        openworkToken: props.openworkToken,
        sessionId: props.sessionId,
      }),
    [props.opencodeBaseUrl, props.openworkToken, props.sessionId],
  );

  useEffect(() => () => store.dispose(), [store]);

  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = useCallback(
    () => store.getSnapshot(),
    [store],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const fallbackEntries = useMemo(
    () => deriveEntriesFromTranscript(props.sessionId, props.transcriptMessages),
    [props.sessionId, props.transcriptMessages],
  );
  const visibleEntries = snapshot.entries.length > 0 ? snapshot.entries : fallbackEntries;

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-dls-border bg-dls-surface">
      <div className="flex items-center justify-between border-b border-dls-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-dls-text">Session Audit</div>
          <div className="text-xs text-dls-secondary">{visibleEntries.length} entries</div>
        </div>
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={props.onClose}>
          Close
        </Button>
      </div>

      {snapshot.error ? (
        <div className="mx-3 mt-3 rounded-md border border-red-7/35 bg-red-3/15 px-3 py-2 text-xs text-red-11">
          {snapshot.error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {visibleEntries.length === 0 ? (
          <div className="flex h-full min-h-[220px] items-center justify-center text-center text-sm text-dls-secondary">
            Waiting for agent activity...
          </div>
        ) : (
          <div className="space-y-2.5">
            {visibleEntries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-dls-border bg-dls-hover/35 px-3 py-2.5"
              >
                <div className="mb-1 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm text-dls-text">
                      <span aria-hidden>{entryIcon(entry)}</span>
                      <span className="truncate font-medium">{entry.toolName || entry.title}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-dls-secondary">
                      {formatTimestamp(entry.timestamp)}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusBadgeClass(entry.status)}`}
                  >
                    {statusLabel(entry.status)}
                  </span>
                </div>
                {entry.inputSummary ? (
                  <div className="text-xs leading-5 text-dls-secondary">{entry.inputSummary}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-dls-border px-3 py-3">
        <Button
          variant="outline"
          className="w-full"
          onClick={() => downloadSessionAuditJson(visibleEntries, props.sessionId)}
          disabled={visibleEntries.length === 0}
        >
          Export Session Log
        </Button>
      </div>
    </aside>
  );
}
