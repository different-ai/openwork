"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Loader2, Pencil, Plug, Puzzle, RefreshCw, Search, Server, Trash2, Users, Wrench } from "lucide-react";
import { buttonVariants, DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { getPluginRoute, getYourConnectionsRoute } from "../../_lib/den-org";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { IntegrationIcon } from "./integration-icon";
import { Microsoft365Dialog } from "./microsoft-365-dialog";
import {
  closeMcpAuthorizationWindow,
  navigateMcpAuthorizationWindow,
  openMcpAuthorizationWindow,
  type McpAuthorizationWindow,
} from "./mcp-authorization-url";
import {
  editableMcpIdentityChanged,
  marketplaceIdentityOwnerNames,
  mcpAccessMode,
  type McpConnectionAccessMode,
} from "./mcp-connection-editing";
import { effectiveMcpAccess, formatInheritedMcpAccess } from "./mcp-connection-display";
import { copyTextToClipboard } from "./mcp-clipboard";
import { shouldShowMcpConnectionsStagingBanner } from "./mcp-connections-capability";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { marketplaceQueryKeys, useMarketplaces } from "./marketplace-data";
import {
  type CreatedMcpConnection,
  type CreateMcpConnectionInput,
  type ExternalMcpAuthType,
  type ExternalMcpConnection,
  type ExternalMcpConfigurationDiscovery,
  type ExternalMcpCredentialMode,
  type ExternalMcpPreset,
  type ExternalMcpTool,
  type McpConnectionAccessInput,
  type UpdatedMcpConnection,
  type UpdateMcpConnectionInput,
  formatMcpConnectedTimestamp,
  mcpConnectionQueryKeys,
  parseExternalMcpConfigurationDiscovery,
  useCreateMcpConnection,
  useDeleteMcpConnection,
  useDiscoverMcpConnection,
  useMcpConnectionPresets,
  useMcpConnections,
  useMcpConnectionTools,
  useNativeProviderClient,
  useSaveNativeProviderClient,
  useStartMcpConnectionOAuth,
  useTelegramConnection,
  useUpdateMcpConnection,
} from "./mcp-connections-data";
import {
  discoveredAuthType,
  discoveryAuthControlCopy,
  discoveryAuthIsEditable,
  discoveryHasUnsupportedRequirements,
  discoveryNeedsInput,
  McpDiscoverySummary,
} from "./mcp-discovery-summary";
import { getPluginPartsSummary, pluginQueryKeys, usePlugins } from "./plugin-data";
import { TelegramDialog } from "./telegram-dialog";

const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_POLL_TIMEOUT_MS = 90_000;
const MCP_TOOL_PAGE_SIZE = 50;
const GITHUB_IMPORT_MAX_COMPONENTS = 12;

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

type GithubPluginImportSkippedReason = "missing_url" | "local_unsupported" | "invalid_url" | "unsupported_auth" | "unsupported_configuration";

type GithubPluginImportServer = {
  authType: ExternalMcpAuthType | "unknown";
  discovery: ExternalMcpConfigurationDiscovery | null;
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
  sourceRevisionRef: string;
  servers: GithubPluginImportServer[];
  skills: GithubPluginImportSkill[];
  warnings: string[];
};

type GithubMcpServerConfiguration = {
  apiKey: string;
  authType: ExternalMcpAuthType;
  clientId: string;
  clientSecret: string;
  credentialMode: ExternalMcpCredentialMode;
  showOAuthClient: boolean;
};

export type GithubImportedMcpOAuthCallback = {
  connectionId: string;
  name: string;
  oauthCallback: string;
};

function initialGithubServerConfiguration(server: GithubPluginImportServer): GithubMcpServerConfiguration {
  const fallback = server.authType === "unknown" ? "oauth" : server.authType;
  const authType = discoveredAuthType(server.discovery, fallback);
  return {
    apiKey: "",
    authType,
    clientId: "",
    clientSecret: "",
    credentialMode: authType === "oauth" ? "per_member" : "shared",
    showOAuthClient: discoveryNeedsInput(server.discovery, "oauth_client_id"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseSkippedReason(value: unknown): GithubPluginImportSkippedReason | null {
  if (value === "missing_url" || value === "local_unsupported" || value === "invalid_url" || value === "unsupported_auth" || value === "unsupported_configuration") {
    return value;
  }
  return null;
}

export function parseGithubPluginImportPreview(payload: unknown): GithubPluginImportPreview {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  if (!item) throw new Error("GitHub plugin preview response was incomplete.");

  return {
    repositoryFullName: asString(item.repositoryFullName) ?? "",
    rootPath: asString(item.rootPath) ?? "",
    sourceRevisionRef: asString(item.sourceRevisionRef) ?? "",
    servers: Array.isArray(item.servers)
      ? item.servers.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const name = asString(entry.name);
          const serverKey = asString(entry.serverKey);
          if (!name || !serverKey) return [];
          return [{
            authType: entry.authType === "oauth" || entry.authType === "apikey" || entry.authType === "none" ? entry.authType : "unknown",
            discovery: parseExternalMcpConfigurationDiscovery(entry.discovery),
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
    warnings: Array.isArray(item.warnings) ? item.warnings.filter((warning): warning is string => typeof warning === "string") : [],
  };
}

export function parseGithubImportedMcpOAuthCallbacks(payload: unknown): GithubImportedMcpOAuthCallback[] {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  if (!item || !Array.isArray(item.imported)) return [];
  return item.imported.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const connectionId = asString(entry.connectionId);
    const name = asString(entry.name);
    const oauthCallback = asString(entry.oauthCallback);
    return connectionId && name && oauthCallback ? [{ connectionId, name, oauthCallback }] : [];
  });
}

export function githubImportServerNeedsExplicitReview(server: GithubPluginImportServer): boolean {
  return server.discovery?.support.status === "needs_review";
}

export function githubImportServerSelectedByDefault(server: GithubPluginImportServer): boolean {
  return server.supported && !githubImportServerNeedsExplicitReview(server);
}

function importServerStatus(server: GithubPluginImportServer): string {
  if (githubImportServerNeedsExplicitReview(server)) return "review required";
  if (server.supported) return "ready";
  if (server.skippedReason === "missing_url") return "missing URL";
  if (server.skippedReason === "unsupported_configuration") return "manual setup needed";
  return "unsupported";
}

export function McpConnectionsScreen() {
  const { orgContext } = useOrgDashboard();
  const { data: connections = [], isLoading, error, refetch } = useMcpConnections();
  const { data: usableConnections = [] } = useMcpConnections("usable");
  const { data: presets = [] } = useMcpConnectionPresets();
  const createConnection = useCreateMcpConnection();
  const updateConnection = useUpdateMcpConnection();
  const startOAuth = useStartMcpConnectionOAuth();
  const deleteConnection = useDeleteMcpConnection();
  const saveNativeClient = useSaveNativeProviderClient();

  const [formOpen, setFormOpen] = useState(false);
  const [formPreset, setFormPreset] = useState<ExternalMcpPreset | null>(null);
  const [editingConnection, setEditingConnection] = useState<ExternalMcpConnection | null>(null);
  const [pluginDialogOpen, setPluginDialogOpen] = useState(false);
  const [googleDialogOpen, setGoogleDialogOpen] = useState(false);
  const [microsoftDialogOpen, setMicrosoftDialogOpen] = useState(false);
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);
  const googleConfigured = usableConnections.some((connection) => connection.id === "google-workspace");
  const microsoftConfigured = usableConnections.some((connection) => connection.id === "microsoft-365");
  const telegramConnection = useTelegramConnection(true);
  const showStagingBanner = orgContext ? shouldShowMcpConnectionsStagingBanner(orgContext.capabilities) : false;
  const [pollingConnectionId, setPollingConnectionId] = useState<string | null>(null);
  const [connectionActionError, setConnectionActionError] = useState<{
    authorizeUrl?: string;
    connectionId: string;
    message: string;
  } | null>(null);
  const [connectionActionNotice, setConnectionActionNotice] = useState<string | null>(null);
  const [toolsConnectionId, setToolsConnectionId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("add") === "plugin") setPluginDialogOpen(true);
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setPollingConnectionId(null);
  }

  function pollUntilConnected(
    connectionId: string,
    authorizationWindow: McpAuthorizationWindow,
    authorizeUrl: string,
  ) {
    setPollingConnectionId(connectionId);
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      const result = await refetch();
      const connection = result.data?.find((entry) => entry.id === connectionId);
      if (connection?.connected) {
        closeMcpAuthorizationWindow(authorizationWindow);
        stopPolling();
        return;
      }
      if (authorizationWindow.closed) {
        stopPolling();
        setConnectionActionError({
          authorizeUrl,
          connectionId,
          message: "The sign-in window was closed before authorization finished.",
        });
        return;
      }
      if (Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        closeMcpAuthorizationWindow(authorizationWindow);
        stopPolling();
        setConnectionActionError({
          authorizeUrl,
          connectionId,
          message: "Authorization is taking longer than expected.",
        });
      }
    }, OAUTH_POLL_INTERVAL_MS);
  }

  async function handleConnectOAuth(
    connectionId: string,
    authorizationWindow: McpAuthorizationWindow | null = openMcpAuthorizationWindow(connectionId),
  ) {
    setConnectionActionError(null);
    try {
      const result = await startOAuth.mutateAsync(connectionId);
      if (result.status === "connected") {
        closeMcpAuthorizationWindow(authorizationWindow);
        void refetch();
        return;
      }
      if (!result.authorizeUrl) throw new Error("The MCP provider did not return an authorization URL.");
      const launch = navigateMcpAuthorizationWindow(authorizationWindow, result.authorizeUrl);
      if (!launch.navigated || !authorizationWindow) {
        closeMcpAuthorizationWindow(authorizationWindow);
        setConnectionActionError({
          authorizeUrl: launch.authorizeUrl,
          connectionId,
          message: authorizationWindow
            ? "The sign-in window closed before it could open the provider."
            : "Your browser blocked the sign-in window.",
        });
        return;
      }
      pollUntilConnected(connectionId, authorizationWindow, launch.authorizeUrl);
    } catch (connectError) {
      closeMcpAuthorizationWindow(authorizationWindow);
      setConnectionActionError({
        connectionId,
        message: connectError instanceof Error ? connectError.message : "Failed to connect the MCP server.",
      });
    }
  }

  async function handleCreate(
    input: CreateMcpConnectionInput,
    authorizationWindow?: McpAuthorizationWindow | null,
  ): Promise<CreatedMcpConnection> {
    let created: CreatedMcpConnection;
    try {
      created = await createConnection.mutateAsync(input);
    } catch (createError) {
      closeMcpAuthorizationWindow(authorizationWindow);
      throw createError;
    }
    if (input.oauthClient) {
      return created;
    }
    setFormOpen(false);
    setFormPreset(null);
    // Shared-credential OAuth: the admin authorizes the org's single account
    // right now. Per-member: nothing to authorize here — each granted person
    // connects their own account from Your Connections.
    if (input.authType === "oauth" && input.credentialMode === "shared") {
      await handleConnectOAuth(created.id, authorizationWindow);
    }
    return created;
  }

  async function handleUpdate(input: UpdateMcpConnectionInput): Promise<UpdatedMcpConnection> {
    setConnectionActionError(null);
    setConnectionActionNotice(null);
    const updated = await updateConnection.mutateAsync(input);
    setEditingConnection(null);
    setConnectionActionNotice(updated.reconnectionRequired
      ? `${updated.name} was saved securely. Reconnect it before the new identity can be used.`
      : updated.identityChanged
        ? `${updated.name} was saved and the replacement configuration was validated.`
        : `${updated.name} was updated without disconnecting it.`);
    return updated;
  }

  async function handleRemoveConnection(connection: ExternalMcpConnection): Promise<void> {
    if (!window.confirm(`Remove “${connection.name}”? This deletes its saved credentials and assignments.`)) return;
    setConnectionActionError(null);
    try {
      await deleteConnection.mutateAsync(connection.id);
    } catch (removeError) {
      setConnectionActionError({
        connectionId: connection.id,
        message: removeError instanceof Error ? removeError.message : "Failed to remove the MCP connection.",
      });
      // A plugin can bind the connection after this view loaded. Refreshing
      // makes the server's authoritative provenance visible and disables the
      // remove action while retaining the actionable 409 message in the row.
      void refetch();
    }
  }

  return (
    <DashboardPageTemplate
      icon={Plug}
      title="Connections"
      badgeLabel="Alpha"
      description="Connect remote MCP servers, inspect their setup requirements, and choose who can use them. search_capabilities and execute_capability pick configured connections up automatically."
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
          {connectionActionError.message}{" "}
          {connectionActionError.authorizeUrl ? (
            <a
              href={connectionActionError.authorizeUrl}
              referrerPolicy="no-referrer"
              className="font-semibold underline underline-offset-2"
            >
              Continue sign-in in this tab
            </a>
          ) : null}
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
              <span className="mt-1 block text-[12px] leading-5 text-gray-500">Connect one remote MCP server by URL.</span>
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
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              polling={pollingConnectionId === connection.id}
              connecting={startOAuth.isPending && startOAuth.variables === connection.id}
              errorMessage={connectionActionError?.connectionId === connection.id ? connectionActionError.message : null}
              authorizationFallbackUrl={connectionActionError?.connectionId === connection.id ? connectionActionError.authorizeUrl ?? null : null}
              onEdit={() => {
                updateConnection.reset();
                setEditingConnection(connection);
              }}
              onConnect={() => void handleConnectOAuth(connection.id)}
              onRemove={() => void handleRemoveConnection(connection)}
              removing={deleteConnection.isPending && deleteConnection.variables === connection.id}
              toolsOpen={toolsConnectionId === connection.id}
              onToggleTools={() => setToolsConnectionId((current) => current === connection.id ? null : connection.id)}
            />
          ))}
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
        submitting={updateConnection.isPending}
        error={updateConnection.error}
        onClose={() => {
          updateConnection.reset();
          setEditingConnection(null);
        }}
        onSubmit={handleUpdate}
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
  const { orgContext, orgSlug, runReauthableAction } = useOrgDashboard();
  const { data: marketplaces = [] } = useMarketplaces();
  const { data: plugins = [], isLoading: pluginsLoading } = usePlugins();
  const [githubUrl, setGithubUrl] = useState("");
  const [marketplaceId, setMarketplaceId] = useState("");
  const [preview, setPreview] = useState<GithubPluginImportPreview | null>(null);
  const [serverConfigurations, setServerConfigurations] = useState<Record<string, GithubMcpServerConfiguration>>({});
  const [selectedServerKeys, setSelectedServerKeys] = useState<string[]>([]);
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [accessMode, setAccessMode] = useState<AddConnectionAccessMode>("everyone");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [importedCallbacks, setImportedCallbacks] = useState<GithubImportedMcpOAuthCallback[]>([]);
  const [copiedCallbackId, setCopiedCallbackId] = useState<string | null>(null);
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
    setPreview(null);
    setServerConfigurations({});
    setSelectedServerKeys([]);
    setSelectedSkillKeys([]);
    setAccessMode("everyone");
    setSelectedTeamIds([]);
    setSelectedMemberIds([]);
    setImportedCallbacks([]);
    setCopiedCallbackId(null);
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
      setServerConfigurations(Object.fromEntries(nextPreview.servers.map((server) => [server.serverKey, initialGithubServerConfiguration(server)])));
      // Inferred auth (especially initialize-only no-auth) is useful guidance,
      // not proof that later tools are public. Leave those servers unchecked
      // until the admin explicitly reviews and selects them.
      setSelectedServerKeys(nextPreview.servers
        .filter(githubImportServerSelectedByDefault)
        .slice(0, GITHUB_IMPORT_MAX_COMPONENTS)
        .map((server) => server.serverKey));
      // Skills contain executable guidance for agents. Require an explicit
      // post-review selection instead of opting admins into running them.
      setSelectedSkillKeys([]);
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
    if (selectedServerKeys.length + selectedSkillKeys.length > GITHUB_IMPORT_MAX_COMPONENTS) {
      setError(`Select at most ${GITHUB_IMPORT_MAX_COMPONENTS} total MCP servers and skills.`);
      return;
    }

    const access: McpConnectionAccessInput = accessMode === "everyone"
      ? { orgWide: true, memberIds: [], teamIds: [] }
      : {
          orgWide: false,
          memberIds: accessMode === "people" ? selectedMemberIds : [],
          teamIds: accessMode === "teams" ? selectedTeamIds : [],
        };
    const selectedServers = preview.servers.filter((server) => selectedServerKeys.includes(server.serverKey));
    const selectedConfigurations = selectedServers.flatMap((server) => {
      const configuration = serverConfigurations[server.serverKey];
      if (!configuration) return [];
      const clientId = configuration.clientId.trim();
      const clientSecret = configuration.clientSecret.trim();
      return [{
        authType: configuration.authType,
        credentialMode: configuration.authType === "oauth" ? configuration.credentialMode : "shared",
        serverKey: server.serverKey,
        ...(configuration.authType === "apikey" ? { apiKey: configuration.apiKey.trim() } : {}),
        ...(configuration.authType === "oauth" && configuration.showOAuthClient && clientId
          ? { oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) } }
          : {}),
      }];
    });
    const legacyConfiguration = selectedConfigurations[0];

    setBusy(true);
    setError(null);
    try {
      let importPayload: unknown = null;
      await runReauthableAction("import-github-connection-plugin", async () => {
        const result = await requestJson(
          "/v1/plugins/import-mcps-from-github-url",
          {
            method: "POST",
            body: JSON.stringify({
              access,
              authType: legacyConfiguration?.authType === "none" ? "none" : "oauth",
              credentialMode: legacyConfiguration?.credentialMode ?? "per_member",
              githubUrl: githubUrl.trim(),
              marketplaceId,
              selectedServerKeys,
              selectedSkillKeys,
              serverConfigurations: selectedConfigurations,
              sourceRevisionRef: preview.sourceRevisionRef,
            }),
          },
          30000,
        );
        if (!result.response.ok) {
          throw getRequestError(result.payload, result.response, "Failed to import GitHub plugin.");
        }
        importPayload = result.payload;
      });
      await queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
      onImported();
      setServerConfigurations((current) => Object.fromEntries(Object.entries(current).map(([serverKey, configuration]) => [serverKey, {
        ...configuration,
        apiKey: "",
        clientSecret: "",
      }])));
      const callbacks = parseGithubImportedMcpOAuthCallbacks(importPayload);
      if (callbacks.length > 0) {
        setImportedCallbacks(callbacks);
      } else {
        onClose();
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Failed to import GitHub plugin.");
    } finally {
      setBusy(false);
    }
  }

  function toggleServer(serverKey: string, checked: boolean) {
    if (
      checked
      && !selectedServerKeys.includes(serverKey)
      && selectedServerKeys.length + selectedSkillKeys.length >= GITHUB_IMPORT_MAX_COMPONENTS
    ) {
      setError(`Select at most ${GITHUB_IMPORT_MAX_COMPONENTS} total MCP servers and skills.`);
      return;
    }
    setSelectedServerKeys((current) =>
      checked ? [...new Set([...current, serverKey])] : current.filter((key) => key !== serverKey),
    );
  }

  function toggleSkill(skillKey: string, checked: boolean) {
    if (
      checked
      && !selectedSkillKeys.includes(skillKey)
      && selectedServerKeys.length + selectedSkillKeys.length >= GITHUB_IMPORT_MAX_COMPONENTS
    ) {
      setError(`Select at most ${GITHUB_IMPORT_MAX_COMPONENTS} total MCP servers and skills.`);
      return;
    }
    setSelectedSkillKeys((current) =>
      checked ? [...new Set([...current, skillKey])] : current.filter((key) => key !== skillKey),
    );
  }

  function updateServerConfiguration(serverKey: string, update: Partial<GithubMcpServerConfiguration>) {
    setServerConfigurations((current) => {
      const existing = current[serverKey];
      if (!existing) return current;
      return { ...current, [serverKey]: { ...existing, ...update } };
    });
  }

  function toggleAccessSelection(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  }

  const teams = orgContext?.teams ?? [];
  const members = (orgContext?.members ?? []).filter((member) => Boolean(member.userId));
  const selectedComponentCount = selectedServerKeys.length + selectedSkillKeys.length;
  const componentSelectionLimitReached = selectedComponentCount >= GITHUB_IMPORT_MAX_COMPONENTS;
  const accessIncomplete = accessMode === "teams"
    ? selectedTeamIds.length === 0
    : accessMode === "people" && selectedMemberIds.length === 0;
  const selectedConfigurationIncomplete = preview?.servers.some((server) => {
    if (!selectedServerKeys.includes(server.serverKey)) return false;
    const configuration = serverConfigurations[server.serverKey];
    if (!configuration || discoveryHasUnsupportedRequirements(server.discovery)) return true;
    if (configuration.authType === "apikey") return !configuration.apiKey.trim();
    if (configuration.authType !== "oauth") return false;
    if (discoveryNeedsInput(server.discovery, "oauth_client_id") && !configuration.clientId.trim()) return true;
    return discoveryNeedsInput(server.discovery, "oauth_client_secret") && !configuration.clientSecret.trim();
  }) === true;

  async function copyImportedCallback(callback: GithubImportedMcpOAuthCallback) {
    if (await copyTextToClipboard(callback.oauthCallback)) setCopiedCallbackId(callback.connectionId);
  }

  if (!open) return null;

  if (importedCallbacks.length > 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
        <div
          className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">Plugin imported — finish OAuth app setup</h2>
          <p className="mt-2 text-[13px] leading-6 text-gray-600">
            Add each exact redirect URL to its provider OAuth app before anyone signs in. These URLs are derived from this OpenWork deployment.
          </p>
          <div className="mt-5 space-y-3">
            {importedCallbacks.map((callback) => (
              <div key={callback.connectionId} className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <p className="text-[13px] font-semibold text-gray-900">{callback.name}</p>
                <p className="mt-2 break-all font-mono text-[12px] leading-5 text-gray-800">{callback.oauthCallback}</p>
                <DenButton variant="secondary" className="mt-3" onClick={() => void copyImportedCallback(callback)}>
                  {copiedCallbackId === callback.connectionId ? "Copied" : "Copy redirect URL"}
                </DenButton>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Link href={getYourConnectionsRoute(orgSlug)} className={buttonVariants({ variant: "secondary" })} onClick={onClose}>
              Open Your Connections
            </Link>
            <DenButton variant="primary" onClick={onClose}>Done</DenButton>
          </div>
        </div>
      </div>
    );
  }

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
              <span className="font-medium text-gray-900">{preview.repositoryFullName}{preview.rootPath ? `/${preview.rootPath}` : ""}</span> at immutable revision{" "}
              <a
                href={`https://github.com/${preview.repositoryFullName}/tree/${preview.sourceRevisionRef}${preview.rootPath ? `/${preview.rootPath}` : ""}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono font-medium text-gray-900 underline decoration-gray-300 underline-offset-2"
              >
                {preview.sourceRevisionRef.slice(0, 12)}
              </a>.
            </div>
            {preview.warnings.length > 0 ? (
              <ul className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] leading-5 text-amber-800">
                {preview.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
              </ul>
            ) : null}
            <p className="text-[12px] font-medium text-gray-500" role="status">
              {selectedComponentCount} of {GITHUB_IMPORT_MAX_COMPONENTS} MCP servers and skills selected
            </p>

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
                            disabled={!server.supported || busy || (componentSelectionLimitReached && !selectedServerKeys.includes(server.serverKey))}
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

            {preview.servers.filter((server) => !server.supported && server.discovery).map((server) => (
              <div key={`unsupported:${server.serverKey}`} className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-[13px] font-semibold text-amber-900">{server.name} needs setup OpenWork cannot host yet</p>
                {server.discovery ? <McpDiscoverySummary discovery={server.discovery} /> : null}
              </div>
            ))}

            {preview.skills.length > 0 ? (
              <div className="overflow-hidden rounded-2xl border border-amber-200">
                <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-[12px] leading-5 text-amber-900">
                  <span className="font-semibold">Review skills before importing.</span>{" "}
                  Skills can contain executable guidance that tells an agent to use tools or run commands. They are not selected by default; inspect the pinned GitHub revision above, then select only the skills you trust.
                </div>
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
                            disabled={!skill.supported || busy || (componentSelectionLimitReached && !selectedSkillKeys.includes(skill.skillKey))}
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

            {preview.servers.filter((server) => selectedServerKeys.includes(server.serverKey)).map((server) => {
              const configuration = serverConfigurations[server.serverKey];
              if (!configuration) return null;
              const clientIdRequired = discoveryNeedsInput(server.discovery, "oauth_client_id");
              const clientSecretRequired = discoveryNeedsInput(server.discovery, "oauth_client_secret");
              const authEditable = discoveryAuthIsEditable(server.discovery);
              return (
                <div key={server.serverKey} className="space-y-3 rounded-2xl border border-gray-100 bg-gray-50 p-4">
                  <div>
                    <p className="text-[13px] font-semibold text-gray-900">Configure {server.name}</p>
                    <p className="mt-0.5 break-all font-mono text-[11px] text-gray-500">{server.url}</p>
                  </div>
                  {server.discovery ? <McpDiscoverySummary discovery={server.discovery} /> : (
                    <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800">
                      This preview did not include discoverable setup metadata. Choose the provider&apos;s documented authentication method.
                    </p>
                  )}
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Authentication</span>
                    <DenSelect
                      value={configuration.authType}
                      onChange={(event) => {
                        const nextAuthType = event.target.value === "apikey" ? "apikey" : event.target.value === "none" ? "none" : "oauth";
                        updateServerConfiguration(server.serverKey, {
                          authType: nextAuthType,
                          credentialMode: nextAuthType === "oauth" ? configuration.credentialMode : "shared",
                        });
                      }}
                      disabled={busy || !authEditable}
                    >
                      <option value="oauth">OAuth</option>
                      <option value="apikey">API key</option>
                      <option value="none">No authentication</option>
                    </DenSelect>
                    <span className="mt-1 block text-[11px] leading-5 text-gray-500">{discoveryAuthControlCopy(server.discovery)}</span>
                  </label>
                  {configuration.authType === "apikey" ? (
                    <label className="block">
                      <span className="mb-1.5 block text-[12px] font-medium text-gray-700">API key</span>
                      <DenInput
                        type="password"
                        value={configuration.apiKey}
                        onChange={(event) => updateServerConfiguration(server.serverKey, { apiKey: event.target.value })}
                        placeholder="API key"
                        autoComplete="off"
                      />
                    </label>
                  ) : null}
                  {configuration.authType === "oauth" ? (
                    <>
                      <label className="block">
                        <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Who signs in?</span>
                        <DenSelect
                          value={configuration.credentialMode}
                          onChange={(event) => updateServerConfiguration(server.serverKey, { credentialMode: event.target.value === "shared" ? "shared" : "per_member" })}
                          disabled={busy}
                        >
                          <option value="per_member">Each user connects their own account</option>
                          <option value="shared">Organization-shared account</option>
                        </DenSelect>
                      </label>
                      {!configuration.showOAuthClient ? (
                        <button
                          type="button"
                          onClick={() => updateServerConfiguration(server.serverKey, { showOAuthClient: true })}
                          className="text-left text-[12px] font-medium text-gray-500 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-900"
                        >
                          This server needs a pre-registered OAuth app
                        </button>
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Client ID{clientIdRequired ? "" : " (optional)"}</span>
                            <DenInput value={configuration.clientId} onChange={(event) => updateServerConfiguration(server.serverKey, { clientId: event.target.value })} placeholder="Client ID" />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Client secret{clientSecretRequired ? "" : " (optional)"}</span>
                            <DenInput type="password" value={configuration.clientSecret} onChange={(event) => updateServerConfiguration(server.serverKey, { clientSecret: event.target.value })} placeholder="Client secret" />
                          </label>
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              );
            })}

            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Marketplace</span>
                <DenSelect value={marketplaceId} onChange={(event) => setMarketplaceId(event.target.value)} disabled={busy}>
                  {marketplaces.map((marketplace) => (
                    <option key={marketplace.id} value={marketplace.id}>{marketplace.name}</option>
                  ))}
                </DenSelect>
              </label>
              <div className="mt-4">
                <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Who can use this import?</span>
                <SegmentedControl options={ACCESS_MODE_OPTIONS} value={accessMode} onChange={setAccessMode} />
                <p className="mt-1.5 text-[12px] leading-5 text-gray-500">
                  This is the initial plugin, skill, and MCP assignment. Effective MCP access can later expand when another active config, plugin, or marketplace assignment includes the same connection.
                </p>
                {accessMode === "teams" ? (
                  <div className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                    {teams.length === 0 ? <p className="px-2 py-1 text-[12px] text-gray-400">No teams in this organization yet.</p> : teams.map((team) => (
                      <button
                        key={team.id}
                        type="button"
                        onClick={() => setSelectedTeamIds((current) => toggleAccessSelection(current, team.id))}
                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] ${selectedTeamIds.includes(team.id) ? "bg-gray-100 text-gray-900" : "text-gray-700 hover:bg-gray-50"}`}
                      >
                        <span className="truncate">{team.name}</span>
                        {selectedTeamIds.includes(team.id) ? <Check className="h-3.5 w-3.5" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {accessMode === "people" ? (
                  <div className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                    {members.length === 0 ? <p className="px-2 py-1 text-[12px] text-gray-400">No members in this organization yet.</p> : members.map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => setSelectedMemberIds((current) => toggleAccessSelection(current, member.id))}
                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] ${selectedMemberIds.includes(member.id) ? "bg-gray-100 text-gray-900" : "text-gray-700 hover:bg-gray-50"}`}
                      >
                        <span className="truncate">{member.user.name || member.user.email}</span>
                        {selectedMemberIds.includes(member.id) ? <Check className="h-3.5 w-3.5" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
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
            disabled={!preview || !marketplaceId || accessIncomplete || selectedConfigurationIncomplete || selectedComponentCount === 0 || selectedComponentCount > GITHUB_IMPORT_MAX_COMPONENTS}
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

function accessSummaryLabel(connection: ExternalMcpConnection): string {
  const access = effectiveMcpAccess(connection.access, connection.inheritedAccess);
  if (!access) return "";
  if (access.orgWide) return "Everyone in the org";
  const parts: string[] = [];
  const marketplaceCount = access.marketplaceIds?.length ?? 0;
  if (access.teamIds.length > 0) parts.push(`${access.teamIds.length} ${access.teamIds.length === 1 ? "team" : "teams"}`);
  if (access.memberIds.length > 0) parts.push(`${access.memberIds.length} ${access.memberIds.length === 1 ? "person" : "people"}`);
  if (marketplaceCount > 0) parts.push(`${marketplaceCount} ${marketplaceCount === 1 ? "marketplace" : "marketplaces"}`);
  return parts.length > 0 ? parts.join(", ") : "Nobody yet";
}

function ConnectionRow({
  connection,
  polling,
  connecting,
  errorMessage,
  onEdit,
  authorizationFallbackUrl,
  onConnect,
  onRemove,
  removing,
  toolsOpen,
  onToggleTools,
}: {
  connection: ExternalMcpConnection;
  polling: boolean;
  connecting: boolean;
  errorMessage: string | null;
  onEdit: () => void;
  authorizationFallbackUrl: string | null;
  onConnect: () => void;
  onRemove: () => void;
  removing: boolean;
  toolsOpen: boolean;
  onToggleTools: () => void;
}) {
  const isPerMember = connection.credentialMode === "per_member";
  const needsOAuthConnect = !isPerMember && connection.authType === "oauth" && !connection.connected;

  const canInspectTools = connection.credentialMode === "shared" ? connection.connected : connection.connectedForMe;
  const requiredByNames = [...new Set(connection.requiredBy.map((item) => item.name))];

  return (
    <div>
      <div className="flex flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <IntegrationIcon name={connection.name} serviceUrl={connection.url} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-[14px] font-semibold text-gray-900">{connection.name}</p>
              {isPerMember ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-900 px-2 py-0.5 text-[11px] font-medium text-white">
                  <Users className="h-3 w-3" />
                  Individual accounts
                </span>
              ) : connection.connected ? (
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
              {connection.access || connection.inheritedAccess ? (
                <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                  {accessSummaryLabel(connection)}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-gray-500">
              {connection.url} · {formatMcpConnectedTimestamp(connection.connectedAt)}
            </p>
            {requiredByNames.length > 0 ? (
              <p className="mt-1 text-[12px] text-amber-700">
                Required by {requiredByNames.join(", ")}. Remove it from the plugin before deleting this connection.
              </p>
            ) : null}
            {errorMessage ? (
              <p className="mt-1 text-[12px] text-red-600">
                {errorMessage}{" "}
                {authorizationFallbackUrl ? (
                  <a href={authorizationFallbackUrl} referrerPolicy="no-referrer" className="font-semibold underline underline-offset-2">
                    Continue sign-in in this tab
                  </a>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
          <DenButton
            variant="secondary"
            size="sm"
            icon={Pencil}
            onClick={onEdit}
            disabled={!connection.updatedAt}
            aria-label={`Edit ${connection.name}`}
            data-testid={`edit-mcp-connection-${connection.id}`}
          >
            Edit
          </DenButton>
          <DenButton
            variant="secondary"
            size="sm"
            disabled={!canInspectTools}
            onClick={onToggleTools}
            title={canInspectTools ? "Inspect the tools this MCP exposes" : "Connect this account before inspecting tools"}
          >
            {toolsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            View tools
          </DenButton>
          {needsOAuthConnect ? (
            <DenButton variant="secondary" size="sm" loading={connecting || polling} onClick={onConnect}>
              Connect
            </DenButton>
          ) : null}
          <DenButton
            variant="destructive"
            size="sm"
            icon={Trash2}
            loading={removing}
            onClick={onRemove}
            disabled={requiredByNames.length > 0}
            title={requiredByNames.length > 0 ? "This connection is still required by a marketplace plugin" : "Remove this connection"}
            aria-label={`Remove ${connection.name}`}
          >
            Remove
          </DenButton>
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
  const gridColumns = options.length === 2
    ? "grid-cols-2"
    : options.length === 4
      ? "grid-cols-2 sm:grid-cols-4"
      : options.length === 5
        ? "grid-cols-2 sm:grid-cols-5"
        : "grid-cols-3";

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

type AddConnectionAccessMode = Exclude<McpConnectionAccessMode, "none">;

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
  { value: "marketplaces", label: "Marketplaces" },
];

function EditConnectionDialog({
  connection,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  connection: ExternalMcpConnection | null;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: UpdateMcpConnectionInput) => Promise<UpdatedMcpConnection>;
}) {
  const { orgContext } = useOrgDashboard();
  const discoverConnection = useDiscoverMcpConnection();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<ExternalMcpAuthType>("oauth");
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>("shared");
  const [apiKey, setApiKey] = useState("");
  const [showOAuthClient, setShowOAuthClient] = useState(false);
  const [oauthClientId, setOAuthClientId] = useState("");
  const [oauthClientSecret, setOAuthClientSecret] = useState("");
  const [accessMode, setAccessMode] = useState<McpConnectionAccessMode>("everyone");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [selectedMarketplaceIds, setSelectedMarketplaceIds] = useState<string[]>([]);
  const [confirmingIdentityChange, setConfirmingIdentityChange] = useState(false);
  const [discovery, setDiscovery] = useState<ExternalMcpConfigurationDiscovery | null>(null);
  const inspectRequestRef = useRef(0);

  useEffect(() => {
    inspectRequestRef.current += 1;
    setDiscovery(null);
    discoverConnection.reset();
    if (!connection) return;
    setName(connection.name);
    setUrl(connection.url);
    setAuthType(connection.authType);
    setCredentialMode(connection.credentialMode);
    setApiKey("");
    setShowOAuthClient(Boolean(connection.oauthClientId));
    setOAuthClientId(connection.oauthClientId ?? "");
    setOAuthClientSecret("");
    setAccessMode(mcpAccessMode(connection.access));
    setSelectedTeamIds(connection.access?.teamIds ?? []);
    setSelectedMemberIds(connection.access?.memberIds ?? []);
    setSelectedMarketplaceIds(connection.access?.marketplaceIds ?? []);
    setConfirmingIdentityChange(false);
  }, [connection]);

  const teams = useMemo(() => orgContext?.teams ?? [], [orgContext?.teams]);
  const members = useMemo(
    () => (orgContext?.members ?? []).filter((member) => Boolean(member.userId)),
    [orgContext?.members],
  );
  const { data: marketplaces = [] } = useMarketplaces();
  const marketplaceOwners = connection?.identityManagedBy ?? [];
  const marketplaceManaged = marketplaceOwners.length > 0;
  const editAccessModeOptions = useMemo<SegmentedControlOption<McpConnectionAccessMode>[]>(() => [
    ...ACCESS_MODE_OPTIONS,
    { value: "none", label: marketplaceManaged ? "Inherited only" : "Nobody" },
  ], [marketplaceManaged]);
  const inheritedAssignmentLabel = formatInheritedMcpAccess(
    connection?.inheritedAccess ?? null,
    teams,
    members.map((member) => ({ id: member.id, name: member.user.name || member.user.email })),
  );
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
      marketplaceIds: selectedMarketplaceIds,
    };
  const accessIncomplete = accessMode === "teams"
    ? selectedTeamIds.length === 0
    : accessMode === "people"
      ? selectedMemberIds.length === 0
      : accessMode === "marketplaces"
        ? selectedMarketplaceIds.length === 0
        : false;
  const replacementApiKeyRequired = authType === "apikey" && identityChanged && !apiKey.trim();

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  }

  async function inspectServer() {
    const inspectedUrl = url.trim();
    if (!inspectedUrl || marketplaceManaged) return;
    const requestId = ++inspectRequestRef.current;
    setDiscovery(null);
    try {
      const nextDiscovery = await discoverConnection.mutateAsync({ url: inspectedUrl });
      if (inspectRequestRef.current !== requestId) return;
      const nextAuthType = discoveredAuthType(nextDiscovery, authType);
      setDiscovery(nextDiscovery);
      setAuthType(nextAuthType);
      if (nextAuthType !== "oauth") {
        setCredentialMode("shared");
        setShowOAuthClient(false);
      } else {
        setShowOAuthClient(Boolean(connection?.oauthClientId) || discoveryNeedsInput(nextDiscovery, "oauth_client_id"));
      }
      setConfirmingIdentityChange(false);
    } catch {
      // The error is rendered beside the manual configuration controls.
    }
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
    const input: UpdateMcpConnectionInput = {
      connectionId: connection.id,
      expectedUpdatedAt: connection.updatedAt,
      name: name.trim(),
      url: url.trim(),
      authType,
      credentialMode: proposedCredentialMode,
      ...(!marketplaceManaged && authType === "apikey" && trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
      ...(!marketplaceManaged && authType === "oauth" && showOAuthClient && trimmedClientId
        ? {
          oauthClient: {
            clientId: trimmedClientId,
            ...(trimmedClientSecret ? { clientSecret: trimmedClientSecret } : {}),
          },
        }
        : {}),
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
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">Edit MCP connection</h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-600">
          Update how this server is presented and who can use it. Saved credentials are never shown here.
        </p>

        {marketplaceManaged ? (
          <div className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-[12px] leading-5 text-blue-800" data-testid="marketplace-managed-identity-note">
            <p className="font-semibold text-blue-900">Server and authentication are managed by {marketplaceIdentityOwnerNames(marketplaceOwners)}.</p>
            <p className="mt-1">Change those values in the marketplace plugin definition. You can still rename this connection here.</p>
            <p className="mt-1" data-testid="marketplace-inherited-access-note">
              {inheritedAssignmentLabel ? <>Inherited plugin access: <span className="font-semibold">{inheritedAssignmentLabel}</span>. </> : null}
              The controls below manage only additional direct assignments and never replace plugin access.
            </p>
          </div>
        ) : null}

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</label>
            <DenInput value={name} onChange={(event) => setName(event.target.value)} data-testid="edit-mcp-name" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Server URL</label>
            <div className="flex gap-2">
              <DenInput
                value={url}
                data-testid="edit-mcp-url"
                disabled={marketplaceManaged}
                onChange={(event) => {
                  inspectRequestRef.current += 1;
                  setUrl(event.target.value);
                  setDiscovery(null);
                  discoverConnection.reset();
                  setConfirmingIdentityChange(false);
                }}
              />
              {!marketplaceManaged ? (
                <DenButton
                  variant="secondary"
                  loading={discoverConnection.isPending}
                  disabled={!url.trim() || discoverConnection.isPending}
                  onClick={() => void inspectServer()}
                  data-testid="inspect-edit-mcp-connection"
                >
                  Inspect
                </DenButton>
              ) : null}
            </div>
          </div>
          {discoverConnection.isPending ? (
            <div className="flex items-center gap-2 rounded-2xl border border-gray-100 bg-gray-50 p-4 text-[13px] text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Inspecting authentication and required setup…
            </div>
          ) : discovery ? (
            <McpDiscoverySummary discovery={discovery} />
          ) : discoverConnection.error ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-5 text-amber-800">
              OpenWork could not inspect this server. You can still configure it manually. {discoverConnection.error instanceof Error ? discoverConnection.error.message : ""}
            </div>
          ) : null}
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

          {!marketplaceManaged && authType === "oauth" && !showOAuthClient ? (
            <button
              type="button"
              onClick={() => {
                setShowOAuthClient(true);
                setConfirmingIdentityChange(false);
              }}
              className="text-left text-[12px] font-medium text-gray-500 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-900"
            >
              Replace a pre-registered OAuth app
            </button>
          ) : null}

          {!marketplaceManaged && authType === "oauth" && showOAuthClient ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-[13px] font-semibold text-gray-900">OAuth app</p>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">The client ID is safe to display. The saved client secret remains hidden.</p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client ID</label>
                  <DenInput
                    value={oauthClientId}
                    onChange={(event) => {
                      setOAuthClientId(event.target.value);
                      setConfirmingIdentityChange(false);
                    }}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Replacement client secret (optional)</label>
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
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">
              {marketplaceManaged ? "Additional direct assignments" : "Who can use this?"}
            </label>
            <SegmentedControl
              options={editAccessModeOptions}
              value={accessMode}
              onChange={(option) => {
                if (option !== accessMode) {
                  if (option === "teams") setSelectedMemberIds([]);
                  if (option === "people") setSelectedTeamIds([]);
                  if (option !== "marketplaces") setSelectedMarketplaceIds([]);
                  if (option === "marketplaces") {
                    setSelectedMemberIds([]);
                    setSelectedTeamIds([]);
                  }
                  if (option === "none") {
                    setSelectedMemberIds([]);
                    setSelectedTeamIds([]);
                    setSelectedMarketplaceIds([]);
                  }
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
            {accessMode === "marketplaces" ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                {marketplaces.length === 0 ? (
                  <p className="px-2 py-1 text-[12px] text-gray-400">No marketplaces in this org yet.</p>
                ) : marketplaces.map((marketplace) => (
                  <button
                    key={marketplace.id}
                    type="button"
                    onClick={() => setSelectedMarketplaceIds((current) => toggle(current, marketplace.id))}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${selectedMarketplaceIds.includes(marketplace.id) ? "bg-gray-100 text-gray-900" : "text-gray-700 hover:bg-gray-50"}`}
                  >
                    <span className="truncate">{marketplace.name}</span>
                    {selectedMarketplaceIds.includes(marketplace.id) ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
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
            disabled={!connection.updatedAt || !name.trim() || !url.trim() || replacementApiKeyRequired || accessIncomplete}
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

export function AddConnectionDialog({
  open,
  preset,
  marketplaceAccess,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  preset: ExternalMcpPreset | null;
  marketplaceAccess?: { id: string; name: string };
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (
    input: CreateMcpConnectionInput,
    authorizationWindow?: McpAuthorizationWindow | null,
  ) => Promise<CreatedMcpConnection>;
}) {
  const { orgContext } = useOrgDashboard();
  const discoverConnection = useDiscoverMcpConnection();
  const [name, setName] = useState(preset?.displayName ?? "");
  const [url, setUrl] = useState(preset?.url ?? "");
  const [authType, setAuthType] = useState<ExternalMcpAuthType>(preset?.authType ?? "oauth");
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>("per_member");
  const [apiKey, setApiKey] = useState("");
  const [showOAuthClient, setShowOAuthClient] = useState(Boolean(preset?.requiresOAuthClient));
  const [oauthClientId, setOAuthClientId] = useState("");
  const [oauthClientSecret, setOAuthClientSecret] = useState("");
  const [discovery, setDiscovery] = useState<ExternalMcpConfigurationDiscovery | null>(null);
  const [oauthCallback, setOAuthCallback] = useState<string | null>(null);
  const [copiedCallback, setCopiedCallback] = useState(false);
  const [accessMode, setAccessMode] = useState<AddConnectionAccessMode>("everyone");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [selectedMarketplaceIds, setSelectedMarketplaceIds] = useState<string[]>([]);
  const inspectRequestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const requestId = ++inspectRequestRef.current;
    setName(preset?.displayName ?? "");
    setUrl(preset?.url ?? "");
    setAuthType(preset?.authType ?? "oauth");
    setCredentialMode("per_member");
    setApiKey("");
    setShowOAuthClient(Boolean(preset?.requiresOAuthClient));
    setOAuthClientId("");
    setOAuthClientSecret("");
    setDiscovery(null);
    discoverConnection.reset();
    setOAuthCallback(null);
    setCopiedCallback(false);
    setAccessMode(marketplaceAccess ? "marketplaces" : "everyone");
    setSelectedTeamIds([]);
    setSelectedMemberIds([]);
    setSelectedMarketplaceIds(marketplaceAccess ? [marketplaceAccess.id] : []);
    if (preset?.url) {
      void discoverConnection.mutateAsync({ url: preset.url }).then((nextDiscovery) => {
        if (cancelled || inspectRequestRef.current !== requestId) return;
        setDiscovery(nextDiscovery);
        setAuthType(discoveredAuthType(nextDiscovery, preset.authType));
        setShowOAuthClient(discoveryNeedsInput(nextDiscovery, "oauth_client_id"));
      }).catch(() => {
        // The curated preset remains a safe fallback when live inspection is unavailable.
      });
    }
    return () => {
      cancelled = true;
    };
  }, [open, preset, marketplaceAccess?.id]);

  const teams = useMemo(() => orgContext?.teams ?? [], [orgContext?.teams]);
  const members = useMemo(
    () => (orgContext?.members ?? []).filter((member) => Boolean(member.userId)),
    [orgContext?.members],
  );
  const { data: marketplaces = [] } = useMarketplaces();

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  }

  const oauthClientIdRequired = authType === "oauth" && (discovery
    ? discoveryNeedsInput(discovery, "oauth_client_id")
    : Boolean(preset?.requiresOAuthClient));
  const oauthClientSecretRequired = authType === "oauth" && (discovery
    ? discoveryNeedsInput(discovery, "oauth_client_secret")
    : Boolean(preset?.requiresOAuthClient));
  const showOAuthClientFields = authType === "oauth" && (oauthClientIdRequired || showOAuthClient);
  const isSlackPreset = preset?.presetId === "slack";
  const access: McpConnectionAccessInput = accessMode === "everyone"
    ? { orgWide: true, memberIds: [], teamIds: [], marketplaceIds: [] }
    : {
      orgWide: false,
      memberIds: accessMode === "people" ? selectedMemberIds : [],
      teamIds: accessMode === "teams" ? selectedTeamIds : [],
      marketplaceIds: accessMode === "marketplaces" ? selectedMarketplaceIds : [],
    };
  const accessIncomplete = accessMode === "teams"
    ? selectedTeamIds.length === 0
    : accessMode === "people"
      ? selectedMemberIds.length === 0
      : accessMode === "marketplaces"
        ? selectedMarketplaceIds.length === 0
        : false;

  async function inspectServer() {
    const inspectedUrl = url.trim();
    if (!inspectedUrl) return;
    const requestId = ++inspectRequestRef.current;
    setDiscovery(null);
    try {
      const nextDiscovery = await discoverConnection.mutateAsync({ url: inspectedUrl });
      if (inspectRequestRef.current !== requestId) return;
      setDiscovery(nextDiscovery);
      setAuthType(discoveredAuthType(nextDiscovery, authType));
      setCredentialMode((current) => discoveredAuthType(nextDiscovery, authType) === "oauth" ? current : "shared");
      setShowOAuthClient(discoveryNeedsInput(nextDiscovery, "oauth_client_id"));
    } catch {
      // The error is rendered beside the manual fallback fields.
    }
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
      requestedOAuthScopes: authType === "oauth"
        && discovery?.oauth
        && discovery.oauth.scopesSource !== "authorization_server"
        && discovery.oauth.scopesSource !== "none"
        ? discovery.oauth.scopes
        : undefined,
      access,
    };
    const authorizationWindow = input.authType === "oauth"
      && input.credentialMode === "shared"
      && !input.oauthClient
      ? openMcpAuthorizationWindow(`new-${input.name}`)
      : undefined;
    try {
      const created = await onSubmit(input, authorizationWindow);
      setApiKey("");
      setOAuthClientSecret("");
      if (input.oauthClient && created.links?.oauthCallback) {
        setOAuthCallback(created.links.oauthCallback);
        setCopiedCallback(false);
      }
    } catch {
      closeMcpAuthorizationWindow(authorizationWindow);
      // The mutation's typed error is rendered by the dialog's error prop.
      // Consume the rejected promise so a clear validation failure does not
      // also become an opaque browser-level unhandled rejection.
    }
  }

  async function copyOAuthCallback() {
    if (!oauthCallback) return;
    if (await copyTextToClipboard(oauthCallback)) setCopiedCallback(true);
  }

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        {oauthCallback ? (
          <>
            <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
              {isSlackPreset ? "Almost done — add this redirect URL to your Slack app" : "Almost done — add this redirect URL to your app"}
            </h2>
            <p className="mt-2 text-[13px] leading-6 text-gray-600">
              {isSlackPreset
                ? "Copy this exact URL into your Slack app's OAuth redirect URLs before teammates connect."
                : "Copy this into the OAuth redirect URLs for your pre-registered app before teammates connect."}
            </p>
            <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50 p-3">
              <p className="break-all font-mono text-[12px] leading-5 text-gray-800">{oauthCallback}</p>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DenButton variant="secondary" onClick={copyOAuthCallback}>
                {copiedCallback ? "Copied" : "Copy"}
              </DenButton>
              <DenButton variant="primary" onClick={onClose}>
                Done
              </DenButton>
            </div>
          </>
        ) : (
          <>
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
          {preset
            ? `Add ${preset.displayName}`
            : marketplaceAccess
              ? `Add a connection to ${marketplaceAccess.name}`
              : "Add a custom MCP server"}
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-600">
          {isSlackPreset ? (
            <>
              Slack MCP needs a pre-registered Slack app — Slack does not support automatic app registration. Paste your Slack app&apos;s OAuth client below.
            </>
          ) : "Inspect a remote MCP server, review what it requires, and choose who can use it. If it uses OAuth, OpenWork guides the right people through sign-in."}
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</label>
            <DenInput value={name} onChange={(event) => setName(event.target.value)} placeholder="notion" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Server URL</label>
            <div className="flex gap-2">
              <DenInput
                value={url}
                onChange={(event) => {
                  inspectRequestRef.current += 1;
                  setUrl(event.target.value);
                  setDiscovery(null);
                  discoverConnection.reset();
                }}
                placeholder="https://mcp.example.com/mcp"
                disabled={Boolean(preset)}
              />
              {!preset ? (
                <DenButton variant="secondary" loading={discoverConnection.isPending} disabled={!url.trim() || discoverConnection.isPending} onClick={() => void inspectServer()}>
                  Inspect
                </DenButton>
              ) : null}
            </div>
          </div>
          {discoverConnection.isPending ? (
            <div className="flex items-center gap-2 rounded-2xl border border-gray-100 bg-gray-50 p-4 text-[13px] text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Inspecting authentication and required setup…
            </div>
          ) : discovery ? (
            <McpDiscoverySummary discovery={discovery} />
          ) : discoverConnection.error ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-5 text-amber-800">
              OpenWork could not inspect this server. You can still configure it manually. {discoverConnection.error instanceof Error ? discoverConnection.error.message : ""}
            </div>
          ) : null}
          {!preset && (!discovery || discovery.auth.kind === "unknown" || discovery.auth.confidence !== "verified") ? (
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
              This server needs a pre-registered OAuth app
            </button>
          ) : null}

          {showOAuthClientFields ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-[13px] font-semibold text-gray-900">{isSlackPreset ? "Slack OAuth app" : "OAuth app"}</p>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">
                {isSlackPreset
                  ? "Create or use an internal or directory-published Slack app, then paste its Client ID and Client secret. After you create the connection, OpenWork shows the exact redirect URL to add to that Slack app."
                  : "Create an app for your workspace, then paste its OAuth client here. Each person connects their own account with it — sign-ins stay in your org's cloud."}
              </p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client ID</label>
                  <DenInput
                    value={oauthClientId}
                    onChange={(event) => setOAuthClientId(event.target.value)}
                    placeholder="1234567890.1234567890123"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client secret{oauthClientSecretRequired ? "" : " (optional)"}</label>
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
            {marketplaceAccess ? (
              <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                <p className="text-[13px] font-semibold text-gray-900">Members of {marketplaceAccess.name}</p>
                <p className="mt-1 text-[12px] leading-5 text-gray-500">
                  This connection follows marketplace access automatically, including everyone, teams, and people assigned to it.
                </p>
              </div>
            ) : (
              <SegmentedControl options={ACCESS_MODE_OPTIONS} value={accessMode} onChange={setAccessMode} />
            )}
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
            {accessMode === "marketplaces" && !marketplaceAccess ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
                {marketplaces.length === 0 ? (
                  <p className="px-2 py-1 text-[12px] text-gray-400">No marketplaces in this org yet.</p>
                ) : (
                  marketplaces.map((marketplace) => (
                    <button
                      key={marketplace.id}
                      type="button"
                      onClick={() => setSelectedMarketplaceIds((current) => toggle(current, marketplace.id))}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${
                        selectedMarketplaceIds.includes(marketplace.id) ? "bg-gray-100 text-gray-900" : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <span className="truncate">{marketplace.name}</span>
                      {selectedMarketplaceIds.includes(marketplace.id) ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
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
            disabled={discoverConnection.isPending || discoveryHasUnsupportedRequirements(discovery) || !name.trim() || !url.trim() || (authType === "apikey" && !apiKey.trim()) || (oauthClientIdRequired && !oauthClientId.trim()) || (oauthClientSecretRequired && !oauthClientSecret.trim()) || accessIncomplete}
            onClick={() => void submit()}
          >
            {showOAuthClientFields ? "Create and show redirect URL" : "Add connection"}
          </DenButton>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
