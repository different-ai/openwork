import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, PlugZap, RefreshCw, RotateCcw, Sparkles, Wrench } from "lucide-react";

import type { ScheduledJob } from "../../app/lib/tauri";
import {
  createOpenworkServerClient,
  type OpenworkAuditEntry,
  type OpenworkCommandItem,
  type OpenworkHubSkillItem,
  type OpenworkMcpItem,
  type OpenworkOpenCodeRouterBindingItem,
  type OpenworkOpenCodeRouterBindingsResult,
  type OpenworkOpenCodeRouterHealthSnapshot,
  type OpenworkPluginItem,
  type OpenworkSkillItem,
} from "../../app/lib/openwork-server";
import { formatRelativeTime } from "../../app/utils";
import { selectActiveWorkspace, selectServerHostLabel, selectWorkspaceScopeLabel, useOpenworkStore } from "../kernel/store";

type SettingsTab = "general" | "skills" | "extensions" | "automations" | "messaging" | "debug";

type ResourceState = {
  skills: OpenworkSkillItem[];
  hubSkills: OpenworkHubSkillItem[];
  plugins: OpenworkPluginItem[];
  mcp: OpenworkMcpItem[];
  commands: OpenworkCommandItem[];
  jobs: ScheduledJob[];
  routerHealth: OpenworkOpenCodeRouterHealthSnapshot | null;
  routerBindings: OpenworkOpenCodeRouterBindingItem[];
  audit: OpenworkAuditEntry[];
};

const EMPTY_RESOURCES: ResourceState = {
  skills: [],
  hubSkills: [],
  plugins: [],
  mcp: [],
  commands: [],
  jobs: [],
  routerHealth: null,
  routerBindings: [],
  audit: [],
};

const TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: "general", label: "General", description: "Connection, runtime, and workspace overview" },
  { id: "skills", label: "Skills", description: "Installed skills and hub install surface" },
  { id: "extensions", label: "Extensions", description: "Plugins, MCP servers, and commands" },
  { id: "automations", label: "Automations", description: "Scheduled jobs and recurring flows" },
  { id: "messaging", label: "Messaging", description: "OpenCode Router health and bindings" },
  { id: "debug", label: "Debug", description: "Audit trail and runtime logs" },
];

function DetailCard(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="ow-soft-card-quiet px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{props.label}</div>
      <div className="mt-2 text-lg font-semibold text-slate-900">{props.value}</div>
      {props.hint ? <div className="mt-2 text-sm leading-6 text-slate-500">{props.hint}</div> : null}
    </div>
  );
}

function EmptyPanel(props: { title: string; body: string }) {
  return (
    <div className="rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm leading-7 text-slate-500">
      <div className="font-medium text-slate-900">{props.title}</div>
      <div className="mt-2">{props.body}</div>
    </div>
  );
}

export function SettingsScreen() {
  const server = useOpenworkStore((state) => state.server);
  const workspaces = useOpenworkStore((state) => state.workspaces);
  const workspacesStatus = useOpenworkStore((state) => state.workspacesStatus);
  const refreshServer = useOpenworkStore((state) => state.refreshServer);
  const connectToServer = useOpenworkStore((state) => state.connectToServer);
  const activeWorkspace = useOpenworkStore(selectActiveWorkspace);
  const serverHost = useOpenworkStore(selectServerHostLabel);
  const logs = useOpenworkStore((state) => state.logs);

  const [url, setUrl] = useState(server.url);
  const [token, setToken] = useState(server.token);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [pluginSpec, setPluginSpec] = useState("");
  const [resources, setResources] = useState<ResourceState>(EMPTY_RESOURCES);
  const [loadingResources, setLoadingResources] = useState(false);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const supportsRouter = server.capabilities?.proxy?.opencodeRouter === true;

  useEffect(() => {
    setUrl(server.url);
    setToken(server.token);
  }, [server.token, server.url]);

  const workspaceId = activeWorkspace?.id ?? null;
  const serverClient = useMemo(() => {
    const baseUrl = server.url.trim();
    if (!baseUrl) return null;
    return createOpenworkServerClient({
      baseUrl,
      token: server.token.trim() || undefined,
    });
  }, [server.token, server.url]);

  const refreshResources = useCallback(async () => {
    if (!serverClient || !workspaceId) {
      setResources(EMPTY_RESOURCES);
      setResourceError(null);
      return;
    }

    setLoadingResources(true);
    setResourceError(null);

    const results = await Promise.allSettled([
      serverClient.listSkills(workspaceId, { includeGlobal: true }),
      serverClient.listHubSkills(),
      serverClient.listPlugins(workspaceId, { includeGlobal: true }),
      serverClient.listMcp(workspaceId),
      serverClient.listCommands(workspaceId),
      serverClient.listScheduledJobs(workspaceId),
      supportsRouter ? serverClient.getOpenCodeRouterHealth(workspaceId) : Promise.resolve(null),
      supportsRouter ? serverClient.getOpenCodeRouterBindings(workspaceId) : Promise.resolve({ items: [] as OpenworkOpenCodeRouterBindingsResult["items"] }),
      serverClient.listAudit(workspaceId, 20),
    ]);

    const failures = results.filter((result, index) => index !== 6 && index !== 7 && result.status === "rejected") as Array<PromiseRejectedResult>;

    const skillsResult = results[0].status === "fulfilled" ? results[0].value : { items: [] as OpenworkSkillItem[] };
    const hubSkillsResult = results[1].status === "fulfilled" ? results[1].value : { items: [] as OpenworkHubSkillItem[] };
    const pluginsResult = results[2].status === "fulfilled" ? results[2].value : { items: [] as OpenworkPluginItem[] };
    const mcpResult = results[3].status === "fulfilled" ? results[3].value : { items: [] as OpenworkMcpItem[] };
    const commandsResult = results[4].status === "fulfilled" ? results[4].value : { items: [] as OpenworkCommandItem[] };
    const jobsResult = results[5].status === "fulfilled" ? results[5].value : { items: [] as ScheduledJob[] };
    const routerHealthResult = supportsRouter && results[6].status === "fulfilled" && results[6].value ? results[6].value.json : null;
    const bindingsResult = results[7].status === "fulfilled"
      ? results[7].value
      : { items: [] as OpenworkOpenCodeRouterBindingsResult["items"] };
    const auditResult = results[8].status === "fulfilled" ? results[8].value : { items: [] as OpenworkAuditEntry[] };

    setResources({
      skills: skillsResult.items ?? [],
      hubSkills: hubSkillsResult.items ?? [],
      plugins: pluginsResult.items ?? [],
      mcp: mcpResult.items ?? [],
      commands: commandsResult.items ?? [],
      jobs: jobsResult.items ?? [],
      routerHealth: routerHealthResult,
      routerBindings: bindingsResult.items ?? [],
      audit: auditResult.items ?? [],
    });

    if (failures.length > 0) {
      setResourceError(failures[0].reason instanceof Error ? failures[0].reason.message : String(failures[0].reason));
    }

    setLoadingResources(false);
  }, [serverClient, supportsRouter, workspaceId]);

  useEffect(() => {
    void refreshResources();
  }, [refreshResources]);

  const handleAddPlugin = async () => {
    if (!serverClient || !workspaceId || !pluginSpec.trim()) return;
    setLoadingResources(true);
    setResourceError(null);
    try {
      await serverClient.addPlugin(workspaceId, pluginSpec.trim());
      setPluginSpec("");
      await refreshResources();
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
      setLoadingResources(false);
    }
  };

  const handleRemovePlugin = async (name: string) => {
    if (!serverClient || !workspaceId) return;
    setLoadingResources(true);
    setResourceError(null);
    try {
      await serverClient.removePlugin(workspaceId, name);
      await refreshResources();
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
      setLoadingResources(false);
    }
  };

  const handleInstallSkill = async (name: string) => {
    if (!serverClient || !workspaceId) return;
    setLoadingResources(true);
    setResourceError(null);
    try {
      await serverClient.installHubSkill(workspaceId, name);
      await refreshResources();
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
      setLoadingResources(false);
    }
  };

  const handleReloadEngine = async () => {
    if (!serverClient || !workspaceId) return;
    setLoadingResources(true);
    setResourceError(null);
    try {
      await serverClient.reloadEngine(workspaceId);
      await refreshResources();
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
      setLoadingResources(false);
    }
  };

  const renderTab = () => {
    if (!activeWorkspace || !workspaceId) {
      return <EmptyPanel body="Choose a workspace to inspect skills, plugins, scheduler jobs, router state, and audit events." title="No workspace selected" />;
    }

    switch (activeTab) {
      case "general":
        return (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <DetailCard hint="Browser-facing OpenWork endpoint" label="Server" value={serverHost} />
              <DetailCard hint="Workspace registry from the OpenWork host" label="Workspaces" value={String(workspaces.length)} />
              <DetailCard hint="Capabilities exposed by the server" label="Capabilities" value={String(server.capabilities ? Object.keys(server.capabilities).length : 0)} />
              <DetailCard hint="Current active scope" label="Workspace" value={activeWorkspace.displayName || activeWorkspace.name} />
            </div>

            <div className="ow-soft-card-quiet px-4 py-4 text-sm leading-7 text-slate-600">
              <div className="font-medium text-slate-900">Workspace scope</div>
              <div className="mt-2">{selectWorkspaceScopeLabel(activeWorkspace)}</div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="ow-button-secondary" onClick={() => void handleReloadEngine()} type="button">
                  <RotateCcw className="h-4 w-4" />
                  Reload engine
                </button>
                <button className="ow-button-secondary" onClick={() => void refreshResources()} type="button">
                  <RefreshCw className="h-4 w-4" />
                  Refresh workspace data
                </button>
              </div>
            </div>
          </div>
        );

      case "skills":
        return (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-3">
              <div className="ow-panel-heading">Installed skills</div>
              {resources.skills.length ? (
                resources.skills.map((skill) => (
                  <div className="ow-soft-card-quiet px-4 py-4" key={skill.path}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-slate-900">{skill.name}</div>
                        <div className="mt-1 text-sm leading-6 text-slate-500">{skill.description || skill.path}</div>
                      </div>
                      <span className="ow-status-pill ow-status-pill-neutral">{skill.scope}</span>
                    </div>
                    {skill.trigger ? <div className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-400">Trigger: {skill.trigger}</div> : null}
                  </div>
                ))
              ) : (
                <EmptyPanel body="This workspace does not currently expose any installed skills through the server API." title="No installed skills" />
              )}
            </div>

            <div className="space-y-3">
              <div className="ow-panel-heading">Skill hub</div>
              {resources.hubSkills.length ? (
                resources.hubSkills.slice(0, 12).map((skill) => (
                  <div className="ow-soft-card-quiet px-4 py-4" key={`${skill.source.owner}/${skill.source.repo}/${skill.name}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-slate-900">{skill.name}</div>
                        <div className="mt-1 text-sm leading-6 text-slate-500">{skill.description}</div>
                        <div className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-400">
                          {skill.source.owner}/{skill.source.repo}@{skill.source.ref}
                        </div>
                      </div>
                      <button className="ow-button-secondary" onClick={() => void handleInstallSkill(skill.name)} type="button">
                        Install
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <EmptyPanel body="The skill hub list could not be loaded or is empty for the current repo source." title="No hub skills" />
              )}
            </div>
          </div>
        );

      case "extensions":
        return (
          <div className="space-y-4">
            <div className="ow-soft-card-quiet px-4 py-4">
              <div className="ow-panel-heading">Plugins</div>
              <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
                <input className="ow-input" onChange={(event) => setPluginSpec(event.target.value)} placeholder="npm package or plugin spec" value={pluginSpec} />
                <button className="ow-button-secondary" onClick={() => void handleAddPlugin()} type="button">
                  Add plugin
                </button>
              </div>
              <div className="mt-4 space-y-2">
                {resources.plugins.length ? resources.plugins.map((plugin) => (
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3" key={`${plugin.scope}:${plugin.spec}`}>
                    <div>
                      <div className="font-medium text-slate-900">{plugin.spec}</div>
                      <div className="mt-1 text-sm text-slate-500">{plugin.source} · {plugin.scope}</div>
                    </div>
                    <button className="ow-button-secondary" onClick={() => void handleRemovePlugin(plugin.spec)} type="button">
                      Remove
                    </button>
                  </div>
                )) : <EmptyPanel body="No plugins are currently configured for this workspace." title="No plugins" />}
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="ow-soft-card-quiet px-4 py-4">
                <div className="ow-panel-heading">MCP servers</div>
                <div className="mt-4 space-y-2">
                  {resources.mcp.length ? resources.mcp.map((item) => (
                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3" key={item.name}>
                      <div className="font-medium text-slate-900">{item.name}</div>
                      <div className="mt-1 text-sm text-slate-500">{item.source}</div>
                    </div>
                  )) : <EmptyPanel body="No MCP servers are configured for this workspace." title="No MCP servers" />}
                </div>
              </div>

              <div className="ow-soft-card-quiet px-4 py-4">
                <div className="ow-panel-heading">Commands</div>
                <div className="mt-4 space-y-2">
                  {resources.commands.length ? resources.commands.map((command) => (
                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3" key={command.name}>
                      <div className="font-medium text-slate-900">/{command.name}</div>
                      <div className="mt-1 text-sm text-slate-500">{command.description || command.template}</div>
                    </div>
                  )) : <EmptyPanel body="No custom commands are available for this workspace." title="No commands" />}
                </div>
              </div>
            </div>
          </div>
        );

      case "automations":
        return resources.jobs.length ? (
          <div className="space-y-3">
            {resources.jobs.map((job) => (
              <div className="ow-soft-card-quiet px-4 py-4" key={job.slug}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-slate-900">{job.name}</div>
                    <div className="mt-1 text-sm leading-6 text-slate-500">{job.schedule}</div>
                  </div>
                  <span className="ow-status-pill ow-status-pill-neutral">{job.lastRunStatus || "never run"}</span>
                </div>
                <div className="mt-3 text-sm leading-6 text-slate-500">
                  {job.lastRunAt ? `Last run ${formatRelativeTime(new Date(job.lastRunAt).getTime())}` : "No runs recorded yet."}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyPanel body="No scheduled jobs are configured for this workspace yet." title="No automations" />
        );

      case "messaging":
        return (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="ow-soft-card-quiet px-4 py-4">
              <div className="ow-panel-heading">Router health</div>
              {resources.routerHealth ? (
                <div className="mt-4 space-y-3 text-sm text-slate-600">
                  <DetailCard hint="OpenCode endpoint seen by the router" label="OpenCode" value={resources.routerHealth.opencode.url} />
                  <DetailCard hint="Healthy channel count" label="Healthy channels" value={String(Object.values(resources.routerHealth.channels).filter(Boolean).length)} />
                  <DetailCard hint="Group messaging mode" label="Groups" value={resources.routerHealth.config.groupsEnabled ? "Enabled" : "Disabled"} />
                </div>
              ) : (
                <EmptyPanel body="OpenCode Router health could not be loaded for the active workspace." title="No messaging health" />
              )}
            </div>

            <div className="ow-soft-card-quiet px-4 py-4">
              <div className="ow-panel-heading">Bindings</div>
              <div className="mt-4 space-y-2">
                {resources.routerBindings.length ? resources.routerBindings.map((binding) => (
                  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3" key={`${binding.channel}:${binding.peerId}:${binding.identityId}`}>
                    <div className="font-medium text-slate-900">{binding.channel} · {binding.peerId}</div>
                    <div className="mt-1 text-sm text-slate-500">identity {binding.identityId} · {binding.directory || "no directory"}</div>
                  </div>
                )) : <EmptyPanel body="No router bindings are currently configured." title="No bindings" />}
              </div>
            </div>
          </div>
        );

      case "debug":
        return (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="ow-soft-card-quiet px-4 py-4">
              <div className="ow-panel-heading">Audit trail</div>
              <div className="mt-4 space-y-2">
                {resources.audit.length ? resources.audit.map((entry) => (
                  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3" key={entry.id}>
                    <div className="font-medium text-slate-900">{entry.summary}</div>
                    <div className="mt-1 text-sm text-slate-500">{entry.action} · {entry.target}</div>
                    <div className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">{formatRelativeTime(entry.timestamp)}</div>
                  </div>
                )) : <EmptyPanel body="No audit entries are available yet for this workspace." title="No audit events" />}
              </div>
            </div>

            <div className="ow-soft-card-quiet px-4 py-4">
              <div className="ow-panel-heading">Client logs</div>
              <div className="mt-4 space-y-2">
                {logs.length ? logs.map((line, index) => (
                  <pre className="overflow-x-auto rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs leading-6 text-slate-600" key={`${line}-${index}`}>
                    {line}
                  </pre>
                )) : <EmptyPanel body="No client-side issues have been captured in the rewrite session yet." title="No logs" />}
              </div>
            </div>
          </div>
        );
    }
  };

  return (
    <section className="space-y-4">
      <div className="ow-soft-shell px-5 py-5 lg:px-6 lg:py-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="ow-kicker">
              <Sparkles className="h-3.5 w-3.5" />
              OpenWork controls
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">Server, skills, extensions, and automations</h1>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                This React settings surface now reaches beyond connection setup and exposes the core OpenWork capability buckets that the earlier rewrite skipped.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="ow-button-secondary" onClick={() => void refreshServer()} type="button">
              <RefreshCw className="h-4 w-4" />
              Re-check server
            </button>
            <button className="ow-button-secondary" onClick={() => void refreshResources()} type="button">
              <Wrench className="h-4 w-4" />
              Refresh workspace data
            </button>
          </div>
        </div>

        <form
          className="mt-6 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void connectToServer({ url, token });
          }}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="space-y-2 text-sm text-slate-700" htmlFor="openwork-server-url">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Server URL</span>
              <input className="ow-input" id="openwork-server-url" name="openworkServerUrl" onChange={(event) => setUrl(event.target.value)} placeholder="http://localhost:8787" value={url} />
            </label>
            <label className="space-y-2 text-sm text-slate-700" htmlFor="openwork-server-token">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Client token</span>
              <input className="ow-input" id="openwork-server-token" name="openworkServerToken" onChange={(event) => setToken(event.target.value)} placeholder="paste the OpenWork client token" value={token} />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="ow-button-primary" type="submit">
              <PlugZap className="h-4 w-4" />
              Connect
            </button>
            <span className={server.status === "connected" ? "ow-status-pill ow-status-pill-positive" : "ow-status-pill ow-status-pill-neutral"}>{server.status}</span>
            <span className="ow-status-pill ow-status-pill-neutral">{server.version ? `v${server.version}` : "version pending"}</span>
            <span className="ow-status-pill ow-status-pill-neutral">{workspacesStatus}</span>
          </div>
        </form>
      </div>

      {resourceError ? (
        <div className="rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {resourceError}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="ow-soft-shell overflow-hidden px-3 py-3">
          <div className="space-y-2">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button className={active ? "ow-settings-tab ow-settings-tab-active" : "ow-settings-tab"} key={tab.id} onClick={() => setActiveTab(tab.id)} type="button">
                  <div className="font-medium text-slate-900">{tab.label}</div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">{tab.description}</div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-7 text-slate-600">
            {activeWorkspace ? (
              <>
                <div className="flex items-center gap-2 font-medium text-slate-900">
                  <Check className="h-4 w-4 text-emerald-600" />
                  {activeWorkspace.displayName || activeWorkspace.name}
                </div>
                <div className="mt-2">{selectWorkspaceScopeLabel(activeWorkspace)}</div>
              </>
            ) : (
              <div>No active workspace selected yet.</div>
            )}
          </div>
        </aside>

        <div className="space-y-4">
          {loadingResources ? (
            <div className="ow-soft-shell flex items-center gap-3 px-4 py-4 text-sm text-slate-600">
              <LoaderState />
              Loading workspace capability data...
            </div>
          ) : null}
          {renderTab()}
        </div>
      </div>
    </section>
  );
}

function LoaderState() {
  return <RefreshCw className="h-4 w-4 animate-spin" />;
}
