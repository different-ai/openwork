import { Show, createMemo } from "solid-js";
import { MessageCircle, Settings } from "lucide-solid";

import { t } from "../../i18n";
import { useConnections } from "../connections/provider";
import type { OpenworkServerStatus } from "../lib/openwork-server";

type StatusBarProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  settingsOpen: boolean;
  onSendFeedback: () => void;
  onOpenSettings: () => void;
  providerConnectedIds: string[];
  statusLabel?: string;
  statusDetail?: string;
  statusDotClass?: string;
  statusPingClass?: string;
  statusPulse?: boolean;
  showSettingsButton?: boolean;
};

export default function StatusBar(props: StatusBarProps) {
  const connections = useConnections();
  const providerConnectedCount = createMemo(() => props.providerConnectedIds?.length ?? 0);
  const mcpConnectedCount = createMemo(
    () => Object.values(connections.mcpStatuses() ?? {}).filter((status) => status?.status === "connected").length,
  );

  const statusCopy = createMemo(() => {
    if (props.statusLabel) {
      return {
        label: props.statusLabel,
        detail: props.statusDetail ?? "",
        dotClass: props.statusDotClass ?? "bg-green-9",
        pingClass: props.statusPingClass ?? "bg-green-9/45 animate-ping",
        pulse: props.statusPulse ?? true,
      };
    }

    const providers = providerConnectedCount();
    const mcp = mcpConnectedCount();

    if (props.clientConnected) {
      const detailBits: string[] = [];
      if (providers > 0) {
        detailBits.push(t("status.providers_connected", undefined, { count: providers, plural: providers === 1 ? "" : "s" }));
      }
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
  });

  return (
    <div class="border-t border-dls-border bg-dls-surface">
      <div class="flex h-12 items-center justify-between gap-3 px-4 md:px-6 text-[12px] text-dls-secondary">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
            <Show when={statusCopy().pulse}>
              <span class={`absolute inline-flex h-full w-full rounded-full ${statusCopy().pingClass}`} />
            </Show>
            <span class={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusCopy().dotClass}`} />
          </span>
          <span class="shrink-0 font-medium text-dls-text">{statusCopy().label}</span>
          <span class="truncate text-dls-secondary">{statusCopy().detail}</span>
        </div>

        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={props.onSendFeedback}
            title={t("status.send_feedback")}
            aria-label={t("status.send_feedback")}
          >
            <MessageCircle class="h-4 w-4" />
            <span class="text-[11px] font-medium">{t("status.feedback")}</span>
          </button>
          <Show when={props.showSettingsButton !== false}>
            <button
              type="button"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={props.onOpenSettings}
              title={props.settingsOpen ? t("status.back") : t("status.settings")}
              aria-label={props.settingsOpen ? t("status.back") : t("status.settings")}
            >
              <Settings class="h-4 w-4" />
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
