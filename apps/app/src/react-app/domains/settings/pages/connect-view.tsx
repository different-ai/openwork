/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";

import type { DenExternalMcpConnection, DenOrgPlugin } from "@/app/lib/den";
import { mintCloudControlMcpToken, readDenSettings } from "@/app/lib/den";
import { openDesktopUrl } from "@/app/lib/desktop";
import type {
  OpenworkCloudMcpEngineRefresh,
  OpenworkCloudMcpHealth,
  OpenworkCloudMcpProviderModelContext,
  OpenworkServerClient,
} from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { DenSignInSurface } from "@/react-app/domains/cloud/den-signin-surface";
import { useDenAuth, type DenAuthStatus } from "@/react-app/domains/cloud/den-auth-provider";
import {
  canDisconnectNativeProviderAccount,
  connectionNeedsReconnect,
} from "@/react-app/domains/connections/native-provider-connections";
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections";
import {
  cloudReadinessConnectableConnectionId,
  cloudReadinessMissingConnectionNames,
  formatPluginConnectRowMeta,
  isConnectAdminRole,
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
  SettingsStatusBadge,
} from "../settings-section";
import {
  OPENWORK_CLOUD_EXPECTED_TOOLS,
  clearCloudMcpDisabledIntent,
  cloudMcpDisplaySummary,
  runOpenworkCloudMcpEngineRefresh,
  runOpenworkCloudMcpReconciler,
  type CloudMcpOperationContext,
} from "../../connections/cloud-mcp-reconciler";
import {
  buildCloudMcpSupportBundle,
  cloudMcpAdvancedRows,
  cloudMcpEngineRefreshLines,
  cloudMcpProbeTraceLines,
} from "../../connections/cloud-mcp-diagnostics";
import { readCloudMcpUserState } from "../../connections/cloud-mcp-user-state";

export type ConnectViewState = "loading" | "signin" | "active" | "pitch";

export function resolveConnectViewState(input: {
  authStatus: DenAuthStatus;
  connectEnabled?: boolean;
  connectionsCount: number;
  activeOrgSelected?: boolean;
}): ConnectViewState {
  if (input.authStatus === "checking") return "loading";
  if (input.authStatus === "signed_out") return "signin";
  if (input.connectEnabled === true || input.connectionsCount > 0 || (input.authStatus === "signed_in" && input.activeOrgSelected === true)) return "active";
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
  openworkClient: OpenworkServerClient | null;
  workspaceId: string | null;
  currentModel: OpenworkCloudMcpProviderModelContext | null;
  onCloudMcpHealthChange?: (health: OpenworkCloudMcpHealth | null) => void;
  orgMcpConnections: ReturnType<typeof useOrgMcpConnections>;
};

type CloudMarketplaceItem = ExtensionItem & { plugin: DenOrgPlugin };

const CLOUD_MCP_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

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

function buildCloudMcpContext(input: {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  currentModel: OpenworkCloudMcpProviderModelContext | null;
}): CloudMcpOperationContext | null {
  const workspaceId = input.workspaceId?.trim() ?? "";
  const serverBaseUrl = input.client?.baseUrl.trim() ?? "";
  const settings = readDenSettings();
  const orgId = settings.activeOrgId?.trim() ?? "";
  if (!workspaceId || !serverBaseUrl || !orgId) return null;
  return {
    denBaseUrl: settings.baseUrl,
    serverBaseUrl,
    orgId,
    workspaceId,
    denAuthToken: settings.authToken ?? null,
    orgSlug: settings.activeOrgSlug,
    orgName: settings.activeOrgName,
    providerModel: input.currentModel ?? undefined,
  };
}

export function readyCloudMcpToolIds(health: OpenworkCloudMcpHealth | null): string[] {
  if (!health?.usable) return [];
  return health.tools.present.filter((tool) => OPENWORK_CLOUD_EXPECTED_TOOLS.some((expected) => expected === tool));
}

function AgentAccessCard(props: {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  currentModel: OpenworkCloudMcpProviderModelContext | null;
  onHealthChange?: (health: OpenworkCloudMcpHealth | null) => void;
}) {
  const cloudSession = useCloudSession();
  const [health, setHealth] = useState<OpenworkCloudMcpHealth | null>(null);
  const [busy, setBusy] = useState<"test" | "repair" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [lastEngineRefresh, setLastEngineRefresh] = useState<OpenworkCloudMcpEngineRefresh | null>(null);
  const context = buildCloudMcpContext(props);
  const userState = context ? readCloudMcpUserState(context) : null;
  const signedIn = cloudSession.isSignedIn && Boolean(cloudSession.authToken.trim());
  const orgSelected = Boolean(context?.orgId.trim());
  const summary = cloudMcpDisplaySummary({
    signedIn,
    orgSelected,
    connecting: busy !== null,
    userState,
    health,
  });

  const updateHealth = (next: OpenworkCloudMcpHealth | null) => {
    setHealth(next);
    props.onHealthChange?.(next);
  };

  const testNow = async () => {
    if (!props.client || !context) return;
    setBusy("test");
    setError(null);
    try {
      // probe: verify the Cloud endpoint directly from the OpenWork server as
      // well, so a failure can be attributed to the endpoint, the network
      // path, or the engine — not just reported as the engine's cached state.
      const result = await runOpenworkCloudMcpReconciler({
        mode: "health",
        client: props.client,
        context: { ...context, trigger: "desktop-connect-test" },
        mintToken: mintCloudControlMcpToken,
        refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
        probe: true,
      });
      updateHealth(result.health);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not test agent access.");
    } finally {
      setBusy(null);
    }
  };

  const refreshEngineConnection = async () => {
    if (!props.client || !context) return;
    setBusy("refresh");
    setError(null);
    try {
      const result = await runOpenworkCloudMcpEngineRefresh({
        client: props.client,
        context: { ...context, trigger: "desktop-connect-engine-refresh" },
      });
      setLastEngineRefresh(result.refresh);
      if (result.health) updateHealth(result.health);
      if (result.status === "skipped") {
        setError(
          result.skippedReason === "unsupported"
            ? "This OpenWork server does not support engine refresh yet. Update OpenWork, then retry."
            : "Select a workspace before refreshing the engine connection.",
        );
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not refresh the engine connection.");
    } finally {
      setBusy(null);
    }
  };

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(buildCloudMcpSupportBundle({
        health,
        refresh: lastEngineRefresh,
        context: context
          ? {
              workspaceId: context.workspaceId,
              orgId: context.orgId,
              denBaseUrl: context.denBaseUrl,
              serverBaseUrl: context.serverBaseUrl,
            }
          : undefined,
      }));
      setCopyStatus("Copied sanitized diagnostic to the clipboard.");
    } catch {
      setCopyStatus("Could not copy the diagnostic.");
    }
  };

  const repairAndTest = async () => {
    if (!props.client || !context) return;
    setBusy("repair");
    setError(null);
    try {
      clearCloudMcpDisabledIntent(context);
      const result = await runOpenworkCloudMcpReconciler({
        mode: "repair",
        client: props.client,
        context: { ...context, trigger: "desktop-connect-repair" },
        mintToken: mintCloudControlMcpToken,
        force: true,
        refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
      });
      updateHealth(result.health);
      if (!result.health && result.skippedReason === "mint_failed") {
        setError("Could not refresh Cloud authentication. Sign in again, then retry.");
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not repair agent access.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!props.client || !context || !signedIn) {
      updateHealth(null);
      return;
    }
    let cancelled = false;
    setBusy("test");
    setError(null);
    void runOpenworkCloudMcpReconciler({
      mode: "health",
      client: props.client,
      context: { ...context, trigger: "desktop-connect-autocheck" },
      mintToken: mintCloudControlMcpToken,
      refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
    })
      .then((result) => {
        if (!cancelled) updateHealth(result.health);
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Could not test agent access.");
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, props.currentModel, props.workspaceId, signedIn]);

  useEffect(() => {
    if (!props.client || !context || !signedIn || typeof window === "undefined") return;
    const client = props.client;
    let cancelled = false;
    const retryAfterReconnect = () => {
      if (window.navigator.onLine === false) return;
      void runOpenworkCloudMcpReconciler({
        mode: "repair",
        client,
        context: { ...context, trigger: "desktop-connect-online-retry" },
        mintToken: mintCloudControlMcpToken,
        refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
      })
        .then((result) => {
          if (cancelled || !result.health) return;
          updateHealth(result.health);
          if (result.health.usable) setError(null);
        })
        .catch((nextError) => {
          if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Could not restore agent access.");
        });
    };

    window.addEventListener("online", retryAfterReconnect);
    return () => {
      cancelled = true;
      window.removeEventListener("online", retryAfterReconnect);
    };
  }, [
    context?.denAuthToken,
    context?.denBaseUrl,
    context?.orgId,
    context?.serverBaseUrl,
    props.client,
    props.currentModel,
    props.workspaceId,
    signedIn,
  ]);

  const canRun = Boolean(props.client && context && signedIn);
  const readyTools = readyCloudMcpToolIds(health);

  if (health?.usable) {
    return (
      <SettingsInset className="flex flex-col gap-3 bg-dls-surface sm:flex-row sm:items-center sm:justify-between" data-testid="agent-access-card">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-base font-semibold text-dls-text">Agent access ready</div>
            <SettingsStatusBadge label={summary.statusLabel} tone={summary.tone} />
          </div>
          <div className="text-sm text-dls-secondary">
            This workspace can search and run your organization&apos;s shared capabilities.
          </div>
          <div className="flex flex-wrap gap-2 font-mono text-xs text-green-11">
            {readyTools.map((tool) => <span key={tool} className="rounded-md bg-green-3 px-2 py-1">{tool}</span>)}
          </div>
        </div>
        <Button variant="outline" size="sm" disabled={!canRun || busy !== null} onClick={() => void testNow()}>
          {busy === "test" ? "Testing…" : "Test again"}
        </Button>
      </SettingsInset>
    );
  }

  return (
    <SettingsInset className="space-y-4 bg-dls-surface" data-testid="agent-access-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="text-base font-semibold text-dls-text">Agent access to connected services</div>
          <div className="max-w-[62ch] text-sm text-dls-secondary">
            Lets agents use the exact OpenWork Cloud tools for this active workspace and organization.
          </div>
        </div>
        <SettingsStatusBadge label={summary.statusLabel} tone={summary.tone} />
      </div>

      <div className="grid gap-2 text-sm text-dls-secondary sm:grid-cols-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-dls-secondary">First issue</div>
          <div className="mt-1 text-dls-text">{summary.stageLabel}</div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-dls-secondary">Recommended action</div>
          <div className="mt-1 text-dls-text">{summary.recommendedAction}</div>
        </div>
      </div>

      {health?.usable ? (
        <div className="space-y-2 rounded-xl border border-green-6/30 bg-green-2 p-3 text-sm text-green-11">
          <div className="font-medium">Cloud tools verified for this workspace</div>
          <div className="flex flex-wrap gap-2 font-mono text-xs">
            {readyTools.map((tool) => <span key={tool} className="rounded-md bg-green-3 px-2 py-1">{tool}</span>)}
          </div>
          <div className="text-xs">
            {health.usableByCurrentModel === null
              ? "Current model access was not checked."
              : health.usableByCurrentModel
                ? "Current model can use these Cloud tools."
                : "Current model cannot use these Cloud tools."}
          </div>
        </div>
      ) : null}

      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!canRun || busy !== null} onClick={() => void testNow()}>
          {busy === "test" ? "Testing…" : "Test now"}
        </Button>
        <Button size="sm" disabled={!canRun || busy !== null} onClick={() => void repairAndTest()}>
          {busy === "repair" ? "Repairing…" : "Repair and test"}
        </Button>
      </div>

      <AgentAccessAdvanced
        health={health}
        engineRefresh={lastEngineRefresh}
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((current) => !current)}
        busyLabel={busy}
        canRun={canRun}
        copyStatus={copyStatus}
        onRefreshEngine={() => void refreshEngineConnection()}
        onCopy={() => void copyDiagnostics()}
      />
    </SettingsInset>
  );
}

function AgentAccessAdvanced(props: {
  health: OpenworkCloudMcpHealth | null;
  engineRefresh: OpenworkCloudMcpEngineRefresh | null;
  open: boolean;
  onToggle: () => void;
  busyLabel: "test" | "repair" | "refresh" | null;
  canRun: boolean;
  copyStatus: string | null;
  onRefreshEngine: () => void;
  onCopy: () => void;
}) {
  const rows = cloudMcpAdvancedRows(props.health);
  const traceLines = cloudMcpProbeTraceLines(props.health?.tools.direct.trace);
  const refreshLines = cloudMcpEngineRefreshLines(props.engineRefresh);
  return (
    <div className="border-t border-dls-border pt-3" data-testid="agent-access-advanced">
      <button
        type="button"
        className="flex items-center gap-1 text-xs font-medium text-dls-secondary transition-colors hover:text-dls-text"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        {props.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Advanced diagnostics
      </button>
      {props.open ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!props.canRun || props.busyLabel !== null}
              onClick={props.onRefreshEngine}
            >
              {props.busyLabel === "refresh" ? "Refreshing engine…" : "Refresh engine connection"}
            </Button>
            <Button variant="outline" size="sm" disabled={!props.health} onClick={props.onCopy}>
              Copy sanitized diagnostic
            </Button>
          </div>
          <div className="text-xs text-dls-secondary">
            Refresh makes the agent engine drop its Cloud connection and reconnect from scratch — the engine never
            retries a failed connection on its own. Diagnostics are redacted before copy.
          </div>
          {props.copyStatus ? <div className="text-xs text-dls-secondary">{props.copyStatus}</div> : null}
          {rows.length ? (
            <div className="grid gap-1.5" data-testid="agent-access-advanced-rows">
              {rows.map((row) => (
                <div key={row.label} className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-dls-secondary">{row.label}</div>
                  <div
                    className={`break-words font-mono text-xs ${
                      row.tone === "error" ? "text-red-11" : row.tone === "muted" ? "text-dls-secondary" : "text-dls-text"
                    }`}
                  >
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-dls-secondary">Run Test now to load diagnostics for this workspace.</div>
          )}
          {traceLines.length ? (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-dls-secondary">Direct probe steps</div>
              <div className="mt-1 space-y-0.5 font-mono text-xs text-dls-text">
                {traceLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
              </div>
            </div>
          ) : null}
          {refreshLines.length ? (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-dls-secondary">Last engine refresh</div>
              <div className="mt-1 space-y-0.5 font-mono text-xs text-dls-text">
                {refreshLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
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
      group: Exclude<ConnectRowGroup, "excluded">;
      name: string;
      description: string;
      meta: string;
      canManage: boolean;
      connection: DenExternalMcpConnection;
    }
  | {
      kind: "plugin";
      id: string;
      group: Exclude<ConnectRowGroup, "excluded">;
      name: string;
      description: string;
      meta: string;
      importedLocally: boolean;
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

export function buildConnectRows(input: {
  connections: DenExternalMcpConnection[];
  items: ExtensionItem[];
  role: "owner" | "admin" | "member" | null | undefined;
}) {
  const marketplaceItems = input.items.filter(isCloudMarketplaceItem);
  const pluginConnectionIds = new Set(
    marketplaceItems.flatMap((item) => item.plugin.cloudReadiness?.connections.flatMap((connection) => connection.id ? [connection.id] : []) ?? []),
  );
  const connectionRows: ConnectOrganizationRow[] = input.connections.filter((connection) => !pluginConnectionIds.has(connection.id)).map((connection) => ({
    kind: "connection",
    id: connection.id,
    group: resolveConnectionRowGroup(connection),
    name: connection.name,
    description: connection.url,
    meta: connection.credentialMode === "shared" ? t("connect.row_meta_managed_by_org") : t("connect.row_meta_your_account"),
    canManage: isConnectAdminRole(input.role),
    connection,
  }));

  const pluginRows: ConnectOrganizationRow[] = marketplaceItems.flatMap((item) => {
    const group = resolveConnectRowGroup(item.plugin.cloudReadiness, input.role, item.plugin.componentCounts);
    if (group === "excluded") return [];
    return [{
      kind: "plugin",
      id: item.plugin.id,
      group,
      name: item.plugin.name,
      description: item.plugin.description ?? "",
      meta: formatPluginConnectRowMeta(item.plugin),
      importedLocally: Boolean(item.importedPlugin),
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
  const needsReconnect = row.kind === "connection"
    && connectionNeedsReconnect(row.connection);
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
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-dls-text">{row.name}</span>
          {row.kind === "plugin" && row.importedLocally ? (
            <span className="shrink-0 rounded-md border border-amber-6/40 bg-amber-3/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-11">
              {t("connect.marketplace_local_copy_badge")}
            </span>
          ) : null}
        </div>
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
            {connecting ? t("connect.waiting_for_browser") : needsReconnect ? t("mcp.org_connection_reconnect_action") : t("mcp.org_connection_connect_action")}
          </Button>
          {disconnectableConnectionId ? (
            <Button size="sm" variant="destructive" disabled={disconnecting} onClick={() => props.onDisconnect(disconnectableConnectionId)}>
              {disconnecting ? t("mcp.org_connection_disconnecting_action") : t("mcp.org_connection_disconnect_action")}
            </Button>
          ) : null}
        </div>
      ) : row.group === "needs_admin_setup" ? (
        row.kind === "connection" && !row.canManage ? (
          <span className="shrink-0 rounded-md bg-amber-3 px-2 py-1 text-xs font-medium text-amber-11">
            {t("connect.group_needs_admin_setup")}
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void openDesktopUrl(denManageConnectionsUrl())} title={setupNames.join(t("connect.row_meta_list_separator"))}>
            {t("connect.row_action_set_up_connection")}
          </Button>
        )
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
    <div
      data-testid="connect-organization-section"
      data-connect-marketplace-item-count={props.items.length}
      className="space-y-3"
    >
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
  openworkClient: OpenworkServerClient | null;
  workspaceId: string | null;
  currentModel: OpenworkCloudMcpProviderModelContext | null;
  onCloudMcpHealthChange?: (health: OpenworkCloudMcpHealth | null) => void;
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
      <AgentAccessCard
        client={props.openworkClient}
        workspaceId={props.workspaceId}
        currentModel={props.currentModel}
        onHealthChange={props.onCloudMcpHealthChange}
      />

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
  const cloudSession = useCloudSession();
  const orgMcpConnections = props.orgMcpConnections;
  const marketplaceItems = props.marketplaceItems ?? [];
  const refreshMarketplaceItems = props.refreshMarketplaceItems;
  const connectionsCount = orgMcpConnections.connections.length;
  const activeOrgSelected = Boolean(cloudSession.activeOrganization?.id.trim() || readDenSettings().activeOrgId?.trim());
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
        activeOrgSelected,
      });

  useEffect(() => {
    if (state !== "active") return;
    void refreshMarketplaceItems?.();
  }, [refreshMarketplaceItems, state]);

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
          openworkClient={props.openworkClient}
          workspaceId={props.workspaceId}
          currentModel={props.currentModel}
          onCloudMcpHealthChange={props.onCloudMcpHealthChange}
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
