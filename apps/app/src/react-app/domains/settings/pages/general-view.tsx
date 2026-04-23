/** @jsxImportSource react */
import { ArrowUpRight, LifeBuoy, MessageCircle, PlugZap } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { ProviderIcon } from "../../../design-system/provider-icon";
import {
  AuthorizedFoldersPanel,
  type AuthorizedFoldersPanelProps,
} from "../panels/authorized-folders-panel";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
const settingsPanelSoftClass = "rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4";

type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
};

export type GeneralSettingsViewProps = {
  authorizedFoldersPanel: AuthorizedFoldersPanelProps;
  busy: boolean;
  providerAuthBusy: boolean;
  providerStatusLabel: string;
  providerStatusStyle: string;
  providerSummary: string;
  connectedProviders: ConnectedProvider[];
  disconnectingProviderId: string | null;
  providerConnectError: string | null;
  providerDisconnectStatus: string | null;
  providerDisconnectError: string | null;
  onOpenProviderAuth: () => void | Promise<void>;
  onDisconnectProvider: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (source?: ConnectedProvider["source"]) => boolean;
  defaultModelLabel: string;
  defaultModelRef: string;
  onChangeDefaultModel: () => void;
  showThinking: boolean;
  onToggleShowThinking: () => void;
  defaultModelVariantLabel: string;
  onConfigureModelBehavior: () => void;
  autoCompactContext: boolean;
  autoCompactContextBusy: boolean;
  onToggleAutoCompactContext: () => void;
  onSendFeedback: () => void;
  onJoinDiscord: () => void;
  onReportIssue: () => void;
};

function providerSourceLabel(source?: ConnectedProvider["source"]) {
  if (source === "env") return t("settings.provider_source_env");
  if (source === "api") return t("providers.api_key_label");
  if (source === "config") return t("settings.provider_source_config");
  if (source === "custom") return t("settings.provider_source_custom");
  return null;
}

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  return (
    <div className="space-y-6">
      <AuthorizedFoldersPanel {...props.authorizedFoldersPanel} />

      <div className={`${settingsPanelClass} space-y-4`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <PlugZap size={16} className="text-gray-11" />
              <div className="text-sm font-medium text-gray-12">
                {t("settings.providers_title")}
              </div>
            </div>
            <div className="mt-1 text-xs text-gray-9">{t("settings.providers_desc")}</div>
          </div>
          <div className={`rounded-full border px-2 py-1 text-xs ${props.providerStatusStyle}`}>
            {props.providerStatusLabel}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void props.onOpenProviderAuth()}
            disabled={props.busy || props.providerAuthBusy}
          >
            {props.providerAuthBusy
              ? t("settings.loading_providers")
              : t("settings.connect_provider")}
          </Button>
          <div className="text-xs text-gray-10">{props.providerSummary}</div>
        </div>

        {props.connectedProviders.length > 0 ? (
          <div className="space-y-2">
            {props.connectedProviders.map((provider) => (
              <div
                key={provider.id}
                className={`${settingsPanelSoftClass} flex flex-wrap items-center justify-between gap-3 px-3 py-2`}
              >
                <div className="min-w-0 flex items-center gap-3">
                  <ProviderIcon providerId={provider.id} size={18} className="text-gray-12" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-12">{provider.name}</div>
                    <div className="truncate font-mono text-[11px] text-gray-8">{provider.id}</div>
                    {providerSourceLabel(provider.source) ? (
                      <div className="mt-1 truncate text-[11px] text-gray-9">
                        {providerSourceLabel(provider.source)}
                      </div>
                    ) : null}
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="h-8 px-3 py-0 text-xs"
                  onClick={() => void props.onDisconnectProvider(provider.id)}
                  disabled={
                    props.busy ||
                    props.providerAuthBusy ||
                    props.disconnectingProviderId !== null ||
                    !props.canDisconnectProvider(provider.source)
                  }
                >
                  {props.disconnectingProviderId === provider.id
                    ? t("settings.disconnecting")
                    : props.canDisconnectProvider(provider.source)
                      ? t("settings.disconnect")
                      : t("settings.managed_by_env")}
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {props.providerConnectError ? (
          <div className="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
            {props.providerConnectError}
          </div>
        ) : null}
        {props.providerDisconnectStatus ? (
          <div className={`${settingsPanelSoftClass} px-3 py-2 text-xs text-gray-10`}>
            {props.providerDisconnectStatus}
          </div>
        ) : null}
        {props.providerDisconnectError ? (
          <div className="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
            {props.providerDisconnectError}
          </div>
        ) : null}

        <div className="text-[11px] text-gray-9">{t("settings.api_keys_info")}</div>
      </div>

      <div className={`${settingsPanelClass} space-y-4`}>
        <div>
          <div className="text-sm font-medium text-gray-12">{t("settings.model_title")}</div>
          <div className="text-xs text-gray-10">{t("settings.model_section_desc")}</div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
          <div className="min-w-0">
            <div className="truncate text-sm text-gray-12">{props.defaultModelLabel}</div>
            <div className="truncate font-mono text-xs text-gray-7">{props.defaultModelRef}</div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.onChangeDefaultModel}
            disabled={props.busy}
          >
            {t("settings.change")}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
          <div className="min-w-0">
            <div className="text-sm text-gray-12">{t("settings.show_model_reasoning")}</div>
            <div className="text-xs text-gray-7">{t("settings.show_model_reasoning_desc")}</div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.onToggleShowThinking}
            disabled={props.busy}
          >
            {props.showThinking ? t("settings.on") : t("settings.off")}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
          <div className="min-w-0">
            <div className="text-sm text-gray-12">{t("settings.model_behavior")}</div>
            <div className="truncate text-xs text-gray-7">{t("settings.model_behavior_desc")}</div>
            <div className="mt-1 truncate text-xs font-medium text-gray-8">
              {props.defaultModelVariantLabel}
            </div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.onConfigureModelBehavior}
            disabled={props.busy}
          >
            {t("settings.configure")}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
          <div className="min-w-0">
            <div className="text-sm text-gray-12">{t("settings.auto_compact")}</div>
            <div className="text-xs text-gray-7">{t("settings.auto_compact_desc")}</div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.onToggleAutoCompactContext}
            disabled={props.busy || props.autoCompactContextBusy}
          >
            {props.autoCompactContext ? t("settings.on") : t("settings.off")}
          </Button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-blue-7/30 bg-gradient-to-br from-blue-3/35 via-gray-1/75 to-cyan-3/30 p-5">
        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-blue-6/20 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-12 left-6 h-24 w-24 rounded-full bg-cyan-6/20 blur-2xl" />

        <div className="relative space-y-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-blue-7/35 bg-blue-4/25 px-2.5 py-1 text-[11px] font-medium text-blue-11">
              <LifeBuoy size={12} />
              {t("settings.feedback_badge")}
            </div>
            <div className="text-sm font-semibold text-gray-12">{t("settings.feedback_title")}</div>
            <div className="max-w-[58ch] text-xs text-gray-10">{t("settings.feedback_desc")}</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-transparent bg-blue-9 px-4 text-xs font-semibold text-blue-1 transition-colors duration-150 active:scale-[0.98] hover:bg-blue-10 focus:outline-none focus:ring-2 focus:ring-blue-7/30"
              onClick={props.onSendFeedback}
            >
              <MessageCircle size={14} />
              {t("settings.send_feedback")}
              <ArrowUpRight size={13} />
            </button>

            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-blue-7/35 bg-gray-1/70 px-3 text-xs font-medium text-gray-11 transition-colors hover:border-blue-7/50 hover:text-gray-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-7/30"
              onClick={props.onJoinDiscord}
            >
              {t("settings.join_discord")}
              <ArrowUpRight size={13} />
            </button>

            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-gray-7/60 bg-gray-1/70 px-3 text-xs font-medium text-gray-10 transition-colors hover:border-gray-7/80 hover:text-gray-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-7/40"
              onClick={props.onReportIssue}
            >
              {t("settings.report_issue")}
              <ArrowUpRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
