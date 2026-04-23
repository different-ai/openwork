"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Github,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { getGithubIntegrationRoute, getIntegrationsRoute } from "../../../../_lib/den-org";
import { buttonVariants, DenButton } from "../../../../_components/ui/button";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenInput } from "../../../../_components/ui/input";
import {
  type IntegrationRepo,
  useApplyGithubDiscovery,
  useConnectorInstanceConfiguration,
  useCreateGithubConnectorInstance,
  useGithubAccountRepositories,
  useGithubConnectorDiscovery,
  useGithubInstallCompletion,
  useIntegrations,
  useRemoveConnectorInstance,
  useSetConnectorInstanceAutoImport,
} from "./integration-data";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

function parseInstallationId(value: string | null) {
  if (!value) return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function GithubIntegrationScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgSlug } = useOrgDashboard();
  const connectorInstanceId = searchParams.get("connectorInstanceId")?.trim() ?? null;
  const connectorAccountId = searchParams.get("connectorAccountId")?.trim() ?? null;
  const mode = searchParams.get("mode")?.trim() ?? null;
  const installationId = parseInstallationId(searchParams.get("installation_id"));
  const state = searchParams.get("state")?.trim() ?? null;

  if (connectorInstanceId) {
    return (
      <GithubConnectorInstanceRouter
        connectorInstanceId={connectorInstanceId}
        mode={mode}
        onBack={() => router.push(getIntegrationsRoute(orgSlug))}
      />
    );
  }

  if (connectorAccountId) {
    return <GithubConnectedAccountSelectionPhase connectorAccountId={connectorAccountId} />;
  }

  if (installationId && state) {
    return <GithubInstallCompletionRedirect installationId={installationId} state={state} />;
  }

  return (
    <DashboardPageTemplate
      icon={Github}
      badgeLabel="GitHub"
      title="Connect GitHub"
      description="Choose a connected account from the Integrations page to continue."
      colors={["#E2E8F0", "#0F172A", "#111827", "#94A3B8"]}
    >
      <StatePanel
        title="Nothing to do here"
        body="Return to Integrations to connect a new GitHub account or configure another repository."
      />
    </DashboardPageTemplate>
  );
}

function GithubInstallCompletionRedirect({ installationId, state }: { installationId: number; state: string }) {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const completionQuery = useGithubInstallCompletion({ installationId, state });

  useEffect(() => {
    if (!completionQuery.data) return;
    const nextUrl = `${getGithubIntegrationRoute(orgSlug)}?connectorAccountId=${encodeURIComponent(completionQuery.data.connectorAccount.id)}`;
    router.replace(nextUrl);
  }, [completionQuery.data, orgSlug, router]);

  return (
    <DashboardPageTemplate
      icon={Github}
      badgeLabel="GitHub"
      title="Finishing GitHub connection"
      description="OpenWork is finalizing the GitHub App installation for this organization."
      colors={["#E2E8F0", "#0F172A", "#111827", "#94A3B8"]}
    >
      {completionQuery.error ? (
        <StatePanel
          title="GitHub connection could not be completed"
          body={completionQuery.error instanceof Error ? completionQuery.error.message : "Unknown GitHub installation error."}
        />
      ) : (
        <section className="flex flex-col items-center justify-center rounded-2xl border border-gray-100 bg-white px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-white">
            <LoaderCircle className="h-6 w-6 animate-spin" aria-hidden />
          </div>
          <h2 className="mt-5 text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
            Finalizing your GitHub connection
          </h2>
          <p className="mt-2 max-w-[460px] text-[13px] leading-[1.6] text-gray-500">
            OpenWork is resolving the installation and loading accessible repositories.
          </p>
        </section>
      )}
    </DashboardPageTemplate>
  );
}

function GithubConnectorInstanceRouter({
  connectorInstanceId,
  mode,
  onBack,
}: {
  connectorInstanceId: string;
  mode: string | null;
  onBack: () => void;
}) {
  const configurationQuery = useConnectorInstanceConfiguration(connectorInstanceId);

  if (configurationQuery.isLoading) {
    return <ConfigurationLoadingState />;
  }

  const configuration = configurationQuery.data;
  const hasConfigured = Boolean(configuration && configuration.configuredPlugins.length > 0);
  const shouldRunDiscovery = !hasConfigured || mode === "rediscover";

  if (shouldRunDiscovery) {
    return (
      <GithubDiscoveryPhase
        connectorInstanceId={connectorInstanceId}
        onBack={onBack}
      />
    );
  }

  if (!configuration) {
    return (
      <GithubDiscoveryPhase
        connectorInstanceId={connectorInstanceId}
        onBack={onBack}
      />
    );
  }

  return (
    <GithubConnectorInstanceManagePhase
      configuration={configuration}
      onBack={onBack}
    />
  );
}

function ConfigurationLoadingState() {
  return (
    <DashboardPageTemplate
      icon={Puzzle}
      badgeLabel="Repository"
      title="Loading…"
      description="OpenWork is loading this repository's connector configuration."
      colors={["#DBEAFE", "#0F172A", "#1D4ED8", "#BFDBFE"]}
    >
      <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-center shadow-sm">
        <LoaderCircle className="mx-auto h-6 w-6 animate-spin text-gray-400" />
        <p className="mt-3 text-[14px] text-gray-500">Loading connector configuration…</p>
      </div>
    </DashboardPageTemplate>
  );
}

function GithubConnectorInstanceManagePhase({
  configuration,
  onBack,
}: {
  configuration: {
    autoImportNewPlugins: boolean;
    configuredPlugins: Array<{
      id: string;
      name: string;
      description: string | null;
      memberCount: number;
      componentCounts: Record<string, number>;
      rootPath: string | null;
    }>;
    connectorInstanceId: string;
    connectorInstanceName: string;
    importedConfigObjectCount: number;
    mappingCount: number;
    repositoryFullName: string | null;
  };
  onBack: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgSlug } = useOrgDashboard();
  const removeMutation = useRemoveConnectorInstance();
  const autoImportMutation = useSetConnectorInstanceAutoImport();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [autoImportChecked, setAutoImportChecked] = useState(configuration.autoImportNewPlugins);

  useEffect(() => {
    setAutoImportChecked(configuration.autoImportNewPlugins);
  }, [configuration.autoImportNewPlugins]);

  const repoName = configuration.repositoryFullName ?? configuration.connectorInstanceName;

  async function handleRemove() {
    await removeMutation.mutateAsync(configuration.connectorInstanceId);
    onBack();
  }

  function handleRediscover() {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("connectorInstanceId", configuration.connectorInstanceId);
    params.set("mode", "rediscover");
    router.push(`${getGithubIntegrationRoute(orgSlug)}?${params.toString()}`);
  }

  async function handleAutoImportToggle(nextValue: boolean) {
    setAutoImportChecked(nextValue);
    try {
      await autoImportMutation.mutateAsync({
        autoImportNewPlugins: nextValue,
        connectorInstanceId: configuration.connectorInstanceId,
      });
    } catch {
      setAutoImportChecked(configuration.autoImportNewPlugins);
    }
  }

  return (
    <DashboardPageTemplate
      icon={Puzzle}
      badgeLabel="Repository"
      title={repoName}
      description="Manage which plugins OpenWork imports from this repository."
      colors={["#DBEAFE", "#0F172A", "#1D4ED8", "#BFDBFE"]}
    >
      <div className="mb-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <DenButton variant="secondary" size="sm" icon={RefreshCw} onClick={handleRediscover}>
          Re-run discovery
        </DenButton>
      </div>

      <div className="space-y-8">
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              Imported plugins
            </h2>
            <p className="text-[11px] text-gray-400">
              {configuration.configuredPlugins.length} plugin{configuration.configuredPlugins.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="mb-4 flex items-start justify-between gap-5 rounded-2xl border border-gray-100 bg-white px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
                Auto-import new plugins
              </p>
              <p className="mt-1 text-[12.5px] leading-[1.6] text-gray-500">
                When new plugin structures appear in this repository on future pushes, OpenWork will discover and import them automatically.
              </p>
              {autoImportMutation.error ? (
                <p className="mt-2 text-[12px] text-red-700">
                  {autoImportMutation.error instanceof Error ? autoImportMutation.error.message : "Failed to update auto-import."}
                </p>
              ) : null}
            </div>
            <Toggle
              checked={autoImportChecked}
              busy={autoImportMutation.isPending}
              onChange={(next) => void handleAutoImportToggle(next)}
            />
          </div>

          {configuration.configuredPlugins.length > 0 ? (
            <div className="grid gap-3">
              {configuration.configuredPlugins.map((plugin) => (
                <PluginListItem key={plugin.id} plugin={plugin} />
              ))}
            </div>
          ) : (
            <div className="rounded-[20px] border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
              <p className="text-[14px] font-medium tracking-[-0.02em] text-gray-800">
                No plugins imported yet
              </p>
              <p className="mx-auto mt-2 max-w-[400px] text-[13px] leading-6 text-gray-400">
                Re-run discovery to pick plugins from this repository.
              </p>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-red-400">
            Danger zone
          </h2>
          <div className="overflow-hidden rounded-2xl border border-red-100 bg-white">
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
                  Remove this repository
                </p>
                <p className="mt-1 text-[12.5px] leading-[1.6] text-gray-500">
                  Deletes everything OpenWork imported from this repository. The GitHub connection itself stays active.
                </p>
              </div>
              <DenButton
                variant="destructive"
                size="sm"
                icon={Trash2}
                onClick={() => setConfirmOpen(true)}
                loading={removeMutation.isPending}
              >
                Remove
              </DenButton>
            </div>
            {removeMutation.error ? (
              <div className="border-t border-red-100 bg-red-50 px-5 py-2 text-[12px] text-red-700">
                {removeMutation.error instanceof Error ? removeMutation.error.message : "Failed to remove this repository."}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <RemoveRepositoryConfirmDialog
        open={confirmOpen}
        repoName={repoName}
        pluginCount={configuration.configuredPlugins.length}
        configObjectCount={configuration.importedConfigObjectCount}
        busy={removeMutation.isPending}
        onClose={() => {
          if (!removeMutation.isPending) setConfirmOpen(false);
        }}
        onConfirm={() => {
          void handleRemove();
          setConfirmOpen(false);
        }}
      />
    </DashboardPageTemplate>
  );
}

const COMPONENT_TYPE_LABELS: Record<string, { singular: string; plural: string }> = {
  skill: { singular: "skill", plural: "skills" },
  agent: { singular: "agent", plural: "agents" },
  command: { singular: "command", plural: "commands" },
  hook: { singular: "hook", plural: "hooks" },
  mcp: { singular: "MCP server", plural: "MCP servers" },
  mcp_server: { singular: "MCP server", plural: "MCP servers" },
  lsp_server: { singular: "LSP server", plural: "LSP servers" },
  monitor: { singular: "monitor", plural: "monitors" },
  settings: { singular: "setting", plural: "settings" },
};

function formatComponentCount(type: string, count: number) {
  const label = COMPONENT_TYPE_LABELS[type] ?? {
    singular: type.replace(/_/g, " "),
    plural: `${type.replace(/_/g, " ")}s`,
  };
  return `${count} ${count === 1 ? label.singular : label.plural}`;
}

function PluginListItem({ plugin }: {
  plugin: {
    id: string;
    name: string;
    description: string | null;
    componentCounts: Record<string, number>;
    rootPath: string | null;
  };
}) {
  const orderedCountEntries = Object.entries(plugin.componentCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const repoPath = plugin.rootPath === null
    ? null
    : plugin.rootPath === ""
      ? "/"
      : plugin.rootPath;

  return (
    <article className="group overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]">
      <div className="flex items-stretch">
        <div className="relative w-[72px] shrink-0 overflow-hidden">
          <div className="absolute inset-0">
            <PaperMeshGradient seed={plugin.id} speed={0} />
          </div>
          <div className="relative flex h-full items-center justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-white/60 bg-white shadow-[0_8px_20px_-8px_rgba(15,23,42,0.3)]">
              <Puzzle className="h-4.5 w-4.5 text-gray-700" aria-hidden />
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-semibold tracking-[-0.02em] text-gray-900">
                {plugin.name}
              </h3>
              {plugin.description ? (
                <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.55] text-gray-500">
                  {plugin.description}
                </p>
              ) : null}
            </div>
            {repoPath ? (
              <code className="shrink-0 rounded-md bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-500">
                {repoPath}
              </code>
            ) : null}
          </div>

          {orderedCountEntries.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-50 pt-3">
              {orderedCountEntries.map(([type, count]) => (
                <span
                  key={type}
                  className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2.5 py-0.5 text-[11.5px] text-gray-600"
                >
                  <span className="font-semibold text-gray-900">{count}</span>
                  <span className="text-gray-500">
                    {formatComponentCount(type, count).replace(`${count} `, "")}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function Toggle({
  checked,
  busy,
  onChange,
}: {
  checked: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-[42px] shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-[#0f172a]" : "bg-gray-200"
      } ${busy ? "opacity-60" : ""} focus:outline-none focus:ring-2 focus:ring-[#0f172a]/20 focus:ring-offset-2`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-[0_2px_6px_-1px_rgba(15,23,42,0.3)] transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function RemoveRepositoryConfirmDialog({
  open,
  repoName,
  pluginCount,
  configObjectCount,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  repoName: string;
  pluginCount: number;
  configObjectCount: number;
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
              Remove {repoName}?
            </h2>
            <p className="mt-1 text-[13px] leading-6 text-gray-600">
              This will delete everything OpenWork imported from this repository, including:
            </p>
            <ul className="mt-3 space-y-1.5 text-[13px] leading-6 text-gray-600">
              <li className="flex gap-2">
                <span className="text-gray-400">•</span>
                <span>
                  <strong>{pluginCount}</strong> imported plugin{pluginCount === 1 ? "" : "s"}
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-gray-400">•</span>
                <span>
                  <strong>{configObjectCount}</strong> imported config object{configObjectCount === 1 ? "" : "s"} and all their versions
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-gray-400">•</span>
                <span>Connector mappings, source bindings, and sync history for this repository</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gray-400">•</span>
                <span>Any marketplace that was created solely from this repository and is now empty</span>
              </li>
            </ul>
            <p className="mt-3 text-[12px] leading-5 text-gray-500">
              The GitHub connection itself stays active. You can re-add this repository later from the Integrations page.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </DenButton>
          <DenButton variant="destructive" icon={Trash2} loading={busy} onClick={onConfirm}>
            Remove repository
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function GithubConnectedAccountSelectionPhase({ connectorAccountId }: { connectorAccountId: string }) {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const { data: connections = [] } = useIntegrations();
  const repositoriesQuery = useGithubAccountRepositories(connectorAccountId);
  const connectMutation = useCreateGithubConnectorInstance();
  const [query, setQuery] = useState("");
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);

  const connection = connections.find((entry) => entry.provider === "github" && entry.account.id === connectorAccountId) ?? null;
  const configuredByFullName = new Map(
    (connection?.repos ?? [])
      .filter((entry) => entry.connectorInstanceId)
      .map((entry) => [entry.fullName, entry.connectorInstanceId as string]),
  );
  const allRepos = repositoriesQuery.data ?? [];
  const unconfiguredRepos = allRepos.filter((repo) => !configuredByFullName.has(repo.fullName));
  const filteredRepos = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const base = !normalized
      ? allRepos
      : allRepos.filter((repository) =>
          `${repository.fullName}\n${repository.description}`.toLowerCase().includes(normalized),
        );

    const priority = (repository: IntegrationRepo): number => {
      if (configuredByFullName.has(repository.fullName)) return 0;
      if (repository.manifestKind) return 1;
      return 2;
    };

    return [...base].sort((left, right) => {
      const diff = priority(left) - priority(right);
      if (diff !== 0) return diff;
      return left.fullName.localeCompare(right.fullName);
    });
  }, [allRepos, configuredByFullName, query]);
  const selectedRepo = unconfiguredRepos.find((repo) => repo.id === selectedRepoId) ?? null;

  async function handleConnectRepo() {
    if (!connection?.account.installationId || !selectedRepo || !selectedRepo.defaultBranch) {
      return;
    }

    const repositoryId = Number(selectedRepo.id);
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
      return;
    }

    const result = await connectMutation.mutateAsync({
      branch: selectedRepo.defaultBranch,
      connectorAccountId,
      connectorInstanceName: selectedRepo.fullName,
      installationId: connection.account.installationId,
      repositoryFullName: selectedRepo.fullName,
      repositoryId,
    });
    router.replace(`${getGithubIntegrationRoute(orgSlug)}?connectorInstanceId=${encodeURIComponent(result.connectorInstanceId)}`);
  }

  const accessLabel = connection?.account.repositorySelection === "selected"
    ? "Only selected"
    : "All repositories";
  const ownerLogin = connection?.account.ownerName ?? connection?.account.name ?? null;
  const totalReadable = allRepos.length;

  return (
    <DashboardPageTemplate
      icon={Github}
      badgeLabel="GitHub"
      title="Add a repository"
      description={ownerLogin
        ? `Pick one of the repositories the @${ownerLogin} installation can already read.`
        : "Pick one of the repositories this GitHub installation can already read."}
      colors={["#E2E8F0", "#0F172A", "#111827", "#94A3B8"]}
    >
      <div className="mb-6 flex items-center justify-between gap-3">
        <Link
          href={getIntegrationsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        {ownerLogin ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-100 bg-white px-3 py-1 text-[12px] font-medium text-gray-600">
            <Github className="h-3.5 w-3.5 text-gray-500" aria-hidden />
            @{ownerLogin}
          </span>
        ) : null}
      </div>

      {repositoriesQuery.isLoading ? (
        <StatePanel
          title="Loading repositories"
          body="OpenWork is checking which repositories this GitHub installation can already read."
        />
      ) : repositoriesQuery.error ? (
        <StatePanel
          title="Could not load repositories"
          body={repositoriesQuery.error instanceof Error ? repositoriesQuery.error.message : "GitHub repositories could not be loaded."}
        />
      ) : !connection ? (
        <StatePanel
          title="Connector account not found"
          body="OpenWork could not find that connected GitHub account. Return to Integrations and reconnect if needed."
        />
      ) : (
        <div className="space-y-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              Repositories
            </h2>
            <div className="flex items-center gap-2 text-[11px] text-gray-400">
              <span>{unconfiguredRepos.length} unconfigured</span>
              <span className="text-gray-300">·</span>
              <span>{totalReadable} readable</span>
              <span className="text-gray-300">·</span>
              <span>{accessLabel}</span>
            </div>
          </div>

          {allRepos.length > 0 ? (
            <>
              <DenInput
                type="search"
                icon={Search}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search repositories"
              />

              {filteredRepos.length > 0 ? (
                <div className="grid gap-2">
                  {filteredRepos.map((repository) => {
                    const configuredInstanceId = configuredByFullName.get(repository.fullName) ?? null;
                    return (
                      <RepositoryCard
                        key={repository.id}
                        fullName={repository.fullName}
                        defaultBranch={repository.defaultBranch ?? null}
                        manifestKind={repository.manifestKind ?? null}
                        marketplacePluginCount={repository.marketplacePluginCount ?? null}
                        configuredInstanceId={configuredInstanceId}
                        configuredHref={configuredInstanceId ? `${getGithubIntegrationRoute(orgSlug)}?connectorInstanceId=${encodeURIComponent(configuredInstanceId)}` : null}
                        selected={!configuredInstanceId && selectedRepoId === repository.id}
                        onSelect={() => {
                          if (!configuredInstanceId) setSelectedRepoId(repository.id);
                        }}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
                  <p className="text-[14px] font-medium tracking-[-0.02em] text-gray-800">
                    No repositories matched your search
                  </p>
                  <p className="mx-auto mt-2 max-w-[360px] text-[13px] leading-6 text-gray-400">
                    Try a different search term, or pick from the list above.
                  </p>
                </div>
              )}

              {selectedRepo ? (
                <div className="flex flex-col-reverse items-stretch justify-between gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold tracking-[-0.01em] text-gray-900">
                      {selectedRepo.fullName}
                    </p>
                    <p className="truncate text-[11.5px] text-gray-500">
                      <GitBranch className="mr-1 inline h-3 w-3 text-gray-400" aria-hidden />
                      {selectedRepo.defaultBranch ?? "Default branch unavailable"}
                    </p>
                  </div>
                  <DenButton
                    disabled={!selectedRepo.defaultBranch}
                    loading={connectMutation.isPending}
                    onClick={() => void handleConnectRepo()}
                  >
                    Start discovery
                  </DenButton>
                </div>
              ) : unconfiguredRepos.length > 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-4 py-3 text-[13px] text-gray-400">
                  Select a repository above to start discovery.
                </div>
              ) : null}
            </>
          ) : null}

          {unconfiguredRepos.length === 0 && allRepos.length > 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
              <p className="text-[14px] font-medium tracking-[-0.02em] text-gray-800">
                Nothing left to configure here
              </p>
              <p className="mx-auto mt-2 max-w-[420px] text-[13px] leading-6 text-gray-500">
                {connection.account.repositorySelection === "selected"
                  ? "This GitHub installation is limited to selected repositories, and OpenWork has already configured all of them."
                  : "This GitHub installation already has access to all repositories under this owner, and there are none unconfigured right now."}
              </p>
              {connection.account.repositorySelection === "selected" && connection.account.manageUrl ? (
                <a
                  href={connection.account.manageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`${buttonVariants({ variant: "primary", size: "sm" })} mt-5 inline-flex gap-2`}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Allow more repositories on GitHub
                </a>
              ) : null}
            </div>
          ) : null}

          {allRepos.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
              <p className="text-[14px] font-medium tracking-[-0.02em] text-gray-800">
                No repositories available
              </p>
              <p className="mx-auto mt-2 max-w-[420px] text-[13px] leading-6 text-gray-500">
                This GitHub installation has no repositories OpenWork can read right now.
              </p>
            </div>
          ) : null}

          {connectMutation.error ? (
            <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {connectMutation.error instanceof Error ? connectMutation.error.message : "Failed to create the connector instance."}
            </div>
          ) : null}
        </div>
      )}
    </DashboardPageTemplate>
  );
}

function manifestLabel(kind: "marketplace" | "plugin" | null, marketplacePluginCount: number | null): string | null {
  if (kind === "marketplace") {
    if (marketplacePluginCount && marketplacePluginCount > 1) {
      return `Claude Marketplace · ${marketplacePluginCount} plugins`;
    }
    return "Claude Marketplace Detected";
  }
  if (kind === "plugin") {
    return "Claude Plugin Detected";
  }
  return null;
}

function RepositoryCard({
  fullName,
  defaultBranch,
  manifestKind,
  marketplacePluginCount,
  configuredInstanceId,
  configuredHref,
  selected,
  onSelect,
}: {
  fullName: string;
  defaultBranch: string | null;
  manifestKind: "marketplace" | "plugin" | null;
  marketplacePluginCount: number | null;
  configuredInstanceId: string | null;
  configuredHref: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const badge = manifestLabel(manifestKind, marketplacePluginCount);
  const isConfigured = Boolean(configuredInstanceId);

  const innerContent = (
    <div className="flex items-stretch">
      <div className="relative w-[72px] shrink-0 overflow-hidden">
        <div className="absolute inset-0">
          <PaperMeshGradient seed={fullName} speed={0} />
        </div>
        <div className="relative flex h-full items-center justify-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-white/60 bg-white shadow-[0_8px_20px_-8px_rgba(15,23,42,0.3)]">
            <GitBranch className="h-4 w-4 text-gray-700" aria-hidden />
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-4 px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
              {fullName}
            </p>
            {isConfigured ? (
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-gray-600">
                Configured
              </span>
            ) : null}
            {badge ? (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-emerald-700">
                {badge}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-gray-500">
            {defaultBranch ? `${defaultBranch} branch` : "Default branch unavailable"}
          </p>
        </div>

        {isConfigured ? (
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 transition group-hover:bg-gray-100 group-hover:text-gray-900"
          >
            <Settings className="h-4 w-4" />
          </span>
        ) : (
          <span
            role="radio"
            aria-checked={selected}
            className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition ${
              selected
                ? "border-[#0f172a] bg-[#0f172a] text-white"
                : "border-gray-300 bg-white text-transparent group-hover:border-gray-500"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${selected ? "bg-white" : "bg-transparent"}`} />
          </span>
        )}
      </div>
    </div>
  );

  const baseClass = `group block w-full overflow-hidden rounded-2xl border text-left transition ${
    selected
      ? "border-[#0f172a] bg-white shadow-[0_8px_24px_-12px_rgba(15,23,42,0.2)]"
      : "border-gray-100 bg-white hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]"
  }`;

  if (isConfigured && configuredHref) {
    return (
      <Link href={configuredHref} aria-label={`Configure ${fullName}`} className={baseClass}>
        {innerContent}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onSelect} className={baseClass}>
      {innerContent}
    </button>
  );
}

function GithubDiscoveryPhase({ connectorInstanceId, onBack }: { connectorInstanceId: string; onBack: () => void }) {
  const discoveryQuery = useGithubConnectorDiscovery(connectorInstanceId);
  const applyMutation = useApplyGithubDiscovery();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [autoImportNewPlugins, setAutoImportNewPlugins] = useState(true);

  useEffect(() => {
    if (!discoveryQuery.data) {
      return;
    }

    setSelectedKeys(
      discoveryQuery.data.discoveredPlugins
        .filter((plugin) => plugin.supported && plugin.selectedByDefault)
        .map((plugin) => plugin.key),
    );
    // Discovery is a fresh-intent operation: default the toggle ON each time
    // the user enters the flow, regardless of the previously saved value.
    setAutoImportNewPlugins(true);
  }, [discoveryQuery.data]);

  const selectedPlugins = (discoveryQuery.data?.discoveredPlugins ?? []).filter((plugin) => selectedKeys.includes(plugin.key));

  async function handleApply() {
    const result = await applyMutation.mutateAsync({
      autoImportNewPlugins,
      connectorInstanceId,
      selectedKeys,
    });

    if (result.createdPluginNames.length === 0 && result.createdMappingCount === 0) {
      return;
    }
  }

  function toggleCandidate(key: string) {
    setSelectedKeys((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  }

  const repoName = discoveryQuery.data?.repositoryFullName ?? null;

  return (
    <DashboardPageTemplate
      icon={Sparkles}
      badgeLabel="Discovery"
      title={repoName ?? "Discover repository"}
      description="Pick which plugins OpenWork should import from this repository."
      colors={["#DBEAFE", "#0F172A", "#1D4ED8", "#BFDBFE"]}
    >
      <div className="mb-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        {discoveryQuery.data ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-100 bg-white px-3 py-1 text-[11px] font-medium text-gray-600">
            <GitBranch className="h-3 w-3 text-gray-400" aria-hidden />
            <code className="font-mono">{discoveryQuery.data.sourceRevisionRef.slice(0, 7)}</code>
          </span>
        ) : null}
      </div>

      {discoveryQuery.isLoading ? (
        <DiscoveryLoadingState />
      ) : discoveryQuery.error ? (
        <StatePanel
          title="Discovery failed"
          body={discoveryQuery.error instanceof Error ? discoveryQuery.error.message : "OpenWork could not inspect the connected repository."}
        />
      ) : applyMutation.isSuccess ? (
        <DiscoveryAppliedState
          createdPluginNames={applyMutation.data.createdPluginNames}
          createdMappingCount={applyMutation.data.createdMappingCount}
          materializedConfigObjectCount={applyMutation.data.materializedConfigObjectCount}
          onDone={onBack}
        />
      ) : discoveryQuery.data ? (
        <div className="space-y-5">
          {discoveryQuery.data.warnings.length > 0 ? (
            <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800">
              {discoveryQuery.data.warnings[0]}
            </div>
          ) : null}
          {discoveryQuery.data.treeSummary.truncated ? (
            <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800">
              GitHub truncated the tree response. Discovery is based on the paths GitHub returned so far.
            </div>
          ) : null}

          <div>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                Discovered plugins
              </h2>
              <p className="text-[11px] text-gray-400">
                {selectedPlugins.length} of {discoveryQuery.data.discoveredPlugins.length} selected
              </p>
            </div>

            <div className="mb-4 flex items-start justify-between gap-5 rounded-2xl border border-gray-100 bg-white px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
                  Auto-import new plugins
                </p>
                <p className="mt-1 text-[12.5px] leading-[1.6] text-gray-500">
                  When new plugin structures appear on future pushes, OpenWork will discover and import them automatically.
                </p>
              </div>
              <Toggle
                checked={autoImportNewPlugins}
                busy={false}
                onChange={(next) => setAutoImportNewPlugins(next)}
              />
            </div>

            {discoveryQuery.data.discoveredPlugins.length > 0 ? (
              <div className="grid gap-3">
                {discoveryQuery.data.discoveredPlugins.map((plugin) => (
                  <DiscoveredPluginCard
                    key={plugin.key}
                    plugin={plugin}
                    selected={selectedKeys.includes(plugin.key)}
                    onToggle={() => {
                      if (plugin.supported) toggleCandidate(plugin.key);
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
                <p className="text-[14px] font-medium tracking-[-0.02em] text-gray-800">
                  No Claude-compatible plugins detected
                </p>
                <p className="mx-auto mt-2 max-w-[440px] text-[13px] leading-6 text-gray-500">
                  OpenWork currently only supports Claude-compatible plugins and marketplaces. Add <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px]">.claude-plugin/marketplace.json</code> or <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px]">.claude-plugin/plugin.json</code> to this repository.
                </p>
              </div>
            )}
          </div>

          {discoveryQuery.data.discoveredPlugins.length > 0 ? (
            <div className="flex flex-col-reverse items-stretch justify-between gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 text-[12.5px] text-gray-500">
                {selectedPlugins.length === 0
                  ? "Select at least one plugin to import."
                  : `This will create ${selectedPlugins.length} plugin${selectedPlugins.length === 1 ? "" : "s"} and their mappings in OpenWork.`}
              </div>
              <DenButton
                disabled={selectedPlugins.length === 0}
                loading={applyMutation.isPending}
                onClick={() => void handleApply()}
              >
                Create plugins and mappings
              </DenButton>
            </div>
          ) : null}

          {applyMutation.error ? (
            <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {applyMutation.error instanceof Error ? applyMutation.error.message : "Failed to apply discovery results."}
            </div>
          ) : null}
        </div>
      ) : null}
    </DashboardPageTemplate>
  );
}

function DiscoveredPluginCard({
  plugin,
  selected,
  onToggle,
}: {
  plugin: {
    key: string;
    displayName: string;
    description: string | null;
    rootPath: string;
    sourceKind: string;
    supported: boolean;
    componentKinds: string[];
    warnings: string[];
  };
  selected: boolean;
  onToggle: () => void;
}) {
  const repoPath = plugin.rootPath === "" ? "/" : plugin.rootPath;

  const baseClass = `group block w-full overflow-hidden rounded-2xl border text-left transition ${
    !plugin.supported
      ? "cursor-not-allowed border-gray-100 bg-white opacity-70"
      : "border-gray-100 bg-white hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]"
  }`;

  return (
    <button type="button" onClick={onToggle} disabled={!plugin.supported} className={baseClass}>
      <div className="flex items-stretch">
        <div className="relative w-[72px] shrink-0 overflow-hidden">
          <div className="absolute inset-0">
            <PaperMeshGradient seed={plugin.key} speed={0} />
          </div>
          <div className="relative flex h-full items-center justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-white/60 bg-white shadow-[0_8px_20px_-8px_rgba(15,23,42,0.3)]">
              <Puzzle className="h-4 w-4 text-gray-700" aria-hidden />
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-[15px] font-semibold tracking-[-0.02em] text-gray-900">
                  {plugin.displayName}
                </h3>
                {!plugin.supported ? (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-amber-700">
                    Unsupported
                  </span>
                ) : null}
              </div>
              {plugin.description ? (
                <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.55] text-gray-500">
                  {plugin.description}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <code className="rounded-md bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-500">
                {repoPath}
              </code>
              <span
                role="checkbox"
                aria-checked={selected}
                aria-disabled={!plugin.supported}
                className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition ${
                  !plugin.supported
                    ? "border-gray-200 bg-gray-50 text-transparent"
                    : selected
                      ? "border-[#0f172a] bg-[#0f172a] text-white"
                      : "border-gray-300 bg-white text-transparent group-hover:border-gray-500"
                }`}
              >
                <svg viewBox="0 0 12 12" aria-hidden className="h-3 w-3">
                  <path
                    d="M2.5 6.2 4.8 8.4 9.5 3.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
          </div>

          {plugin.componentKinds.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-50 pt-3">
              {plugin.componentKinds.map((kind) => (
                <span
                  key={`${plugin.key}:${kind}`}
                  className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2.5 py-0.5 text-[11.5px] text-gray-600"
                >
                  {kind.replaceAll("_", " ")}
                </span>
              ))}
            </div>
          ) : null}

          {plugin.warnings.length > 0 ? (
            <p className="mt-2 text-[11.5px] text-amber-700">{plugin.warnings[0]}</p>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function DiscoveryAppliedState({
  createdPluginNames,
  createdMappingCount,
  materializedConfigObjectCount,
  onDone,
}: {
  createdPluginNames: string[];
  createdMappingCount: number;
  materializedConfigObjectCount: number;
  onDone: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-emerald-100 bg-white">
      <div className="flex items-start gap-4 px-6 py-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
          <CheckCircle2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-gray-950">
            Discovery applied
          </h2>
          <p className="mt-1 text-[12.5px] leading-[1.6] text-gray-500">
            OpenWork created <span className="font-semibold text-gray-900">{createdPluginNames.length}</span> plugin{createdPluginNames.length === 1 ? "" : "s"},{" "}
            <span className="font-semibold text-gray-900">{createdMappingCount}</span> mapping{createdMappingCount === 1 ? "" : "s"}, and{" "}
            <span className="font-semibold text-gray-900">{materializedConfigObjectCount}</span> imported config object{materializedConfigObjectCount === 1 ? "" : "s"}.
          </p>

          {createdPluginNames.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {createdPluginNames.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded-full bg-gray-50 px-2.5 py-0.5 text-[11.5px] text-gray-700"
                >
                  {name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex justify-end border-t border-gray-100 bg-gray-50/60 px-6 py-3">
        <DenButton onClick={onDone}>Return to integrations</DenButton>
      </div>
    </div>
  );
}

function DiscoveryLoadingState() {
  return (
    <section className="flex flex-col items-center justify-center rounded-2xl border border-gray-100 bg-white px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-white">
        <LoaderCircle className="h-6 w-6 animate-spin" aria-hidden />
      </div>
      <h2 className="mt-5 text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
        Discovering marketplaces and plugins in your repository
      </h2>
      <p className="mt-2 max-w-[460px] text-[13px] leading-[1.6] text-gray-500">
        OpenWork is scanning the repo for Claude-compatible plugin and marketplace manifests.
      </p>
    </section>
  );
}

function StatePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
      <p className="text-[14px] font-medium tracking-[-0.02em] text-gray-900">{title}</p>
      <p className="mx-auto mt-2 max-w-xl text-[13px] leading-6 text-gray-500">{body}</p>
    </div>
  );
}


