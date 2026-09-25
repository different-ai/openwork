import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DesktopFreePreferences } from "@/app/lib/openwork-server";
import { t } from "@/i18n";
import { gatewayConnectCopy, gatewayConnectProviderKey, type GatewayConnectProvider, isCloudManagedProviderKey, OPENWORK_GATEWAY_BADGE_LABEL } from "../../connections/provider-auth/cloud-provider-config";
import type { ProviderLoadState } from "../../connections/provider-auth/store";
import { AUTO_PROVIDER_ID } from "@/react-app/domains/models/model-catalog";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice } from "../settings-section";
import { LayoutSection, LayoutSectionHeader, LayoutSectionTitle, LayoutStack } from "../settings-layout";

export type ConnectedProvider = {
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
  providerLoadState: ProviderLoadState;
  onRetryProviders: () => void | Promise<void>;
  connectedProviders: ConnectedProvider[];
  disconnectingProviderId: string | null;
  providerConnectError: string | null;
  providerDisconnectStatus: string | null;
  providerDisconnectError: string | null;
  onOpenProviderAuth: () => void | Promise<void>;
  onDisconnectProvider: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (provider: ConnectedProvider) => boolean;
  canAddProviders: boolean;
  organizationName?: string;
  cloudProviderIds?: Set<string>;
  gatewayProviderIds?: ReadonlySet<string>;
  gatewayConnectProviders?: GatewayConnectProvider[];
  connectingGatewayProviderId?: string | null;
  onConnectGatewayProvider?: (provider: GatewayConnectProvider) => void | Promise<void>;
  onCancelGatewayConnect?: () => void;
  onOpenModelConnections?: () => void;
  showOpenWorkModelsConnect?: boolean;
  showOpenWorkModelsSyncing?: boolean;
  onDismissOpenWorkModels?: () => void | Promise<void>;
  cloudProvidersView?: ReactNode;
  autoPreferences?: DesktopFreePreferences | null;
  autoBusy?: boolean;
  autoError?: string | null;
  onSetAutoEnabled?: (enabled: boolean) => void | Promise<void>;
  organizationProviderIds?: ReadonlySet<string>;
  onOpenDen?: () => void;
};

export function GatewayConnectRow({ provider, busy, onConnect, onCancel }: {
  provider: GatewayConnectProvider;
  busy: boolean;
  onConnect?: (provider: GatewayConnectProvider) => void | Promise<void>;
  onCancel?: () => void;
}) {
  return <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-0">
    <div className="flex min-w-0 items-center gap-3">
      <ProviderIcon providerId={provider.providerId} providerName={provider.name} size={20} />
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{provider.name}</span><Badge variant="outline">Needs your sign-in</Badge></div><div className="text-xs text-muted-foreground">{gatewayConnectCopy(provider.name)} · {OPENWORK_GATEWAY_BADGE_LABEL}</div></div>
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <Button variant="outline" disabled={busy || !onConnect} onClick={() => void onConnect?.(provider)}>{busy ? "Waiting for sign-in…" : "Login"}</Button>
      {busy && onCancel ? <Button variant="outline" onClick={onCancel}>Stop waiting</Button> : null}
    </div>
  </div>;
}

export function AiSettingsView(props: AiSettingsViewProps) {
  const ready = props.providerLoadState.status === "ready";
  const loading = props.providerLoadState.status === "loading" || props.providerLoadState.status === "idle";
  const error = props.providerLoadState.error;
  const managed = (provider: ConnectedProvider) => provider.id !== AUTO_PROVIDER_ID && (isCloudManagedProviderKey(provider.id) || props.cloudProviderIds?.has(provider.id) || props.gatewayProviderIds?.has(provider.id));
  const local = props.connectedProviders.filter((provider) => !managed(provider) && provider.id !== AUTO_PROVIDER_ID);
  const organization = props.connectedProviders.filter(managed);
  const showAuto = Boolean(props.autoPreferences || props.connectedProviders.some((provider) => provider.id === AUTO_PROVIDER_ID));
  const autoOff = props.autoPreferences?.enabled === false;
  const autoAvailable = props.autoPreferences?.available ?? ready;
  const locked = !props.canAddProviders;

  return <LayoutStack>
    {props.onOpenModelConnections ? <Button variant="outline" className="self-start" onClick={props.onOpenModelConnections}>My Model Connections</Button> : null}
    <LayoutSection>
      <LayoutSectionHeader><div className="flex items-center justify-between gap-3">
        <LayoutSectionTitle>AI Providers</LayoutSectionTitle>
        <Button disabled={locked || props.busy || props.providerAuthBusy || !ready} onClick={() => void props.onOpenProviderAuth()}>{locked ? <Lock className="size-4" /> : null}Connect a provider</Button>
      </div></LayoutSectionHeader>
      {locked ? <p className="text-xs text-muted-foreground">Provider connections are managed by your organization administrator.</p> : null}
      {error ? <SettingsNotice tone="error" className="flex flex-wrap items-center justify-between gap-3"><div role="alert"><p>{error}</p>{props.connectedProviders.length ? <p>{t("settings.providers_not_refreshed")}</p> : null}</div><Button variant="outline" disabled={props.busy || loading} aria-busy={loading} onClick={() => void props.onRetryProviders()}>{t("settings.providers_retry")}</Button></SettingsNotice> : null}
      {loading && !props.connectedProviders.length ? <div role="status" aria-label={t("settings.loading_providers")} className="grid gap-3 py-3">{[0, 1, 2].map((key) => <div key={key} className="h-12 animate-pulse rounded-md bg-muted" />)}</div> : null}
      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">On this device</h3>{ready ? <span className="text-xs text-muted-foreground">{local.length + Number(showAuto)} providers</span> : null}</div>
      <p className="text-xs text-muted-foreground">{props.organizationName ? "Signed in or pasted by you. Keys never leave this device and only you can disconnect them." : "Works without an account. Keys you paste never leave this device and only you can disconnect them."}</p>
      <div className="divide-y divide-border">
        {showAuto ? <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-3" data-testid="settings-auto-provider">
          <div className="flex min-w-0 items-center gap-3"><ProviderIcon providerId="openwork" size={20} /><div><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">OpenWork Models</span><span className="text-xs text-muted-foreground">{autoOff ? "Turned off" : props.autoError ? "Could not verify" : autoAvailable ? "Included" : "Unavailable"}</span></div><p className="text-xs text-muted-foreground">{props.organizationName ? "Auto · Free · weekly limit for your account" : "Auto · Free · No account needed · weekly limit on this device"}</p></div></div>
          {props.onSetAutoEnabled ? <Button variant="ghost" disabled={props.autoBusy || (autoOff && !props.autoPreferences?.canEnable)} onClick={() => void props.onSetAutoEnabled?.(autoOff)}>{autoOff ? "Turn on" : "Turn off"}</Button> : null}
        </div> : null}
        {local.map((provider) => <div key={provider.id} className="flex min-h-12 items-center justify-between gap-3 px-4 py-3" data-provider-scope="device">
          <div className="flex min-w-0 items-center gap-3"><ProviderIcon providerId={provider.id} size={20} /><div className="min-w-0"><div className="text-sm font-medium">{provider.name}</div><div className="text-xs text-muted-foreground">{provider.source === "api" ? "API key on this device" : provider.source === "env" ? "Environment credential" : "Configured on this device"}{props.organizationProviderIds?.has(provider.id) ? ` · Also available from ${props.organizationName || "your organization"}` : ""}</div></div></div>
          <div className="flex shrink-0 items-center gap-1"><Button variant="ghost" disabled={props.busy || props.providerAuthBusy || !ready || !props.canDisconnectProvider(provider) || props.disconnectingProviderId !== null} onClick={() => void props.onDisconnectProvider(provider.id)}>{props.disconnectingProviderId === provider.id ? t("settings.disconnecting") : props.canDisconnectProvider(provider) ? t("settings.disconnect") : t("settings.managed_by_env")}</Button>
          </div>
        </div>)}
      </div>
      {ready && !local.length && !showAuto ? <p className="text-sm text-muted-foreground">{t("settings.no_providers_connected")}</p> : null}
      {props.autoError ? <SettingsNotice tone="error">{props.autoError}</SettingsNotice> : null}
      {props.autoPreferences && !props.autoPreferences.canEnable ? <p className="text-xs text-muted-foreground">Auto is unavailable on this device or blocked by your organization administrator.</p> : null}
      {props.providerConnectError ? <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice> : null}
      {props.providerDisconnectStatus ? <SettingsNotice>{props.providerDisconnectStatus}</SettingsNotice> : null}
      {props.providerDisconnectError ? <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice> : null}
    </LayoutSection>
    {props.cloudProvidersView ?? <LayoutSection><LayoutSectionHeader><LayoutSectionTitle>From {props.organizationName || "your organization"}</LayoutSectionTitle>{props.onOpenDen ? <Button variant="ghost" onClick={props.onOpenDen}>Open in Den</Button> : null}</LayoutSectionHeader>{organization.map((provider) => <div key={provider.id} className="flex items-center gap-3 border-b border-border py-3"><ProviderIcon providerId={provider.id} providerName={provider.name} size={20} /><span className="text-sm font-medium">{provider.name}</span><span className="text-xs text-muted-foreground">Managed in Den</span></div>)}{props.gatewayConnectProviders?.map((provider) => <GatewayConnectRow key={gatewayConnectProviderKey(provider)} provider={provider} busy={props.connectingGatewayProviderId === gatewayConnectProviderKey(provider)} onConnect={props.onConnectGatewayProvider} onCancel={props.onCancelGatewayConnect} />)}</LayoutSection>}
  </LayoutStack>;
}
