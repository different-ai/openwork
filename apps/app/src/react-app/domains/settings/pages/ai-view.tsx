/** @jsxImportSource react */
import { Button } from "@/components/ui/button";

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
  /** Set of local provider IDs that were imported from cloud. */
  cloudProviderIds?: Set<string>;
  showOpenWorkModelsSubscribe?: boolean;
  onSubscribeOpenWorkModels?: () => void | Promise<void>;
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

        {props.showOpenWorkModelsSubscribe ? (
          <LayoutSectionItem className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-6 bg-blue-2/30 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProviderIcon providerId="openwork" size={20} className="text-blue-11" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-dls-text">OpenWork Models</div>
                <div className="text-xs text-muted-foreground">
                  Frontier intelligence, hand picked for your team&apos;s most ambitious work.
                </div>
              </div>
            </div>
            <Button
              onClick={() => void props.onSubscribeOpenWorkModels?.()}
              disabled={props.busy || props.providerAuthBusy}
            >
              Subscribe
            </Button>
          </LayoutSectionItem>
        ) : null}

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
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-dls-text">{provider.name}</span>
                      {props.cloudProviderIds?.has(provider.id) ? (
                        <span className="shrink-0 rounded-full border border-blue-6 bg-blue-2 px-2 py-0.5 text-[10px] font-medium text-blue-11">
                          Cloud
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
                  </div>
                </div>
                {!props.cloudProviderIds?.has(provider.id) ? (
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
                ) : null}
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


    </LayoutStack>
  );
}
