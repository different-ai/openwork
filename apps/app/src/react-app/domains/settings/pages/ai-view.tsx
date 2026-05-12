/** @jsxImportSource react */
import { Info } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Select, SelectTrigger } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { t } from "@/i18n";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

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
    <LayoutStack>
      {/* ---- Providers ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.providers_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.providers_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>
              {props.providerSummary}
              <SettingsStatusBadge
                tone={providerStatusTone(props.providerStatusLabel)}
                label={props.providerStatusLabel}
              />
            </LayoutSectionItemTitle>
            <LayoutSectionItemHeaderActions>
              <Button
                onClick={() => void props.onOpenProviderAuth()}
                disabled={props.busy || props.providerAuthBusy}
              >
                {props.providerAuthBusy
                  ? t("settings.loading_providers")
                  : t("settings.connect_provider")}
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {props.connectedProviders.length > 0 ? (
          <div className="space-y-2">
            {props.connectedProviders.map((provider) => (
              <LayoutSectionItem
                key={provider.id}
                className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderIcon providerId={provider.id} size={20} className="text-dls-text" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-dls-text">{provider.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
                    {providerSourceLabel(provider.source) ? (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {providerSourceLabel(provider.source)}
                      </div>
                    ) : null}
                  </div>
                </div>
                <Button
                  variant="destructive"
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
              </LayoutSectionItem>
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

        <LayoutSectionItemFootnote>{t("settings.api_keys_info")}</LayoutSectionItemFootnote>
      </LayoutSection>

      <Separator />

      {/* ---- Model ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.model_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.model_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        {/* Default model */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{props.defaultModelLabel}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription className="truncate font-mono">{props.defaultModelRef}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Button
                variant="outline"
                onClick={props.onChangeDefaultModel}
                disabled={props.busy}
              >
                {t("settings.change")}
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {/* Show reasoning */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.show_model_reasoning")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.show_model_reasoning_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.show_model_reasoning")}
                checked={props.showThinking}
                disabled={props.busy}
                onCheckedChange={props.onToggleShowThinking}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {/* Model behavior */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.model_behavior")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.model_behavior_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Select
                value={props.defaultModelVariantLabel}
                disabled
              >
                <SelectTrigger className="w-48 max-w-full" aria-label={t("settings.model_behavior")}>
                  <span className="truncate">{props.defaultModelVariantLabel}</span>
                </SelectTrigger>
              </Select>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
          <Alert>
            <Info />
            <AlertDescription>{t("settings.model_behavior_unavailable")}</AlertDescription>
          </Alert>
        </LayoutSectionItem>

        {/* Auto context compaction */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.auto_compact")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.auto_compact_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.auto_compact")}
                checked={props.autoCompactContext}
                // TODO: Restore the conditional disabled state once this action is wired into the React settings route.
                // disabled={props.busy || props.autoCompactContextBusy}
                disabled
                onCheckedChange={props.onToggleAutoCompactContext}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
          <Alert>
            <Info />
            <AlertDescription>{t("settings.auto_compact_unavailable")}</AlertDescription>
          </Alert>
        </LayoutSectionItem>
      </LayoutSection>
    </LayoutStack>
  );
}
