"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, Loader2, MoreHorizontal, Pencil, Plug, Puzzle, RefreshCw, Search, Server, Trash2, Users, Wrench } from "lucide-react";
import { buttonVariants, DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { getPluginRoute } from "../../_lib/den-org";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { IntegrationIcon } from "./integration-icon";
import { Microsoft365Dialog } from "./microsoft-365-dialog";
import { openMcpAuthorizationWindow, safeMcpAuthorizationUrl } from "./mcp-authorization-url";
import {
  editableMcpIdentityChanged,
  marketplaceIdentityOwnerNames,
  mcpAccessMode,
  type McpConnectionAccessMode,
} from "./mcp-connection-editing";
import { formatConnectionCreatorAttribution } from "./mcp-connection-display";
import {
  connectionNeedsOAuthClientConfiguration,
  marketplaceConnectionNeedsAdminSetup,
} from "./mcp-connection-setup";
import { shouldShowMcpConnectionsStagingBanner } from "./mcp-connections-capability";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { marketplaceQueryKeys, useMarketplaces } from "./marketplace-data";
import {
  type CreateMcpConnectionInput,
  type ExternalMcpAuthType,
  type ExternalMcpConnection,
  type ExternalMcpCredentialMode,
  type ExternalMcpPreset,
  type ExternalMcpTool,
  type McpConnectionResolution,
  type McpIssuerReview,
  type McpRequirementsDiscovery,
  type McpConnectionAccessInput,
  McpOAuthConfigurationRequiredError,
  type UpdatedMcpConnection,
  type UpdateMcpConnectionInput,
  formatMcpConnectedTimestamp,
  mcpConnectionQueryKeys,
  useCreateMcpConnection,
  useDeleteMcpConnection,
  useDisconnectMcpConnection,
  useDiscoverMcpConnectionRequirements,
  useMcpConnectionPresets,
  useMcpConnections,
  useMcpConnectionTools,
  useNativeProviderClient,
  useResolveMcpConnection,
  useReviewMcpIssuer,
  useSaveNativeProviderClient,
  useStartMcpConnectionOAuth,
  useTelegramConnection,
  useUpdateMcpConnection,
} from "./mcp-connections-data";
import {
  classifySmartAddInput,
  planSmartAdd,
  smartAddAuthLabel,
} from "./mcp-connection-smart-add";
import { getPluginPartsSummary, pluginQueryKeys, usePlugins } from "./plugin-data";
import { TelegramDialog } from "./telegram-dialog";

const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_POLL_TIMEOUT_MS = 90_000;
const MCP_REQUIREMENTS_DISCOVERY_DELAY_MS = 500;
// Smart resolve fans out server-side probes, so it debounces longer than the
// single-URL requirements discovery.
const SMART_RESOLVE_DELAY_MS = 800;
const MCP_TOOL_PAGE_SIZE = 50;
const MCP_OAUTH_REDIRECT_DOCS_URL = "https://openworklabs.com/docs/cloud/share-with-your-team/shared-mcp-connections#oauth-redirect-url";

function isDiscoverableMcpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

const GOOGLE_WORKSPACE_DEFAULT_FEATURES = ["calendarRead", "gmailDraft", "driveFile"];

const GOOGLE_WORKSPACE_PERMISSION_GROUPS = [
  {
    name: "Calendar",
    permissions: [
      { key: "calendarRead", label: "Read calendar" },
      { key: "calendarWrite", label: "Create calendar events" },
    ],
  },
  {
    name: "Gmail",
    permissions: [
      { key: "gmailDraft", label: "Draft emails" },
      { key: "gmailRead", label: "Read Gmail" },
    ],
  },
  {
    name: "Drive",
    permissions: [
      { key: "driveFile", label: "Work with selected Drive files" },
      { key: "driveRead", label: "Read all Drive files" },
      { key: "driveFull", label: "Full Drive access" },
    ],
  },
  {
    name: "Chat",
    permissions: [
      { key: "chat", label: "Google Chat" },
    ],
  },
];

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (clipboard) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

type GithubPluginImportSkippedReason = "missing_url" | "local_unsupported" | "invalid_url" | "unsupported_auth";

type GithubPluginImportServer = {
  name: string;
  serverKey: string;
  url: string | null;
  supported: boolean;
  skippedReason: GithubPluginImportSkippedReason | null;
};

type GithubPluginImportSkill = {
  description: string | null;
  name: string;
  skillKey: string;
  sourcePath: string;
  supported: boolean;
};

type GithubPluginImportPreview = {
  repositoryFullName: string;
  rootPath: string;
  servers: GithubPluginImportServer[];
  skills: GithubPluginImportSkill[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseSkippedReason(value: unknown): GithubPluginImportSkippedReason | null {
  if (value === "missing_url" || value === "local_unsupported" || value === "invalid_url" || value === "unsupported_auth") {
    return value;
  }
  return null;
}

function parseGithubPluginImportPreview(payload: unknown): GithubPluginImportPreview {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  if (!item) throw new Error("GitHub plugin preview response was incomplete.");

  return {
    repositoryFullName: asString(item.repositoryFullName) ?? "",
    rootPath: asString(item.rootPath) ?? "",
    servers: Array.isArray(item.servers)
      ? item.servers.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const name = asString(entry.name);
          const serverKey = asString(entry.serverKey);
          if (!name || !serverKey) return [];
          return [{
            name,
            serverKey,
            url: asString(entry.url),
            supported: entry.supported === true,
            skippedReason: parseSkippedReason(entry.skippedReason),
          }];
        })
      : [],
    skills: Array.isArray(item.skills)
      ? item.skills.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const name = asString(entry.name);
          const skillKey = asString(entry.skillKey);
          if (!name || !skillKey) return [];
          return [{
            description: asString(entry.description),
            name,
            skillKey,
            sourcePath: asString(entry.sourcePath) ?? "SKILL.md",
            supported: entry.supported === true,
          }];
        })
      : [],
  };
}

function importServerStatus(server: GithubPluginImportServer): string {
  if (server.supported) return "ready";
  if (server.skippedReason === "missing_url") return "missing URL";
  return "unsupported";
}

export function McpConnectionsScreen() {
  const { orgContext, orgSlug } = useOrgDashboard();
  const { data: connections = [], isLoading, error, refetch } = useMcpConnections();
  const { data: usableConnections = [] } = useMcpConnections("usable");
  const { data: presets = [] } = useMcpConnectionPresets();
  const createConnection = useCreateMcpConnection();
  const updateConnection = useUpdateMcpConnection();
  const startOAuth = useStartMcpConnectionOAuth();
  const disconnectConnection = useDisconnectMcpConnection();
  const deleteConnection = useDeleteMcpConnection();
  const saveNativeClient = useSaveNativeProviderClient();
  const reviewIssuer = useReviewMcpIssuer();

  const [formOpen, setFormOpen] = useState(false);
  const [formPreset, setFormPreset] = useState<ExternalMcpPreset | null>(null);
  const [editingConnection, setEditingConnection] = useState<ExternalMcpConnection | null>(null);
  const [configuringOAuthClient, setConfiguringOAuthClient] = useState(false);
  const [issuerReviewConnection, setIssuerReviewConnection] = useState<ExternalMcpConnection | null>(null);
  const [issuerReviewPreview, setIssuerReviewPreview] = useState<McpIssuerReview | null>(null);
  const [pluginDialogOpen, setPluginDialogOpen] = useState(false);
  const [googleDialogOpen, setGoogleDialogOpen] = useState(false);
  const [microsoftDialogOpen, setMicrosoftDialogOpen] = useState(false);
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);
  const googleConfigured = usableConnections.some((connection) => connection.id === "google-workspace");
  const microsoftConfigured = usableConnections.some((connection) => connection.id === "microsoft-365");
  const telegramConnection = useTelegramConnection(true);
  const showStagingBanner = orgContext ? shouldShowMcpConnectionsStagingBanner(orgContext.capabilities) : false;
  const [pollingConnectionId, setPollingConnectionId] = useState<string | null>(null);
  const [oauthClientConfigurationRequiredIds, setOAuthClientConfigurationRequiredIds] = useState<string[]>([]);
  const [connectionActionError, setConnectionActionError] = useState<{ connectionId: string; message: string } | null>(null);
  const [connectionActionNotice, setConnectionActionNotice] = useState<string | null>(null);
  const [toolsConnectionId, setToolsConnectionId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setPollingConnectionId(null);
  }

  function pollUntilConnected(connectionId: string) {
    setPollingConnectionId(connectionId);
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      const result = await refetch();
      const connection = result.data?.find((entry) => entry.id === connectionId);
      if (connection?.connected || Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        stopPolling();
      }
    }, OAUTH_POLL_INTERVAL_MS);
  }

  async function handleConnectOAuth(connectionId: string, pendingAuthorizationWindow?: Window) {
    setConnectionActionError(null);
    let authorizationWindow: Window | null = pendingAuthorizationWindow ?? null;
    try {
      authorizationWindow = authorizationWindow ?? openMcpAuthorizationWindow();
      const result = await startOAuth.mutateAsync(connectionId);
      if (result.status === "connected") {
        authorizationWindow.close();
        void refetch();
        return;
      }
      if (!result.authorizeUrl) throw new Error("The MCP provider did not return an authorization URL.");
      authorizationWindow.location.href = safeMcpAuthorizationUrl(result.authorizeUrl);
      pollUntilConnected(connectionId);
    } catch (connectError) {
      authorizationWindow?.close();
      if (connectError instanceof McpOAuthConfigurationRequiredError) {
        setOAuthClientConfigurationRequiredIds((current) => current.includes(connectionId)
          ? current
          : [...current, connectionId]);
        return;
      }
      setConnectionActionError({
        connectionId,
        message: connectError instanceof Error ? connectError.message : "Failed to connect the MCP server.",
      });
    }
  }

  async function handleCreate(
    input: CreateMcpConnectionInput,
    options: { startOAuth: boolean },
  ): Promise<void> {
    const authorizationWindow = options.startOAuth
      ? openMcpAuthorizationWindow()
      : undefined;
    try {
      const created = await createConnection.mutateAsync(input);
      setFormOpen(false);
      setFormPreset(null);
      // Shared-credential OAuth: the admin authorizes the org's single account
      // right now. Per-member: nothing to authorize here — each granted person
      // connects their own account from Your Connections.
      if (options.startOAuth) {
        await handleConnectOAuth(created.id, authorizationWindow);
      }
    } catch (createError) {
      authorizationWindow?.close();
      throw createError;
    }
  }

  async function handleUpdate(input: UpdateMcpConnectionInput): Promise<UpdatedMcpConnection> {
    setConnectionActionError(null);
    setConnectionActionNotice(null);
    const updated = await updateConnection.mutateAsync(input);
    setOAuthClientConfigurationRequiredIds((current) => current.filter((connectionId) => connectionId !== input.connectionId));
    setEditingConnection(null);
    setConfiguringOAuthClient(false);
    setConnectionActionNotice(updated.reconnectionRequired
      ? `${updated.name} was saved securely. Reconnect it before the new identity can be used.`
      : updated.identityChanged
        ? `${updated.name} was saved and the replacement configuration was validated.`
        : `${updated.name} was updated without disconnecting it.`);
    return updated;
  }

  function handleRemove(connection: ExternalMcpConnection) {
    const confirmed = window.confirm(
      `Delete ${connection.name}? This can remove access grants, per-member authorization state, and plugin or marketplace bindings.`,
    );
    if (confirmed) deleteConnection.mutate(connection.id);
  }

  async function handleDisconnect(connection: ExternalMcpConnection) {
    const confirmed = window.confirm(
      `Disconnect ${connection.name}? This signs out every associated account for this connection, but keeps the MCP server setup, access rules, and plugin or marketplace bindings so you can reconnect later.`,
    );
    if (!confirmed) return;
    setConnectionActionError(null);
    setConnectionActionNotice(null);
    try {
      await disconnectConnection.mutateAsync(connection.id);
      setConnectionActionNotice(`${connection.name} was disconnected. Its setup, access rules, and bindings were kept.`);
    } catch (disconnectError) {
      setConnectionActionError({
        connectionId: connection.id,
        message: disconnectError instanceof Error ? disconnectError.message : "Failed to disconnect the MCP connection.",
      });
    }
  }

  async function handleOpenIssuerReview(connection: ExternalMcpConnection) {
    reviewIssuer.reset();
    setIssuerReviewConnection(connection);
    setIssuerReviewPreview(null);
    try {
      const preview = await reviewIssuer.mutateAsync({
        connectionId: connection.id,
        action: "preview",
      });
      setIssuerReviewPreview(preview);
    } catch {
      // The dialog renders the mutation error with a retry path.
    }
  }

  async function handleConfirmIssuer(authorizationServerIssuer: string) {
    const connection = issuerReviewConnection;
    if (!connection?.updatedAt) return;
    const result = await reviewIssuer.mutateAsync({
      connectionId: connection.id,
      action: "confirm",
      expectedUpdatedAt: connection.updatedAt,
      authorizationServerIssuer,
    });
    setIssuerReviewConnection(null);
    setIssuerReviewPreview(null);
    setConnectionActionNotice(result.reconnectionRequired
      ? `${connection.name} now trusts the confirmed issuer. Its old OAuth client and credentials were cleared; reconnect it to finish recovery.`
      : `${connection.name}'s current issuer was confirmed from live provider metadata.`);
  }

  return (
    <DashboardPageTemplate
      icon={Plug}
      title="Connections"
      badgeLabel="Alpha"
      description="Connect any MCP server — Notion, Linear, Stripe, or a custom URL — once for the whole org. search_capabilities and execute_capability pick these up automatically."
      colors={["#E2E8F0", "#020617", "#0F172A", "#94A3B8"]}
    >
      {showStagingBanner ? (
        <div data-testid="mcp-connections-staging-banner" className="mb-6 rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-4 text-[14px] leading-6 text-amber-800">
          <p className="font-semibold text-amber-900">OpenWork Connect (alpha) is staged for this org.</p>
          <p className="mt-1">
            Connections and marketplace capabilities you set up here stay staged and invisible to members until a platform admin enables OpenWork Connect (alpha) for this org. Admin management remains fully usable.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load MCP connections."}
        </div>
      ) : null}

      {connectionActionError ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700" role="alert">
          {connectionActionError.message}
        </div>
      ) : null}

      {connectionActionNotice ? (
        <div className="mb-6 rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-[14px] text-emerald-800" role="status">
          {connectionActionNotice}
        </div>
      ) : null}

      <div className="mb-6 rounded-2xl border border-gray-100 bg-white px-6 py-5">
        <div>
          <h2 className="text-[15px] font-semibold text-gray-900">Add a connection</h2>
          <p className="mt-1 text-[13px] text-gray-500">
            Add a single MCP server, or import a plugin bundle so its MCPs and skills become available through capabilities.
          </p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              setFormPreset(null);
              setFormOpen(true);
            }}
            className="flex items-start gap-3 rounded-2xl border border-gray-100 px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-900 text-white">
              <Server className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-[14px] font-semibold text-gray-900">MCP server</span>
              <span className="mt-1 block text-[12px] leading-5 text-gray-500">Paste a server URL and we&apos;ll check it for you.</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setPluginDialogOpen(true)}
            className="flex items-start gap-3 rounded-2xl border border-gray-100 px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-900 text-white">
              <Puzzle className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-[14px] font-semibold text-gray-900">Plugin bundle</span>
              <span className="mt-1 block text-[12px] leading-5 text-gray-500">Import from GitHub or choose from your plugin library.</span>
            </span>
          </button>
        </div>
      </div>

      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Quick add</h3>
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <button
          type="button"
          onClick={() => setGoogleDialogOpen(true)}
          className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm"
        >
          <div className="flex items-start gap-3">
            <IntegrationIcon name="Google Workspace" iconUrl="/integrations/google.svg" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-gray-900">Google Workspace</p>
              <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">
                Your company&apos;s Google. Set it up once — every member connects their own account.
              </p>
            </div>
          </div>
          <p className="mt-2 text-[12px] font-medium text-gray-900">
            {googleConfigured ? "Configured — tap to update" : "Tap to set up"}
          </p>
        </button>
        <button
          type="button"
          data-testid="quick-add-microsoft-365"
          onClick={() => setMicrosoftDialogOpen(true)}
          className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm"
        >
          <div className="flex items-start gap-3">
            <IntegrationIcon name="Microsoft 365" simpleIconSlug="microsoft" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-gray-900">Microsoft 365</p>
              <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">
                Outlook mail, calendar, and OneDrive. Each teammate connects their own work account.
              </p>
            </div>
          </div>
          <p className="mt-2 text-[12px] font-medium text-gray-900">
            {microsoftConfigured ? "Configured — tap to update" : "Tap to set up"}
          </p>
        </button>
        <button
          type="button"
          data-testid="quick-add-telegram"
          onClick={() => setTelegramDialogOpen(true)}
          className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm"
        >
          <div className="flex items-start gap-3">
            <IntegrationIcon name="Telegram" simpleIconSlug="telegram" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-gray-900">Telegram</p>
              <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">
                Pair a private Telegram chat to a cloud worker for tasks and replies.
              </p>
            </div>
          </div>
          <p className="mt-2 text-[12px] font-medium text-gray-900">
            {telegramConnection.data ? "Connected — tap to manage" : "Tap to set up"}
          </p>
        </button>
        {presets.map((preset) => {
          const alreadyAdded = connections.some((connection) => connection.url === preset.url);
          return (
            <button
              key={preset.presetId}
              type="button"
              disabled={alreadyAdded}
              onClick={() => {
                setFormPreset(preset);
                setFormOpen(true);
              }}
              className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="flex items-start gap-3">
                <IntegrationIcon name={preset.displayName} serviceUrl={preset.url} />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-gray-900">{preset.displayName}</p>
                  <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">{preset.description}</p>
                </div>
              </div>
              <p className="mt-2 text-[12px] font-medium text-gray-900">
                {alreadyAdded ? "Already added" : "Tap to add"}
              </p>
            </button>
          );
        })}
      </div>

      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Your connections</h3>
      {isLoading ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading MCP connections…
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-center text-[14px] text-gray-500">
          No MCP connections yet.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
          {connections.map((connection) => {
            const connectAttemptRequiresConfiguration = oauthClientConfigurationRequiredIds.includes(connection.id);
            const needsOAuthClientConfiguration = connectionNeedsOAuthClientConfiguration(
              connection,
              connectAttemptRequiresConfiguration,
            );
            const needsPluginSetup = marketplaceConnectionNeedsAdminSetup(connection, presets)
              && !needsOAuthClientConfiguration;
            const setupPluginId = connection.identityManagedBy[0]?.pluginId;
            return <ConnectionRow
              key={connection.id}
              connection={connection}
              needsPluginSetup={needsPluginSetup}
              needsOAuthClientConfiguration={needsOAuthClientConfiguration}
              setupHref={needsPluginSetup && setupPluginId ? getPluginRoute(orgSlug, setupPluginId) : null}
              polling={pollingConnectionId === connection.id}
              connecting={startOAuth.isPending && startOAuth.variables === connection.id}
              errorMessage={connectionActionError?.connectionId === connection.id ? connectionActionError.message : null}
              onEdit={() => {
                updateConnection.reset();
                setConfiguringOAuthClient(false);
                setEditingConnection(connection);
              }}
              onConfigure={() => {
                updateConnection.reset();
                setConfiguringOAuthClient(true);
                setEditingConnection(connection);
              }}
              onReviewIssuer={() => void handleOpenIssuerReview(connection)}
              onConnect={() => void handleConnectOAuth(connection.id)}
              onDisconnect={() => void handleDisconnect(connection)}
              onRemove={() => handleRemove(connection)}
              disconnecting={disconnectConnection.isPending && disconnectConnection.variables === connection.id}
              removing={deleteConnection.isPending && deleteConnection.variables === connection.id}
              toolsOpen={toolsConnectionId === connection.id}
              onToggleTools={() => setToolsConnectionId((current) => current === connection.id ? null : connection.id)}
            />;
          })}
        </div>
      )}

      <AddConnectionDialog
        open={formOpen}
        preset={formPreset}
        submitting={createConnection.isPending}
        error={createConnection.error}
        onClose={() => {
          setFormOpen(false);
          setFormPreset(null);
        }}
        onSubmit={handleCreate}
      />

      <EditConnectionDialog
        connection={editingConnection}
        configureOAuthClient={configuringOAuthClient}
        submitting={updateConnection.isPending}
        error={updateConnection.error}
        onClose={() => {
          updateConnection.reset();
          setConfiguringOAuthClient(false);
          setEditingConnection(null);
        }}
        onSubmit={handleUpdate}
      />

      <IssuerReviewDialog
        connection={issuerReviewConnection}
        preview={issuerReviewPreview}
        loading={reviewIssuer.isPending}
        error={reviewIssuer.error}
        onRetry={() => issuerReviewConnection ? void handleOpenIssuerReview(issuerReviewConnection) : undefined}
        onClose={() => {
          if (reviewIssuer.isPending) return;
          setIssuerReviewConnection(null);
          setIssuerReviewPreview(null);
          reviewIssuer.reset();
        }}
        onConfirm={(issuer) => void handleConfirmIssuer(issuer)}
      />

      <ImportPluginConnectionDialog
        open={pluginDialogOpen}
        onClose={() => setPluginDialogOpen(false)}
        onImported={() => void refetch()}
      />

      <GoogleWorkspaceDialog
        open={googleDialogOpen}
        submitting={saveNativeClient.isPending}
        error={saveNativeClient.error}
        onClose={() => setGoogleDialogOpen(false)}
        onSubmit={async (input) => {
          await saveNativeClient.mutateAsync({ providerId: "google-workspace", ...input });
          setGoogleDialogOpen(false);
        }}
      />

      <Microsoft365Dialog
        open={microsoftDialogOpen}
        submitting={saveNativeClient.isPending}
        error={saveNativeClient.error}
        onClose={() => setMicrosoftDialogOpen(false)}
        onSubmit={async (input) => {
          await saveNativeClient.mutateAsync({ providerId: "microsoft-365", ...input });
          setMicrosoftDialogOpen(false);
        }}
      />

      <TelegramDialog open={telegramDialogOpen} onClose={() => setTelegramDialogOpen(false)} />
    </DashboardPageTemplate>
  );
}

function ImportPluginConnectionDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const queryClient = useQueryClient();
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const { data: marketplaces = [] } = useMarketplaces();
  const { data: plugins = [], isLoading: pluginsLoading } = usePlugins();
  const [githubUrl, setGithubUrl] = useState("");
  const [marketplaceId, setMarketplaceId] = useState("");
  const [authType, setAuthType] = useState<"oauth" | "none">("oauth");
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>("per_member");
  const [preview, setPreview] = useState<GithubPluginImportPreview | null>(null);
  const [selectedServerKeys, setSelectedServerKeys] = useState<string[]>([]);
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!marketplaceId && marketplaces.length > 0) {
      setMarketplaceId(marketplaces[0].id);
    }
  }, [marketplaceId, marketplaces, open]);

  useEffect(() => {
    if (!open) return;
    setGithubUrl("");
    setAuthType("oauth");
    setCredentialMode("per_member");
    setPreview(null);
    setSelectedServerKeys([]);
    setSelectedSkillKeys([]);
    setError(null);
  }, [open]);

  const libraryPlugins = useMemo(
    () => plugins.filter((plugin) => plugin.mcps.length > 0 || plugin.skills.length > 0),
    [plugins],
  );

  async function previewGithubPlugin() {
    if (!githubUrl.trim()) {
      setError("Paste a GitHub plugin URL.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let payload: unknown = null;
      await runReauthableAction("preview-github-connection-plugin", async () => {
        const result = await requestJson(
          "/v1/plugins/import-mcps-from-github-url/preview",
          { method: "POST", body: JSON.stringify({ githubUrl: githubUrl.trim() }) },
          20000,
        );
        if (!result.response.ok) {
          throw getRequestError(result.payload, result.response, "Failed to preview GitHub plugin.");
        }
        payload = result.payload;
      });
      const nextPreview = parseGithubPluginImportPreview(payload);
      setPreview(nextPreview);
      setSelectedServerKeys(nextPreview.servers.filter((server) => server.supported).map((server) => server.serverKey));
      setSelectedSkillKeys(nextPreview.skills.filter((skill) => skill.supported).map((skill) => skill.skillKey));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Failed to preview GitHub plugin.");
    } finally {
      setBusy(false);
    }
  }

  async function importGithubPlugin() {
    if (!preview) {
      setError("Preview the GitHub plugin first.");
      return;
    }
    if (!marketplaceId) {
      setError("Choose a marketplace.");
      return;
    }
    if (selectedServerKeys.length === 0 && selectedSkillKeys.length === 0) {
      setError("Select at least one MCP or skill.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await runReauthableAction("import-github-connection-plugin", async () => {
        const result = await requestJson(
          "/v1/plugins/import-mcps-from-github-url",
          {
            method: "POST",
            body: JSON.stringify({
              access: { orgWide: true, memberIds: [], teamIds: [] },
              authType,
              credentialMode: authType === "oauth" ? credentialMode : "shared",
              githubUrl: githubUrl.trim(),
              marketplaceId,
              selectedServerKeys,
              selectedSkillKeys,
            }),
          },
          30000,
        );
        if (!result.response.ok) {
          throw getRequestError(result.payload, result.response, "Failed to import GitHub plugin.");
        }
      });
      await queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
      onImported();
      onClose();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Failed to import GitHub plugin.");
    } finally {
      setBusy(false);
    }
  }

  function toggleServer(serverKey: string, checked: boolean) {
    setSelectedServerKeys((current) =>
      checked ? [...new Set([...current, serverKey])] : current.filter((key) => key !== serverKey),
    );
  }

  function toggleSkill(skillKey: string, checked: boolean) {
    setSelectedSkillKeys((current) =>
      checked ? [...new Set([...current, skillKey])] : current.filter((key) => key !== skillKey),
    );
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">Add plugin connection</h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-600">
          Import a plugin from GitHub. Remote MCPs become Den-hosted org connections; imported skills are saved to Skill Hub storage and show up in capabilities.
        </p>

        <div className="mt-5 rounded-2xl border border-gray-100 bg-gray-50 p-4">
          <label className="mb-1.5 block text-[12px] font-medium text-gray-700">GitHub plugin URL</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <DenInput
              value={githubUrl}
              onChange={(event) => {
                setGithubUrl(event.target.value);
                setPreview(null);
                setSelectedServerKeys([]);
                setSelectedSkillKeys([]);
                setError(null);
              }}
              placeholder="https://github.com/anthropics/knowledge-work-plugins/tree/main/sales"
              disabled={busy}
            />
            <DenButton variant="secondary" onClick={() => void previewGithubPlugin()} disabled={busy || !githubUrl.trim()}>
              {busy && !preview ? "Previewing..." : "Preview"}
            </DenButton>
          </div>
        </div>

        {preview ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-2xl border border-gray-100 bg-white px-4 py-3 text-[13px] text-gray-600">
              Found {preview.servers.filter((server) => server.supported).length} MCPs and {preview.skills.filter((skill) => skill.supported).length} skills in{" "}
              <span className="font-medium text-gray-900">{preview.repositoryFullName}{preview.rootPath ? `/${preview.rootPath}` : ""}</span>.
            </div>

            {preview.servers.length > 0 ? (
              <div className="overflow-hidden rounded-2xl border border-gray-100">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.12em] text-gray-400">
                    <tr>
                      <th className="w-12 px-4 py-3">Use</th>
                      <th className="px-4 py-3">MCP</th>
                      <th className="px-4 py-3">URL</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {preview.servers.map((server) => (
                      <tr key={server.serverKey}>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedServerKeys.includes(server.serverKey)}
                            disabled={!server.supported || busy}
                            onChange={(event) => toggleServer(server.serverKey, event.target.checked)}
                          />
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900">{server.name}</td>
                        <td className="max-w-[240px] truncate px-4 py-3 font-mono text-[12px] text-gray-500">{server.url ?? "—"}</td>
                        <td className="px-4 py-3 text-gray-500">{importServerStatus(server)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {preview.skills.length > 0 ? (
              <div className="overflow-hidden rounded-2xl border border-gray-100">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.12em] text-gray-400">
                    <tr>
                      <th className="w-12 px-4 py-3">Use</th>
                      <th className="px-4 py-3">Skill</th>
                      <th className="px-4 py-3">Path</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {preview.skills.map((skill) => (
                      <tr key={skill.skillKey}>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedSkillKeys.includes(skill.skillKey)}
                            disabled={!skill.supported || busy}
                            onChange={(event) => toggleSkill(skill.skillKey, event.target.checked)}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{skill.name}</div>
                          {skill.description ? <div className="mt-0.5 text-[12px] text-gray-500">{skill.description}</div> : null}
                        </td>
                        <td className="max-w-[240px] truncate px-4 py-3 font-mono text-[12px] text-gray-500">{skill.sourcePath}</td>
                        <td className="px-4 py-3 text-gray-500">{skill.supported ? "ready" : "unsupported"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Authentication</span>
                <DenSelect value={authType} onChange={(event) => setAuthType(event.target.value === "none" ? "none" : "oauth")} disabled={busy}>
                  <option value="oauth">OAuth</option>
                  <option value="none">No auth</option>
                </DenSelect>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Account mode</span>
                <DenSelect
                  value={credentialMode}
                  onChange={(event) => setCredentialMode(event.target.value === "shared" ? "shared" : "per_member")}
                  disabled={busy || authType === "none"}
                >
                  <option value="per_member">Individual accounts</option>
                  <option value="shared">Org account</option>
                </DenSelect>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Marketplace</span>
                <DenSelect value={marketplaceId} onChange={(event) => setMarketplaceId(event.target.value)} disabled={busy}>
                  {marketplaces.map((marketplace) => (
                    <option key={marketplace.id} value={marketplace.id}>
                      {marketplace.name}
                    </option>
                  ))}
                </DenSelect>
              </label>
            </div>
          </div>
        ) : null}

        <div className="mt-6">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-gray-400">Plugin library</h3>
          <div className="mt-3 rounded-2xl border border-gray-100 bg-white">
            {pluginsLoading ? (
              <div className="px-4 py-5 text-[13px] text-gray-500">Loading plugin library...</div>
            ) : libraryPlugins.length === 0 ? (
              <div className="px-4 py-5 text-[13px] text-gray-500">No imported plugins with MCPs or skills yet.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {libraryPlugins.slice(0, 6).map((plugin) => (
                  <Link
                    key={plugin.id}
                    href={getPluginRoute(orgSlug, plugin.id)}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-gray-50"
                    onClick={onClose}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-gray-900">{plugin.name}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-gray-500">{getPluginPartsSummary(plugin)}</span>
                    </span>
                    <span className="text-[12px] font-medium text-gray-500">Open</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {error ? (
          <p className="mt-3 text-[13px] text-red-600">{error}</p>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </DenButton>
          <DenButton
            variant="primary"
            loading={busy && Boolean(preview)}
            disabled={!preview || !marketplaceId || (selectedServerKeys.length === 0 && selectedSkillKeys.length === 0)}
            onClick={() => void importGithubPlugin()}
          >
            Import selected
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function GoogleWorkspaceDialog({
  open,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: { clientId?: string; clientSecret?: string; features: string[] }) => void;
}) {
  const clientConfig = useNativeProviderClient("google-workspace", open);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [features, setFeatures] = useState<string[]>([]);
  const [copiedRedirectUri, setCopiedRedirectUri] = useState(false);
  const [replacingCredentials, setReplacingCredentials] = useState(false);
  const featuresPrefilled = useRef(false);

  useEffect(() => {
    if (!open) return;
    setClientId("");
    setClientSecret("");
    setFeatures(GOOGLE_WORKSPACE_DEFAULT_FEATURES);
    setCopiedRedirectUri(false);
    setReplacingCredentials(false);
    featuresPrefilled.current = false;
  }, [open]);

  useEffect(() => {
    if (!open || featuresPrefilled.current || !clientConfig.isSuccess || clientConfig.isFetching) return;
    setFeatures(clientConfig.data.features);
    featuresPrefilled.current = true;
  }, [open, clientConfig.isSuccess, clientConfig.isFetching, clientConfig.data?.features]);

  if (!open) {
    return null;
  }

  const configured = clientConfig.data?.configured ?? false;
  const savedClientId = clientConfig.data?.clientId;
  const redirectUri = clientConfig.data?.redirectUri ?? "";
  const loadingConfig = clientConfig.isLoading;
  const formError = error ?? clientConfig.error;
  const trimmedClientId = clientId.trim();
  const trimmedClientSecret = clientSecret.trim();
  const showCredentialFields = !loadingConfig && (!configured || replacingCredentials);
  const saveDisabled = loadingConfig || (showCredentialFields && (!trimmedClientId || !trimmedClientSecret));

  function toggleFeature(feature: string) {
    setFeatures((current) => current.includes(feature) ? current.filter((entry) => entry !== feature) : [...current, feature]);
  }

  async function copyRedirectUri() {
    if (!redirectUri) return;
    if (await copyTextToClipboard(redirectUri)) setCopiedRedirectUri(true);
  }

  function startReplacingCredentials() {
    setClientId(savedClientId ?? "");
    setClientSecret("");
    setReplacingCredentials(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
          {configured ? "Update Google Workspace" : "Set up Google Workspace"}
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-600">
          Use one Google OAuth web app for your org. Members then connect their own Google account from Your Connections — sign-ins stay in your org&apos;s cloud.
        </p>

        <div className="mt-5 space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-[13px] font-semibold text-gray-900">How to set it up</p>
            <ol className="mt-2 list-decimal space-y-2 pl-4 text-[12px] leading-5 text-gray-600">
              <li>
                In Google Cloud Console, create an OAuth client ID for a Web application.{" "}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-4">
                  Open Google Cloud Console
                </a>
              </li>
              <li>
                <p>Add this exact authorized redirect URI:</p>
                <div className="mt-1 flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2">
                  <p data-google-redirect-uri className="min-w-0 flex-1 break-all font-mono text-[11px] leading-5 text-gray-800">
                    {redirectUri || "Loading redirect URI…"}
                  </p>
                  <DenButton variant="secondary" size="sm" data-testid="copy-redirect-uri" onClick={copyRedirectUri} disabled={!redirectUri}>
                    {copiedRedirectUri ? "Copied" : "Copy"}
                  </DenButton>
                </div>
              </li>
              <li>
                Enable the Google APIs for the permissions you pick (Gmail, Calendar, Drive).{" "}
                <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener" className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-4">
                  Open API library
                </a>
              </li>
              <li>Paste the client ID and secret here for first-time setup, or only when you choose to replace saved credentials.</li>
            </ol>
          </div>
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-[13px] font-semibold text-gray-900">Permissions</p>
            <p className="mt-1 text-[12px] leading-5 text-gray-500">
              Pick what your team&apos;s AI can do across Calendar, Gmail, and Drive. Signing in always shares the member&apos;s name and email.
            </p>
            <div className="mt-3 space-y-3">
              {GOOGLE_WORKSPACE_PERMISSION_GROUPS.map((group) => (
                <div key={group.name}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">{group.name}</p>
                  <div className="space-y-2">
                    {group.permissions.map((permission) => (
                      <label key={permission.key} className="flex items-center gap-2 text-[13px] text-gray-700">
                        <input
                          type="checkbox"
                          data-feature={permission.key}
                          className="h-4 w-4 rounded border-gray-300 text-gray-900"
                          checked={features.includes(permission.key)}
                          disabled={loadingConfig}
                          onChange={() => toggleFeature(permission.key)}
                        />
                        <span>{permission.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {loadingConfig ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4 text-[13px] text-gray-500">
              Checking saved credentials…
            </div>
          ) : null}
          {configured && !replacingCredentials ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-600" />
                <p className="text-[13px] font-semibold text-gray-900">Credentials saved</p>
              </div>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">
                OpenWork keeps the saved Google client ID and secret when you save permission changes. Replace them only if you are rotating credentials.
              </p>
              <div className="mt-3 rounded-xl border border-gray-100 bg-white px-3 py-2 text-[12px] text-gray-800">
                Saved client ID: <span className="font-mono">{savedClientId ?? "stored in OpenWork"}</span>
              </div>
              <DenButton className="mt-3" variant="secondary" size="sm" onClick={startReplacingCredentials} disabled={submitting}>
                Replace credentials
              </DenButton>
            </div>
          ) : null}
          {showCredentialFields ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-[13px] font-semibold text-gray-900">Google OAuth credentials</p>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">
                {replacingCredentials
                  ? "Paste the new client ID and client secret. Both are required to replace the saved credentials."
                  : "Paste the client ID and client secret from the Google OAuth app. Both are required for first-time setup."}
              </p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client ID</label>
                  <DenInput
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    placeholder="1234567890-abc.apps.googleusercontent.com"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client secret</label>
                  <DenInput
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    placeholder="GOCSPX-…"
                  />
                </div>
              </div>
              {replacingCredentials ? (
                <DenButton className="mt-3" variant="secondary" size="sm" onClick={() => setReplacingCredentials(false)} disabled={submitting}>
                  Keep saved credentials
                </DenButton>
              ) : null}
            </div>
          ) : null}
        </div>

        {formError ? (
          <DenNotice message={formError instanceof Error ? formError.message : "Failed to save the OAuth client."} className="mt-3" />
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </DenButton>
          <DenButton
            variant="primary"
            loading={submitting}
            disabled={saveDisabled}
            onClick={() => onSubmit({
              ...(showCredentialFields ? { clientId: trimmedClientId, clientSecret: trimmedClientSecret } : {}),
              features,
            })}
          >
            {configured && !replacingCredentials ? "Save permissions" : replacingCredentials ? "Save new credentials" : "Save setup"}
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function IssuerReviewDialog({
  connection,
  preview,
  loading,
  error,
  onRetry,
  onClose,
  onConfirm,
}: {
  connection: ExternalMcpConnection | null;
  preview: McpIssuerReview | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onClose: () => void;
  onConfirm: (issuer: string) => void;
}) {
  const [selectedIssuer, setSelectedIssuer] = useState("");

  useEffect(() => {
    if (!preview) {
      setSelectedIssuer("");
      return;
    }
    setSelectedIssuer(
      preview.currentIssuer && preview.advertisedIssuers.includes(preview.currentIssuer)
        ? preview.currentIssuer
        : preview.advertisedIssuers[0] ?? "",
    );
  }, [preview]);

  if (!connection) return null;
  const issuerWillChange = Boolean(preview && selectedIssuer && selectedIssuer !== preview.currentIssuer);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/35 px-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-issuer-review-title"
        className="w-full max-w-xl rounded-[28px] border border-gray-100 bg-white p-6 shadow-2xl shadow-gray-950/20"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id="mcp-issuer-review-title" className="text-[18px] font-semibold text-gray-950">Review OAuth provider</h2>
            <p className="mt-1 text-[13px] leading-5 text-gray-600">
              {connection.name} now advertises OAuth metadata that differs from the issuer previously approved for this connection.
            </p>
          </div>
        </div>

        {loading && !preview ? (
          <div className="mt-6 flex items-center gap-2 rounded-2xl bg-gray-50 px-4 py-4 text-[13px] text-gray-600">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking the provider&apos;s live OAuth metadata…
          </div>
        ) : error && !preview ? (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-[13px] text-red-700" role="alert">
            <p>{error.message}</p>
            <DenButton className="mt-3" variant="secondary" size="sm" onClick={onRetry}>Try again</DenButton>
          </div>
        ) : preview ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">Previously approved</p>
              <p className="mt-1 break-all font-mono text-[12px] text-gray-700">{preview.currentIssuer ?? "No issuer selected"}</p>
            </div>
            <fieldset>
              <legend className="text-[13px] font-semibold text-gray-900">Issuer advertised now</legend>
              <div className="mt-2 space-y-2">
                {preview.advertisedIssuers.map((issuer) => (
                  <label key={issuer} className="flex cursor-pointer items-start gap-3 rounded-2xl border border-gray-200 px-4 py-3 transition has-[:checked]:border-gray-950 has-[:checked]:bg-gray-50">
                    <input
                      type="radio"
                      name="mcp-oauth-issuer"
                      value={issuer}
                      checked={selectedIssuer === issuer}
                      onChange={() => setSelectedIssuer(issuer)}
                      className="mt-0.5"
                    />
                    <span className="break-all font-mono text-[12px] text-gray-700">{issuer}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={`rounded-2xl px-4 py-3 text-[12px] leading-5 ${issuerWillChange ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-800"}`}>
              {issuerWillChange
                ? "Confirming a different issuer clears the old OAuth client and credentials. Everyone will reconnect against the newly approved provider."
                : "Confirming the same issuer clears the stale discovery cache without signing anyone out."}
            </div>
            {error ? <p className="text-[12px] text-red-600" role="alert">{error.message}</p> : null}
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <DenButton variant="secondary" size="sm" disabled={loading} onClick={onClose}>Cancel</DenButton>
          <DenButton
            variant="primary"
            size="sm"
            loading={loading && Boolean(preview)}
            disabled={!preview || !selectedIssuer}
            onClick={() => onConfirm(selectedIssuer)}
          >
            Confirm issuer
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function accessSummaryLabel(connection: ExternalMcpConnection): string {
  const access = connection.access;
  if (!access) return "";
  if (access.orgWide) return "Everyone in the org";
  const parts: string[] = [];
  if (access.teamIds.length > 0) parts.push(`${access.teamIds.length} ${access.teamIds.length === 1 ? "team" : "teams"}`);
  if (access.memberIds.length > 0) parts.push(`${access.memberIds.length} ${access.memberIds.length === 1 ? "person" : "people"}`);
  return parts.length > 0 ? parts.join(", ") : "Nobody yet";
}

function ConnectionRow({
  connection,
  needsPluginSetup,
  needsOAuthClientConfiguration,
  setupHref,
  polling,
  connecting,
  errorMessage,
  onEdit,
  onConfigure,
  onReviewIssuer,
  onConnect,
  onDisconnect,
  onRemove,
  disconnecting,
  removing,
  toolsOpen,
  onToggleTools,
}: {
  connection: ExternalMcpConnection;
  needsPluginSetup: boolean;
  needsOAuthClientConfiguration: boolean;
  setupHref: string | null;
  polling: boolean;
  connecting: boolean;
  errorMessage: string | null;
  onEdit: () => void;
  onConfigure: () => void;
  onReviewIssuer: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  disconnecting: boolean;
  removing: boolean;
  toolsOpen: boolean;
  onToggleTools: () => void;
}) {
  const isPerMember = connection.credentialMode === "per_member";
  const creatorAttribution = formatConnectionCreatorAttribution(connection.createdByName);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const setupRequired = needsPluginSetup || needsOAuthClientConfiguration;
  const displayedConnected = connection.connected && !setupRequired;
  const canConnectOAuth = !setupRequired && !connection.issuerReviewRequired && connection.authType === "oauth"
    && (isPerMember ? !connection.connectedForMe : !connection.connected);
  const canInspectTools = !setupRequired && !connection.issuerReviewRequired
    && (connection.credentialMode === "shared" ? connection.connected : connection.connectedForMe);

  useEffect(() => {
    if (!actionsOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !actionsMenuRef.current?.contains(event.target)) {
        setActionsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setActionsOpen(false);
      actionsTriggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsOpen]);

  return (
    <div data-testid={`mcp-connection-row-${connection.id}`}>
      <div className="flex flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <IntegrationIcon name={connection.name} serviceUrl={connection.url} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-[14px] font-semibold text-gray-900">{connection.name}</p>
              {setupRequired ? (
                <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  Setup required
                </span>
              ) : connection.issuerReviewRequired ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  <AlertTriangle className="h-3 w-3" />
                  OAuth settings need review
                </span>
              ) : isPerMember ? (
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${connection.connected ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                  <Users className="h-3 w-3" />
                  {connection.connected ? "Individual accounts connected" : "Not connected"}
                </span>
              ) : displayedConnected ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  <Check className="h-3 w-3" />
                  Connected
                </span>
              ) : polling ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Waiting for authorization…
                </span>
              ) : (
                <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                  Not connected
                </span>
              )}
              {connection.access ? (
                <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                  {accessSummaryLabel(connection)}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-gray-500">
              {connection.url}{setupRequired ? "" : ` · ${formatMcpConnectedTimestamp(connection.connectedAt)}`}{creatorAttribution ? ` · ${creatorAttribution}` : ""}
            </p>
            {connection.authType === "oauth" ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
                {connection.authorizationServerIssuer ? <span className="max-w-full truncate">Issuer: {connection.authorizationServerIssuer}</span> : null}
                {(connection.requestedScopes?.length ?? 0) > 0 ? <span>Scopes: {connection.requestedScopes?.join(", ")}</span> : null}
              </div>
            ) : null}
            {errorMessage ? <p className="mt-1 text-[12px] text-red-600">{errorMessage}</p> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
          {needsOAuthClientConfiguration ? (
            <DenButton variant="primary" size="sm" onClick={onConfigure}>
              Configure
            </DenButton>
          ) : null}
          {setupHref ? (
            <Link href={setupHref} className={buttonVariants({ variant: "primary", size: "sm" })}>
              Set up
            </Link>
          ) : null}
          {connection.issuerReviewRequired ? (
            <DenButton variant="primary" size="sm" icon={AlertTriangle} onClick={onReviewIssuer}>
              Review OAuth
            </DenButton>
          ) : null}
          {canConnectOAuth ? (
            <DenButton
              variant="secondary"
              size="sm"
              loading={connecting || polling}
              onClick={onConnect}
            >
              Connect
            </DenButton>
          ) : null}
          {displayedConnected ? (
            <DenButton
              variant="secondary"
              size="sm"
              loading={disconnecting}
              onClick={onDisconnect}
              aria-label={`Disconnect ${connection.name}`}
              data-testid={`disconnect-mcp-connection-${connection.id}`}
            >
              Disconnect
            </DenButton>
          ) : null}
          <div ref={actionsMenuRef} className="relative">
            <button
              ref={actionsTriggerRef}
              type="button"
              onClick={() => setActionsOpen((current) => !current)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900"
              aria-label={`More actions for ${connection.name}`}
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              data-testid={`mcp-connection-more-${connection.id}`}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
            {actionsOpen ? (
              <div
                role="menu"
                aria-label={`Actions for ${connection.name}`}
                className="absolute right-0 top-10 z-30 w-44 overflow-hidden rounded-2xl border border-gray-100 bg-white p-1.5 text-[13px] shadow-xl shadow-gray-900/10"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    onEdit();
                  }}
                  disabled={!connection.updatedAt}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-gray-600 transition hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`Edit ${connection.name}`}
                  data-testid={`edit-mcp-connection-${connection.id}`}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    onToggleTools();
                  }}
                  disabled={!canInspectTools}
                  title={canInspectTools ? "Inspect the tools this MCP exposes" : "Connect this account before inspecting tools"}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-gray-600 transition hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {toolsOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                  {toolsOpen ? "Hide tools" : "View tools"}
                </button>
                <div className="my-1 border-t border-gray-100" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    onRemove();
                  }}
                  disabled={removing}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label={`Remove ${connection.name}`}
                >
                  {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                  Remove
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {toolsOpen && canInspectTools ? <McpToolCatalog connection={connection} /> : null}
    </div>
  );
}

function schemaInputs(schema: Record<string, unknown>): Array<{ name: string; required: boolean; type: string | null }> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  return Object.entries(properties).map(([name, definition]) => ({
    name,
    required: required.has(name),
    type: isRecord(definition) && typeof definition.type === "string" ? definition.type : null,
  }));
}

function toolHints(tool: ExternalMcpTool): Array<{ label: string; className: string }> {
  const annotations = tool.annotations;
  if (!annotations) return [];
  return [
    annotations.readOnlyHint ? { label: "Read-only hint", className: "bg-blue-50 text-blue-700" } : null,
    annotations.destructiveHint ? { label: "Destructive hint", className: "bg-red-50 text-red-700" } : null,
    annotations.idempotentHint ? { label: "Idempotent hint", className: "bg-emerald-50 text-emerald-700" } : null,
    annotations.openWorldHint ? { label: "External access hint", className: "bg-amber-50 text-amber-700" } : null,
  ].filter((hint): hint is { label: string; className: string } => hint !== null);
}

function McpToolCatalog({ connection }: { connection: ExternalMcpConnection }) {
  const catalog = useMcpConnectionTools(connection.id, true);
  const [toolSearch, setToolSearch] = useState("");
  const [visibleToolLimit, setVisibleToolLimit] = useState(MCP_TOOL_PAGE_SIZE);
  const filteredTools = useMemo(() => {
    const needle = toolSearch.trim().toLowerCase();
    if (!needle) return catalog.data ?? [];
    return (catalog.data ?? []).filter((tool) =>
      [tool.name, tool.title, tool.annotations?.title, tool.description]
        .some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [catalog.data, toolSearch]);
  const visibleTools = filteredTools.slice(0, visibleToolLimit);
  const remainingToolCount = filteredTools.length - visibleTools.length;

  return (
    <div className="border-t border-gray-100 bg-gray-50/70 px-6 py-5" data-mcp-tool-catalog={connection.id}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-gray-500" />
            <p className="text-[13px] font-semibold text-gray-900">Tools available to your agents</p>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-gray-500">
            Live from {connection.name}. Inspecting this list does not run a tool. Provider annotations are hints, not guarantees.
          </p>
        </div>
        <DenButton variant="secondary" size="sm" loading={catalog.isFetching} onClick={() => void catalog.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </DenButton>
      </div>

      {catalog.data && catalog.data.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-sm">
            <DenInput
              aria-label="Search MCP tools"
              icon={Search}
              value={toolSearch}
              onChange={(event) => {
                setToolSearch(event.target.value);
                setVisibleToolLimit(MCP_TOOL_PAGE_SIZE);
              }}
              placeholder="Search tools by name or description"
            />
          </div>
          <p className="shrink-0 text-[11px] font-medium text-gray-500" role="status">
            {toolSearch.trim()
              ? `${filteredTools.length} of ${catalog.data.length} tools`
              : `${catalog.data.length} ${catalog.data.length === 1 ? "tool" : "tools"} exposed`}
          </p>
        </div>
      ) : null}

      {catalog.isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-[12px] text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading the MCP tool catalog…
        </div>
      ) : catalog.error ? (
        <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-5 text-red-700">
          {catalog.error instanceof Error ? catalog.error.message : "Could not read this MCP's tools."}
        </div>
      ) : catalog.data?.length === 0 ? (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-500">
          This MCP is connected but does not currently expose any tools.
        </div>
      ) : filteredTools.length === 0 ? (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-500">
          No tools match “{toolSearch.trim()}”.
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {visibleTools.map((tool) => {
              const inputs = schemaInputs(tool.inputSchema);
              const hints = toolHints(tool);
              const displayTitle = tool.title || tool.annotations?.title;
              return (
                <details key={tool.name} className="group rounded-2xl border border-gray-200 bg-white p-4">
                  <summary className="cursor-pointer list-none">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {displayTitle ? (
                          <>
                            <p className="break-words text-[12px] font-semibold text-gray-900">{displayTitle}</p>
                            <p className="mt-0.5 break-words font-mono text-[10px] text-gray-500">{tool.name}</p>
                          </>
                        ) : (
                          <p className="break-words font-mono text-[12px] font-semibold text-gray-900">{tool.name}</p>
                        )}
                        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-gray-500">
                          {tool.description || "No description provided by this MCP."}
                        </p>
                      </div>
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 transition group-open:rotate-90" />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <p className="text-[11px] font-medium text-gray-500">
                        {inputs.length === 0 ? "No inputs" : `${inputs.length} ${inputs.length === 1 ? "input" : "inputs"}`}
                      </p>
                      {hints.map((hint) => (
                        <span
                          key={hint.label}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${hint.className}`}
                          title="Provider-supplied MCP annotation; treat as a hint."
                        >
                          {hint.label}
                        </span>
                      ))}
                    </div>
                  </summary>
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    {inputs.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {inputs.map((input) => (
                          <span key={input.name} className="rounded-full bg-gray-100 px-2.5 py-1 font-mono text-[11px] text-gray-700">
                            {input.name}{input.type ? `: ${input.type}` : ""}{input.required ? " · required" : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-[11px] font-medium text-gray-500">View input schema</summary>
                      <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-gray-950 p-3 text-[10px] leading-4 text-gray-100">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                    </details>
                    {tool.outputSchema ? (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-[11px] font-medium text-gray-500">View output schema</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-gray-950 p-3 text-[10px] leading-4 text-gray-100">{JSON.stringify(tool.outputSchema, null, 2)}</pre>
                      </details>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
          {remainingToolCount > 0 ? (
            <div className="mt-4 flex justify-center">
              <DenButton
                variant="secondary"
                size="sm"
                onClick={() => setVisibleToolLimit((current) => current + MCP_TOOL_PAGE_SIZE)}
              >
                Show {Math.min(MCP_TOOL_PAGE_SIZE, remainingToolCount)} more
              </DenButton>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

type SegmentedControlOption<TValue extends string> = {
  value: TValue;
  label: string;
};

function SegmentedControl<TValue extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: SegmentedControlOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
  disabled?: boolean;
}) {
  const gridColumns = options.length === 2 ? "grid-cols-2" : "grid-cols-3";

  return (
    <div className={`grid ${gridColumns} gap-1 rounded-full border border-gray-200 bg-gray-50 p-1`} role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
            value === option.value
              ? "bg-white text-gray-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]"
              : "text-gray-500 hover:text-gray-900"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type AddConnectionAccessMode = McpConnectionAccessMode;

const AUTH_TYPE_OPTIONS: SegmentedControlOption<ExternalMcpAuthType>[] = [
  { value: "oauth", label: "OAuth" },
  { value: "apikey", label: "API key" },
  { value: "none", label: "None" },
];

const CREDENTIAL_MODE_OPTIONS: SegmentedControlOption<ExternalMcpCredentialMode>[] = [
  { value: "per_member", label: "Individual accounts" },
  { value: "shared", label: "One org account" },
];

const ACCESS_MODE_OPTIONS: SegmentedControlOption<AddConnectionAccessMode>[] = [
  { value: "everyone", label: "Everyone" },
  { value: "teams", label: "Specific teams" },
  { value: "people", label: "Specific people" },
];

function EditConnectionDialog({
  connection,
  configureOAuthClient,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  connection: ExternalMcpConnection | null;
  configureOAuthClient: boolean;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: UpdateMcpConnectionInput) => Promise<UpdatedMcpConnection>;
}) {
  const { orgContext } = useOrgDashboard();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<ExternalMcpAuthType>("oauth");
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>("shared");
  const [apiKey, setApiKey] = useState("");
  const [showOAuthClient, setShowOAuthClient] = useState(false);
  const [oauthClientId, setOAuthClientId] = useState("");
  const [oauthClientSecret, setOAuthClientSecret] = useState("");
  const [requestedScopesText, setRequestedScopesText] = useState("");
  const [accessMode, setAccessMode] = useState<AddConnectionAccessMode>("everyone");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [confirmingIdentityChange, setConfirmingIdentityChange] = useState(false);

  useEffect(() => {
    if (!connection) return;
    setName(connection.name);
    setUrl(connection.url);
    setAuthType(connection.authType);
    setCredentialMode(connection.credentialMode);
    setApiKey("");
    setShowOAuthClient(configureOAuthClient || Boolean(connection.oauthClientId));
    setOAuthClientId(connection.oauthClientId ?? "");
    setOAuthClientSecret("");
    setRequestedScopesText((connection.requestedScopes ?? []).join(" "));
    setAccessMode(mcpAccessMode(connection.access));
    setSelectedTeamIds(connection.access?.teamIds ?? []);
    setSelectedMemberIds(connection.access?.memberIds ?? []);
    setConfirmingIdentityChange(false);
  }, [configureOAuthClient, connection]);

  const teams = useMemo(() => orgContext?.teams ?? [], [orgContext?.teams]);
  const members = useMemo(
    () => (orgContext?.members ?? []).filter((member) => Boolean(member.userId)),
    [orgContext?.members],
  );
  const marketplaceOwners = connection?.identityManagedBy ?? [];
  const marketplaceManaged = marketplaceOwners.length > 0;
  const proposedCredentialMode = authType === "oauth" ? credentialMode : "shared";
  const identityChanged = Boolean(connection && editableMcpIdentityChanged(connection, {
    url,
    authType,
    credentialMode: proposedCredentialMode,
  }));
  const access: McpConnectionAccessInput = accessMode === "everyone"
    ? { orgWide: true, memberIds: [], teamIds: [] }
    : {
      orgWide: false,
      // Preserve a pre-existing mixed direct grant set on unrelated edits.
      // Choosing a different mode below explicitly clears the hidden set.
      memberIds: selectedMemberIds,
      teamIds: selectedTeamIds,
    };
  const accessIncomplete = accessMode === "teams"
    ? selectedTeamIds.length === 0
    : accessMode === "people"
      ? selectedMemberIds.length === 0
      : false;
  const replacementApiKeyRequired = authType === "apikey" && identityChanged && !apiKey.trim();
  const oauthClientIdRequired = configureOAuthClient && authType === "oauth" && !oauthClientId.trim();

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  }

  async function submit() {
    if (!connection?.updatedAt) return;
    if (identityChanged && !confirmingIdentityChange) {
      setConfirmingIdentityChange(true);
      return;
    }
    const trimmedApiKey = apiKey.trim();
    const trimmedClientId = oauthClientId.trim();
    const trimmedClientSecret = oauthClientSecret.trim();
    const requestedScopes = [...new Set(requestedScopesText.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))];
    const input: UpdateMcpConnectionInput = {
      connectionId: connection.id,
      expectedUpdatedAt: connection.updatedAt,
      name: name.trim(),
      url: url.trim(),
      authType,
      credentialMode: proposedCredentialMode,
      ...(!marketplaceManaged && authType === "apikey" && trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
      ...(authType === "oauth" && showOAuthClient && trimmedClientId
        ? {
          oauthClient: {
            clientId: trimmedClientId,
            ...(trimmedClientSecret ? { clientSecret: trimmedClientSecret } : {}),
          },
        }
        : {}),
      ...(!marketplaceManaged && authType === "oauth" ? { requestedScopes } : {}),
      access,
    };
    try {
      await onSubmit(input);
    } catch {
      // The mutation error is rendered below and the dialog stays open with
      // the proposed values, including a stale-edit response from the API.
    }
  }

  if (!connection) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
        data-testid="edit-mcp-connection-dialog"
      >
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
          {configureOAuthClient ? "Configure MCP connection" : "Edit MCP connection"}
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-600">
          {configureOAuthClient
            ? "Add the OAuth app credentials this server requires before anyone connects."
            : "Update how this server is presented and who can use it. Saved credentials are never shown here."}
        </p>

        {marketplaceManaged ? (
          <div className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-[12px] leading-5 text-blue-800" data-testid="marketplace-managed-identity-note">
            <p className="font-semibold text-blue-900">Server and authentication are managed by {marketplaceIdentityOwnerNames(marketplaceOwners)}.</p>
            <p className="mt-1">Configure organization OAuth credentials here. Change the server URL or authentication type in the marketplace plugin definition.</p>
          </div>
        ) : null}

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</label>
            <DenInput value={name} onChange={(event) => setName(event.target.value)} data-testid="edit-mcp-name" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Server URL</label>
            <DenInput
              value={url}
              data-testid="edit-mcp-url"
              disabled={marketplaceManaged}
              onChange={(event) => {
                setUrl(event.target.value);
                setConfirmingIdentityChange(false);
              }}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Authentication</label>
            <SegmentedControl
              options={AUTH_TYPE_OPTIONS}
              value={authType}
              disabled={marketplaceManaged}
              onChange={(option) => {
                setAuthType(option);
                if (option !== "oauth") {
                  setCredentialMode("shared");
                  setShowOAuthClient(false);
                }
                setConfirmingIdentityChange(false);
              }}
            />
          </div>

          {!marketplaceManaged && authType === "apikey" ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">
                {identityChanged ? "Replacement API key (required)" : "Replacement API key (optional)"}
              </label>
              <DenInput
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setConfirmingIdentityChange(false);
                }}
                placeholder={identityChanged ? "Enter a key for the new identity" : "Leave empty to keep the saved key"}
                data-testid="edit-mcp-api-key"
              />
              <p className="mt-1.5 text-[11px] leading-5 text-gray-500">The saved key is encrypted and is never returned to this form.</p>
            </div>
          ) : null}

          {authType === "oauth" && !showOAuthClient ? (
            <button
              type="button"
              onClick={() => {
                setShowOAuthClient(true);
                setConfirmingIdentityChange(false);
              }}
              className="text-left text-[12px] font-medium text-gray-500 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-900"
            >
              {connection.oauthClientId ? "Replace the pre-registered OAuth app" : "Add the pre-registered OAuth app"}
            </button>
          ) : null}

          {authType === "oauth" && showOAuthClient ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] font-semibold text-gray-900">OAuth app</p>
                <Link href={MCP_OAUTH_REDIRECT_DOCS_URL} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-gray-500 underline underline-offset-2 hover:text-gray-900">
                  How redirect URLs work
                </Link>
              </div>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">Add the provider credentials here. The saved client secret remains hidden.</p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">
                    Client ID{configureOAuthClient ? " (required)" : ""}
                  </label>
                  <DenInput
                    value={oauthClientId}
                    onChange={(event) => {
                      setOAuthClientId(event.target.value);
                      setConfirmingIdentityChange(false);
                    }}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">
                    {connection.oauthClientId ? "Replacement client secret (optional)" : "Client secret (optional)"}
                  </label>
                  <DenInput
                    type="password"
                    value={oauthClientSecret}
                    onChange={(event) => {
                      setOAuthClientSecret(event.target.value);
                      setConfirmingIdentityChange(false);
                    }}
                    placeholder="Leave empty to keep it when identity and client ID are unchanged"
                    data-testid="edit-mcp-oauth-client-secret"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {authType === "oauth" ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Requested OAuth scopes</label>
              <DenInput
                value={requestedScopesText}
                disabled={marketplaceManaged}
                onChange={(event) => setRequestedScopesText(event.target.value)}
                placeholder="records.read records.write"
                data-testid="edit-mcp-requested-scopes"
              />
              <p className="mt-1.5 text-[11px] leading-5 text-gray-500">Separate scopes with spaces or commas. Scope changes apply on next connect — reconnect to re-authorize.</p>
            </div>
          ) : null}

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Whose account does the AI use?</label>
            <SegmentedControl
              options={CREDENTIAL_MODE_OPTIONS}
              value={proposedCredentialMode}
              disabled={marketplaceManaged || authType !== "oauth"}
              onChange={(option) => {
                setCredentialMode(option);
                setConfirmingIdentityChange(false);
              }}
            />
            {authType !== "oauth" ? (
              <p className="mt-1.5 text-[11px] leading-5 text-gray-500">API-key and no-auth connections always use one organization connection.</p>
            ) : null}
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Who can use this?</label>
            <SegmentedControl
              options={ACCESS_MODE_OPTIONS}
              value={accessMode}
              onChange={(option) => {
                if (option !== accessMode) {
                  if (option === "teams") setSelectedMemberIds([]);
                  if (option === "people") setSelectedTeamIds([]);
                }
                setAccessMode(option);
              }}
            />
            {accessMode === "teams" ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                {teams.length === 0 ? (
                  <p className="px-2 py-1 text-[12px] text-gray-400">No teams in this org yet.</p>
                ) : teams.map((team) => (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => setSelectedTeamIds((current) => toggle(current, team.id))}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${selectedTeamIds.includes(team.id) ? "bg-gray-100 text-gray-900" : "text-gray-700 hover:bg-gray-50"}`}
                  >
                    <span className="truncate">{team.name}</span>
                    {selectedTeamIds.includes(team.id) ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {accessMode === "people" ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                {members.length === 0 ? (
                  <p className="px-2 py-1 text-[12px] text-gray-400">No members in this org yet.</p>
                ) : members.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => setSelectedMemberIds((current) => toggle(current, member.id))}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${selectedMemberIds.includes(member.id) ? "bg-gray-100 text-gray-900" : "text-gray-700 hover:bg-gray-50"}`}
                  >
                    <span className="truncate">{member.user.name || member.user.email}</span>
                    {selectedMemberIds.includes(member.id) ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {identityChanged && !marketplaceManaged ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-5 text-amber-900" data-testid="mcp-identity-change-warning">
            <p className="font-semibold">This changes the connection identity.</p>
            <p className="mt-1">OpenWork will clear shared and individual sessions, API keys, pending OAuth state, OAuth client registration, scopes, and connected timestamps before the new server can be used.</p>
            {authType === "oauth" ? <p className="mt-1 font-medium">The connection must be authorized again after saving.</p> : null}
            {confirmingIdentityChange ? <p className="mt-2 font-semibold">Confirm that you want to invalidate the old identity.</p> : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 text-[13px] text-red-600" role="alert">{error instanceof Error ? error.message : "Failed to update connection."}</p>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {confirmingIdentityChange ? (
            <DenButton variant="secondary" onClick={() => setConfirmingIdentityChange(false)} disabled={submitting}>Back</DenButton>
          ) : (
            <DenButton variant="secondary" onClick={onClose} disabled={submitting}>Cancel</DenButton>
          )}
          <DenButton
            variant="primary"
            loading={submitting}
            disabled={!connection.updatedAt || !name.trim() || !url.trim() || replacementApiKeyRequired || oauthClientIdRequired || accessIncomplete}
            onClick={() => void submit()}
            data-testid="save-mcp-connection-edit"
          >
            {confirmingIdentityChange ? "Confirm and save" : identityChanged ? "Review identity change" : "Save changes"}
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function AddConnectionDialog({
  open,
  preset,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  preset: ExternalMcpPreset | null;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (
    input: CreateMcpConnectionInput,
    options: { startOAuth: boolean },
  ) => Promise<void>;
}) {
  const { orgContext } = useOrgDashboard();
  const discoverRequirements = useDiscoverMcpConnectionRequirements();
  const resolveConnection = useResolveMcpConnection();
  // Preset quick-add cards land in their prefilled form. The generic MCP
  // action opens directly on URL discovery.
  const [view, setView] = useState<"smart" | "advanced">(preset ? "advanced" : "smart");
  const [smartQuery, setSmartQuery] = useState("");
  const [smartState, setSmartState] = useState<"idle" | "waiting" | "resolving" | "done" | "error">("idle");
  const [smartError, setSmartError] = useState<unknown>(null);
  const [resolution, setResolution] = useState<McpConnectionResolution | null>(null);
  const [smartName, setSmartName] = useState("");
  const smartRequestId = useRef(0);
  const smartResolveDelayRef = useRef(SMART_RESOLVE_DELAY_MS);
  const [name, setName] = useState(preset?.displayName ?? "");
  const [url, setUrl] = useState(preset?.url ?? "");
  const [authType, setAuthType] = useState<ExternalMcpAuthType>(preset?.authType ?? "oauth");
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>("per_member");
  const [apiKey, setApiKey] = useState("");
  const [showOAuthClient, setShowOAuthClient] = useState(Boolean(preset?.requiresOAuthClient));
  const [oauthClientId, setOAuthClientId] = useState("");
  const [oauthClientSecret, setOAuthClientSecret] = useState("");
  const [requirements, setRequirements] = useState<McpRequirementsDiscovery | null>(null);
  const [discoveryState, setDiscoveryState] = useState<"idle" | "waiting" | "checking" | "ready" | "error">("idle");
  const [discoveryError, setDiscoveryError] = useState<unknown>(null);
  const [authorizationServerIssuer, setAuthorizationServerIssuer] = useState("");
  const [requestedScopes, setRequestedScopes] = useState<string[]>([]);
  const [accessMode, setAccessMode] = useState<AddConnectionAccessMode>("everyone");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const discoveryRequestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    setView(preset ? "advanced" : "smart");
    setSmartQuery("");
    setSmartState("idle");
    setSmartError(null);
    setResolution(null);
    setSmartName("");
    smartRequestId.current += 1;
    smartResolveDelayRef.current = SMART_RESOLVE_DELAY_MS;
    setName(preset?.displayName ?? "");
    setUrl(preset?.url ?? "");
    setAuthType(preset?.authType ?? "oauth");
    setCredentialMode("per_member");
    setApiKey("");
    setShowOAuthClient(Boolean(preset?.requiresOAuthClient));
    setOAuthClientId("");
    setOAuthClientSecret("");
    setRequirements(null);
    setDiscoveryState("idle");
    setDiscoveryError(null);
    discoveryRequestId.current += 1;
    setAuthorizationServerIssuer("");
    setRequestedScopes([]);
    discoverRequirements.reset();
    setAccessMode("everyone");
    setSelectedTeamIds([]);
    setSelectedMemberIds([]);
  }, [open, preset]);

  const teams = useMemo(() => orgContext?.teams ?? [], [orgContext?.teams]);
  const members = useMemo(
    () => (orgContext?.members ?? []).filter((member) => Boolean(member.userId)),
    [orgContext?.members],
  );

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  }

  const showOAuthClientFields = authType === "oauth" && (Boolean(preset?.requiresOAuthClient) || showOAuthClient);
  const authorizationServers = requirements?.authentication.authorizationServers ?? [];
  const selectedAuthorizationServer = authorizationServers.find((server) => server.issuer === authorizationServerIssuer);
  const requiredScopes = requirements?.authentication.requiredScopes ?? [];
  const availableScopes = selectedAuthorizationServer?.scopesSupported
    ?? authorizationServers[0]?.scopesSupported
    ?? [];
  const optionalScopes = availableScopes.filter((scope) => !requiredScopes.includes(scope));
  const access: McpConnectionAccessInput = accessMode === "everyone"
    ? { orgWide: true, memberIds: [], teamIds: [] }
    : { orgWide: false, memberIds: accessMode === "people" ? selectedMemberIds : [], teamIds: accessMode === "teams" ? selectedTeamIds : [] };
  const accessIncomplete = accessMode === "teams" ? selectedTeamIds.length === 0 : accessMode === "people" ? selectedMemberIds.length === 0 : false;

  function applyDiscoveredRequirements(result: McpRequirementsDiscovery) {
    setRequirements(result);
    if (result.authentication.kind === "none") setAuthType("none");
    else if (result.authentication.kind === "oauth") setAuthType("oauth");
    const servers = result.authentication.authorizationServers;
    setAuthorizationServerIssuer(servers.length === 1 ? servers[0].issuer : "");
    setRequestedScopes(result.authentication.recommendedScopes);
    setShowOAuthClient(Boolean(preset?.requiresOAuthClient) || result.authentication.recommendedRegistrationMethod === "pre_registered");
  }

  async function discover(targetUrl: string, requestId: number) {
    setDiscoveryState("checking");
    setDiscoveryError(null);
    try {
      const result = await discoverRequirements.mutateAsync(targetUrl);
      if (discoveryRequestId.current !== requestId) return;
      applyDiscoveredRequirements(result);
      setDiscoveryState("ready");
    } catch (discoveryFailure) {
      if (discoveryRequestId.current !== requestId) return;
      setDiscoveryError(discoveryFailure);
      setDiscoveryState("error");
    }
  }

  useEffect(() => {
    const requestId = discoveryRequestId.current + 1;
    discoveryRequestId.current = requestId;
    // The smart view carries its own discovery inside the resolve result;
    // per-URL discovery only runs while the full form is visible.
    if (!open || view !== "advanced") {
      setDiscoveryState("idle");
      return;
    }

    const targetUrl = url.trim();
    setRequirements(null);
    setAuthorizationServerIssuer("");
    setRequestedScopes([]);
    setDiscoveryError(null);

    if (!isDiscoverableMcpUrl(targetUrl)) {
      setDiscoveryState("idle");
      return;
    }

    setDiscoveryState("waiting");
    const timer = window.setTimeout(() => {
      void discover(targetUrl, requestId);
    }, MCP_REQUIREMENTS_DISCOVERY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, url, view]);

  async function resolveSmart(query: string, requestId: number) {
    setSmartState("resolving");
    try {
      const result = await resolveConnection.mutateAsync(query.trim());
      if (smartRequestId.current !== requestId) return;
      setResolution(result);
      setSmartName(result.match?.suggestedName ?? result.preset?.displayName ?? "");
      setSmartState("done");
    } catch (resolveFailure) {
      if (smartRequestId.current !== requestId) return;
      setSmartError(resolveFailure);
      setSmartState("error");
    }
  }

  useEffect(() => {
    if (!open || view !== "smart") return;
    const requestId = smartRequestId.current + 1;
    smartRequestId.current = requestId;
    setResolution(null);
    setSmartError(null);
    const kind = classifySmartAddInput(smartQuery);
    if (kind !== "url" && kind !== "domain") {
      setSmartState("idle");
      return;
    }
    setSmartState("waiting");
    const delay = smartResolveDelayRef.current;
    smartResolveDelayRef.current = SMART_RESOLVE_DELAY_MS;
    const timer = window.setTimeout(() => {
      void resolveSmart(smartQuery, requestId);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [open, view, smartQuery]);

  const smartMatch = smartState === "done" ? resolution?.match ?? null : null;
  const smartPlan = smartMatch
    ? planSmartAdd(smartMatch.discovery, { name: smartName.trim() || smartMatch.suggestedName, url: smartMatch.url })
    : null;
  // A curated preset can demand org-level input (Slack's pre-registered OAuth
  // app, Exa's API key) even when the live probe alone would look one-click.
  const smartBlockers = smartPlan
    ? smartPlan.readiness !== "one_click"
      ? smartPlan.reasons
      : resolution?.preset?.requiresOAuthClient
        ? ["This provider needs a pre-registered OAuth app."]
        : resolution?.preset?.authType === "apikey"
          ? ["This provider needs your org's API key."]
          : []
    : [];
  const smartOneClick = smartPlan?.readiness === "one_click" && smartBlockers.length === 0 ? smartPlan : null;

  function transferToAdvanced() {
    discoveryRequestId.current += 1;
    if (smartMatch) {
      setName(smartName.trim() || smartMatch.suggestedName);
      setUrl(smartMatch.url);
      if (resolution?.preset) {
        setAuthType(resolution.preset.authType);
        setShowOAuthClient(Boolean(resolution.preset.requiresOAuthClient));
      } else if (smartMatch.discovery.authentication.kind === "manual_bearer") {
        setAuthType("apikey");
      }
    } else if (resolution?.preset) {
      setName(resolution.preset.displayName);
      setUrl(resolution.preset.url);
      setAuthType(resolution.preset.authType);
      setShowOAuthClient(Boolean(resolution.preset.requiresOAuthClient));
    } else {
      const kind = classifySmartAddInput(smartQuery);
      if (kind === "url") setUrl(smartQuery.trim());
      else if (kind === "domain") setUrl(`https://${smartQuery.trim()}`);
      else if (kind === "name") setName(smartQuery.trim());
    }
    setView("advanced");
  }

  async function submitSmart() {
    if (!smartOneClick) return;
    try {
      await onSubmit(smartOneClick.input, {
        startOAuth: smartOneClick.input.authType === "oauth" && smartOneClick.input.credentialMode === "shared",
      });
    } catch {
      // The mutation's typed error is rendered by the dialog's error prop.
    }
  }

  function retryDiscovery() {
    const targetUrl = url.trim();
    if (!isDiscoverableMcpUrl(targetUrl)) return;
    const requestId = discoveryRequestId.current + 1;
    discoveryRequestId.current = requestId;
    void discover(targetUrl, requestId);
  }

  async function submit() {
    const trimmedClientId = oauthClientId.trim();
    const trimmedClientSecret = oauthClientSecret.trim();
    const input: CreateMcpConnectionInput = {
      name: name.trim(),
      url: url.trim(),
      authType,
      credentialMode: authType === "oauth" ? credentialMode : "shared",
      apiKey: authType === "apikey" ? apiKey.trim() : undefined,
      oauthClient: showOAuthClientFields && trimmedClientId
        ? {
          clientId: trimmedClientId,
          ...(trimmedClientSecret ? { clientSecret: trimmedClientSecret } : {}),
        }
        : undefined,
      authorizationServerIssuer: authType === "oauth" && authorizationServerIssuer
        ? authorizationServerIssuer
        : undefined,
      requestedScopes: authType === "oauth" ? [...new Set([...requiredScopes, ...requestedScopes])] : undefined,
      access,
    };
    try {
      await onSubmit(input, {
        startOAuth: authType === "oauth" && credentialMode === "shared" && !showOAuthClientFields,
      });
    } catch {
      // The mutation's typed error is rendered by the dialog's error prop.
      // Consume the rejected promise so a clear validation failure does not
      // also become an opaque browser-level unhandled rejection.
    }
  }

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        data-testid="add-mcp-connection-dialog"
        className="max-h-[calc(100dvh-3rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        {view === "smart" ? (
          <>
            <h2 className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
              <Server className="h-4 w-4 text-gray-400" />
              Add an MCP server
            </h2>
            <p className="mt-1.5 text-[13px] leading-5 text-gray-500">
              Paste the MCP server URL and we&apos;ll find and check its authentication requirements.
            </p>

            <div className="mt-5">
              <DenInput
                autoFocus
                value={smartQuery}
                onChange={(event) => setSmartQuery(event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                data-testid="smart-add-query-input"
              />
            </div>

            {smartState === "waiting" || smartState === "resolving" ? (
              <div className="mt-4 flex items-center gap-2.5 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3.5 text-[13px] text-gray-500" role="status">
                <Loader2 className="h-4 w-4 animate-spin" />
                {smartState === "resolving" ? "Checking the server…" : "Looking it up…"}
              </div>
            ) : null}

            {smartState === "error" ? (
              <div className="mt-4 rounded-2xl border border-red-100 bg-red-50 px-4 py-3.5 text-[13px] text-red-700" role="alert">
                {smartError instanceof Error ? smartError.message : "The lookup failed. Try again, or set the server up manually."}
              </div>
            ) : null}

            {smartState === "done" && resolution?.resolution === "not_found" ? (
              <div className="mt-4 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3.5 text-[13px] leading-5 text-gray-600">
                {resolution.reason ?? `We couldn't find an MCP server for "${smartQuery.trim()}". Double-check the address, or set it up manually below.`}
              </div>
            ) : null}

            {smartMatch ? (
              <div data-testid="smart-add-result-card" className="mt-4 rounded-2xl border border-gray-200 p-4">
                <div className="flex items-start gap-3">
                  <IntegrationIcon name={smartName || smartMatch.suggestedName} serviceUrl={smartMatch.url} />
                  <div className="min-w-0 flex-1">
                    <DenInput
                      value={smartName}
                      onChange={(event) => setSmartName(event.target.value)}
                      placeholder={smartMatch.suggestedName || "Connection name"}
                      aria-label="Connection name"
                    />
                    <p className="mt-1.5 truncate text-[12px] text-gray-500">{smartMatch.url}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">{smartAddAuthLabel(smartMatch.discovery)}</span>
                  {typeof smartMatch.discovery.tools.count === "number" && smartMatch.discovery.tools.count > 0 ? (
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">
                      {smartMatch.discovery.tools.count} tool{smartMatch.discovery.tools.count === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {smartOneClick ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">Ready to add</span>
                  ) : null}
                </div>
                {smartOneClick && smartOneClick.input.authType === "oauth" ? (
                  <p className="mt-3 text-[12px] leading-5 text-gray-500">
                    Everyone in the org gets this connection, and each person signs in with their own account. Fine-tune who and how under More options.
                  </p>
                ) : null}
                {smartBlockers.length > 0 ? (
                  <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-[12px] leading-5 text-amber-800">
                    Needs a little more setup: {smartBlockers.join(" · ")}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={transferToAdvanced}
                  className="mt-3 text-[12px] font-medium text-gray-500 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-900"
                >
                  {smartOneClick ? "More options" : "Continue setup"}
                </button>
              </div>
            ) : null}

            {smartState === "done" && !smartMatch && resolution?.preset ? (
              <div className="mt-4 rounded-2xl border border-gray-200 p-4">
                <div className="flex items-start gap-3">
                  <IntegrationIcon name={resolution.preset.displayName} serviceUrl={resolution.preset.url} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-gray-900">{resolution.preset.displayName}</p>
                    <p className="mt-0.5 truncate text-[12px] text-gray-500">{resolution.preset.url}</p>
                  </div>
                </div>
                <p className="mt-3 text-[12px] leading-5 text-gray-500">{resolution.preset.description}</p>
                <button
                  type="button"
                  onClick={transferToAdvanced}
                  className="mt-3 text-[12px] font-medium text-gray-500 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-900"
                >
                  Continue setup
                </button>
              </div>
            ) : null}

            {error ? (
              <p className="mt-3 text-[13px] text-red-600">{error instanceof Error ? error.message : "Failed to add connection."}</p>
            ) : null}

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={transferToAdvanced}
                className="text-left text-[12px] font-medium text-gray-500 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-900"
              >
                Advanced setup
              </button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <DenButton variant="secondary" onClick={onClose} disabled={submitting}>
                  Cancel
                </DenButton>
                <DenButton
                  variant="primary"
                  loading={submitting}
                  disabled={!smartOneClick}
                  onClick={() => void submitSmart()}
                  data-testid="smart-add-submit"
                >
                  Add connection
                </DenButton>
              </div>
            </div>
          </>
        ) : (
          <>
        {!preset ? (
          <button
            type="button"
            onClick={() => setView("smart")}
            className="mb-2 flex items-center gap-1 text-[12px] font-medium text-gray-500 transition hover:text-gray-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            MCP server
          </button>
        ) : null}
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
          {preset ? `Add ${preset.displayName}` : "Add a custom MCP server"}
        </h2>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</label>
            <DenInput value={name} onChange={(event) => setName(event.target.value)} placeholder="notion" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Server URL</label>
            <DenInput
              value={url}
              onChange={(event) => {
                discoveryRequestId.current += 1;
                setUrl(event.target.value);
                setRequirements(null);
                setDiscoveryState("idle");
                setAuthorizationServerIssuer("");
                setRequestedScopes([]);
                setDiscoveryError(null);
              }}
              placeholder="https://mcp.example.com/mcp"
              disabled={Boolean(preset)}
            />
            {discoveryState === "waiting" || discoveryState === "checking" ? (
              <p className="mt-2 flex items-center gap-2 text-[12px] text-gray-500" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking…
              </p>
            ) : null}
            {discoveryState === "error" ? (
              <div className="mt-2 flex items-start justify-between gap-3 text-[12px] text-red-600" role="alert">
                <p>{discoveryError instanceof Error ? discoveryError.message : "Requirements discovery failed."}</p>
                <button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={retryDiscovery}>
                  Retry
                </button>
              </div>
            ) : null}
          </div>
          {!preset ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Authentication</label>
              <SegmentedControl
                options={AUTH_TYPE_OPTIONS}
                value={authType}
                onChange={(option) => {
                  setAuthType(option);
                  if (option !== "oauth") setShowOAuthClient(false);
                }}
              />
            </div>
          ) : null}
          {authType === "apikey" ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">API key</label>
              <DenInput type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." />
            </div>
          ) : null}

          {authType === "oauth" && !preset?.requiresOAuthClient && !showOAuthClient ? (
            <button
              type="button"
              onClick={() => setShowOAuthClient(true)}
              className="text-left text-[12px] font-medium text-gray-500 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-900"
            >
              Use a pre-registered OAuth app instead
            </button>
          ) : null}

          {showOAuthClientFields ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] font-semibold text-gray-900">OAuth app</p>
                <Link href={MCP_OAUTH_REDIRECT_DOCS_URL} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-gray-500 underline underline-offset-2 hover:text-gray-900">
                  How redirect URLs work
                </Link>
              </div>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">
                Register this Den instance's redirect URL with the provider, then add its credentials here.
              </p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client ID (optional for now)</label>
                  <DenInput
                    value={oauthClientId}
                    onChange={(event) => setOAuthClientId(event.target.value)}
                    placeholder="1234567890.1234567890123"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client secret (optional for now)</label>
                  <DenInput
                    type="password"
                    value={oauthClientSecret}
                    onChange={(event) => setOAuthClientSecret(event.target.value)}
                    placeholder="Client secret"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {authType === "oauth" && authorizationServers.length > 1 ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Authorization server</label>
              <DenSelect
                value={authorizationServerIssuer}
                onChange={(event) => {
                  const issuer = event.target.value;
                  const server = authorizationServers.find((candidate) => candidate.issuer === issuer);
                  const supportedScopes = server?.scopesSupported ?? [];
                  const recommendedScopes = [...requiredScopes];
                  if (server?.grantTypesSupported?.includes("refresh_token") && supportedScopes.includes("offline_access")) {
                    recommendedScopes.push("offline_access");
                  }
                  setAuthorizationServerIssuer(issuer);
                  setRequestedScopes([...new Set(recommendedScopes)]);
                }}
              >
                <option value="" disabled>Choose an issuer</option>
                {authorizationServers.map((server) => <option key={server.issuer} value={server.issuer}>{server.issuer}</option>)}
              </DenSelect>
            </div>
          ) : null}

          {authType === "oauth" && requirements && (requiredScopes.length > 0 || optionalScopes.length > 0) ? (
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-gray-700">Permissions</p>
              <div className="space-y-2 rounded-2xl border border-gray-100 bg-gray-50 p-3 text-[12px]">
                {requiredScopes.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-gray-700">
                    <input type="checkbox" checked disabled />
                    <span>{scope} <span className="text-gray-400">required</span></span>
                  </label>
                ))}
                {optionalScopes.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-gray-700">
                    <input
                      type="checkbox"
                      checked={requestedScopes.includes(scope)}
                      onChange={(event) => setRequestedScopes((current) => event.target.checked
                        ? [...new Set([...current, scope])]
                        : current.filter((entry) => entry !== scope))}
                    />
                    <span>{scope} <span className="text-gray-400">optional</span></span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          {authType === "oauth" ? (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Whose account does the AI use?</label>
              <SegmentedControl options={CREDENTIAL_MODE_OPTIONS} value={credentialMode} onChange={setCredentialMode} />
              <p className="mt-1.5 text-[12px] leading-5 text-gray-500">
                {credentialMode === "per_member"
                  ? "Each person signs in with their own account from Your Connections. Their AI acts as them, with their permissions."
                  : "You sign in once with a single account — everyone granted access acts as it. Good for bot or service accounts."}
              </p>
            </div>
          ) : null}

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Who can use this?</label>
            <SegmentedControl options={ACCESS_MODE_OPTIONS} value={accessMode} onChange={setAccessMode} />
            {accessMode === "teams" ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                {teams.length === 0 ? (
                  <p className="px-2 py-1 text-[12px] text-gray-400">No teams in this org yet.</p>
                ) : (
                  teams.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => setSelectedTeamIds((current) => toggle(current, team.id))}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${
                        selectedTeamIds.includes(team.id) ? "bg-gray-100 text-gray-900" : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <span className="truncate">{team.name}</span>
                      {selectedTeamIds.includes(team.id) ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
            {accessMode === "people" ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                {members.length === 0 ? (
                  <p className="px-2 py-1 text-[12px] text-gray-400">No members in this org yet.</p>
                ) : (
                  members.map((member) => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => setSelectedMemberIds((current) => toggle(current, member.id))}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${
                        selectedMemberIds.includes(member.id) ? "bg-gray-100 text-gray-900" : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <span className="truncate">{member.user.name || member.user.email}</span>
                      {selectedMemberIds.includes(member.id) ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="mt-3 text-[13px] text-red-600">{error instanceof Error ? error.message : "Failed to add connection."}</p>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </DenButton>
          <DenButton
            variant="primary"
            loading={submitting}
            disabled={!name.trim() || !url.trim() || !requirements || discoveryState !== "ready" || (authType === "oauth" && authorizationServers.length > 1 && !authorizationServerIssuer) || (authType === "apikey" && !apiKey.trim()) || accessIncomplete}
            onClick={() => void submit()}
          >
            Add connection
          </DenButton>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
