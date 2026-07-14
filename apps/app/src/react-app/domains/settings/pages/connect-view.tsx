/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowUpRight, Cloud, HardDrive, Plus, Power, Trash2 } from "lucide-react";
import type { AgentContextDiagnosticsReport } from "@openwork/types/agent-context-diagnostics";

import { serializeAgentContextDiagnosticsReport } from "@/app/lib/agent-context-diagnostics";
import type { DenExternalMcpConnection, DenOrgPlugin } from "@/app/lib/den";
import { mintCloudControlMcpToken, readDenSettings } from "@/app/lib/den";
import { openDesktopUrl } from "@/app/lib/desktop";
import type {
  OpenworkCloudMcpHealth,
  OpenworkCloudMcpProviderModelContext,
  OpenworkConnectMode,
  OpenworkConnectProfile,
  OpenworkLocalConnectConnection,
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
  SettingsSectionHeaderActions,
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
  runOpenworkCloudMcpReconciler,
  type CloudMcpOperationContext,
} from "../../connections/cloud-mcp-reconciler";
import { readCloudMcpUserState } from "../../connections/cloud-mcp-user-state";
import {
  AgentContextDiagnosticsErrorNotice,
  AgentContextDiagnosticsReportView,
} from "./agent-context-diagnostics-report";

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
  diagnosticsScopeKey: object;
  diagnosticsAvailable: boolean;
  diagnosticsUnavailableReason: "direct-remote-opencode" | null;
  orgMcpConnections: ReturnType<typeof useOrgMcpConnections>;
  onRunAgentDiagnostics: () => Promise<AgentContextDiagnosticsReport>;
};

export type DiagnosticsScope = {
  key: object;
  generation: number;
};

export type DiagnosticsScopeIdentitySignals = {
  client: object | null;
  workspaceCredential: string;
  workspaceId: string;
  workspaceType: string;
  denBaseUrl: string;
  denCredential: string;
  denSignedIn: boolean;
  organizationId: string;
  principalId: string;
};

/**
 * `useMemo` owns the signal comparison. The value crossing into ConnectView is
 * deliberately an empty identity object so credentials and principal fields
 * can invalidate stale results without becoming readable report state.
 */
export function createOpaqueDiagnosticsScopeKey(
  _signals: DiagnosticsScopeIdentitySignals,
): object {
  return Object.freeze({});
}

export type ScopedDiagnosticsValue<T> = {
  scope: DiagnosticsScope;
  value: T;
};

export function readDiagnosticsValueForScope<T>(
  scoped: ScopedDiagnosticsValue<T> | null,
  scope: DiagnosticsScope,
): T | null {
  if (!scoped) return null;
  if (scoped.scope.key !== scope.key || scoped.scope.generation !== scope.generation) return null;
  return scoped.value;
}

type AgentDiagnosticsViewState = {
  report: AgentContextDiagnosticsReport | null;
  busy: boolean;
  copying: boolean;
  error: string | null;
  copied: boolean;
};

function emptyAgentDiagnosticsViewState(): AgentDiagnosticsViewState {
  return {
    report: null,
    busy: false,
    copying: false,
    error: null,
    copied: false,
  };
}

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
  const [busy, setBusy] = useState<"test" | "repair" | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      const result = await runOpenworkCloudMcpReconciler({
        mode: "health",
        client: props.client,
        context: { ...context, trigger: "desktop-connect-test" },
        mintToken: mintCloudControlMcpToken,
        refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
      });
      updateHealth(result.health);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not test agent access.");
    } finally {
      setBusy(null);
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

  const canRun = Boolean(props.client && context && signedIn);
  const readyTools = readyCloudMcpToolIds(health);

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
    </SettingsInset>
  );
}

function ConnectIntro(props: { busy: boolean; disabled: boolean; onRun: () => void }) {
  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>{t("connect.header_title")}</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>
            {t("connect.header_description")}
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
        <SettingsSectionHeaderActions>
          <Button
            data-testid="run-agent-diagnostics"
            size="sm"
            variant="outline"
            disabled={props.busy || props.disabled}
            onClick={props.onRun}
          >
            <Activity size={14} />
            {props.busy ? t("connect.diagnostics_running") : t("connect.diagnostics_run")}
          </Button>
        </SettingsSectionHeaderActions>
      </SettingsSectionHeader>
      <SettingsNotice>{t("connect.diagnostics_preflight_notice")}</SettingsNotice>
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

export function ConnectModeSelector(props: {
  profile: OpenworkConnectProfile | null;
  busy: boolean;
  error: string | null;
  onSelect: (mode: OpenworkConnectMode) => void;
}) {
  const mode = props.profile?.mode ?? "hosted";
  const choices: Array<{
    mode: OpenworkConnectMode;
    title: string;
    description: string;
    icon: typeof Cloud;
  }> = [
    {
      mode: "hosted",
      title: "Hosted (recommended)",
      description: "OpenWork Cloud manages team connections and access.",
      icon: Cloud,
    },
    {
      mode: "local",
      title: "Local",
      description: "The active OpenWork Server keeps connections, credentials, and execution under its owner’s control.",
      icon: HardDrive,
    },
    {
      mode: "disabled",
      title: "Off",
      description: "Do not give agents access to connected services.",
      icon: Power,
    },
  ];
  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>Where Connect runs</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>
            Hosted and Local use the same agent experience. Only the owner of credentials and runtime changes.
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
        <SettingsStatusBadge
          label={mode === "hosted" ? "Hosted" : mode === "local" ? "Local" : "Off"}
          tone={mode === "disabled" ? "neutral" : "ready"}
        />
      </SettingsSectionHeader>
      <div className="grid gap-3 md:grid-cols-3" data-testid="connect-mode-selector">
        {choices.map((choice) => {
          const Icon = choice.icon;
          const selected = mode === choice.mode;
          const disabled = props.busy || (choice.mode === "local" && props.profile?.localAvailable === false);
          return (
            <button
              key={choice.mode}
              type="button"
              disabled={disabled}
              data-connect-mode={choice.mode}
              data-selected={selected ? "true" : "false"}
              className={`rounded-xl border p-4 text-left transition-colors ${selected ? "border-dls-accent bg-dls-hover" : "border-dls-border bg-dls-surface hover:bg-dls-hover"} disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={() => props.onSelect(choice.mode)}
            >
              <Icon size={18} className="mb-3 text-dls-secondary" />
              <div className="text-sm font-semibold text-dls-text">{choice.title}</div>
              <div className="mt-1 text-xs leading-5 text-dls-secondary">{choice.description}</div>
            </button>
          );
        })}
      </div>
      {props.profile && props.profile.vault.status !== "ready" ? (
        <SettingsNotice tone="error">{props.profile.vault.message}</SettingsNotice>
      ) : null}
      {props.error ? <SettingsNotice tone="error">{props.error}</SettingsNotice> : null}
    </SettingsSection>
  );
}

function localConnectionStatus(connection: OpenworkLocalConnectConnection): { label: string; tone: "ready" | "warning" | "error" | "neutral" } {
  if (connection.status === "connected") return { label: "Ready", tone: "ready" };
  if (connection.status === "needs_auth") return { label: "Sign in needed", tone: "warning" };
  if (connection.status === "error") return { label: "Needs attention", tone: "error" };
  return { label: "Not connected", tone: "neutral" };
}

function readLocalAuthType(value: string): OpenworkLocalConnectConnection["authType"] {
  if (value === "none" || value === "api-key") return value;
  return "oauth";
}

export function LocalConnectPanel(props: {
  client: OpenworkServerClient | null;
  profile: OpenworkConnectProfile;
  onProfileChange: (profile: OpenworkConnectProfile) => void;
}) {
  const [connections, setConnections] = useState<OpenworkLocalConnectConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [authorizingId, setAuthorizingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [authType, setAuthType] = useState<OpenworkLocalConnectConnection["authType"]>("oauth");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const refresh = async () => {
    if (!props.client) return;
    const result = await props.client.listLocalConnectConnections();
    setConnections(result.items);
    props.onProfileChange({
      ...props.profile,
      connectionCount: result.items.length,
      connectedCount: result.items.filter((connection) => connection.status === "connected").length,
    });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void refresh()
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Could not load local connections.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [props.client]);

  useEffect(() => {
    if (!authorizingId || !props.client) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      void props.client?.listLocalConnectConnections().then((result) => {
        setConnections(result.items);
        const connection = result.items.find((item) => item.id === authorizingId);
        if (connection?.status === "connected" || Date.now() - startedAt > 120_000) {
          setAuthorizingId(null);
          window.clearInterval(timer);
        }
      }).catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [authorizingId, props.client]);

  const createConnection = async () => {
    if (!props.client || !name.trim() || !serverUrl.trim()) return;
    setBusyId("new");
    setError(null);
    try {
      await props.client.createLocalConnectConnection({
        name: name.trim(),
        serverUrl: serverUrl.trim(),
        authType,
        allowPrivateNetwork,
        ...(authType === "api-key" ? { apiKey: apiKey.trim() } : {}),
        ...(authType === "oauth" && clientId.trim()
          ? { oauthClient: { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) } }
          : {}),
      });
      setName("");
      setServerUrl("");
      setApiKey("");
      setClientId("");
      setClientSecret("");
      setAllowPrivateNetwork(false);
      setFormOpen(false);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not add the connection.");
    } finally {
      setBusyId(null);
    }
  };

  const connect = async (connection: OpenworkLocalConnectConnection) => {
    if (!props.client) return;
    setBusyId(connection.id);
    setError(null);
    try {
      const result = await props.client.connectLocalConnectConnection(connection.id);
      if (result.authorizeUrl) {
        setAuthorizingId(connection.id);
        await openDesktopUrl(result.authorizeUrl);
      }
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not connect this service.");
      await refresh().catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (connection: OpenworkLocalConnectConnection) => {
    if (!props.client) return;
    setBusyId(connection.id);
    setError(null);
    try {
      await props.client.disconnectLocalConnectConnection(connection.id);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not disconnect this service.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (connection: OpenworkLocalConnectConnection) => {
    if (!props.client || !window.confirm(`Remove ${connection.name} from Local Connect?`)) return;
    setBusyId(connection.id);
    setError(null);
    try {
      await props.client.deleteLocalConnectConnection(connection.id);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not remove this connection.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>Local connections</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>
            Remote MCP services run through this OpenWork Server. Secrets are encrypted and never returned to the app.
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
        <SettingsSectionHeaderActions>
          <SettingsStatusBadge label={`${props.profile.connectedCount} ready`} tone={props.profile.connectedCount > 0 ? "ready" : "neutral"} />
          <Button size="sm" onClick={() => setFormOpen((current) => !current)}>
            <Plus size={14} />
            Add connection
          </Button>
        </SettingsSectionHeaderActions>
      </SettingsSectionHeader>

      {formOpen ? (
        <SettingsInset className="space-y-3 bg-dls-surface" data-testid="local-connect-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-medium text-dls-secondary">
              Name
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project knowledge" />
            </label>
            <label className="space-y-1 text-xs font-medium text-dls-secondary">
              Server URL
              <Input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" />
            </label>
          </div>
          <label className="block space-y-1 text-xs font-medium text-dls-secondary">
            Sign-in method
            <select
              value={authType}
              onChange={(event) => setAuthType(readLocalAuthType(event.target.value))}
              className="mt-1 h-9 w-full rounded-xl border border-dls-border bg-dls-surface px-3 text-sm text-dls-text"
            >
              <option value="oauth">Browser sign-in (OAuth)</option>
              <option value="api-key">API key</option>
              <option value="none">No sign-in</option>
            </select>
          </label>
          {authType === "api-key" ? (
            <label className="block space-y-1 text-xs font-medium text-dls-secondary">
              API key
              <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" />
            </label>
          ) : null}
          {authType === "oauth" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium text-dls-secondary">
                Client ID (optional)
                <Input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" />
              </label>
              <label className="space-y-1 text-xs font-medium text-dls-secondary">
                Client secret (optional)
                <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" />
              </label>
            </div>
          ) : null}
          <label className="flex items-start gap-2 rounded-xl border border-dls-border bg-dls-hover p-3 text-xs text-dls-secondary">
            <input
              type="checkbox"
              checked={allowPrivateNetwork}
              onChange={(event) => setAllowPrivateNetwork(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium text-dls-text">Allow private-network access</span>
              Enable only for a trusted MCP server on your device or private network. Public HTTPS is safer and remains the default.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={busyId === "new" || !name.trim() || !serverUrl.trim() || (authType === "api-key" && !apiKey.trim())}
              onClick={() => void createConnection()}
            >
              {busyId === "new" ? "Adding…" : "Add"}
            </Button>
          </div>
        </SettingsInset>
      ) : null}

      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      {loading ? <SettingsNotice>Loading local connections…</SettingsNotice> : null}
      {!loading && connections.length === 0 ? (
        <SettingsNotice>Add a remote MCP connection to make its capabilities available to agents.</SettingsNotice>
      ) : null}
      <div className="space-y-2">
        {connections.map((connection) => {
          const status = localConnectionStatus(connection);
          const busy = busyId === connection.id;
          return (
            <div key={connection.id} data-testid="local-connect-row" className="flex flex-col gap-3 rounded-xl border border-dls-border bg-dls-surface p-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-dls-text">{connection.name}</div>
                <div className="truncate text-xs text-dls-secondary">{connection.serverUrl}</div>
                <div className="mt-1 text-xs text-dls-secondary">
                  {connection.networkPolicy === "private" ? "Private-network access allowed" : "Public network only"}
                </div>
                {connection.lastError ? <div className="mt-1 text-xs text-red-10">{connection.lastError}</div> : null}
              </div>
              <SettingsStatusBadge label={authorizingId === connection.id ? "Waiting for browser" : status.label} tone={status.tone} />
              <div className="flex shrink-0 gap-2">
                {connection.status === "connected" ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect(connection)}>Disconnect</Button>
                ) : (
                  <Button size="sm" disabled={busy || authorizingId === connection.id} onClick={() => void connect(connection)}>
                    {busy ? "Connecting…" : "Connect"}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${connection.name}`} onClick={() => void remove(connection)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <SettingsInset className="space-y-2 bg-dls-surface">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-dls-secondary">Available in this mode</div>
        <div className="grid gap-2 text-sm text-dls-secondary sm:grid-cols-2">
          <div>Remote MCP connections</div>
          <SettingsStatusBadge label="Included" tone="ready" />
          <div>Private-network MCP</div>
          <SettingsStatusBadge label={props.profile.features.privateNetworkSources ? "Per connection" : "Unavailable"} tone="neutral" />
          <div>Team sharing and per-person credentials</div>
          <SettingsStatusBadge label="Hosted only" tone="neutral" />
          <div>Local skills and installed plugins</div>
          <SettingsStatusBadge label="Not in this release" tone="warning" />
        </div>
        <div className="text-xs text-dls-secondary">
          Runtime {props.profile.runtimeVersion} · Contract {props.profile.contractVersion}
        </div>
      </SettingsInset>
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
  const needsReconnect = row.kind === "connection"
    && row.connection.connectedForMe
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
  const diagnosticsRunRef = useRef(0);
  const diagnosticsInFlightRef = useRef<{ run: number; scope: DiagnosticsScope } | null>(null);
  const diagnosticsCopyRunRef = useRef(0);
  const diagnosticsCopyInFlightRef = useRef<{
    run: number;
    scope: DiagnosticsScope;
    report: AgentContextDiagnosticsReport;
  } | null>(null);
  const diagnosticsScopeRef = useRef<DiagnosticsScope>({
    key: props.diagnosticsScopeKey,
    generation: 0,
  });
  if (diagnosticsScopeRef.current.key !== props.diagnosticsScopeKey) {
    diagnosticsScopeRef.current = {
      key: props.diagnosticsScopeKey,
      generation: diagnosticsScopeRef.current.generation + 1,
    };
    diagnosticsInFlightRef.current = null;
    diagnosticsCopyRunRef.current += 1;
    diagnosticsCopyInFlightRef.current = null;
  }
  const diagnosticsScope = diagnosticsScopeRef.current;
  const [connectProfile, setConnectProfile] = useState<OpenworkConnectProfile | null>(null);
  const [connectProfileBusy, setConnectProfileBusy] = useState(Boolean(props.openworkClient));
  const [connectProfileError, setConnectProfileError] = useState<string | null>(null);
  const [scopedDiagnosticsState, setScopedDiagnosticsState] = useState<ScopedDiagnosticsValue<AgentDiagnosticsViewState>>(() => ({
    scope: diagnosticsScope,
    value: emptyAgentDiagnosticsViewState(),
  }));
  const diagnosticsState = readDiagnosticsValueForScope(scopedDiagnosticsState, diagnosticsScope)
    ?? emptyAgentDiagnosticsViewState();
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
    let cancelled = false;
    const client = props.openworkClient;
    if (!client) {
      setConnectProfile(null);
      setConnectProfileBusy(false);
      setConnectProfileError(null);
      return () => { cancelled = true; };
    }
    setConnectProfileBusy(true);
    setConnectProfileError(null);
    void client.getConnectProfile()
      .then((profile) => {
        if (!cancelled) setConnectProfile(profile);
      })
      .catch((error) => {
        if (!cancelled) {
          setConnectProfileError(error instanceof Error ? error.message : "Could not read the Connect mode.");
        }
      })
      .finally(() => {
        if (!cancelled) setConnectProfileBusy(false);
      });
    return () => { cancelled = true; };
  }, [props.openworkClient]);

  useEffect(() => {
    if (state !== "active" || connectEnabled !== true) return;
    void refreshMarketplaceItems?.();
  }, [connectEnabled, refreshMarketplaceItems, state]);

  useEffect(() => {
    setScopedDiagnosticsState((current) => readDiagnosticsValueForScope(current, diagnosticsScope) !== null
      ? current
      : { scope: diagnosticsScope, value: emptyAgentDiagnosticsViewState() });
  }, [diagnosticsScope]);

  const runAgentDiagnostics = async () => {
    const inFlight = diagnosticsInFlightRef.current;
    if (
      !props.diagnosticsAvailable
      || (inFlight?.scope.key === diagnosticsScope.key
        && inFlight.scope.generation === diagnosticsScope.generation)
    ) return;
    const run = diagnosticsRunRef.current + 1;
    diagnosticsRunRef.current = run;
    const scope = diagnosticsScope;
    diagnosticsInFlightRef.current = { run, scope };
    diagnosticsCopyRunRef.current += 1;
    diagnosticsCopyInFlightRef.current = null;
    setScopedDiagnosticsState({
      scope,
      value: {
        report: null,
        busy: true,
        copying: false,
        error: null,
        copied: false,
      },
    });
    const isCurrentRun = () => {
      const currentScope = diagnosticsScopeRef.current;
      return diagnosticsRunRef.current === run
        && currentScope.key === scope.key
        && currentScope.generation === scope.generation;
    };
    try {
      const report = await props.onRunAgentDiagnostics();
      if (!isCurrentRun()) return;
      setScopedDiagnosticsState({
        scope,
        value: {
          report,
          busy: true,
          copying: false,
          error: null,
          copied: false,
        },
      });
    } catch {
      if (!isCurrentRun()) return;
      setScopedDiagnosticsState({
        scope,
        value: {
          report: null,
          busy: true,
          copying: false,
          error: t("connect.diagnostics_run_failed"),
          copied: false,
        },
      });
    } finally {
      if (!isCurrentRun()) return;
      if (diagnosticsInFlightRef.current?.run === run) diagnosticsInFlightRef.current = null;
      setScopedDiagnosticsState((current) => {
        const value = readDiagnosticsValueForScope(current, scope);
        return value ? { scope, value: { ...value, busy: false } } : current;
      });
    }
  };

  const copyDiagnosticsReport = async () => {
    const scope = diagnosticsScope;
    const report = diagnosticsState.report;
    const currentScope = diagnosticsScopeRef.current;
    const inFlight = diagnosticsCopyInFlightRef.current;
    if (
      !report
      || currentScope.key !== scope.key
      || currentScope.generation !== scope.generation
      || (inFlight?.scope.key === scope.key
        && inFlight.scope.generation === scope.generation
        && inFlight.report === report)
    ) return;
    const run = diagnosticsCopyRunRef.current + 1;
    diagnosticsCopyRunRef.current = run;
    diagnosticsCopyInFlightRef.current = { run, scope, report };
    setScopedDiagnosticsState((current) => {
      const value = readDiagnosticsValueForScope(current, scope);
      if (!value || value.report !== report) return current;
      return {
        scope,
        value: {
          ...value,
          copying: true,
          copied: false,
          error: null,
        },
      };
    });
    const isCurrentCopy = () => {
      const latestScope = diagnosticsScopeRef.current;
      return diagnosticsCopyRunRef.current === run
        && latestScope.key === scope.key
        && latestScope.generation === scope.generation;
    };
    try {
      await navigator.clipboard.writeText(serializeAgentContextDiagnosticsReport(report));
      if (!isCurrentCopy()) return;
      setScopedDiagnosticsState((current) => {
        const value = readDiagnosticsValueForScope(current, scope);
        if (!value || value.report !== report) return current;
        return { scope, value: { ...value, copied: true, error: null } };
      });
    } catch {
      if (!isCurrentCopy()) return;
      setScopedDiagnosticsState((current) => {
        const value = readDiagnosticsValueForScope(current, scope);
        if (!value || value.report !== report) return current;
        return {
          scope,
          value: {
            ...value,
            copied: false,
            error: t("connect.diagnostics_copy_failed"),
          },
        };
      });
    } finally {
      if (!isCurrentCopy()) return;
      if (diagnosticsCopyInFlightRef.current?.run === run) diagnosticsCopyInFlightRef.current = null;
      setScopedDiagnosticsState((current) => {
        const value = readDiagnosticsValueForScope(current, scope);
        if (!value || value.report !== report) return current;
        return { scope, value: { ...value, copying: false } };
      });
    }
  };

  const selectConnectMode = async (mode: OpenworkConnectMode) => {
    const client = props.openworkClient;
    if (!client || connectProfileBusy || connectProfile?.mode === mode) return;
    const label = mode === "hosted" ? "Hosted Connect" : mode === "local" ? "Local Connect" : "Connect off";
    if (connectProfile && !window.confirm(`Switch to ${label}? Your existing connections and credentials will stay where they are.`)) return;
    setConnectProfileBusy(true);
    setConnectProfileError(null);
    try {
      const result = await client.setConnectProfile(mode);
      setConnectProfile(result.profile);
      const failed = result.deliveries.filter((delivery) => delivery.status === "failed");
      if (failed.length > 0) {
        setConnectProfileError(`Connect changed mode, but ${failed.length} workspace${failed.length === 1 ? "" : "s"} could not be updated.`);
      }
    } catch (error) {
      setConnectProfileError(error instanceof Error ? error.message : "Could not change the Connect mode.");
    } finally {
      setConnectProfileBusy(false);
    }
  };

  const connectMode = connectProfile?.mode ?? "hosted";

  return (
    <SettingsStack>
      <Separator />
      <ConnectModeSelector
        profile={connectProfile}
        busy={connectProfileBusy || !props.openworkClient}
        error={connectProfileError}
        onSelect={(mode) => void selectConnectMode(mode)}
      />
      {connectProfileBusy && !connectProfile ? <ConnectLoadingPanel /> : null}
      {!connectProfileBusy && connectMode === "local" && connectProfile ? (
        <LocalConnectPanel
          client={props.openworkClient}
          profile={connectProfile}
          onProfileChange={setConnectProfile}
        />
      ) : null}
      {!connectProfileBusy && connectMode === "disabled" ? (
        <SettingsSection>
          <SettingsNotice>Connect is off. Agents cannot search or use connected services. Your saved hosted and local connections were not deleted.</SettingsNotice>
        </SettingsSection>
      ) : null}
      {!connectProfileBusy && connectMode === "hosted" ? (
        <>
          <ConnectIntro
            busy={diagnosticsState.busy}
            disabled={!props.diagnosticsAvailable}
            onRun={() => void runAgentDiagnostics()}
          />
          {props.diagnosticsUnavailableReason === "direct-remote-opencode" ? (
            <div data-testid="agent-diagnostics-unavailable-direct-opencode">
              <SettingsNotice>{t("connect.diagnostics_unavailable_direct_opencode")}</SettingsNotice>
            </div>
          ) : null}
          {diagnosticsState.error ? <AgentContextDiagnosticsErrorNotice message={diagnosticsState.error} /> : null}
          {diagnosticsState.report ? (
            <AgentContextDiagnosticsReportView
              report={diagnosticsState.report}
              copied={diagnosticsState.copied}
              copying={diagnosticsState.copying}
              onCopy={copyDiagnosticsReport}
            />
          ) : null}
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
        </>
      ) : null}
    </SettingsStack>
  );
}
