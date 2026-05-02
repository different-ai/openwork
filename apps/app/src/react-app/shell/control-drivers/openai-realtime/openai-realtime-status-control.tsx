/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Loader2, Mic2, Square } from "lucide-react";

import { useFeatureFlagsPreferences } from "../../../domains/settings/state/feature-flags-preferences";
import { useOpenworkControl } from "../../control/control-provider";
import { getRealtimeControlController } from "./openai-realtime-controller";

export function OpenAIRealtimeStatusControl() {
  const { realtimeControlEnabled } = useFeatureFlagsPreferences();
  const control = useOpenworkControl();
  const [realtimeState, setRealtimeState] = useState(() => getRealtimeControlController().state());

  useEffect(() => {
    if (!realtimeControlEnabled) return undefined;
    return getRealtimeControlController().subscribe(setRealtimeState);
  }, [realtimeControlEnabled]);

  if (!realtimeControlEnabled || !control) return null;

  const connectAction = control.actions.find((action) => action.id === "remote.realtime.connect");
  const disconnectAction = control.actions.find((action) => action.id === "remote.realtime.disconnect");
  const connected = realtimeState.status === "connected";
  const busy = realtimeState.status === "connecting" || realtimeState.mic === "requesting" || connectAction?.busy || disconnectAction?.busy;
  const unavailable = connected ? disconnectAction?.disabled === true : connectAction?.disabled !== false;
  const title = realtimeState.lastError || (connected ? "Stop Realtime control" : "Start Realtime control");
  const transcript = realtimeState.lastTranscript?.trim() ?? "";
  const outputText = realtimeState.lastText?.trim() ?? "";
  const stateText = realtimeState.lastError
    ? realtimeState.lastError
    : transcript
      ? `You: ${transcript}`
      : outputText
      ? outputText
      : realtimeState.status === "connecting"
        ? realtimeState.mic === "requesting"
          ? `Requesting microphone${realtimeState.micPermission ? ` (${realtimeState.micPermission})` : ""}…`
          : "Connecting Realtime…"
        : connected
          ? realtimeState.mic === "on"
            ? `Mic live${realtimeState.micLabel ? ` · ${realtimeState.micLabel}` : ""}${realtimeState.micTrack ? ` (${realtimeState.micTrack})` : ""} — listening for commands`
            : "Realtime connected"
          : "Preview voice control";
  const label = busy
    ? "Control…"
    : connected
      ? "Control on"
      : realtimeState.status === "error"
        ? "Control error"
        : "Control";

  const handleClick = async () => {
    if (busy || unavailable) return;
    const actionId = connected ? "remote.realtime.disconnect" : "remote.realtime.connect";
    await control.executeAction(actionId);
    setRealtimeState(getRealtimeControlController().state());
  };

  return (
    <div className="hidden max-w-[360px] items-center gap-2 md:flex">
      <div
        className={`min-w-0 truncate rounded-full px-2.5 py-1 text-[11px] ${
          realtimeState.lastError
            ? "bg-red-3/45 text-red-11"
            : connected || busy
              ? "bg-[rgba(var(--dls-accent-rgb),0.09)] text-dls-accent"
              : "bg-dls-hover/55 text-dls-secondary"
        }`}
        title={stateText}
      >
        {stateText}
      </div>
      <button
        type="button"
        className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
          connected
            ? "bg-[rgba(var(--dls-accent-rgb),0.13)] text-dls-accent hover:bg-[rgba(var(--dls-accent-rgb),0.18)]"
            : realtimeState.status === "error"
              ? "bg-red-3/50 text-red-10 hover:bg-red-4/70"
              : "bg-dls-hover/70 text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
        }`}
        onClick={() => void handleClick()}
        disabled={busy || unavailable}
        title={title}
        aria-label={title}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : connected ? (
          <Square className="h-3.5 w-3.5" />
        ) : (
          <Mic2 className="h-3.5 w-3.5" />
        )}
        <span>{label}</span>
      </button>
    </div>
  );
}
