"use client";

import Link from "next/link";
import { useState } from "react";
import { Cable, Check, GitBranch, Github, Loader2, Plus, Settings, Trash2 } from "lucide-react";
import { getGithubIntegrationAccountRoute, getGithubIntegrationRoute, getGithubIntegrationSetupRoute } from "../../../../_lib/den-org";
import { DenButton } from "../../../../_components/ui/button";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { IntegrationConnectDialog } from "./integration-connect-dialog";
import {
  type ConnectedIntegration,
  type IntegrationProvider,
  INTEGRATION_PROVIDERS,
  formatIntegrationTimestamp,
  useDisconnectIntegration,
  useIntegrations,
  useStartGithubInstall,
} from "./integration-data";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function IntegrationsScreen() {
  const { orgSlug } = useOrgDashboard();
  const { data: connections = [], isLoading, error } = useIntegrations();
  const disconnect = useDisconnectIntegration();
  const startGithubInstall = useStartGithubInstall();
  const [dialogProvider, setDialogProvider] = useState<IntegrationProvider | null>(null);

  async function handleConnect(provider: IntegrationProvider) {
    if (provider !== "github") {
      setDialogProvider(provider);
      return;
    }

    try {
      const result = await startGithubInstall.mutateAsync({
        returnPath: getGithubIntegrationRoute(orgSlug),
      });
      window.location.assign(result.redirectUrl);
    } catch {
      return;
    }
  }

  const connectedByProvider = connections.reduce<
    Partial<Record<IntegrationProvider, ConnectedIntegration[]>>
  >((acc, connection) => {
    const list = acc[connection.provider] ?? [];
    list.push(connection);
    acc[connection.provider] = list;
    return acc;
  }, {});

  const providers = Object.values(INTEGRATION_PROVIDERS);

  return (
    <DashboardPageTemplate
      icon={Cable}
      badgeLabel="Preview"
      title="Integrations"
      description="Connect to GitHub or Bitbucket. Once an account is linked, plugins and skills from those repositories show up on the Plugins page."
      colors={["#E0F2FE", "#0C4A6E", "#0284C7", "#7DD3FC"]}
    >
      {error || startGithubInstall.error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error
            ? error.message
            : startGithubInstall.error instanceof Error
              ? startGithubInstall.error.message
              : "Failed to load integrations."}
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading integrations…
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {providers.map((meta) => {
            const providerConnections = connectedByProvider[meta.provider] ?? [];
            const isConnected = providerConnections.length > 0;

            return (
              <div
                key={meta.provider}
                className="overflow-hidden rounded-2xl border border-gray-100 bg-white"
              >
                {/* Header */}
                <div
                  className={`flex items-start gap-4 px-6 py-5 ${isConnected ? "border-b border-gray-100" : ""}`}
                >
                  <ProviderLogo provider={meta.provider} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-gray-900">{meta.name}</h2>
                      {meta.provider === "bitbucket" ? (
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                          Coming soon
                        </span>
                      ) : isConnected ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                          <Check className="h-3 w-3" />
                          Connected
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                          Not connected
                        </span>
                      )}
                    </div>
                    {!isConnected ? (
                      <p className="mt-1 text-[13px] leading-[1.55] text-gray-500">{meta.description}</p>
                    ) : null}
                  </div>

                  <div className="shrink-0">
                    <DenButton
                      variant={isConnected ? "secondary" : "primary"}
                      size="sm"
                      loading={meta.provider === "github" && startGithubInstall.isPending}
                      disabled={meta.provider === "bitbucket"}
                      onClick={() => void handleConnect(meta.provider)}
                    >
                      {meta.provider === "bitbucket"
                        ? "Coming soon"
                        : isConnected
                          ? "Connect another"
                          : "Connect"}
                    </DenButton>
                  </div>
                </div>

                {/* Body: connected accounts + repos */}
                {isConnected ? (
                  <div className="divide-y divide-gray-100">
                    {providerConnections.map((connection) => (
                      <ConnectionRow
                        key={connection.id}
                        connection={connection}
                        orgSlug={orgSlug}
                        onConfigureNewRepo={meta.provider === "github" ? () => window.location.assign(getGithubIntegrationAccountRoute(orgSlug, connection.account.id)) : undefined}
                        onDisconnect={() => disconnect.mutate(connection.id)}
                        busy={disconnect.isPending && disconnect.variables === connection.id}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <IntegrationConnectDialog
        open={dialogProvider !== null}
        provider={dialogProvider}
        onClose={() => setDialogProvider(null)}
      />
    </DashboardPageTemplate>
  );
}

function ConnectionRow({
  connection,
  orgSlug,
  onConfigureNewRepo,
  onDisconnect,
  busy,
}: {
  connection: ConnectedIntegration;
  orgSlug: string | null;
  onConfigureNewRepo?: () => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const accountLogin = connection.account.ownerName ?? connection.account.name;
  const connectedBy = connection.account.createdByName ?? null;
  const avatarUrl = connection.provider === "github" && accountLogin
    ? `https://github.com/${encodeURIComponent(accountLogin)}.png?size=80`
    : null;
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        aria-label={`Disconnect ${accountLogin}`}
        disabled={busy}
        className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-400 opacity-0 transition-all duration-150 hover:bg-red-50 hover:text-red-600 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-500/30 group-hover:opacity-100 disabled:cursor-not-allowed"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="h-4 w-4" aria-hidden />
        )}
      </button>

      <div className="flex items-start gap-3 px-6 py-5 pr-14">
        <Avatar url={avatarUrl} fallback={connection.account.avatarInitial} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-[14px] font-semibold text-gray-900">@{accountLogin}</p>
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
              {connection.account.kind === "user" ? "Personal" : "Organization"}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[12px] text-gray-500">
            {connectedBy ? `Added by ${connectedBy}` : "Added recently"}
            <span className="text-gray-400"> · {formatIntegrationTimestamp(connection.connectedAt)}</span>
          </p>
        </div>
      </div>

      <div className="px-6 pb-5">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">
          Configured repositories
        </p>

        {connection.repos.length > 0 ? (
          <ul className="space-y-1.5">
            {connection.repos.map((repo) => (
              <li
                key={repo.id}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition hover:bg-gray-50"
              >
                <span className="inline-flex min-w-0 items-center gap-2 text-[13px] text-gray-700">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span className="truncate">{repo.fullName}</span>
                </span>
                {connection.provider === "github" && repo.connectorInstanceId ? (
                  <Link
                    href={getGithubIntegrationSetupRoute(orgSlug, repo.connectorInstanceId)}
                    aria-label={`Open setup for ${repo.fullName}`}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-200 hover:text-gray-900"
                  >
                    <Settings className="h-4 w-4" aria-hidden />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-gray-400">No repositories configured yet.</p>
        )}

        {onConfigureNewRepo ? (
          <button
            type="button"
            onClick={onConfigureNewRepo}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 px-3 py-2 text-[13px] font-medium text-gray-500 transition hover:border-gray-400 hover:bg-gray-50 hover:text-gray-900"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add new repo
          </button>
        ) : null}
      </div>

      <DisconnectConfirmDialog
        open={confirmOpen}
        accountLogin={accountLogin}
        repoCount={connection.repos.length}
        busy={busy}
        onClose={() => {
          if (!busy) setConfirmOpen(false);
        }}
        onConfirm={() => {
          onDisconnect();
          setConfirmOpen(false);
        }}
      />
    </div>
  );
}

function Avatar({ url, fallback }: { url: string | null; fallback: string }) {
  const [errored, setErrored] = useState(false);

  if (!url || errored) {
    return (
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#0f172a] text-[14px] font-semibold text-white">
        {fallback}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      onError={() => setErrored(true)}
      className="h-11 w-11 shrink-0 rounded-full bg-gray-100 object-cover"
    />
  );
}

function DisconnectConfirmDialog({
  open,
  accountLogin,
  repoCount,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  accountLogin: string;
  repoCount: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
            <Trash2 className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
              Remove @{accountLogin}?
            </h2>
            <p className="mt-1 text-[13px] leading-6 text-gray-600">
              This will permanently delete everything OpenWork imported from this GitHub account, including:
            </p>
            <ul className="mt-3 space-y-1.5 text-[13px] leading-6 text-gray-600">
              <li className="flex gap-2">
                <span className="text-gray-400">•</span>
                <span>
                  <strong>{repoCount}</strong> connected {repoCount === 1 ? "repository" : "repositories"} and their connector setup
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-gray-400">•</span>
                <span>All plugins and marketplaces created from those repos</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gray-400">•</span>
                <span>All imported config objects, versions and source bindings</span>
              </li>
            </ul>
            <p className="mt-3 text-[12px] leading-5 text-gray-500">
              The GitHub App installation itself stays on GitHub. You can remove it from your GitHub account settings if you also want to revoke access.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </DenButton>
          <DenButton variant="destructive" icon={Trash2} loading={busy} onClick={onConfirm}>
            Remove integration
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function ProviderLogo({ provider }: { provider: IntegrationProvider }) {
  if (provider === "github") {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#0f172a] text-white">
        <Github className="h-5 w-5" aria-hidden />
      </div>
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#2684FF] text-[13px] font-semibold text-white">
      BB
    </div>
  );
}
