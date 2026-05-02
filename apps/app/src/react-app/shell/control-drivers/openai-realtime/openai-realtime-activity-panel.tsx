/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Wrench } from "lucide-react";

import { useFeatureFlagsPreferences } from "../../../domains/settings/state/feature-flags-preferences";
import {
  readRealtimeControlTranscriptPanelEnabled,
  subscribeRealtimeControlPreferencesChanged,
} from "../../../domains/settings/state/realtime-control-preferences";
import { getRealtimeControlController } from "./openai-realtime-controller";

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

  return (
    <aside className="hidden min-h-0 w-[300px] shrink-0 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)] lg:flex">
      <div className="flex items-center justify-between gap-3 border-b border-dls-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-dls-text">
            {isListening ? (
              <span className="relative flex h-2 w-2 items-center justify-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-9/50" />
                <span className="inline-flex h-2 w-2 rounded-full bg-green-9" />
              </span>
            ) : isError ? (
              <span className="inline-flex h-2 w-2 rounded-full bg-red-9" />
            ) : null}
            Voice
          </div>
          <div className="truncate text-[11px] text-dls-secondary">
            {isListening
              ? realtimeState.micLabel ?? "System default"
              : isError
                ? realtimeState.lastError || "Connection error"
                : realtimeState.status === "connecting"
                  ? "Connecting…"
                  : realtimeState.status}
          </div>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {entries.length ? entries.map((entry) => {
          const isUser = entry.role === "user";
          const isAssistant = entry.role === "assistant";
          const isTool = entry.role === "tool";
          const isSystem = entry.role === "system";
          return (
            <div
              key={entry.id}
              className={`rounded-2xl px-3 py-2 ${
                isUser
                  ? "bg-[rgba(var(--dls-accent-rgb),0.08)] text-dls-text"
                  : isAssistant
                    ? "bg-dls-hover/50 text-dls-text"
                    : isTool
                      ? entry.status === "error"
                        ? "bg-red-3/30 text-red-11"
                        : "bg-amber-2/40 text-amber-11"
                      : isSystem
                        ? "bg-transparent text-dls-secondary"
                        : "bg-dls-hover/30 text-dls-secondary"
              }`}
            >
              {!isSystem && (
                <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide opacity-60">
                  {isTool ? <Wrench size={10} /> : null}
                  <span>{entry.role}</span>
                </div>
              )}
              <div className={`whitespace-pre-wrap break-words leading-relaxed ${isSystem ? "text-[11px]" : "text-[12px]"}`}>
                {entry.text}
              </div>
            </div>
          );
        }) : (
          <div className="px-2 py-6 text-center text-[12px] text-dls-secondary">
            Speak or type a command. Transcript, responses, and tool calls will appear here.
          </div>
        )}
      </div>
    </aside>
  );
}
