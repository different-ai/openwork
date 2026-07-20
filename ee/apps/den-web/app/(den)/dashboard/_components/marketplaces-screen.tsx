"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { AlertCircle, Cable, CheckCircle2, Github, KeyRound, Loader2, Plus, Search, Server, Store } from "lucide-react";
import { StaticSeededGradient } from "@openwork/ui/react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { getIntegrationsRoute, getMarketplaceRoute, getMarketplacesRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useHasAnyIntegration } from "./integration-data";
import { AddConnectionDialog, GoogleWorkspaceDialog, ImportPluginConnectionDialog } from "./mcp-connections-screen";
import {
  type CreateMcpConnectionInput,
  type ExternalMcpConnection,
  type ExternalMcpPreset,
  formatMcpConnectedTimestamp,
  mcpConnectionQueryKeys,
  useCreateMcpConnection,
  useMcpConnectionPresets,
  useMcpConnections,
  useSaveNativeProviderClient,
  useStartMcpConnectionOAuth,
} from "./mcp-connections-data";
import {
  type DenMarketplace,
  formatMarketplaceTimestamp,
  useCreateMarketplace,
  useMarketplaces,
  useWrapStandaloneConnections,
} from "./marketplace-data";
import { IntegrationIcon } from "./integration-icon";
import { MarketplaceLogo } from "./marketplace-logo";

type MarketplaceHubTab = "browse" | "servers";

export function MarketplacesScreen() {
  const { orgSlug } = useOrgDashboard();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: marketplaces = [], isLoading, error } = useMarketplaces();
  const { hasAny: hasAnyIntegration, isLoading: integrationsLoading } = useHasAnyIntegration();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const activeTab: MarketplaceHubTab = searchParams.get("tab") === "servers" ? "servers" : "browse";

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalizedQuery) return marketplaces;
    return marketplaces.filter((marketplace) =>
      `${marketplace.name}\n${marketplace.description ?? ""}`.toLowerCase().includes(normalizedQuery),
    );
  }, [marketplaces, normalizedQuery]);

  async function refreshAfterImport() {
    await queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
  }

  return (
    <DashboardPageTemplate
      icon={Store}
      badgeLabel="Preview"
      title="Marketplaces"
      description="Marketplaces are where admins publish plugin items, configure MCP server instances, and govern access for desktop members."
      colors={["#FEF3C7", "#92400E", "#F59E0B", "#FDE68A"]}
    >
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex rounded-full border border-gray-200 bg-white p-1">
          <TabLink active={activeTab === "browse"} href={getMarketplacesRoute(orgSlug)}>
            Browse
          </TabLink>
          <TabLink active={activeTab === "servers"} href={`${getMarketplacesRoute(orgSlug)}?tab=servers`}>
            Configured servers
          </TabLink>
        </div>
        <div className="flex items-center gap-2">
          <DenButton variant="secondary" icon={Github} onClick={() => setImportOpen(true)}>
            Import from GitHub
          </DenButton>
          <DenButton icon={Plus} onClick={() => setCreateOpen(true)}>
            New marketplace
          </DenButton>
        </div>
      </div>

      {activeTab === "servers" ? (
        <ConfiguredServersPanel />
      ) : (
        <>
          <div className="mb-6">
            <DenInput
              type="search"
              icon={Search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search marketplaces..."
            />
          </div>

          {error ? (
            <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
              {error instanceof Error ? error.message : "Failed to load marketplaces."}
            </div>
          ) : null}

          {isLoading || integrationsLoading ? (
            <div className="rounded-2xl border border-gray-100 bg-white px-6 py-10 text-[14px] text-gray-500">
              Loading marketplaces...
            </div>
          ) : !hasAnyIntegration && marketplaces.length === 0 ? (
            <ConnectIntegrationEmptyState integrationsHref={getIntegrationsRoute(orgSlug)} />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={marketplaces.length === 0 ? "No marketplaces yet" : "No marketplaces match that search"}
              description={
                marketplaces.length === 0
                  ? "Create or connect a marketplace, then assign it to everyone in your org or specific users and teams."
                  : "Try a different search term or open the configured servers tab."
              }
              action={
                marketplaces.length === 0
                  ? { href: getIntegrationsRoute(orgSlug), label: "Open Integrations", icon: Cable }
                  : undefined
              }
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filtered.map((marketplace) => (
                <Link
                  key={marketplace.id}
                  href={getMarketplaceRoute(orgSlug, marketplace.id)}
                  className="group block overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]"
                >
                  <div className="flex items-stretch">
                    <div className="relative w-[68px] shrink-0 overflow-hidden">
                      <StaticSeededGradient seed={marketplace.id} className="absolute inset-0" />
                      <div className="relative flex h-full items-center justify-center">
                        <div className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-white/60 bg-white shadow-[0_8px_20px_-8px_rgba(15,23,42,0.3)]">
                          <MarketplaceLogo
                            logoUrl={marketplace.logoUrl}
                            name={marketplace.name}
                            imgClassName="h-6 w-6"
                            iconClassName="h-4 w-4"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="min-w-0 flex-1 px-5 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <h2 className="truncate text-[14px] font-semibold text-gray-900">
                          {marketplace.name}
                        </h2>
                        <span className="shrink-0 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500">
                          {marketplace.pluginCount} plugin{marketplace.pluginCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      {marketplace.description ? (
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">
                          {marketplace.description}
                        </p>
                      ) : null}
                      <p className="mt-3 text-[11.5px] text-gray-400">
                        Added {formatMarketplaceTimestamp(marketplace.createdAt)}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      <ImportPluginConnectionDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void refreshAfterImport()}
      />

      <CreateMarketplaceDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(marketplace) => {
          setCreateOpen(false);
          router.push(getMarketplaceRoute(orgSlug, marketplace.id));
        }}
      />
    </DashboardPageTemplate>
  );
}

function CreateMarketplaceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (marketplace: DenMarketplace) => void;
}) {
  const createMutation = useCreateMarketplace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  if (!open) {
    return null;
  }

  const trimmedName = name.trim();

  async function submit() {
    const created = await createMutation.mutateAsync({
      name: trimmedName,
      description: description.trim() || undefined,
    });
    setName("");
    setDescription("");
    onCreated(created);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="w-full max-w-[440px] rounded-2xl border border-gray-100 bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.4)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-gray-950">New marketplace</h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-500">
          A curated catalog of plugins for your org. Add plugins to it, then choose who can see it.
        </p>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</span>
          <DenInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Engineering tools"
            autoFocus
          />
        </label>
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Description (optional)</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What belongs in this marketplace?"
            rows={2}
            className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2 text-[13px] text-gray-900 outline-none transition placeholder:text-gray-300 focus:border-gray-400"
          />
        </label>

        {createMutation.error ? (
          <p className="mt-3 text-[12.5px] text-red-600">
            {createMutation.error instanceof Error ? createMutation.error.message : "Failed to create marketplace."}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <DenButton variant="secondary" onClick={onClose} disabled={createMutation.isPending}>
            Cancel
          </DenButton>
          <DenButton
            disabled={!trimmedName || createMutation.isPending}
            onClick={() => void submit()}
          >
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Create marketplace
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function TabLink({ active, href, children }: { active: boolean; href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition ${
        active ? "bg-gray-950 text-white" : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
      }`}
    >
      {children}
    </Link>
  );
}

function ConfiguredServersPanel() {
  const queryClient = useQueryClient();
  const connectionsQuery = useMcpConnections("manageable");
  const { data: usableConnections = [] } = useMcpConnections("usable");
  const { data: presets = [] } = useMcpConnectionPresets();
  const wrapMutation = useWrapStandaloneConnections();
  const createConnection = useCreateMcpConnection();
  const saveNativeClient = useSaveNativeProviderClient();
  const connectMutation = useStartMcpConnectionOAuth();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formPreset, setFormPreset] = useState<ExternalMcpPreset | null>(null);
  const [googleDialogOpen, setGoogleDialogOpen] = useState(false);

  const connections = connectionsQuery.data ?? [];
  const standaloneConnections = connections.filter((connection) => !connection.pluginId);
  const googleConfigured = usableConnections.some((connection) => connection.id === "google-workspace");

  async function wrapStandalone() {
    await wrapMutation.mutateAsync(undefined);
    await queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
  }

  async function connect(connectionId: string) {
    setConnectError(null);
    try {
      const result = await connectMutation.mutateAsync(connectionId);
      if (result.status === "needs_auth" && result.authorizeUrl) {
        window.open(result.authorizeUrl, "_blank", "noopener,noreferrer");
      }
      await queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Failed to start OAuth.");
    }
  }

  async function handleCreate(
    input: CreateMcpConnectionInput,
    options: { startOAuth: boolean },
  ): Promise<void> {
    const created = await createConnection.mutateAsync(input);
    if (!input.oauthClient) {
      setFormOpen(false);
      setFormPreset(null);
      await queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
      if (options.startOAuth) {
        await connect(created.id);
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-gray-100 bg-white px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-gray-900">Add a configured server</h2>
            <p className="mt-1 text-[13px] leading-6 text-gray-500">
              Add a single MCP server directly, or configure a server template from a marketplace plugin.
            </p>
          </div>
          <DenButton
            onClick={() => {
              setFormPreset(null);
              setFormOpen(true);
            }}
          >
            Add custom
          </DenButton>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <button
            type="button"
            onClick={() => setGoogleDialogOpen(true)}
            className="rounded-xl border border-gray-100 px-3 py-3 text-left transition hover:border-gray-300 hover:shadow-sm"
          >
            <div className="flex items-start gap-3">
              <IntegrationIcon name="Google Workspace" iconUrl="/integrations/google.svg" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-gray-900">Google Workspace</p>
                <p className="mt-1 line-clamp-2 text-[11.5px] leading-5 text-gray-500">
                  Company Google, with each member connecting their own account.
                </p>
              </div>
            </div>
            <p className="mt-2 text-[11.5px] font-medium text-gray-900">
              {googleConfigured ? "Configured - tap to update" : "Tap to set up"}
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
                className="rounded-xl border border-gray-100 px-3 py-3 text-left transition hover:border-gray-300 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-start gap-3">
                  <IntegrationIcon name={preset.displayName} serviceUrl={preset.url} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-gray-900">{preset.displayName}</p>
                    <p className="mt-1 line-clamp-2 text-[11.5px] leading-5 text-gray-500">{preset.description}</p>
                  </div>
                </div>
                <p className="mt-2 text-[11.5px] font-medium text-gray-900">
                  {alreadyAdded ? "Already added" : "Tap to add"}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {standaloneConnections.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[14px] font-semibold text-amber-950">
              {standaloneConnections.length} standalone server{standaloneConnections.length === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-[13px] leading-6 text-amber-800">
              Wrap them into marketplace items so desktop sees plugins instead of loose MCP rows.
            </p>
          </div>
          <DenButton
            variant="secondary"
            loading={wrapMutation.isPending}
            onClick={() => void wrapStandalone()}
          >
            Wrap standalone
          </DenButton>
        </div>
      ) : null}

      {connectError ? (
        <div className="rounded-2xl border border-red-100 bg-red-50 px-5 py-3 text-[13px] text-red-700">
          {connectError}
        </div>
      ) : null}

      {connectionsQuery.isLoading ? (
        <div className="rounded-2xl border border-gray-100 bg-white px-6 py-10 text-[14px] text-gray-500">
          Loading configured servers...
        </div>
      ) : connectionsQuery.error ? (
        <div className="rounded-2xl border border-red-100 bg-red-50 px-5 py-3 text-[13px] text-red-700">
          {connectionsQuery.error instanceof Error ? connectionsQuery.error.message : "Failed to load configured servers."}
        </div>
      ) : connections.length === 0 ? (
        <EmptyState
          title="No configured servers yet"
          description="Import a plugin from GitHub or add MCP server templates to plugins, then configure them here."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.12em] text-gray-400">
              <tr>
                <th className="px-4 py-3">Server</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Auth</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Access</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {connections.map((connection) => (
                <ConfiguredServerRow
                  key={connection.id}
                  connection={connection}
                  connecting={connectMutation.isPending}
                  onConnect={(id) => void connect(id)}
                />
              ))}
            </tbody>
          </table>
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

      <GoogleWorkspaceDialog
        open={googleDialogOpen}
        submitting={saveNativeClient.isPending}
        error={saveNativeClient.error}
        onClose={() => setGoogleDialogOpen(false)}
        onSubmit={async (input) => {
          await saveNativeClient.mutateAsync({ providerId: "google-workspace", ...input });
          setGoogleDialogOpen(false);
          await queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
        }}
      />
    </div>
  );
}

function ConfiguredServerRow({
  connection,
  connecting,
  onConnect,
}: {
  connection: ExternalMcpConnection;
  connecting: boolean;
  onConnect: (connectionId: string) => void;
}) {
  const accessLabel = connection.access?.orgWide
    ? "Everyone"
    : connection.access
      ? [
          connection.access.teamIds.length > 0 ? `${connection.access.teamIds.length} teams` : null,
          connection.access.memberIds.length > 0 ? `${connection.access.memberIds.length} people` : null,
        ].filter(Boolean).join(", ") || "No grants"
      : "Granted";
  const needsConnection = connection.credentialMode === "per_member"
    ? !connection.connectedForMe
    : !connection.connected;
  const statusLabel = needsConnection ? "Needs setup" : "Connected";

  return (
    <tr className="align-top">
      <td className="px-4 py-4">
        <div className="flex gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-gray-50 text-gray-500">
            <Server className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold text-gray-900">{connection.instanceLabel ?? connection.name}</p>
            <p className="mt-0.5 max-w-[280px] truncate font-mono text-[11.5px] text-gray-400">{connection.url}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-4">
        {connection.pluginId ? (
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700">
            Marketplace item
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-[12px] font-medium text-gray-600">
            Standalone
          </span>
        )}
      </td>
      <td className="px-4 py-4 text-gray-600">
        <div className="inline-flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 text-gray-400" aria-hidden />
          <span>{connection.authType === "none" ? "No auth" : connection.authType.toUpperCase()}</span>
        </div>
        <p className="mt-1 text-[12px] text-gray-400">
          {connection.credentialMode === "per_member" ? "Individual accounts" : "One org account"}
        </p>
      </td>
      <td className="px-4 py-4">
        <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${needsConnection ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
          {needsConnection ? <AlertCircle className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
          {statusLabel}
        </div>
        <p className="mt-1 text-[12px] text-gray-400">{formatMcpConnectedTimestamp(connection.connectedAt)}</p>
      </td>
      <td className="px-4 py-4 text-gray-500">{accessLabel}</td>
      <td className="px-4 py-4 text-right">
        {connection.authType === "oauth" && needsConnection ? (
          <DenButton
            size="sm"
            variant="secondary"
            disabled={connecting}
            onClick={() => onConnect(connection.id)}
          >
            Connect
          </DenButton>
        ) : (
          <span className="text-[12px] text-gray-400">Ready</span>
        )}
      </td>
    </tr>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { href: string; label: string; icon: ComponentType<{ className?: string }> };
}) {
  const ActionIcon = action?.icon;
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <p className="text-[15px] font-semibold text-gray-900">{title}</p>
      <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-6 text-gray-500">{description}</p>
      {action ? (
        <div className="mt-5 flex justify-center">
          <Link href={action.href} className={buttonVariants({ variant: "primary", size: "sm" })}>
            {ActionIcon ? <ActionIcon className="h-4 w-4" aria-hidden="true" /> : null}
            {action.label}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function ConnectIntegrationEmptyState({ integrationsHref }: { integrationsHref: string }) {
  return (
    <EmptyState
      title="Connect an integration to discover marketplaces"
      description="Marketplaces are created when OpenWork finds plugins in a connected repository. Assign them to everyone in your org or specific users and teams."
      action={{ href: integrationsHref, label: "Open Integrations", icon: Cable }}
    />
  );
}
