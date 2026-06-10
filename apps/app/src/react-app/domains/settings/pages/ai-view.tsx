/** @jsxImportSource react */
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";
import { ArrowRight, CheckCircle2, KeyRound, X } from "lucide-react";

import { t } from "@/i18n";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
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
  /** Subtle fallback row when OpenWork Models is not connected and the banner was dismissed. */
  showOpenWorkModelsConnect?: boolean;
  onSubscribeOpenWorkModels?: () => void | Promise<void>;
  onDismissOpenWorkModels?: () => void | Promise<void>;
  cloudProvidersView?: ReactNode;
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
          <LayoutSectionItem className="relative overflow-hidden rounded-2xl border border-blue-6 bg-blue-2/30 px-4 py-4">
            <button
              type="button"
              className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full text-blue-11 transition-colors hover:bg-blue-3/70"
              onClick={() => void props.onDismissOpenWorkModels?.()}
              aria-label="Dismiss OpenWork Models banner"
            >
              <X className="size-3.5" />
            </button>
            <div className="flex flex-col gap-4 pr-8 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3">
                <ProviderIcon providerId="openwork" size={22} className="mt-0.5 shrink-0 text-blue-11" />
                <div className="min-w-0 space-y-2">
                  <div>
                    <div className="text-sm font-medium text-dls-text">OpenWork Models</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Hosted frontier models for OpenWork tasks without managing provider API keys.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-blue-11">
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-6 bg-blue-3 px-2 py-0.5">
                      <CheckCircle2 className="size-3" /> Managed by OpenWork Cloud
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-6 bg-blue-3 px-2 py-0.5">
                      <KeyRound className="size-3" /> No API key setup
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Pricing is handled through OpenWork Cloud. You can continue using OpenCode Zen or your own providers.
                  </p>
                </div>
              </div>
              <Button
                className="shrink-0"
                onClick={() => void props.onSubscribeOpenWorkModels?.()}
                disabled={props.busy || props.providerAuthBusy}
              >
                Subscribe
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            </div>
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
                      {provider.source === "env" ? (
                        <span className="shrink-0 rounded-full border border-amber-6 bg-amber-2 px-2 py-0.5 text-[10px] font-medium text-amber-11">
                          {providerSourceLabel("env")}
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

        {props.showOpenWorkModelsConnect ? (
          <LayoutSectionItem className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-dls-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProviderIcon providerId="openwork" size={20} className="text-muted-foreground" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-dls-text">OpenWork Models</span>
                  <span className="shrink-0 rounded-full border border-dls-border bg-dls-sidebar/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Not connected
                  </span>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  Hosted frontier models without managing API keys.
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => void props.onSubscribeOpenWorkModels?.()}
              disabled={props.busy || props.providerAuthBusy}
            >
              Connect
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          </LayoutSectionItem>
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

      {props.cloudProvidersView}

    </LayoutStack>
  );
}
