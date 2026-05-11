/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Cloud, MessageCircle, Settings } from "lucide-react";

import { t } from "../../../../i18n";
import { buildDenAuthUrl, readDenBootstrapConfig } from "../../../../app/lib/den";
import { usePlatform } from "../../../kernel/platform";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { useShellConfig } from "../../../shell/shell-config";
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

export function StatusBar(props: StatusBarProps) {
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const { config: shellConfig } = useShellConfig();
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
          <span className="relative flex size-2.5 shrink-0 items-center justify-center">
            {statusCopy.pulse ? (
              <span
                className={`absolute inline-flex size-full rounded-full ${statusCopy.pingClass}`}
              />
            ) : null}
            <span
              className={`relative inline-flex size-2.5 rounded-full ${statusCopy.dotClass}`}
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
          {shellConfig.cloudSignin && !denAuth.isSignedIn && denAuth.status !== "checking" ? (
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[#011627] px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-black"
              onClick={() => {
                const baseUrl = readDenBootstrapConfig().baseUrl;
                platform.openLink(buildDenAuthUrl(baseUrl, "sign-in"));
              }}
            >
              <Cloud className="size-3" />
              <span>Sign in</span>
            </button>
          ) : null}
          {shellConfig.docsButton ? (
            <button
              ref={docsButtonRef}
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={() => platform.openLink(DOCS_URL)}
              title={t("status.open_docs")}
              aria-label={t("status.open_docs")}
            >
              <BookOpen className="size-4" />
              <span className="text-[11px] font-medium">{t("status.docs")}</span>
            </button>
          ) : null}
          {shellConfig.feedbackButton ? (
            <button
              ref={feedbackButtonRef}
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={props.onSendFeedback}
              title={t("status.send_feedback")}
              aria-label={t("status.send_feedback")}
            >
              <MessageCircle className="size-4" />
              <span className="text-[11px] font-medium">
                {t("status.feedback")}
              </span>
            </button>
          ) : null}
          {props.showSettingsButton !== false ? (
            <button
              ref={settingsButtonRef}
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={props.onOpenSettings}
              title={
                props.settingsOpen ? t("status.back") : t("status.settings")
              }
              aria-label={
                props.settingsOpen ? t("status.back") : t("status.settings")
              }
            >
              <Settings className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
