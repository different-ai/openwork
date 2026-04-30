/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { BookOpen, MessageCircle, Settings } from "lucide-react";

import { t } from "../../../../i18n";
import { usePlatform } from "../../../kernel/platform";
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
          <button
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
