/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Activity, Mic2, Terminal, X } from "lucide-react";

import { useFeatureFlagsPreferences } from "../../../domains/settings/state/feature-flags-preferences";
import {
  readRealtimeControlTranscriptPanelEnabled,
  writeRealtimeControlTranscriptPanelEnabled,
  subscribeRealtimeControlPreferencesChanged,
} from "../../../domains/settings/state/realtime-control-preferences";
import { getRealtimeControlController } from "./openai-realtime-controller";

function relativeTime(ts: number) {
  const delta = Math.round((Date.now() - ts) / 1000);
  if (delta < 5) return "now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

export function OpenAIRealtimeActivityPanel() {
  const { realtimeControlEnabled } = useFeatureFlagsPreferences();
  const [panelEnabled, setPanelEnabled] = useState(readRealtimeControlTranscriptPanelEnabled);
  const [realtimeState, setRealtimeState] = useState(() => getRealtimeControlController().state());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeRealtimeControlPreferencesChanged(() => {
      setPanelEnabled(readRealtimeControlTranscriptPanelEnabled());
    });
  }, []);

  useEffect(() => {
    if (!realtimeControlEnabled || !panelEnabled) return undefined;
    return getRealtimeControlController().subscribe(setRealtimeState);
  }, [panelEnabled, realtimeControlEnabled]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [realtimeState.transcriptLog]);

  const visible = realtimeControlEnabled && (panelEnabled || realtimeState.status === "connected" || realtimeState.status === "connecting");
  if (!visible || realtimeState.status === "idle") return null;

  const entries = realtimeState.transcriptLog ?? [];
  const isError = realtimeState.status === "error";
  const isConnected = realtimeState.status === "connected";
  const isListening = isConnected && realtimeState.mic === "on";

  const statusLine = isListening
    ? realtimeState.micLabel ?? "Listening"
    : isError
      ? realtimeState.lastError || "Connection error"
      : realtimeState.status === "connecting"
        ? "Connecting…"
        : realtimeState.status;

  const dismissPanel = () => {
    writeRealtimeControlTranscriptPanelEnabled(false);
    setPanelEnabled(false);
  };

  return (
    <aside className="hidden min-h-0 w-[280px] shrink-0 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface lg:flex">
      {/* ── header ── */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative flex h-5 w-5 shrink-0 items-center justify-center">
            {isListening ? (
              <>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-9/30" />
                <Mic2 size={13} className="relative text-green-10" />
              </>
            ) : isError ? (
              <Activity size={13} className="text-red-10" />
            ) : (
              <Activity size={13} className="text-dls-secondary" />
            )}
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-dls-text">Control</div>
            <div className="truncate text-[11px] text-dls-secondary">{statusLine}</div>
          </div>
        </div>
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          onClick={dismissPanel}
          title="Hide activity panel"
          aria-label="Hide activity panel"
        >
          <X size={13} />
        </button>
      </div>

      <div className="mx-3 border-t border-dls-border" />

      {/* ── transcript entries ── */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {entries.length ? (
          <div className="space-y-1">
            {entries.map((entry) => {
              const isUser = entry.role === "user";
              const isAssistant = entry.role === "assistant";
              const isTool = entry.role === "tool";
              const isSystem = entry.role === "system";
              const isPending = entry.status === "pending";
              const isToolError = isTool && entry.status === "error";

              if (isSystem) {
                return (
                  <div key={entry.id} className="px-1 py-1.5 text-[11px] leading-relaxed text-dls-secondary">
                    {entry.text}
                  </div>
                );
              }

              return (
                <div
                  key={entry.id}
                  className={`rounded-xl px-3 py-2 ${
                    isUser
                      ? "bg-[rgba(var(--dls-accent-rgb),0.06)]"
                      : isToolError
                        ? "bg-red-2/40"
                        : isTool
                          ? "bg-gray-2/60"
                          : isAssistant
                            ? "bg-dls-hover/40"
                            : "bg-dls-hover/30"
                  }`}
                >
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <div className={`flex items-center gap-1.5 text-[10px] font-medium ${
                      isUser
                        ? "text-dls-accent"
                        : isToolError
                          ? "text-red-10"
                          : isTool
                            ? "text-gray-9"
                            : "text-dls-secondary"
                    }`}>
                      {isTool ? <Terminal size={10} /> : null}
                      <span>{isUser ? "You" : isAssistant ? "Assistant" : isTool ? "Tool" : entry.role}</span>
                      {isPending ? (
                        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-current" />
                      ) : null}
                    </div>
                    <span className="text-[9px] tabular-nums text-gray-8">{relativeTime(entry.createdAt)}</span>
                  </div>
                  <div className={`whitespace-pre-wrap break-words text-[12px] leading-relaxed ${
                    isToolError ? "text-red-11" : "text-dls-text"
                  }`}>
                    {entry.text}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-dls-hover/70">
              <Mic2 size={16} className="text-dls-secondary" />
            </div>
            <div className="max-w-[200px] space-y-1">
              <div className="text-[12px] font-medium text-dls-text">Listening for commands</div>
              <div className="text-[11px] leading-relaxed text-dls-secondary">
                Speak or type a command. Transcript and tool activity will appear here.
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
