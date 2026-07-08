/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";

import type { DenExternalMcpConnection, DenOrgPlugin } from "@/app/lib/den";
import { readDenSettings } from "@/app/lib/den";
import { openDesktopUrl } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { DenSignInSurface } from "@/react-app/domains/cloud/den-signin-surface";
import { useDenAuth, type DenAuthStatus } from "@/react-app/domains/cloud/den-auth-provider";
import { canDisconnectNativeProviderAccount } from "@/react-app/domains/connections/native-provider-connections";
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections";
import {
  cloudReadinessConnectableConnectionId,
  cloudReadinessMissingConnectionNames,
  formatPluginConnectRowMeta,
  resolveConnectRowGroup,
  resolveConnectionRowGroup,
  type ConnectRowGroup,
} from "@/react-app/domains/settings/connect-cloud-readiness";
import type { ExtensionItem } from "@/react-app/domains/settings/extension-items";
import { useConnectEnabled, useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";
import { useCloudSession } from "../cloud/cloud-session-provider";
import type { useDenSession } from "../cloud/use-den-session";
import {
  SettingsInset,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
  SettingsStack,
} from "../settings-section";

export type ConnectViewState = "loading" | "signin" | "active" | "pitch";

export function resolveConnectViewState(input: {
  authStatus: DenAuthStatus;
  connectEnabled?: boolean;
  connectionsCount: number;
}): ConnectViewState {
  if (input.authStatus === "checking") return "loading";
  if (input.authStatus === "signed_out") return "signin";
  if (input.connectEnabled === true || input.connectionsCount > 0) return "active";
  return "pitch";
}

type ConnectSession = Pick<
  ReturnType<typeof useDenSession>,
  | "authBusy"
  | "authError"
  | "baseUrlDraft"
  | "baseUrlError"
  | "sessionBusy"
  | "signinFallbackUrl"
  | "onApplyBaseUrl"
  | "onBaseUrlDraftChange"
  | "onClearAuthError"
  | "onOpenBrowserAuth"
  | "onOpenControlPlane"
  | "onResetBaseUrl"
  | "onSubmitManualAuth"
>;

export type ConnectViewProps = {
  developerMode: boolean;
  session: ConnectSession;
  marketplaceItems?: ExtensionItem[];
  refreshMarketplaceItems?: () => Promise<unknown> | void;
};

type CloudMarketplaceItem = ExtensionItem & { plugin: DenOrgPlugin };

function denManageConnectionsUrl() {
  return new URL("/dashboard/mcp-connections", readDenSettings().baseUrl).toString();
}

function ManageInDenButton() {
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-fit"
      onClick={() => void openDesktopUrl(denManageConnectionsUrl())}
    >
      {t("connect.manage_in_den_web")}
      <ArrowUpRight size={13} />
    </Button>
  );
}

function ConnectIntro() {
  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>{t("connect.header_title")}</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>
            {t("connect.header_description")}
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
      </SettingsSectionHeader>
    </SettingsSection>
  );
}

function ConnectLoadingPanel() {
  return (
    <SettingsSection>
      <SettingsNotice>{t("connect.loading")}</SettingsNotice>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </SettingsSection>
  );
}

function ConnectSignInPanel(props: ConnectViewProps) {
  const { baseUrl, statusMessage } = useCloudSession();
  const [manualAuthOpen, setManualAuthOpen] = useState(false);
  const [manualAuthInput, setManualAuthInput] = useState("");

  useEffect(() => {
    if (props.session.signinFallbackUrl) setManualAuthOpen(true);
  }, [props.session.signinFallbackUrl]);

  const submitManualAuth = async () => {
    const ok = await props.session.onSubmitManualAuth(manualAuthInput);
    if (!ok) return;
    setManualAuthInput("");
    setManualAuthOpen(false);
  };

  return (
    <DenSignInSurface
      variant="panel"
      developerMode={props.developerMode}
      baseUrl={baseUrl}
      baseUrlDraft={props.session.baseUrlDraft}
      baseUrlError={props.session.baseUrlError}
      statusMessage={statusMessage}
      signinFallbackUrl={props.session.signinFallbackUrl}
      authError={props.session.authError}
      authBusy={props.session.authBusy}
      baseUrlBusy={false}
      sessionBusy={props.session.sessionBusy}
      manualAuthOpen={manualAuthOpen}
      manualAuthInput={manualAuthInput}
      onBaseUrlDraftInput={props.session.onBaseUrlDraftChange}
      onResetBaseUrl={props.session.onResetBaseUrl}
      onApplyBaseUrl={props.session.onApplyBaseUrl}
      onOpenControlPlane={props.session.onOpenControlPlane}
      onOpenBrowserAuth={props.session.onOpenBrowserAuth}
      onToggleManualAuth={() => {
        props.session.onClearAuthError();
        setManualAuthOpen((current) => !current);
      }}
      onManualAuthInput={setManualAuthInput}
      onSubmitManualAuth={() => void submitManualAuth()}
    />
  );
}

function isCloudMarketplaceItem(item: ExtensionItem): item is CloudMarketplaceItem {
  return Boolean(item.plugin);
}

type ConnectOrganizationRow =
  | {
      kind: "connection";
      id: string;
      group: Exclude<ConnectRowGroup, "needs_admin_setup" | "excluded">;
      name: string;
      description: string;
      meta: string;
      connection: DenExternalMcpConnection;
    }
  | {
      kind: "plugin";
      id: string;
      group: Exclude<ConnectRowGroup, "excluded">;
      name: string;
      description: string;
      meta: string;
      plugin: DenOrgPlugin;
    };

const connectGroupOrder: Array<Exclude<ConnectRowGroup, "excluded">> = ["needs_signin", "ready", "needs_admin_setup"];

function connectGroupLabel(group: Exclude<ConnectRowGroup, "excluded">) {
  switch (group) {
    case "needs_signin":
      return t("connect.group_needs_signin");
    case "ready":
      return t("connect.group_ready");
    case "needs_admin_setup":
      return t("connect.group_needs_admin_setup");
  }
}

function ConnectRowIcon(props: { iconSlug?: string; iconSrc?: string; name: string; serviceUrl?: string }) {
  const resolved = resolveExtensionIconUrl({ iconSlug: props.iconSlug, iconSrc: props.iconSrc, serviceUrl: props.serviceUrl });
  const [failed, setFailed] = useState(false);
  const src = failed ? undefined : resolved;
  const initial = props.name.trim().slice(0, 1).toUpperCase() || "•";
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-dls-hover">
      {src ? (
        <div className="flex size-6 items-center justify-center rounded-md bg-white">
          <img src={src} alt="" width={16} height={16} loading="lazy" className="block" onError={() => setFailed(true)} />
        </div>
      ) : (
        <span className="text-sm font-semibold text-dls-secondary" aria-hidden="true">{initial}</span>
      )}
    </div>
  );
}

function rowSearchText(row: ConnectOrganizationRow) {
  return [row.name, row.description, row.meta].join(" ").toLowerCase();
}

function buildConnectRows(input: {
  connections: DenExternalMcpConnection[];
  items: ExtensionItem[];
  role: "owner" | "admin" | "member" | null | undefined;
}) {
  const connectionRows: ConnectOrganizationRow[] = input.connections.map((connection) => ({
    kind: "connection",
    id: connection.id,
    group: resolveConnectionRowGroup(connection),
    name: connection.name,
    description: connection.url,
    meta: connection.credentialMode === "shared" ? t("connect.row_meta_managed_by_org") : t("connect.row_meta_your_account"),
    connection,
  }));

  const pluginRows: ConnectOrganizationRow[] = input.items.filter(isCloudMarketplaceItem).flatMap((item) => {
    const group = resolveConnectRowGroup(item.plugin.cloudReadiness, input.role, item.plugin.componentCounts);
    if (group === "excluded") return [];
    return [{
      kind: "plugin",
      id: item.plugin.id,
      group,
      name: item.plugin.name,
      description: item.plugin.description ?? "",
      meta: formatPluginConnectRowMeta(item.plugin),
      plugin: item.plugin,
    }];
  });

  return [...connectionRows, ...pluginRows];
}

function ConnectOrganizationRow(props: {
  connectingId: string | null;
  disconnectingId: string | null;
  onConnect: (connectionId: string) => void;
  onDisconnect: (connectionId: string) => void;
  row: ConnectOrganizationRow;
}) {
  const row = props.row;
  const pluginManifest = row.kind === "plugin" ? row.plugin.extension?.manifest : null;
  const needsReconnect = row.kind === "connection" && row.connection.connectedForMe && row.connection.needsReconnect === true;
  const connectableConnectionId = row.kind === "plugin"
    ? cloudReadinessConnectableConnectionId(row.plugin.cloudReadiness)
    : row.connection.credentialMode === "per_member" && (!row.connection.connectedForMe || needsReconnect)
      ? row.connection.id
      : null;
  const setupNames = row.kind === "plugin" ? cloudReadinessMissingConnectionNames(row.plugin.cloudReadiness) : [];
  const connecting = connectableConnectionId ? props.connectingId === connectableConnectionId : false;
  const disconnectableConnectionId = row.kind === "connection" && canDisconnectNativeProviderAccount(row.connection) ? row.connection.id : null;
  const disconnecting = disconnectableConnectionId ? props.disconnectingId === disconnectableConnectionId : false;

  return (
    <div
      data-testid="connect-organization-row"
      data-connect-row-kind={row.kind}
      className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-3 py-3"
    >
      <ConnectRowIcon
        name={row.name}
        serviceUrl={row.kind === "connection" ? row.connection.url : undefined}
        iconSlug={pluginManifest?.icon?.simpleIconSlug}
        iconSrc={pluginManifest?.icon?.src}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-dls-text">{row.name}</div>
        <div className="truncate text-xs text-dls-secondary">{row.meta}</div>
      </div>
      {row.group === "needs_signin" && connectableConnectionId ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            disabled={connecting}
            className={needsReconnect ? "border border-amber-6 bg-amber-2 text-amber-11 hover:bg-amber-3" : undefined}
            onClick={() => props.onConnect(connectableConnectionId)}
          >
            {connecting ? t("connect.waiting_for_browser") : needsReconnect ? t("mcp.org_connection_reconnect_action") : t("connect.row_action_connect")}
          </Button>
          {disconnectableConnectionId ? (
            <Button size="sm" variant="destructive" disabled={disconnecting} onClick={() => props.onDisconnect(disconnectableConnectionId)}>
              {disconnecting ? t("mcp.org_connection_disconnecting_action") : t("mcp.org_connection_disconnect_action")}
            </Button>
          ) : null}
        </div>
      ) : row.group === "needs_admin_setup" ? (
        <Button size="sm" variant="outline" onClick={() => void openDesktopUrl(denManageConnectionsUrl())} title={setupNames.join(t("connect.row_meta_list_separator"))}>
          {t("connect.row_action_set_up_connection")}
        </Button>
      ) : disconnectableConnectionId ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <span className="rounded-md bg-green-3 px-2 py-1 text-xs font-medium text-green-11">
            {t("connect.row_chip_ready")}
          </span>
          <Button size="sm" variant="destructive" disabled={disconnecting} onClick={() => props.onDisconnect(disconnectableConnectionId)}>
            {disconnecting ? t("mcp.org_connection_disconnecting_action") : t("mcp.org_connection_disconnect_action")}
          </Button>
        </div>
      ) : (
        <span className="shrink-0 rounded-md bg-green-3 px-2 py-1 text-xs font-medium text-green-11">
          {t("connect.row_chip_ready")}
        </span>
      )}
    </div>
  );
}

function ConnectOrganizationList(props: {
  connectingId: string | null;
  disconnectingId: string | null;
  connections: DenExternalMcpConnection[];
  items: ExtensionItem[];
  onConnect: (connectionId: string) => void;
  onDisconnect: (connectionId: string) => void;
  role: "owner" | "admin" | "member" | null | undefined;
}) {
  const [search, setSearch] = useState("");
  const rows = useMemo(() => buildConnectRows({ connections: props.connections, items: props.items, role: props.role }), [props.connections, props.items, props.role]);
  const query = search.trim().toLowerCase();
  const filteredRows = query ? rows.filter((row) => rowSearchText(row).includes(query)) : rows;
  const rowsByGroup = new Map<ConnectOrganizationRow["group"], ConnectOrganizationRow[]>();
  for (const row of filteredRows) {
    const existing = rowsByGroup.get(row.group) ?? [];
    existing.push(row);
    rowsByGroup.set(row.group, existing);
  }

  return (
    <div data-testid="connect-organization-section" className="space-y-3">
      <div className="space-y-1">
        <div className="text-sm font-semibold text-dls-text">{t("connect.organization_section_title")}</div>
        <div className="text-sm text-dls-secondary">{t("connect.organization_section_description")}</div>
      </div>
      {rows.length > 10 ? (
        <Input
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={t("connect.organization_search_placeholder")}
        />
      ) : null}
      {rows.length === 0 ? (
        <SettingsInset className="bg-dls-surface">
          <div className="text-sm text-dls-secondary">{t("connect.organization_empty")}</div>
        </SettingsInset>
      ) : filteredRows.length === 0 ? (
        <SettingsInset className="bg-dls-surface">
          <div className="text-sm text-dls-secondary">{t("connect.organization_no_matches")}</div>
        </SettingsInset>
      ) : (
        <div className="space-y-4">
          {connectGroupOrder.map((group) => {
            const groupRows = rowsByGroup.get(group) ?? [];
            if (groupRows.length === 0) return null;
            return (
              <div key={group} className="space-y-2" data-connect-group={group}>
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-dls-secondary">
                  {connectGroupLabel(group)}
                </div>
                <div className="space-y-2">
                  {groupRows.map((row) => (
                    <ConnectOrganizationRow
                      key={`${row.kind}:${row.id}`}
                      row={row}
                      connectingId={props.connectingId}
                      disconnectingId={props.disconnectingId}
                      onConnect={props.onConnect}
                      onDisconnect={props.onDisconnect}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConnectActivePanel(props: {
  connections: DenExternalMcpConnection[];
  marketplaceItems: ExtensionItem[];
  loading: boolean;
  error: string | null;
  connectingId: string | null;
  disconnectingId: string | null;
  onConnect: (connectionId: string) => void;
  onDisconnect: (connectionId: string) => void;
}) {
  const { activeOrganization } = useCloudSession();
  const activeOrgName = activeOrganization?.name.trim();

  return (
    <SettingsSection>
      <div
        data-testid="connect-org-status-row"
        className="flex items-center gap-2 rounded-2xl border border-green-6/30 bg-green-2 px-4 py-3 text-sm font-medium text-green-11"
      >
        <span className="size-2 rounded-full bg-green-9" />
        {activeOrgName
          ? t("connect.connected_to_org", { name: activeOrgName })
          : t("connect.connected_to_cloud")}
      </div>

      {props.error ? <SettingsNotice tone="error">{props.error}</SettingsNotice> : null}
      {props.loading ? <SettingsNotice>{t("connect.loading")}</SettingsNotice> : null}

      <ConnectOrganizationList
        connections={props.connections}
        items={props.marketplaceItems}
        role={activeOrganization?.role}
        connectingId={props.connectingId}
        disconnectingId={props.disconnectingId}
        onConnect={props.onConnect}
        onDisconnect={props.onDisconnect}
      />

      <div className="flex justify-end">
        <ManageInDenButton />
      </div>
    </SettingsSection>
  );
}

function ConnectPitchPanel() {
  return (
    <SettingsSection>
      <SettingsInset className="space-y-4 bg-dls-surface">
        <div className="space-y-2">
          <div className="text-base font-semibold text-dls-text">{t("connect.pitch_title")}</div>
          <div className="max-w-[58ch] text-sm text-dls-secondary">{t("connect.pitch_body")}</div>
        </div>
        <ManageInDenButton />
      </SettingsInset>
    </SettingsSection>
  );
}

export function ConnectView(props: ConnectViewProps) {
  const denAuth = useDenAuth();
  const desktopConfig = useDesktopConfig();
  const connectEnabled = useConnectEnabled();
  const orgMcpConnections = useOrgMcpConnections();
  const marketplaceItems = props.marketplaceItems ?? [];
  const refreshMarketplaceItems = props.refreshMarketplaceItems;
  const connectionsCount = orgMcpConnections.connections.length;
  const signedInLoading = denAuth.status === "signed_in"
    && connectionsCount === 0
    && connectEnabled !== true
    && (desktopConfig.loading || orgMcpConnections.loading);
  const state = signedInLoading
    ? "loading"
    : resolveConnectViewState({
        authStatus: denAuth.status,
        connectEnabled,
        connectionsCount,
      });

  useEffect(() => {
    if (state !== "active" || connectEnabled !== true) return;
    void refreshMarketplaceItems?.();
  }, [connectEnabled, refreshMarketplaceItems, state]);

  return (
    <SettingsStack>
      <Separator />
      <ConnectIntro />
      {state === "loading" ? <ConnectLoadingPanel /> : null}
      {state === "signin" ? <ConnectSignInPanel {...props} /> : null}
      {state === "active" ? (
        <ConnectActivePanel
          connections={orgMcpConnections.connections}
          marketplaceItems={marketplaceItems}
          loading={orgMcpConnections.loading}
          error={orgMcpConnections.error}
          connectingId={orgMcpConnections.connectingId}
          disconnectingId={orgMcpConnections.disconnectingId}
          onConnect={orgMcpConnections.connect}
          onDisconnect={orgMcpConnections.disconnect}
        />
      ) : null}
      {state === "pitch" ? <ConnectPitchPanel /> : null}
    </SettingsStack>
  );
}
