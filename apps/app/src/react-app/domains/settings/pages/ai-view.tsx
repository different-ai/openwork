/** @jsxImportSource react */
import { PlugZap, BrainCircuit } from "lucide-react";
import { Separator } from "@/components/ui/separator";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { ProviderIcon } from "../../../design-system/provider-icon";
import {
  SettingsStack,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderTitle,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderActions,
  SettingsInset,
  SettingsNotice,
  SettingsStatusBadge,
} from "../settings-section";

type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
};

export type AiSettingsViewProps = {
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
};

function providerSourceLabel(source?: ConnectedProvider["source"]) {
  if (source === "env") return t("settings.provider_source_env");
  if (source === "api") return t("providers.api_key_label");
  if (source === "config") return t("settings.provider_source_config");
  if (source === "custom") return t("settings.provider_source_custom");
  return null;
}

function providerStatusTone(label: string): "ready" | "warning" | "neutral" {
  if (label.toLowerCase().includes("connected")) return "ready";
  if (label.toLowerCase().includes("error") || label.toLowerCase().includes("fail")) return "warning";
  return "neutral";
}

export function AiSettingsView(props: AiSettingsViewProps) {
  return (
    <SettingsStack>
      {/* ---- Providers ---- */}
      <SettingsSection>
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>
              <PlugZap size={16} />
              {t("settings.providers_title")}
              <SettingsStatusBadge
                tone={providerStatusTone(props.providerStatusLabel)}
                label={props.providerStatusLabel}
              />
            </SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              {t("settings.providers_desc")}
            </SettingsSectionHeaderDescription>
          </SettingsSectionHeaderContent>
          <SettingsSectionHeaderActions>
            <Button
              variant="primary"
              onClick={() => void props.onOpenProviderAuth()}
              disabled={props.busy || props.providerAuthBusy}
            >
              {props.providerAuthBusy
                ? t("settings.loading_providers")
                : t("settings.connect_provider")}
            </Button>
          </SettingsSectionHeaderActions>
        </SettingsSectionHeader>

        {props.connectedProviders.length > 0 ? (
          <div className="space-y-2">
            {props.connectedProviders.map((provider) => (
              <SettingsInset key={provider.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderIcon providerId={provider.id} size={20} className="text-dls-text" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-dls-text">{provider.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{provider.id}</div>
                    {providerSourceLabel(provider.source) ? (
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
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
              </SettingsInset>
            ))}
          </div>
        ) : null}

        {props.providerConnectError ? (
          <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice>
        ) : null}
        {props.providerDisconnectStatus ? (
          <SettingsNotice>{props.providerDisconnectStatus}</SettingsNotice>
        ) : null}
        {props.providerDisconnectError ? (
          <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice>
        ) : null}

        <div className="text-[11px] text-muted-foreground">{t("settings.api_keys_info")}</div>
      </SettingsSection>

      <Separator />

      {/* ---- Model ---- */}
      <SettingsSection>
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>
              <BrainCircuit size={16} />
              {t("settings.model_title")}
            </SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              {t("settings.model_section_desc")}
            </SettingsSectionHeaderDescription>
          </SettingsSectionHeaderContent>
        </SettingsSectionHeader>

        {/* Default model */}
        <SettingsInset className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-dls-text">{props.defaultModelLabel}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{props.defaultModelRef}</div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.onChangeDefaultModel}
            disabled={props.busy}
          >
            {t("settings.change")}
          </Button>
        </SettingsInset>

        {/* Show reasoning */}
        <SettingsInset className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-dls-text">{t("settings.show_model_reasoning")}</div>
            <div className="text-[12px] text-muted-foreground">{t("settings.show_model_reasoning_desc")}</div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.onToggleShowThinking}
            disabled={props.busy}
          >
            {props.showThinking ? t("settings.on") : t("settings.off")}
          </Button>
        </SettingsInset>

        {/* Model behavior */}
        <SettingsInset className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-dls-text">{t("settings.model_behavior")}</div>
            <div className="text-[12px] text-muted-foreground">{t("settings.model_behavior_desc")}</div>
            <div className="mt-1 truncate text-xs font-medium text-dls-text">
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
        </SettingsInset>

        {/* Auto context compaction */}
        <SettingsInset className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-dls-text">{t("settings.auto_compact")}</div>
            <div className="text-[12px] text-muted-foreground">{t("settings.auto_compact_desc")}</div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.onToggleAutoCompactContext}
            disabled={props.busy || props.autoCompactContextBusy}
          >
            {props.autoCompactContext ? t("settings.on") : t("settings.off")}
          </Button>
        </SettingsInset>
      </SettingsSection>
    </SettingsStack>
  );
}
