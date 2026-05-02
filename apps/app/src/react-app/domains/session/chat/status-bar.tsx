/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Loader2, MessageCircle, Mic2, Settings, Square, Wrench } from "lucide-react";

import { t } from "../../../../i18n";
import { usePlatform } from "../../../kernel/platform";
import { useControlAction, useOpenworkControl, type OpenworkControlAction } from "../../../shell/control-mode";
import { getRealtimeControlController } from "../../../shell/realtime-control";
import { useFeatureFlagsPreferences } from "../../settings/state/feature-flags-preferences";
import {
  readRealtimeControlTranscriptPanelEnabled,
  subscribeRealtimeControlPreferencesChanged,
} from "../../settings/state/realtime-control-preferences";
import type { OpenworkServerStatus } from "../../../../app/lib/openwork-server";

const DOCS_URL = "https://openworklabs.com/docs";
const STATUS_BAR_BOOT_STARTED_AT = Date.now();
const STATUS_BAR_INITIALIZING_MS = 15_000;

export type StatusBarProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  settingsOpen: boolean;
  onSendFeedback: () => void;
  onOpenSettings: () => void;
  providerConnectedIds: string[];
  mcpConnectedCount: number;
  statusLabel?: string;
  statusDetail?: string;
  statusDotClass?: string;
  statusPingClass?: string;
  statusPulse?: boolean;
  showSettingsButton?: boolean;
  initializing?: boolean;
};

type StatusCopy = {
  label: string;
  detail: string;
  dotClass: string;
  pingClass: string;
  pulse: boolean;
};

function deriveStatusCopy(props: StatusBarProps): StatusCopy {
  if (props.statusLabel) {
    return {
      label: props.statusLabel,
      detail: props.statusDetail ?? "",
      dotClass: props.statusDotClass ?? "bg-green-9",
      pingClass: props.statusPingClass ?? "bg-green-9/45 animate-ping",
      pulse: props.statusPulse ?? true,
    };
  }

  const mcp = props.mcpConnectedCount;

  if (!props.clientConnected && props.openworkServerStatus === "disconnected" && props.initializing) {
    return {
      label: "Preparing workspace",
      detail: t("session.loading_detail"),
      dotClass: "bg-amber-9",
      pingClass: "bg-amber-9/35 animate-ping",
      pulse: true,
    };
  }

  if (props.clientConnected) {
    const detailBits: string[] = [];
    if (mcp > 0) {
      detailBits.push(t("status.mcp_connected", undefined, { count: mcp }));
    }
    if (!detailBits.length) {
      detailBits.push(t("status.ready_for_tasks"));
    }
    if (props.developerMode) {
      detailBits.push(t("status.developer_mode"));
    }
    return {
      label: t("status.openwork_ready"),
      detail: detailBits.join(" · "),
      dotClass: "bg-green-9",
      pingClass: "bg-green-9/45 animate-ping",
      pulse: true,
    };
  }

  if (props.openworkServerStatus === "limited") {
    return {
      label: t("status.limited_mode"),
      detail:
        mcp > 0
          ? t("status.limited_mcp_hint", undefined, { count: mcp })
          : t("status.limited_hint"),
      dotClass: "bg-amber-9",
      pingClass: "bg-amber-9/35",
      pulse: false,
    };
  }

  return {
    label: t("status.disconnected_label"),
    detail: t("status.disconnected_hint"),
    dotClass: "bg-red-9",
    pingClass: "bg-red-9/35",
    pulse: false,
  };
}

function RealtimeControlStatus() {
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

export function RealtimeTranscriptPanel() {
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

export function StatusBar(props: StatusBarProps) {
  const platform = usePlatform();
  const docsButtonRef = useRef<HTMLButtonElement>(null);
  const feedbackButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [initializing, setInitializing] = useState(
    () => Date.now() - STATUS_BAR_BOOT_STARTED_AT < STATUS_BAR_INITIALIZING_MS,
  );

  useEffect(() => {
    if (!initializing) return;
    const remaining = Math.max(
      0,
      STATUS_BAR_INITIALIZING_MS - (Date.now() - STATUS_BAR_BOOT_STARTED_AT),
    );
    const timeout = window.setTimeout(() => setInitializing(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [initializing]);

  const statusCopy = deriveStatusCopy({ ...props, initializing });
  const docsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.docs.open",
    label: "Open OpenWork docs",
    description: "Open the documentation from the status bar.",
    sideEffect: "external",
    targetRef: docsButtonRef,
    execute: () => platform.openLink(DOCS_URL),
  }), [platform]);
  useControlAction(docsControlAction);

  const feedbackControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.feedback.open",
    label: "Send feedback",
    description: "Open the OpenWork feedback surface from the status bar.",
    sideEffect: "external",
    targetRef: feedbackButtonRef,
    execute: props.onSendFeedback,
  }), [props.onSendFeedback]);
  useControlAction(feedbackControlAction);

  const settingsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.settings.open",
    label: props.settingsOpen ? "Go back from settings" : "Open settings from the status bar",
    description: "Use the visible settings button in the status bar.",
    sideEffect: "navigation",
    disabled: props.showSettingsButton === false,
    targetRef: settingsButtonRef,
    execute: props.onOpenSettings,
  }), [props.onOpenSettings, props.settingsOpen, props.showSettingsButton]);
  useControlAction(settingsControlAction);

  return (
    <div className="border-t border-dls-border bg-dls-surface">
      <div className="flex h-12 items-center justify-between gap-3 px-4 md:px-6 text-[12px] text-dls-secondary">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
            {statusCopy.pulse ? (
              <span
                className={`absolute inline-flex h-full w-full rounded-full ${statusCopy.pingClass}`}
              />
            ) : null}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusCopy.dotClass}`}
            />
          </span>
          <span className="shrink-0 font-medium text-dls-text">
            {statusCopy.label}
          </span>
          <span className="truncate text-dls-secondary">
            {statusCopy.detail}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <RealtimeControlStatus />
          <button
            ref={docsButtonRef}
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={() => platform.openLink(DOCS_URL)}
            title={t("status.open_docs")}
            aria-label={t("status.open_docs")}
          >
            <BookOpen className="h-4 w-4" />
            <span className="text-[11px] font-medium">{t("status.docs")}</span>
          </button>
          <button
            ref={feedbackButtonRef}
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={props.onSendFeedback}
            title={t("status.send_feedback")}
            aria-label={t("status.send_feedback")}
          >
            <MessageCircle className="h-4 w-4" />
            <span className="text-[11px] font-medium">
              {t("status.feedback")}
            </span>
          </button>
          {props.showSettingsButton !== false ? (
            <button
              ref={settingsButtonRef}
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={props.onOpenSettings}
              title={
                props.settingsOpen ? t("status.back") : t("status.settings")
              }
              aria-label={
                props.settingsOpen ? t("status.back") : t("status.settings")
              }
            >
              <Settings className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
