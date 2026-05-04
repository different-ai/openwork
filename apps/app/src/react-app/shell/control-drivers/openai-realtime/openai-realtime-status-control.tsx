/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Loader2, Mic2, MicOff } from "lucide-react";

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
  const isListening = connected && realtimeState.mic === "on";

  const title = realtimeState.lastError || (connected ? "Disconnect voice control" : "Connect voice control");

  // Compact status text for the pill — keep short and readable
  const stateText = realtimeState.lastError
    ? "Error"
    : realtimeState.status === "connecting"
      ? "Connecting…"
      : isListening
        ? "Listening"
        : connected
          ? "Connected"
          : "";

  const handleClick = async () => {
    if (busy || unavailable) return;
    const actionId = connected ? "remote.realtime.disconnect" : "remote.realtime.connect";
    await control.executeAction(actionId);
    setRealtimeState(getRealtimeControlController().state());
  };

  return (
    <div className="hidden items-center gap-1 md:flex">
      {stateText ? (
        <span
          className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
            realtimeState.lastError
              ? "text-red-10"
              : connected || busy
                ? "text-dls-accent"
                : "text-dls-secondary"
          }`}
          title={realtimeState.lastError || title}
        >
          {stateText}
        </span>
      ) : null}
      <button
        type="button"
        className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
          connected
            ? "text-dls-accent hover:bg-[rgba(var(--dls-accent-rgb),0.08)]"
            : realtimeState.status === "error"
              ? "text-red-10 hover:bg-red-2/50"
              : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
        }`}
        onClick={() => void handleClick()}
        disabled={busy || unavailable}
        title={title}
        aria-label={title}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : connected ? (
          <MicOff className="h-3.5 w-3.5" />
        ) : (
          <Mic2 className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
