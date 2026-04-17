/** @jsxImportSource react */
import { ArrowRight, ChevronRight, Copy, Link, RefreshCcw, Shield } from "lucide-react";

import { t } from "../../../../i18n";
import type {
  OpenworkOpenCodeRouterHealthSnapshot,
  OpenworkOpenCodeRouterIdentityItem,
  OpenworkOpenCodeRouterSendResult,
  OpenworkServerStatus,
} from "../../../../app/lib/openwork-server";
import { Button } from "../../../design-system/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { TextInput } from "../../../design-system/text-input";

const agentFilePath = ".opencode/agents/opencode-router.md";

export type MessagingViewTab = "general" | "advanced";
export type MessagingChannel = "telegram" | "slack";
export type MessagingViewExpandedChannel = MessagingChannel | null;

export type MessagingViewProps = {
  busy: boolean;
  showHeader?: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  scopedOpenworkBaseUrl?: string;
  workspaceId: string | null;
  selectedWorkspaceRoot: string;
  refreshing: boolean;
  openworkReconnectBusy: boolean;
  reconnectStatus: string | null;
  reconnectError: string | null;
  health: OpenworkOpenCodeRouterHealthSnapshot | null;
  healthError: string | null;
  messagingEnabled: boolean;
  messagingSaving: boolean;
  messagingStatus: string | null;
  messagingError: string | null;
  messagingRestartRequired: boolean;
  messagingRestartBusy: boolean;
  activeTab: MessagingViewTab;
  expandedChannel: MessagingViewExpandedChannel;
  telegram: {
    identities: OpenworkOpenCodeRouterIdentityItem[];
    identitiesError: string | null;
    token: string;
    enabled: boolean;
    saving: boolean;
    status: string | null;
    error: string | null;
    botUsername: string | null;
    pairingCode: string | null;
  };
  slack: {
    identities: OpenworkOpenCodeRouterIdentityItem[];
    identitiesError: string | null;
    botToken: string;
    appToken: string;
    enabled: boolean;
    saving: boolean;
    status: string | null;
    error: string | null;
  };
  agent: {
    loading: boolean;
    saving: boolean;
    exists: boolean;
    content: string;
    draft: string;
    status: string | null;
    error: string | null;
  };
  sendTest: {
    channel: MessagingChannel;
    directory: string;
    peerId: string;
    autoBind: boolean;
    text: string;
    busy: boolean;
    status: string | null;
    error: string | null;
    result: OpenworkOpenCodeRouterSendResult | null;
  };
  modals: {
    messagingRiskOpen: boolean;
    messagingRestartPromptOpen: boolean;
    messagingRestartAction: "enable" | "disable";
    messagingDisableConfirmOpen: boolean;
    publicTelegramWarningOpen: boolean;
  };
  onRepairAndReconnect: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onSelectTab: (tab: MessagingViewTab) => void;
  onToggleExpandedChannel: (channel: MessagingChannel) => void;
  onOpenMessagingRisk: () => void;
  onCancelMessagingRisk: () => void;
  onConfirmEnableMessaging: () => void | Promise<void>;
  onOpenDisableMessagingConfirm: () => void;
  onCancelDisableMessagingConfirm: () => void;
  onConfirmDisableMessaging: () => void | Promise<void>;
  onCancelRestartPrompt: () => void;
  onConfirmRestartMessagingWorker: () => void | Promise<void>;
  onTelegramTokenChange: (value: string) => void;
  onTelegramEnabledChange: (value: boolean) => void;
  onOpenPublicTelegramWarning: () => void;
  onCancelPublicTelegramWarning: () => void;
  onConfirmPublicTelegram: () => void | Promise<void>;
  onConnectPrivateTelegram: () => void | Promise<void>;
  onDeleteTelegram: (id: string) => void | Promise<void>;
  onCopyTelegramPairingCode: () => void | Promise<void>;
  onHideTelegramPairingCode: () => void;
  onSlackBotTokenChange: (value: string) => void;
  onSlackAppTokenChange: (value: string) => void;
  onSlackEnabledChange: (value: boolean) => void;
  onConnectSlack: () => void | Promise<void>;
  onDeleteSlack: (id: string) => void | Promise<void>;
  onLoadAgentFile: () => void | Promise<void>;
  onCreateDefaultAgentFile: () => void | Promise<void>;
  onChangeAgentDraft: (value: string) => void;
  onSaveAgentFile: () => void | Promise<void>;
  onChangeSendChannel: (channel: MessagingChannel) => void;
  onChangeSendPeerId: (value: string) => void;
  onChangeSendDirectory: (value: string) => void;
  onChangeSendAutoBind: (value: boolean) => void;
  onChangeSendText: (value: string) => void;
  onSendTestMessage: () => void | Promise<void>;
};

function TelegramIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#229ED9" />
      <path d="M7 12.5l2.5 2L16 8.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 14.5l-.5 3 2-1.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SlackIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.5 2a2 2 0 012 2v4.5h-2a2 2 0 010-4h0V2z" fill="#E01E5A" />
      <path d="M2 9.5a2 2 0 012-2h4.5v2a2 2 0 01-4 0V9.5z" fill="#36C5F0" />
      <path d="M9.5 22a2 2 0 01-2-2v-4.5h2a2 2 0 010 4v2.5z" fill="#2EB67D" />
      <path d="M22 14.5a2 2 0 01-2 2h-4.5v-2a2 2 0 014 0h2.5z" fill="#ECB22E" />
      <path d="M8.5 9.5h2v2h-2z" fill="#36C5F0" />
      <path d="M13.5 9.5h2v2h-2z" fill="#ECB22E" />
      <path d="M8.5 14.5h2v-2h-2z" fill="#2EB67D" />
      <path d="M13.5 14.5h2v-2h-2z" fill="#E01E5A" />
    </svg>
  );
}

function StatusPill(props: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex-1 rounded-lg border border-gray-4 bg-gray-1 px-3.5 py-2.5">
      <div className="mb-0.5 text-[11px] text-gray-9">{props.label}</div>
      <div className={`text-[13px] font-semibold ${props.ok ? "text-gray-12" : "text-gray-8"}`}>
        {props.value}
      </div>
    </div>
  );
}

function formatLastActivityLabel(timestamp?: number | null) {
  if (!timestamp) return "-";
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  if (elapsedMs < 60_000) return t("identities.just_now");
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return t("identities.minutes_ago", undefined, { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("identities.hours_ago", undefined, { hours });
  const days = Math.floor(hours / 24);
  return t("identities.days_ago", undefined, { days });
}

export function MessagingView(props: MessagingViewProps) {
  const serverReady = props.openworkServerStatus === "connected";
  const scopedWorkspaceReady = Boolean(props.workspaceId?.trim());
  const workspaceScopeLabel =
    props.scopedOpenworkBaseUrl?.trim() || props.openworkServerUrl.trim() || t("identities.not_set");
  const defaultRoutingDirectory = props.selectedWorkspaceRoot.trim() || t("identities.not_set");
  const telegramBotLink = props.telegram.botUsername?.trim()
    ? `https://t.me/${props.telegram.botUsername.trim().replace(/^@+/, "")}`
    : null;
  const agentDirty = props.agent.draft !== props.agent.content;
  const hasTelegramConnected = props.telegram.identities.some((item) => item.enabled);
  const hasSlackConnected = props.slack.identities.some((item) => item.enabled);
  const connectedChannelCount = Number(hasTelegramConnected) + Number(hasSlackConnected);
  const messagesToday = props.health?.activity
    ? (props.health.activity.inboundToday ?? 0) + (props.health.activity.outboundToday ?? 0)
    : null;
  const lastActivityAt = props.health?.activity?.lastMessageAt ?? null;
  const lastActivityLabel = formatLastActivityLabel(lastActivityAt);
  const isWorkerOnline = props.health?.ok === true;
  const statusLabel = props.healthError
    ? t("identities.health_unavailable")
    : props.health
      ? props.health.ok
        ? t("identities.health_running")
        : t("identities.health_offline")
      : t("identities.health_unknown");

  return (
    <div className="w-full space-y-6">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          {props.showHeader !== false ? (
            <h1 className="text-lg font-bold tracking-tight text-gray-12">{t("identities.title")}</h1>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="h-8 px-3 text-xs"
              onClick={() => void props.onRepairAndReconnect()}
              disabled={props.busy || props.openworkReconnectBusy}
            >
              <RefreshCcw size={14} className={props.openworkReconnectBusy ? "animate-spin" : ""} />
              <span className="ml-1.5">{t("identities.repair_reconnect")}</span>
            </Button>
            <Button
              variant="outline"
              className="h-8 px-3 text-xs"
              onClick={() => void props.onRefresh()}
              disabled={!serverReady || props.refreshing}
            >
              <RefreshCcw size={14} className={props.refreshing ? "animate-spin" : ""} />
              <span className="ml-1.5">{t("common.refresh")}</span>
            </Button>
          </div>
        </div>

        {props.showHeader !== false ? (
          <p className="text-sm leading-relaxed text-gray-9">{t("identities.subtitle")}</p>
        ) : null}

        <div className="mt-1.5 break-all font-mono text-[11px] text-gray-8">
          {t("identities.workspace_scope_prefix")} {workspaceScopeLabel}
        </div>
        {props.reconnectStatus ? <div className="mt-1 text-[11px] text-gray-9">{props.reconnectStatus}</div> : null}
        {props.reconnectError ? <div className="mt-1 text-[11px] text-red-12">{props.reconnectError}</div> : null}
        {props.messagingStatus ? <div className="mt-1 text-[11px] text-gray-9">{props.messagingStatus}</div> : null}
        {props.messagingError ? <div className="mt-1 text-[11px] text-red-12">{props.messagingError}</div> : null}
      </div>

      {!serverReady ? (
        <div className="rounded-xl border border-gray-4 bg-gray-1 p-5">
          <div className="text-sm font-semibold text-gray-12">{t("identities.connect_server_title")}</div>
          <div className="mt-1 text-xs text-gray-10">{t("identities.connect_server_desc")}</div>
        </div>
      ) : null}

      {serverReady ? (
        <>
          {!scopedWorkspaceReady ? (
            <div className="rounded-xl border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
              {t("identities.workspace_id_required")}
            </div>
          ) : null}

          {props.messagingEnabled ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-2 rounded-xl border border-gray-4 bg-gray-1 p-1">
                <button
                  type="button"
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                    props.activeTab === "general" ? "bg-gray-12 text-gray-1" : "text-gray-10 hover:bg-gray-2"
                  }`}
                  onClick={() => props.onSelectTab("general")}
                >
                  {t("identities.tab_general")}
                </button>
                <button
                  type="button"
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                    props.activeTab === "advanced" ? "bg-gray-12 text-gray-1" : "text-gray-10 hover:bg-gray-2"
                  }`}
                  onClick={() => props.onSelectTab("advanced")}
                >
                  {t("settings.tab_advanced")}
                </button>
              </div>
              <Button
                variant="outline"
                className="h-8 px-3 text-xs"
                disabled={props.messagingSaving}
                onClick={props.onOpenDisableMessagingConfirm}
              >
                {t("identities.disable_messaging")}
              </Button>
            </div>
          ) : null}

          {!props.messagingEnabled ? (
            <div className="space-y-3 rounded-xl border border-gray-4 bg-gray-1 px-4 py-4">
              <div className="text-sm font-semibold text-gray-12">{t("identities.messaging_disabled_title")}</div>
              <p className="text-xs leading-relaxed text-gray-10">{t("identities.messaging_disabled_risk")}</p>
              <p className="text-xs leading-relaxed text-gray-10">{t("identities.messaging_disabled_hint")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  className="h-8 px-3 text-xs"
                  disabled={props.messagingSaving || !scopedWorkspaceReady}
                  onClick={props.onOpenMessagingRisk}
                >
                  {props.messagingSaving ? t("identities.enabling") : t("identities.enable_messaging")}
                </Button>
              </div>
            </div>
          ) : null}

          {props.activeTab === "general" && props.messagingEnabled ? (
            <>
              {props.messagingRestartRequired ? (
                <div className="rounded-xl border border-gray-4 bg-gray-1 px-4 py-3 text-xs leading-relaxed text-gray-10">
                  {t("identities.messaging_sidecar_not_running")}
                  <div className="mt-3">
                    <Button
                      variant="primary"
                      className="h-8 px-3 text-xs"
                      disabled={props.messagingRestartBusy}
                      onClick={() => void props.onConfirmRestartMessagingWorker()}
                    >
                      {props.messagingRestartBusy ? t("identities.restarting") : t("identities.restart_worker")}
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="space-y-3.5 rounded-xl border border-gray-4 bg-gray-1 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {isWorkerOnline ? (
                      <div className="h-2.5 w-2.5 rounded-full bg-emerald-9 animate-pulse" />
                    ) : (
                      <div className="h-2.5 w-2.5 rounded-full bg-gray-8" />
                    )}
                    <span className="text-[15px] font-semibold text-gray-12">
                      {isWorkerOnline
                        ? t("identities.worker_online")
                        : props.healthError
                          ? t("identities.worker_unavailable")
                          : t("identities.worker_offline")}
                    </span>
                  </div>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                      isWorkerOnline
                        ? "border-emerald-7/25 bg-emerald-1/40 text-emerald-11"
                        : props.healthError
                          ? "border-red-7/20 bg-red-1/40 text-red-12"
                          : "border-amber-7/25 bg-amber-1/40 text-amber-12"
                    }`}
                  >
                    {statusLabel}
                  </span>
                </div>

                {props.healthError ? (
                  <div className="rounded-lg border border-red-7/20 bg-red-1/30 px-3 py-2 text-xs text-red-12">
                    {props.healthError}
                  </div>
                ) : null}

                <div className="flex gap-3">
                  <StatusPill
                    label={t("identities.channels_label")}
                    value={`${connectedChannelCount} ${t("identities.channels_connected")}`}
                    ok={connectedChannelCount > 0}
                  />
                  <StatusPill
                    label={t("identities.messages_today")}
                    value={messagesToday == null ? "-" : String(messagesToday)}
                    ok={(messagesToday ?? 0) > 0}
                  />
                  <StatusPill
                    label={t("identities.last_activity")}
                    value={lastActivityLabel}
                    ok={Boolean(lastActivityAt)}
                  />
                </div>
              </div>

              <div>
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-9">
                  {t("identities.available_channels")}
                </div>

                <div className="flex flex-col gap-2.5">
                  <div
                    className={`overflow-hidden rounded-xl border transition-colors ${
                      hasTelegramConnected ? "border-emerald-7/30 bg-emerald-1/20" : "border-gray-4 bg-gray-1"
                    }`}
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-gray-2/50"
                      onClick={() => props.onToggleExpandedChannel("telegram")}
                    >
                      <TelegramIcon size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[15px] font-semibold text-gray-12">Telegram</span>
                          {hasTelegramConnected ? (
                            <span className="rounded-full bg-emerald-1/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-11">
                              {t("identities.connected_badge")}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-[13px] leading-snug text-gray-9">{t("identities.telegram_desc")}</div>
                      </div>
                      <ChevronRight
                        size={16}
                        className={`shrink-0 text-gray-8 transition-transform ${
                          props.expandedChannel === "telegram" ? "rotate-90" : ""
                        }`}
                      />
                    </button>

                    {props.expandedChannel === "telegram" ? (
                      <div className="space-y-3 border-t border-gray-4 px-4 py-4 animate-[fadeUp_0.2s_ease-out]">
                        {props.telegram.identitiesError ? (
                          <div className="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
                            {props.telegram.identitiesError}
                          </div>
                        ) : null}

                        {props.telegram.identities.length > 0 ? (
                          <>
                            <div className="space-y-2">
                              {props.telegram.identities.map((item) => (
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <div
                                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.running ? "bg-emerald-9" : "bg-gray-8"}`}
                                      />
                                      <span className="truncate text-[13px] font-semibold text-gray-12">
                                        <span className="font-mono text-[12px]">{item.id}</span>
                                      </span>
                                    </div>
                                    <div className="mt-0.5 pl-3.5 text-[11px] text-gray-9">
                                      {item.enabled ? t("identities.enabled_label") : t("identities.disabled_label")} · {item.running ? t("identities.running_label") : t("identities.stopped_label")} · {item.access === "private" ? t("identities.private_label") : t("identities.public_label")}
                                    </div>
                                  </div>
                                  <Button
                                    variant="outline"
                                    className="h-7 shrink-0 px-2.5 text-[11px]"
                                    disabled={props.telegram.saving || item.id === "env" || !scopedWorkspaceReady}
                                    onClick={() => void props.onDeleteTelegram(item.id)}
                                  >
                                    {t("identities.disconnect")}
                                  </Button>
                                </div>
                              ))}
                            </div>

                            <div className="flex gap-2.5">
                              <div className="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                                <div className="mb-0.5 text-[11px] text-gray-9">{t("identities.status_label")}</div>
                                <div className="flex items-center gap-1.5">
                                  <div
                                    className={`h-1.5 w-1.5 rounded-full ${
                                      props.telegram.identities.some((item) => item.running) ? "bg-emerald-9" : "bg-gray-8"
                                    }`}
                                  />
                                  <span
                                    className={`text-[13px] font-semibold ${
                                      props.telegram.identities.some((item) => item.running)
                                        ? "text-emerald-11"
                                        : "text-gray-10"
                                    }`}
                                  >
                                    {props.telegram.identities.some((item) => item.running)
                                      ? t("identities.status_active")
                                      : t("identities.status_stopped")}
                                  </span>
                                </div>
                              </div>
                              <div className="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                                <div className="mb-0.5 text-[11px] text-gray-9">{t("identities.identities_label")}</div>
                                <div className="text-[13px] font-semibold text-gray-12">
                                  {props.telegram.identities.length} {t("identities.configured_suffix")}
                                </div>
                              </div>
                              <div className="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                                <div className="mb-0.5 text-[11px] text-gray-9">{t("identities.channel_label")}</div>
                                <div className="text-[13px] font-semibold text-gray-12">
                                  {props.health?.channels.telegram ? t("common.on") : t("common.off")}
                                </div>
                              </div>
                            </div>

                            {props.telegram.status ? <div className="text-[11px] text-gray-9">{props.telegram.status}</div> : null}
                            {props.telegram.error ? <div className="text-[11px] text-red-12">{props.telegram.error}</div> : null}
                          </>
                        ) : null}

                        <div className="space-y-2.5">
                          {props.telegram.identities.length === 0 ? (
                            <div className="space-y-2.5 rounded-xl border border-gray-4 bg-gray-2/60 px-3.5 py-3">
                              <div className="text-[12px] font-semibold text-gray-12">{t("identities.quick_setup")}</div>
                              <ol className="space-y-2 text-[12px] leading-relaxed text-gray-10">
                                <li className="flex items-start gap-2">
                                  <span className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">1</span>
                                  <span>
                                    {t("identities.botfather_step1_open")}{" "}
                                    <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-medium text-gray-12 underline">
                                      @BotFather
                                    </a>{" "}
                                    {t("identities.botfather_step1_run")}{" "}
                                    <code className="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/newbot</code>.
                                  </span>
                                </li>
                                <li className="flex items-start gap-2">
                                  <span className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">2</span>
                                  <span>{t("identities.copy_bot_token_hint")}</span>
                                </li>
                                <li className="flex items-start gap-2">
                                  <span className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">3</span>
                                  <span>
                                    {t("identities.botfather_step3_choose")} <span className="font-medium text-gray-12">{t("identities.botfather_step3_public")}</span>{" "}
                                    {t("identities.botfather_step3_or_private")} <span className="font-medium text-gray-12">{t("identities.botfather_step3_private")}</span>{" "}
                                    {t("identities.botfather_step3_to_require")} <code className="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/pair &lt;code&gt;</code>.
                                  </span>
                                </li>
                              </ol>
                            </div>
                          ) : null}

                          <TextInput
                            label={t("identities.bot_token_label")}
                            placeholder={t("identities.bot_token_placeholder")}
                            type="password"
                            value={props.telegram.token}
                            onChange={(event) => props.onTelegramTokenChange(event.currentTarget.value)}
                            className="rounded-lg border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                          />

                          <label className="flex items-center gap-2 text-xs text-gray-11">
                            <input
                              type="checkbox"
                              checked={props.telegram.enabled}
                              onChange={(event) => props.onTelegramEnabledChange(event.currentTarget.checked)}
                            />
                            {t("identities.enabled_label")}
                          </label>

                          <div className="rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[11px] leading-relaxed text-gray-10">
                            {t("identities.telegram_bot_access_desc")}
                          </div>

                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <button
                              type="button"
                              onClick={props.onOpenPublicTelegramWarning}
                              disabled={props.telegram.saving || !scopedWorkspaceReady || !props.telegram.token.trim()}
                              className={`flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
                                props.telegram.saving || !scopedWorkspaceReady || !props.telegram.token.trim()
                                  ? "cursor-not-allowed border-gray-5 bg-gray-3 text-gray-8"
                                  : "cursor-pointer border-gray-6 bg-gray-12 text-gray-1 hover:bg-gray-11"
                              }`}
                            >
                              {props.telegram.saving ? (
                                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              ) : (
                                <Link size={15} />
                              )}
                              {props.telegram.saving ? t("identities.connecting") : t("identities.create_public_bot")}
                            </button>

                            <button
                              type="button"
                              onClick={() => void props.onConnectPrivateTelegram()}
                              disabled={props.telegram.saving || !scopedWorkspaceReady || !props.telegram.token.trim()}
                              className={`flex items-center justify-center gap-2 rounded-lg border-none px-4 py-2.5 text-sm font-semibold text-white transition-opacity ${
                                props.telegram.saving || !scopedWorkspaceReady || !props.telegram.token.trim()
                                  ? "cursor-not-allowed opacity-50"
                                  : "cursor-pointer opacity-100 hover:opacity-90"
                              }`}
                              style={{ background: "#229ED9" }}
                            >
                              {props.telegram.saving ? (
                                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              ) : (
                                <Shield size={15} />
                              )}
                              {props.telegram.saving ? t("identities.connecting") : t("identities.create_private_bot")}
                            </button>
                          </div>

                          {props.telegram.pairingCode ? (
                            <div className="space-y-2 rounded-xl border border-sky-7/25 bg-sky-1/40 px-3.5 py-3">
                              <div className="text-[12px] font-semibold text-sky-11">{t("identities.private_pairing_code")}</div>
                              <div className="rounded-md border border-sky-7/20 bg-sky-2/80 px-3 py-2 font-mono text-[13px] tracking-[0.08em] text-sky-12">
                                {props.telegram.pairingCode}
                              </div>
                              <div className="text-[11px] leading-relaxed text-sky-11/90">
                                {t("identities.pairing_code_instruction_prefix")}{" "}
                                <code className="rounded bg-sky-3/60 px-1 py-0.5 font-mono text-[10px]">
                                  /pair {props.telegram.pairingCode}
                                </code>
                                .
                              </div>
                              <div className="flex items-center gap-2">
                                <Button variant="outline" className="h-7 px-2.5 text-[11px]" onClick={() => void props.onCopyTelegramPairingCode()}>
                                  <Copy size={12} />
                                  <span className="ml-1">{t("identities.copy_code")}</span>
                                </Button>
                                <Button variant="outline" className="h-7 px-2.5 text-[11px]" onClick={props.onHideTelegramPairingCode}>
                                  {t("common.hide")}
                                </Button>
                              </div>
                            </div>
                          ) : null}

                          {telegramBotLink ? (
                            <a
                              href={telegramBotLink}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-2 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[12px] font-medium text-gray-11 hover:bg-gray-2"
                            >
                              <Link size={14} />
                              {t("identities.open_bot_link", undefined, { username: props.telegram.botUsername ?? "" })}
                            </a>
                          ) : null}

                          {props.telegram.identities.length === 0 && props.telegram.status ? (
                            <div className="text-[11px] text-gray-9">{props.telegram.status}</div>
                          ) : null}
                          {props.telegram.identities.length === 0 && props.telegram.error ? (
                            <div className="text-[11px] text-red-12">{props.telegram.error}</div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div
                    className={`overflow-hidden rounded-xl border transition-colors ${
                      hasSlackConnected ? "border-emerald-7/30 bg-emerald-1/20" : "border-gray-4 bg-gray-1"
                    }`}
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-gray-2/50"
                      onClick={() => props.onToggleExpandedChannel("slack")}
                    >
                      <SlackIcon size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[15px] font-semibold text-gray-12">Slack</span>
                          {hasSlackConnected ? (
                            <span className="rounded-full bg-emerald-1/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-11">
                              {t("identities.connected_badge")}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-[13px] leading-snug text-gray-9">{t("identities.slack_desc")}</div>
                      </div>
                      <ChevronRight
                        size={16}
                        className={`shrink-0 text-gray-8 transition-transform ${
                          props.expandedChannel === "slack" ? "rotate-90" : ""
                        }`}
                      />
                    </button>

                    {props.expandedChannel === "slack" ? (
                      <div className="space-y-3 border-t border-gray-4 px-4 py-4 animate-[fadeUp_0.2s_ease-out]">
                        {props.slack.identitiesError ? (
                          <div className="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
                            {props.slack.identitiesError}
                          </div>
                        ) : null}

                        {props.slack.identities.length > 0 ? (
                          <>
                            <div className="space-y-2">
                              {props.slack.identities.map((item) => (
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <div
                                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.running ? "bg-emerald-9" : "bg-gray-8"}`}
                                      />
                                      <span className="truncate text-[13px] font-semibold text-gray-12">
                                        <span className="font-mono text-[12px]">{item.id}</span>
                                      </span>
                                    </div>
                                    <div className="mt-0.5 pl-3.5 text-[11px] text-gray-9">
                                      {item.enabled ? t("identities.enabled_label") : t("identities.disabled_label")} · {item.running ? t("identities.running_label") : t("identities.stopped_label")}
                                    </div>
                                  </div>
                                  <Button
                                    variant="outline"
                                    className="h-7 shrink-0 px-2.5 text-[11px]"
                                    disabled={props.slack.saving || item.id === "env" || !scopedWorkspaceReady}
                                    onClick={() => void props.onDeleteSlack(item.id)}
                                  >
                                    {t("identities.disconnect")}
                                  </Button>
                                </div>
                              ))}
                            </div>

                            <div className="flex gap-2.5">
                              <div className="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                                <div className="mb-0.5 text-[11px] text-gray-9">{t("identities.status_label")}</div>
                                <div className="flex items-center gap-1.5">
                                  <div
                                    className={`h-1.5 w-1.5 rounded-full ${
                                      props.slack.identities.some((item) => item.running) ? "bg-emerald-9" : "bg-gray-8"
                                    }`}
                                  />
                                  <span
                                    className={`text-[13px] font-semibold ${
                                      props.slack.identities.some((item) => item.running)
                                        ? "text-emerald-11"
                                        : "text-gray-10"
                                    }`}
                                  >
                                    {props.slack.identities.some((item) => item.running)
                                      ? t("identities.status_active")
                                      : t("identities.status_stopped")}
                                  </span>
                                </div>
                              </div>
                              <div className="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                                <div className="mb-0.5 text-[11px] text-gray-9">{t("identities.identities_label")}</div>
                                <div className="text-[13px] font-semibold text-gray-12">
                                  {props.slack.identities.length} {t("identities.configured_suffix")}
                                </div>
                              </div>
                              <div className="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                                <div className="mb-0.5 text-[11px] text-gray-9">{t("identities.channel_label")}</div>
                                <div className="text-[13px] font-semibold text-gray-12">
                                  {props.health?.channels.slack ? t("common.on") : t("common.off")}
                                </div>
                              </div>
                            </div>

                            {props.slack.status ? <div className="text-[11px] text-gray-9">{props.slack.status}</div> : null}
                            {props.slack.error ? <div className="text-[11px] text-red-12">{props.slack.error}</div> : null}
                          </>
                        ) : null}

                        <div className="space-y-2.5">
                          {props.slack.identities.length === 0 ? (
                            <p className="text-[13px] leading-relaxed text-gray-10">{t("identities.slack_intro")}</p>
                          ) : null}

                          <div className="space-y-2">
                            <TextInput
                              label={t("identities.bot_token_label")}
                              placeholder="xoxb-..."
                              type="password"
                              value={props.slack.botToken}
                              onChange={(event) => props.onSlackBotTokenChange(event.currentTarget.value)}
                              className="rounded-lg border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                            />
                            <TextInput
                              label={t("identities.app_token_label")}
                              placeholder="xapp-..."
                              type="password"
                              value={props.slack.appToken}
                              onChange={(event) => props.onSlackAppTokenChange(event.currentTarget.value)}
                              className="rounded-lg border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                            />
                          </div>

                          <label className="flex items-center gap-2 text-xs text-gray-11">
                            <input
                              type="checkbox"
                              checked={props.slack.enabled}
                              onChange={(event) => props.onSlackEnabledChange(event.currentTarget.checked)}
                            />
                            {t("identities.enabled_label")}
                          </label>

                          <button
                            type="button"
                            onClick={() => void props.onConnectSlack()}
                            disabled={props.slack.saving || !scopedWorkspaceReady || !props.slack.botToken.trim() || !props.slack.appToken.trim()}
                            className={`flex items-center gap-2 rounded-lg border-none px-4 py-2.5 text-sm font-semibold text-white transition-opacity ${
                              props.slack.saving || !scopedWorkspaceReady || !props.slack.botToken.trim() || !props.slack.appToken.trim()
                                ? "cursor-not-allowed opacity-50"
                                : "cursor-pointer opacity-100 hover:opacity-90"
                            }`}
                            style={{ background: "#4A154B" }}
                          >
                            {props.slack.saving ? (
                              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                            ) : (
                              <Link size={15} />
                            )}
                            {props.slack.saving ? t("identities.connecting") : t("identities.connect_slack")}
                          </button>

                          {props.slack.identities.length === 0 && props.slack.status ? (
                            <div className="text-[11px] text-gray-9">{props.slack.status}</div>
                          ) : null}
                          {props.slack.identities.length === 0 && props.slack.error ? (
                            <div className="text-[11px] text-red-12">{props.slack.error}</div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {props.activeTab === "advanced" && props.messagingEnabled ? (
            <>
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-9">
                  {t("identities.message_routing_title")}
                </div>
                <p className="mb-3 text-[13px] leading-relaxed text-gray-9">{t("identities.message_routing_desc")}</p>

                <div className="space-y-3 rounded-xl border border-gray-4 bg-gray-2/50 px-4 py-3.5">
                  <div className="flex items-center gap-2">
                    <Shield size={16} className="text-gray-9" />
                    <span className="text-[13px] font-medium text-gray-11">{t("identities.default_routing")}</span>
                  </div>
                  <div className="flex items-center gap-2 pl-6">
                    <span className="rounded-md bg-gray-4 px-2.5 py-1 text-[12px] font-medium text-gray-11">
                      {t("identities.all_channels")}
                    </span>
                    <ArrowRight size={14} className="text-gray-8" />
                    <span className="rounded-md bg-dls-accent/10 px-2.5 py-1 text-[12px] font-medium text-dls-accent">
                      {defaultRoutingDirectory}
                    </span>
                  </div>
                </div>

                <div className="mt-2.5 text-xs text-gray-10">
                  {t("identities.routing_override_prefix")}{" "}
                  <code className="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/dir &lt;path&gt;</code>{" "}
                  {t("identities.routing_override_suffix")}
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-gray-4 bg-gray-1 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-semibold text-gray-12">{t("identities.agent_behavior_title")}</div>
                    <div className="mt-0.5 text-[12px] text-gray-9">{t("identities.agent_behavior_desc")}</div>
                  </div>
                  <span className="rounded-md border border-gray-4 bg-gray-2/50 px-2 py-1 text-[11px] font-mono text-gray-10">
                    {agentFilePath}
                  </span>
                </div>

                {props.health?.agent ? (
                  <div className="rounded-lg border border-gray-4 bg-gray-2/40 px-3 py-2 text-[11px] text-gray-10">
                    {t("identities.agent_scope_status", undefined, {
                      status: props.health.agent.loaded ? t("identities.agent_status_loaded") : t("identities.agent_status_missing"),
                      agent: props.health.agent.selected || t("identities.agent_none"),
                    })}
                  </div>
                ) : null}

                {props.agent.loading ? <div className="text-[11px] text-gray-9">{t("identities.agent_loading")}</div> : null}

                {!props.agent.exists && !props.agent.loading ? (
                  <div className="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
                    {t("identities.agent_not_found")}
                  </div>
                ) : null}

                <textarea
                  className="min-h-[220px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 font-mono text-[13px] text-gray-12 placeholder:text-gray-8"
                  placeholder={t("identities.agent_placeholder")}
                  value={props.agent.draft}
                  onChange={(event) => props.onChangeAgentDraft(event.currentTarget.value)}
                />

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => void props.onLoadAgentFile()}
                    disabled={props.agent.loading || !scopedWorkspaceReady}
                  >
                    {t("identities.reload")}
                  </Button>
                  {!props.agent.exists ? (
                    <Button
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      onClick={() => void props.onCreateDefaultAgentFile()}
                      disabled={props.agent.saving || !scopedWorkspaceReady}
                    >
                      {t("identities.create_default_file")}
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    onClick={() => void props.onSaveAgentFile()}
                    disabled={props.agent.saving || !scopedWorkspaceReady || !agentDirty}
                  >
                    {props.agent.saving ? t("identities.saving") : t("identities.save_behavior")}
                  </Button>
                  {agentDirty && !props.agent.saving ? (
                    <span className="text-[11px] text-gray-9">{t("identities.unsaved_changes")}</span>
                  ) : null}
                </div>

                {props.agent.status ? <div className="text-[11px] text-gray-9">{props.agent.status}</div> : null}
                {props.agent.error ? <div className="text-[11px] text-red-12">{props.agent.error}</div> : null}
              </div>

              <div className="space-y-3 rounded-xl border border-gray-4 bg-gray-1 p-4">
                <div>
                  <div className="text-[13px] font-semibold text-gray-12">{t("identities.send_test_title")}</div>
                  <div className="mt-0.5 text-[12px] text-gray-9">{t("identities.send_test_desc")}</div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-[12px] text-gray-9">{t("identities.channel_label")}</label>
                    <select
                      className="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12"
                      value={props.sendTest.channel}
                      onChange={(event) => props.onChangeSendChannel(event.currentTarget.value === "slack" ? "slack" : "telegram")}
                    >
                      <option value="telegram">Telegram</option>
                      <option value="slack">Slack</option>
                    </select>
                  </div>
                  <TextInput
                    label={t("identities.peer_id_label")}
                    placeholder={
                      props.sendTest.channel === "telegram"
                        ? t("identities.peer_id_placeholder_telegram")
                        : t("identities.peer_id_placeholder_slack")
                    }
                    value={props.sendTest.peerId}
                    onChange={(event) => props.onChangeSendPeerId(event.currentTarget.value)}
                    className="rounded-lg border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <TextInput
                    label={t("identities.directory_label")}
                    placeholder={defaultRoutingDirectory}
                    value={props.sendTest.directory}
                    onChange={(event) => props.onChangeSendDirectory(event.currentTarget.value)}
                    className="rounded-lg border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                  />
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2 text-xs text-gray-11">
                      <input
                        type="checkbox"
                        checked={props.sendTest.autoBind}
                        onChange={(event) => props.onChangeSendAutoBind(event.currentTarget.checked)}
                      />
                      {t("identities.auto_bind_label")}
                    </label>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[12px] text-gray-9">{t("identities.message_label")}</label>
                  <textarea
                    className="min-h-[90px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                    placeholder={t("identities.send_test_button")}
                    value={props.sendTest.text}
                    onChange={(event) => props.onChangeSendText(event.currentTarget.value)}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    onClick={() => void props.onSendTestMessage()}
                    disabled={props.sendTest.busy || !scopedWorkspaceReady || !props.sendTest.text.trim()}
                  >
                    {props.sendTest.busy ? t("identities.sending") : t("identities.send_test_button")}
                  </Button>
                  {props.sendTest.status ? <span className="text-[11px] text-gray-9">{props.sendTest.status}</span> : null}
                </div>

                {props.sendTest.error ? <div className="text-[11px] text-red-12">{props.sendTest.error}</div> : null}
                {props.sendTest.result ? (
                  <div className="space-y-1 rounded-lg border border-gray-4 bg-gray-2/40 px-3 py-2 font-mono text-[11px] text-gray-10">
                    <div>
                      sent={props.sendTest.result.sent} attempted={props.sendTest.result.attempted}
                      {props.sendTest.result.failures?.length ? ` failures=${props.sendTest.result.failures.length}` : ""}
                      {props.sendTest.result.reason?.trim() ? ` reason=${props.sendTest.result.reason}` : ""}
                    </div>
                    {props.sendTest.result.failures?.map((failure) => (
                      <div key={`${failure.identityId}:${failure.peerId}:${failure.error}`} className="text-red-11">
                        {failure.identityId}/{failure.peerId}: {failure.error}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          <ConfirmModal
            open={props.modals.messagingRiskOpen}
            title={t("identities.enable_messaging_title")}
            message={t("identities.enable_messaging_risk")}
            confirmLabel={props.messagingSaving ? t("identities.enabling") : t("identities.enable_messaging")}
            cancelLabel={t("common.cancel")}
            variant="danger"
            onCancel={props.onCancelMessagingRisk}
            onConfirm={() => void props.onConfirmEnableMessaging()}
          />

          <ConfirmModal
            open={props.modals.messagingRestartPromptOpen}
            title={t("identities.restart_worker_title")}
            message={
              props.modals.messagingRestartAction === "enable"
                ? t("identities.restart_to_enable_messaging")
                : t("identities.restart_to_disable_messaging")
            }
            confirmLabel={props.messagingRestartBusy ? t("identities.restarting") : t("identities.restart_worker")}
            cancelLabel={t("identities.later")}
            onCancel={props.onCancelRestartPrompt}
            onConfirm={() => void props.onConfirmRestartMessagingWorker()}
          />

          <ConfirmModal
            open={props.modals.messagingDisableConfirmOpen}
            title={t("identities.disable_messaging_title")}
            message={t("identities.disable_messaging_message")}
            confirmLabel={props.messagingSaving ? t("identities.disabling") : t("identities.disable_messaging")}
            cancelLabel={t("common.cancel")}
            onCancel={props.onCancelDisableMessagingConfirm}
            onConfirm={() => void props.onConfirmDisableMessaging()}
          />

          <ConfirmModal
            open={props.modals.publicTelegramWarningOpen}
            title={t("identities.public_bot_warning_title")}
            message={t("identities.public_bot_warning_message")}
            confirmLabel={t("identities.public_bot_confirm")}
            cancelLabel={t("common.cancel")}
            variant="danger"
            confirmButtonVariant="danger"
            cancelButtonVariant="primary"
            onCancel={props.onCancelPublicTelegramWarning}
            onConfirm={() => void props.onConfirmPublicTelegram()}
          />
        </>
      ) : null}
    </div>
  );
}
