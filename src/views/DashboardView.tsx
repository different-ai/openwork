import { For, Match, Show, Switch, createEffect, createMemo } from "solid-js";
import type { CuratedPackage, DashboardTab, PluginScope, SkillCard, WorkspaceTemplate } from "../app/types";
import type { WorkspaceInfo } from "../lib/tauri";
import { formatBytes, formatRelativeTime, isTauriRuntime } from "../app/utils";

import Button from "../components/Button";
import CreateWorkspaceModal from "../components/CreateWorkspaceModal";
import OpenWorkLogo from "../components/OpenWorkLogo";
import TextInput from "../components/TextInput";
import WorkspaceChip from "../components/WorkspaceChip";
import WorkspacePicker from "../components/WorkspacePicker";
import {
  Command,
  Cpu,
  FileText,
  HardDrive,
  Package,
  Play,
  Plus,
  RefreshCcw,
  Shield,
  Smartphone,
  Trash2,
  Upload,
} from "lucide-solid";

export type DashboardViewProps = {
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  view: "dashboard" | "session" | "onboarding";
  setView: (view: "dashboard" | "session" | "onboarding") => void;
  mode: "host" | "client" | null;
  baseUrl: string;
  clientConnected: boolean;
  busy: boolean;
  busyHint: string | null;
  busyLabel: string | null;
  newTaskDisabled: boolean;
  headerStatus: string;
  error: string | null;
  activeWorkspaceDisplay: WorkspaceInfo;
  workspaceSearch: string;
  setWorkspaceSearch: (value: string) => void;
  workspacePickerOpen: boolean;
  setWorkspacePickerOpen: (open: boolean) => void;
  workspaces: WorkspaceInfo[];
  filteredWorkspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  activateWorkspace: (id: string) => void;
  createWorkspaceOpen: boolean;
  setCreateWorkspaceOpen: (open: boolean) => void;
  createWorkspaceFlow: (preset: "starter" | "automation" | "minimal") => void;
  sessions: Array<{ id: string; slug?: string | null; title: string; time: { updated: number }; directory?: string | null }>;
  sessionStatusById: Record<string, string>;
  activeWorkspaceRoot: string;
  workspaceTemplates: WorkspaceTemplate[];
  globalTemplates: WorkspaceTemplate[];
  setTemplateDraftTitle: (value: string) => void;
  setTemplateDraftDescription: (value: string) => void;
  setTemplateDraftPrompt: (value: string) => void;
  setTemplateDraftScope: (value: "workspace" | "global") => void;
  openTemplateModal: () => void;
  resetTemplateDraft?: (scope?: "workspace" | "global") => void;
  runTemplate: (template: WorkspaceTemplate) => void;
  deleteTemplate: (templateId: string) => void;
  refreshSkills: () => void;
  refreshPlugins: (scopeOverride?: PluginScope) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  openPackageSource: string;
  setOpenPackageSource: (value: string) => void;
  installFromOpenPackage: () => void;
  importLocalSkill: () => void;
  packageSearch: string;
  setPackageSearch: (value: string) => void;
  filteredPackages: CuratedPackage[];
  useCuratedPackage: (pkg: CuratedPackage) => void;
  pluginScope: PluginScope;
  setPluginScope: (scope: PluginScope) => void;
  pluginConfigPath: string | null;
  pluginList: string[];
  pluginInput: string;
  setPluginInput: (value: string) => void;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  setActivePluginGuide: (value: string | null) => void;
  isPluginInstalled: (name: string, aliases?: string[]) => boolean;
  suggestedPlugins: Array<{
    name: string;
    packageName: string;
    description: string;
    tags: string[];
    aliases?: string[];
    installMode?: "simple" | "guided";
    steps?: Array<{
      title: string;
      description: string;
      command?: string;
      url?: string;
      path?: string;
      note?: string;
    }>;
  }>;
  addPlugin: (pluginNameOverride?: string) => void;
  createSessionAndOpen: () => void;
  selectSession: (sessionId: string) => Promise<void> | void;
  defaultModelLabel: string;
  defaultModelRef: string;
  openDefaultModelPicker: () => void;
  showThinking: boolean;
  toggleShowThinking: () => void;
  modelVariantLabel: string;
  editModelVariant: () => void;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateStatus: {
    state: string;
    lastCheckedAt?: number | null;
    version?: string;
    date?: string;
    notes?: string;
    totalBytes?: number | null;
    downloadedBytes?: number;
    message?: string;
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  appVersion: string | null;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdateAndRestart: () => void;
  anyActiveRuns: boolean;
  engineSource: "path" | "sidecar";
  setEngineSource: (value: "path" | "sidecar") => void;
  isWindows: boolean;
  toggleDeveloperMode: () => void;
  developerMode: boolean;
  stopHost: () => void;
  openResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  onResetStartupPreference: () => void;
  pendingPermissions: unknown;
  events: unknown;
  safeStringify: (value: unknown) => string;
};

export default function DashboardView(props: DashboardViewProps) {
  const title = createMemo(() => {
    switch (props.tab) {
      case "sessions":
        return "Sessions";
      case "templates":
        return "Templates";
      case "skills":
        return "Skills";
      case "plugins":
        return "Plugins";
      case "settings":
        return "Settings";
      default:
        return "Dashboard";
    }
  });

  const quickTemplates = createMemo(() => props.workspaceTemplates.slice(0, 3));

  createEffect(() => {
    if (props.tab === "skills") {
      props.refreshSkills();
    }
    if (props.tab === "plugins") {
      props.refreshPlugins();
    }

    if (props.tab === "sessions" || props.view === "session") {
      props.refreshSkills();
      props.refreshPlugins("project");
    }
  });

  const navItem = (t: DashboardTab, label: string, icon: any) => {
    const active = () => props.tab === t;
    return (
      <button
        class={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
          active() ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-white hover:bg-zinc-900/50"
        }`}
        onClick={() => props.setTab(t)}
      >
        {icon}
        {label}
      </button>
    );
  };

  const updateState = () => props.updateStatus?.state ?? "idle";
  const updateNotes = () => props.updateStatus?.notes ?? null;
  const updateVersion = () => props.updateStatus?.version ?? null;
  const updateDate = () => props.updateStatus?.date ?? null;
  const updateLastCheckedAt = () => props.updateStatus?.lastCheckedAt ?? null;
  const updateDownloadedBytes = () => props.updateStatus?.downloadedBytes ?? null;
  const updateTotalBytes = () => props.updateStatus?.totalBytes ?? null;
  const updateErrorMessage = () => props.updateStatus?.message ?? null;

  return (
    <div class="flex h-screen bg-zinc-950 text-white overflow-hidden">
      <aside class="w-64 border-r border-zinc-800 p-6 hidden md:flex flex-col justify-between bg-zinc-950">
        <div>
          <div class="flex items-center gap-3 mb-10 px-2">
            <div class="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
              <OpenWorkLogo size={18} class="text-black" />
            </div>
            <span class="font-bold text-lg tracking-tight">OpenWork</span>
          </div>

          <nav class="space-y-1">
            {navItem("home", "Dashboard", <Command size={18} />)}
            {navItem("sessions", "Sessions", <Play size={18} />)}
            {navItem("templates", "Templates", <FileText size={18} />)}
            {navItem("skills", "Skills", <Package size={18} />)}
            {navItem("plugins", "Plugins", <Cpu size={18} />)}
            {navItem("settings", "Settings", <Shield size={18} />)}
          </nav>
        </div>

        <div class="space-y-4">
          <div class="px-3 py-3 rounded-xl bg-zinc-900/50 border border-zinc-800">
            <div class="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
              {props.mode === "host" ? <Cpu size={12} /> : <Smartphone size={12} />}
              {props.mode === "host" ? "Local Engine" : "Client Mode"}
            </div>
            <div class="flex items-center gap-2">
              <div
                class={`w-2 h-2 rounded-full ${
                  props.clientConnected ? "bg-emerald-500 animate-pulse" : "bg-zinc-600"
                }`}
              />
              <span
                class={`text-sm font-mono ${props.clientConnected ? "text-emerald-500" : "text-zinc-500"}`}
              >
                {props.clientConnected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <div class="mt-2 text-[11px] text-zinc-600 font-mono truncate">{props.baseUrl}</div>
          </div>

          <Show when={props.mode === "host"}>
            <Button variant="danger" onClick={props.stopHost} disabled={props.busy} class="w-full">
              Stop & Disconnect
            </Button>
          </Show>

          <Show when={props.mode === "client"}>
            <Button variant="outline" onClick={props.stopHost} disabled={props.busy} class="w-full">
              Disconnect
            </Button>
          </Show>
        </div>
      </aside>

      <main class="flex-1 overflow-y-auto relative pb-24 md:pb-0">
        <header class="h-16 flex items-center justify-between px-6 md:px-10 border-b border-zinc-800 sticky top-0 bg-zinc-950/80 backdrop-blur-md z-10">
          <div class="flex items-center gap-3">
            <WorkspaceChip
              workspace={props.activeWorkspaceDisplay}
              onClick={() => {
                props.setWorkspaceSearch("");
                props.setWorkspacePickerOpen(true);
              }}
            />
            <h1 class="text-lg font-medium">{title()}</h1>
            <span class="text-xs text-zinc-600">{props.headerStatus}</span>
            <Show when={props.busyHint}>
              <span class="text-xs text-zinc-500">{props.busyHint}</span>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <Show when={props.tab === "home" || props.tab === "sessions"}>
              <Button
                onClick={props.createSessionAndOpen}
                disabled={props.newTaskDisabled}
                title={props.newTaskDisabled ? props.busyHint ?? "Busy" : ""}
              >
                <Play size={16} />
                New Task
              </Button>
            </Show>
            <Show when={props.tab === "templates"}>
              <Button
                variant="secondary"
                onClick={() => {
                    const reset = props.resetTemplateDraft;
                    if (reset) {
                      reset("workspace");
                    } else {
                      props.setTemplateDraftTitle("");
                      props.setTemplateDraftDescription("");
                      props.setTemplateDraftPrompt("");
                      props.setTemplateDraftScope("workspace");
                    }
                    props.openTemplateModal();

                }}
                disabled={props.busy}
              >
                <Plus size={16} />
                New
              </Button>
            </Show>
            <Button variant="ghost" onClick={props.toggleDeveloperMode}>
              <Shield size={16} />
            </Button>
          </div>
        </header>

        <div class="p-6 md:p-10 max-w-5xl mx-auto space-y-10">
          <Switch>
            <Match when={props.tab === "home"}>
              <section>
                <div class="bg-gradient-to-r from-zinc-900 to-zinc-800 rounded-3xl p-1 border border-zinc-800 shadow-2xl">
                  <div class="bg-zinc-950 rounded-[22px] p-6 md:p-8 flex flex-col md:flex-row items-center justify-between gap-6">
                    <div class="space-y-2 text-center md:text-left">
                      <h2 class="text-2xl font-semibold text-white">What should we do today?</h2>
                      <p class="text-zinc-400">
                        Describe an outcome. OpenWork will run it and keep an audit trail.
                      </p>
                    </div>
                    <Button
                      onClick={props.createSessionAndOpen}
                      disabled={props.newTaskDisabled}
                      title={props.newTaskDisabled ? props.busyHint ?? "Busy" : ""}
                      class="w-full md:w-auto py-3 px-6 text-base"
                    >
                      <Play size={18} />
                      New Task
                    </Button>
                  </div>
                </div>
              </section>

              <section>
                <div class="flex items-center justify-between mb-4">
                  <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider">Quick Start Templates</h3>
                  <button
                    class="text-sm text-zinc-500 hover:text-white"
                    onClick={() => props.setTab("templates")}
                  >
                    View all
                  </button>
                </div>

                <Show
                  when={quickTemplates().length}
                  fallback={
                    <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-6 text-sm text-zinc-500">
                      No templates yet. Starter templates will appear here.
                    </div>
                  }
                >
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <For each={quickTemplates()}>
                      {(t) => (
                        <button
                          onClick={() => props.runTemplate(t)}
                          class="group p-5 rounded-2xl bg-zinc-900/30 border border-zinc-800/50 hover:bg-zinc-900 hover:border-zinc-700 transition-all text-left"
                        >
                          <div class="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                            <FileText size={20} class="text-indigo-400" />
                          </div>
                          <h4 class="font-medium text-white mb-1">{t.title}</h4>
                          <p class="text-sm text-zinc-500">{t.description || "Run a saved workflow"}</p>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </section>

              <section>
                <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">Recent Sessions</h3>

                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl overflow-hidden">
                  <For each={props.sessions.slice(0, 12)}>
                    {(s, idx) => (
                      <button
                        class={`w-full p-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors text-left ${
                          idx() !== Math.min(props.sessions.length, 12) - 1 ? "border-b border-zinc-800/50" : ""
                        }`}
                        onClick={async () => {
                          await props.selectSession(s.id);
                          props.setView("session");
                          props.setTab("sessions");
                        }}
                      >
                        <div class="flex items-center gap-4">
                          <div class="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-500 font-mono">
                            #{s.slug?.slice(0, 2) ?? ".."}
                          </div>
                          <div>
                            <div class="font-medium text-sm text-zinc-200">{s.title}</div>
                            <div class="text-xs text-zinc-500 flex items-center gap-2">
                              <span class="flex items-center gap-1">{formatRelativeTime(s.time.updated)}</span>
                              <Show when={props.activeWorkspaceRoot && s.directory === props.activeWorkspaceRoot}>
                                <span class="text-[11px] px-2 py-0.5 rounded-full border border-zinc-700/60 text-zinc-500">
                                  this workspace
                                </span>
                              </Show>
                            </div>
                          </div>
                        </div>
                        <div class="flex items-center gap-4">
                          <span class="text-xs px-2 py-0.5 rounded-full border border-zinc-700/60 text-zinc-400 flex items-center gap-1.5">
                            <span class="w-1.5 h-1.5 rounded-full bg-current" />
                            {props.sessionStatusById[s.id] ?? "idle"}
                          </span>
                        </div>
                      </button>
                    )}
                  </For>

                  <Show when={!props.sessions.length}>
                    <div class="p-6 text-sm text-zinc-500">No sessions yet.</div>
                  </Show>
                </div>
              </section>
            </Match>

            <Match when={props.tab === "sessions"}>
              <section>
                <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">All Sessions</h3>

                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl overflow-hidden">
                  <For each={props.sessions}>
                    {(s, idx) => (
                      <button
                        class={`w-full p-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors text-left ${
                          idx() !== props.sessions.length - 1 ? "border-b border-zinc-800/50" : ""
                        }`}
                        onClick={async () => {
                          await props.selectSession(s.id);
                          props.setView("session");
                        }}
                      >
                        <div class="flex items-center gap-4">
                          <div class="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-500 font-mono">
                            #{s.slug?.slice(0, 2) ?? ".."}
                          </div>
                          <div>
                            <div class="font-medium text-sm text-zinc-200">{s.title}</div>
                            <div class="text-xs text-zinc-500 flex items-center gap-2">
                              <span class="flex items-center gap-1">{formatRelativeTime(s.time.updated)}</span>
                              <Show when={props.activeWorkspaceRoot && s.directory === props.activeWorkspaceRoot}>
                                <span class="text-[11px] px-2 py-0.5 rounded-full border border-zinc-700/60 text-zinc-500">
                                  this workspace
                                </span>
                              </Show>
                            </div>
                          </div>
                        </div>
                        <div class="flex items-center gap-4">
                          <span class="text-xs px-2 py-0.5 rounded-full border border-zinc-700/60 text-zinc-400 flex items-center gap-1.5">
                            <span class="w-1.5 h-1.5 rounded-full bg-current" />
                            {props.sessionStatusById[s.id] ?? "idle"}
                          </span>
                        </div>
                      </button>
                    )}
                  </For>

                  <Show when={!props.sessions.length}>
                    <div class="p-6 text-sm text-zinc-500">No sessions yet.</div>
                  </Show>
                </div>
              </section>
            </Match>

            <Match when={props.tab === "templates"}>
              <section class="space-y-4">
                <div class="flex items-center justify-between">
                  <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider">Templates</h3>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const reset = props.resetTemplateDraft;
                      if (reset) {
                        reset("workspace");
                      } else {
                        props.setTemplateDraftTitle("");
                        props.setTemplateDraftDescription("");
                        props.setTemplateDraftPrompt("");
                        props.setTemplateDraftScope("workspace");
                      }
                      props.openTemplateModal();
                    }}
                    disabled={props.busy}
                  >
                    <Plus size={16} />
                    New
                  </Button>
                </div>

                <Show
                  when={props.workspaceTemplates.length || props.globalTemplates.length}
                  fallback={
                    <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-6 text-sm text-zinc-500">
                      Starter templates will appear here. Create one or save from a session.
                    </div>
                  }
                >
                  <div class="space-y-6">
                    <Show when={props.workspaceTemplates.length}>
                      <div class="space-y-3">
                        <div class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Workspace</div>
                        <For each={props.workspaceTemplates}>
                          {(t) => (
                            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 flex items-start justify-between gap-4">
                              <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                  <FileText size={16} class="text-indigo-400" />
                                  <div class="font-medium text-white truncate">{t.title}</div>
                                </div>
                                <div class="mt-1 text-sm text-zinc-500">{t.description || ""}</div>
                                <div class="mt-2 text-xs text-zinc-600 font-mono">{formatRelativeTime(t.createdAt)}</div>
                              </div>
                              <div class="shrink-0 flex gap-2">
                                <Button variant="secondary" onClick={() => props.runTemplate(t)} disabled={props.busy}>
                                  <Play size={16} />
                                  Run
                                </Button>
                                <Button variant="danger" onClick={() => props.deleteTemplate(t.id)} disabled={props.busy}>
                                  <Trash2 size={16} />
                                </Button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={props.globalTemplates.length}>
                      <div class="space-y-3">
                        <div class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Global</div>
                        <For each={props.globalTemplates}>
                          {(t) => (
                            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 flex items-start justify-between gap-4">
                              <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                  <FileText size={16} class="text-emerald-400" />
                                  <div class="font-medium text-white truncate">{t.title}</div>
                                </div>
                                <div class="mt-1 text-sm text-zinc-500">{t.description || ""}</div>
                                <div class="mt-2 text-xs text-zinc-600 font-mono">{formatRelativeTime(t.createdAt)}</div>
                              </div>
                              <div class="shrink-0 flex gap-2">
                                <Button variant="secondary" onClick={() => props.runTemplate(t)} disabled={props.busy}>
                                  <Play size={16} />
                                  Run
                                </Button>
                                <Button variant="danger" onClick={() => props.deleteTemplate(t.id)} disabled={props.busy}>
                                  <Trash2 size={16} />
                                </Button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </section>
            </Match>

            <Match when={props.tab === "skills"}>
              <section class="space-y-6">
                <div class="flex items-center justify-between">
                  <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider">Skills</h3>
                  <Button variant="secondary" onClick={props.refreshSkills} disabled={props.busy}>
                    Refresh
                  </Button>
                </div>

                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-sm font-medium text-white">Install from OpenPackage</div>
                    <Show when={props.mode !== "host"}>
                      <div class="text-xs text-zinc-500">Host mode only</div>
                    </Show>
                  </div>
                  <div class="flex flex-col md:flex-row gap-2">
                    <input
                      class="w-full bg-zinc-900/50 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                      placeholder="github:anthropics/claude-code"
                      value={props.openPackageSource}
                      onInput={(e) => props.setOpenPackageSource(e.currentTarget.value)}
                    />
                    <Button
                      onClick={props.installFromOpenPackage}
                      disabled={props.busy || props.mode !== "host" || !isTauriRuntime()}
                      class="md:w-auto"
                    >
                      <Package size={16} />
                      Install
                    </Button>
                  </div>
                  <div class="text-xs text-zinc-500">
                    Installs OpenPackage packages into the current workspace. Skills should land in `.opencode/skill`.
                  </div>

                  <div class="flex items-center justify-between gap-3 pt-2 border-t border-zinc-800/60">
                    <div class="text-sm font-medium text-white">Import local skill</div>
                    <Button
                      variant="secondary"
                      onClick={props.importLocalSkill}
                      disabled={props.busy || props.mode !== "host" || !isTauriRuntime()}
                    >
                      <Upload size={16} />
                      Import
                    </Button>
                  </div>

                  <Show when={props.skillsStatus}>
                    <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-300 whitespace-pre-wrap break-words">
                      {props.skillsStatus}
                    </div>
                  </Show>
                </div>

                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
                  <div class="flex items-center justify-between">
                    <div class="text-sm font-medium text-white">Curated packages</div>
                    <div class="text-xs text-zinc-500">{props.filteredPackages.length}</div>
                  </div>

                  <input
                    class="w-full bg-zinc-900/50 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                    placeholder="Search packages or lists (e.g. claude, registry, community)"
                    value={props.packageSearch}
                    onInput={(e) => props.setPackageSearch(e.currentTarget.value)}
                  />

                  <Show
                    when={props.filteredPackages.length}
                    fallback={
                      <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-400">
                        No curated matches. Try a different search.
                      </div>
                    }
                  >
                    <div class="space-y-3">
                      <For each={props.filteredPackages}>
                        {(pkg) => (
                          <div class="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
                            <div class="flex items-start justify-between gap-4">
                              <div class="space-y-2">
                                <div class="text-sm font-medium text-white">{pkg.name}</div>
                                <div class="text-xs text-zinc-500 font-mono break-all">{pkg.source}</div>
                                <div class="text-sm text-zinc-500">{pkg.description}</div>
                                <div class="flex flex-wrap gap-2">
                                  <For each={pkg.tags}>
                                    {(tag) => (
                                      <span class="text-[10px] uppercase tracking-wide bg-zinc-800/70 text-zinc-400 px-2 py-0.5 rounded-full">
                                        {tag}
                                      </span>
                                    )}
                                  </For>
                                </div>
                              </div>
                              <Button
                                variant={pkg.installable ? "secondary" : "outline"}
                                onClick={() => props.useCuratedPackage(pkg)}
                                disabled={
                                  props.busy ||
                                  (pkg.installable && (props.mode !== "host" || !isTauriRuntime()))
                                }
                              >
                                {pkg.installable ? "Install" : "View"}
                              </Button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <div class="text-xs text-zinc-500">
                    Publishing to the OpenPackage registry (`opkg push`) requires authentication today. A registry search + curated list sync is planned.
                  </div>
                </div>

                <div>
                  <div class="flex items-center justify-between mb-3">
                    <div class="text-sm font-medium text-white">Installed skills</div>
                    <div class="text-xs text-zinc-500">{props.skills.length}</div>
                  </div>

                  <Show
                    when={props.skills.length}
                    fallback={
                      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-6 text-sm text-zinc-500">
                        No skills detected in `.opencode/skill`.
                      </div>
                    }
                  >
                    <div class="grid gap-3">
                      <For each={props.skills}>
                        {(s) => (
                          <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5">
                            <div class="flex items-center gap-2">
                              <Package size={16} class="text-zinc-400" />
                              <div class="font-medium text-white">{s.name}</div>
                            </div>
                            <Show when={s.description}>
                              <div class="mt-1 text-sm text-zinc-500">{s.description}</div>
                            </Show>
                            <div class="mt-2 text-xs text-zinc-600 font-mono">{s.path}</div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </section>
            </Match>

            <Match when={props.tab === "plugins"}>
              <section class="space-y-6">
                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
                  <div class="flex items-start justify-between gap-4">
                    <div class="space-y-1">
                      <div class="text-sm font-medium text-white">OpenCode plugins</div>
                      <div class="text-xs text-zinc-500">
                        Manage `opencode.json` for your project or global OpenCode plugins.
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                          props.pluginScope === "project"
                            ? "bg-white/10 text-white border-white/20"
                            : "text-zinc-500 border-zinc-800 hover:text-white"
                        }`}
                        onClick={() => {
                          props.setPluginScope("project");
                          props.refreshPlugins("project");
                        }}
                      >
                        Project
                      </button>
                      <button
                        class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                          props.pluginScope === "global"
                            ? "bg-white/10 text-white border-white/20"
                            : "text-zinc-500 border-zinc-800 hover:text-white"
                        }`}
                        onClick={() => {
                          props.setPluginScope("global");
                          props.refreshPlugins("global");
                        }}
                      >
                        Global
                      </button>
                      <Button variant="ghost" onClick={() => props.refreshPlugins()}>
                        Refresh
                      </Button>
                    </div>
                  </div>

                  <div class="flex flex-col gap-1 text-xs text-zinc-500">
                    <div>Config</div>
                    <div class="text-zinc-600 font-mono truncate">
                      {props.pluginConfigPath ?? "Not loaded yet"}
                    </div>
                  </div>

                  <div class="space-y-3">
                    <div class="text-xs font-medium text-zinc-400 uppercase tracking-wider">Suggested plugins</div>
                    <div class="grid gap-3">
                      <For each={props.suggestedPlugins}>
                        {(plugin) => {
                          const isGuided = () => plugin.installMode === "guided";
                          const isInstalled = () => props.isPluginInstalled(plugin.packageName, plugin.aliases ?? []);
                          const isGuideOpen = () => props.activePluginGuide === plugin.packageName;

                          return (
                            <div class="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 p-4 space-y-3">
                              <div class="flex items-start justify-between gap-4">
                                <div>
                                  <div class="text-sm font-medium text-white font-mono">{plugin.name}</div>
                                  <div class="text-xs text-zinc-500 mt-1">{plugin.description}</div>
                                  <Show when={plugin.packageName !== plugin.name}>
                                    <div class="text-xs text-zinc-600 font-mono mt-1">
                                      {plugin.packageName}
                                    </div>
                                  </Show>
                                </div>
                                <div class="flex items-center gap-2">
                                  <Show when={isGuided()}>
                                    <Button
                                      variant="ghost"
                                      onClick={() =>
                                        props.setActivePluginGuide(isGuideOpen() ? null : plugin.packageName)
                                      }
                                    >
                                      {isGuideOpen() ? "Hide setup" : "Setup"}
                                    </Button>
                                  </Show>
                                  <Button
                                    variant={isInstalled() ? "outline" : "secondary"}
                                    onClick={() => props.addPlugin(plugin.packageName)}
                                    disabled={
                                      props.busy ||
                                      isInstalled() ||
                                      !isTauriRuntime() ||
                                      (props.pluginScope === "project" && !props.activeWorkspaceRoot.trim())
                                    }
                                  >
                                    {isInstalled() ? "Added" : "Add"}
                                  </Button>
                                </div>
                              </div>
                              <div class="flex flex-wrap gap-2">
                                <For each={plugin.tags}>
                                  {(tag) => (
                                    <span class="text-[10px] uppercase tracking-wide bg-zinc-800/70 text-zinc-400 px-2 py-0.5 rounded-full">
                                      {tag}
                                    </span>
                                  )}
                                </For>
                              </div>
                              <Show when={isGuided() && isGuideOpen()}>
                                <div class="rounded-xl border border-zinc-800/70 bg-zinc-950/60 p-4 space-y-3">
                                  <For each={plugin.steps ?? []}>
                                    {(step, idx) => (
                                      <div class="space-y-1">
                                        <div class="text-xs font-medium text-zinc-300">
                                          {idx() + 1}. {step.title}
                                        </div>
                                        <div class="text-xs text-zinc-500">{step.description}</div>
                                        <Show when={step.command}>
                                          <div class="text-xs font-mono text-zinc-200 bg-zinc-900/60 border border-zinc-800/70 rounded-lg px-3 py-2">
                                            {step.command}
                                          </div>
                                        </Show>
                                        <Show when={step.note}>
                                          <div class="text-xs text-zinc-500">{step.note}</div>
                                        </Show>
                                        <Show when={step.url}>
                                          <div class="text-xs text-zinc-500">
                                            Open: <span class="font-mono text-zinc-400">{step.url}</span>
                                          </div>
                                        </Show>
                                        <Show when={step.path}>
                                          <div class="text-xs text-zinc-500">
                                            Path: <span class="font-mono text-zinc-400">{step.path}</span>
                                          </div>
                                        </Show>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>

                  <Show
                    when={props.pluginList.length}
                    fallback={
                      <div class="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-sm text-zinc-500">
                        No plugins configured yet.
                      </div>
                    }
                  >
                    <div class="grid gap-2">
                      <For each={props.pluginList}>
                        {(pluginName) => (
                          <div class="flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-2.5">
                            <div class="text-sm text-zinc-200 font-mono">{pluginName}</div>
                            <div class="text-[10px] uppercase tracking-wide text-zinc-500">Enabled</div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <div class="flex flex-col gap-3">
                    <div class="flex flex-col md:flex-row gap-3">
                      <div class="flex-1">
                        <TextInput
                          label="Add plugin"
                          placeholder="opencode-wakatime"
                          value={props.pluginInput}
                          onInput={(e) => props.setPluginInput(e.currentTarget.value)}
                          hint="Add npm package names, e.g. opencode-wakatime"
                        />
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() => props.addPlugin()}
                        disabled={props.busy || !props.pluginInput.trim()}
                        class="md:mt-6"
                      >
                        Add
                      </Button>
                    </div>
                    <Show when={props.pluginStatus}>
                      <div class="text-xs text-zinc-500">{props.pluginStatus}</div>
                    </Show>
                  </div>
                </div>
              </section>
            </Match>

            <Match when={props.tab === "settings"}>
              <section class="space-y-6">
                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
                  <div class="text-sm font-medium text-white">Connection</div>
                  <div class="text-xs text-zinc-500">{props.headerStatus}</div>
                  <div class="text-xs text-zinc-600 font-mono">{props.baseUrl}</div>
                  <div class="pt-2 flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={props.toggleDeveloperMode}>
                      <Shield size={16} />
                      {props.developerMode ? "Disable Developer Mode" : "Enable Developer Mode"}
                    </Button>
                    <Show when={props.mode === "host"}>
                      <Button variant="danger" onClick={props.stopHost} disabled={props.busy}>
                        Stop engine
                      </Button>
                    </Show>
                    <Show when={props.mode === "client"}>
                      <Button variant="outline" onClick={props.stopHost} disabled={props.busy}>
                        Disconnect
                      </Button>
                    </Show>
                  </div>

                  <Show when={isTauriRuntime() && props.mode === "host"}>
                    <div class="pt-4 border-t border-zinc-800/60 space-y-3">
                      <div class="text-xs text-zinc-500">Engine source</div>
                      <div class="grid grid-cols-2 gap-2">
                        <Button
                          variant={props.engineSource === "path" ? "secondary" : "outline"}
                          onClick={() => props.setEngineSource("path")}
                          disabled={props.busy}
                        >
                          PATH
                        </Button>
                        <Button
                          variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                          onClick={() => props.setEngineSource("sidecar")}
                          disabled={props.busy || props.isWindows}
                          title={props.isWindows ? "Sidecar is not supported on Windows yet" : ""}
                        >
                          Sidecar
                        </Button>
                      </div>
                      <div class="text-[11px] text-zinc-600">
                        PATH uses your installed OpenCode (default). Sidecar will use a bundled binary when available.
                        <Show when={props.isWindows}>
                          <span class="text-zinc-500"> Sidecar is currently unavailable on Windows.</span>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>

                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-white">Model</div>
                    <div class="text-xs text-zinc-500">Defaults + thinking controls for runs.</div>
                  </div>

                  <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-zinc-200 truncate">{props.defaultModelLabel}</div>
                      <div class="text-xs text-zinc-600 font-mono truncate">{props.defaultModelRef}</div>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={props.openDefaultModelPicker}
                      disabled={props.busy}
                    >
                      Change
                    </Button>
                  </div>

                  <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-zinc-200">Thinking</div>
                      <div class="text-xs text-zinc-600">Show thinking parts (Developer mode only).</div>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={props.toggleShowThinking}
                      disabled={props.busy}
                    >
                      {props.showThinking ? "On" : "Off"}
                    </Button>
                  </div>

                  <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-zinc-200">Model variant</div>
                      <div class="text-xs text-zinc-600 font-mono truncate">
                        {props.modelVariantLabel}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={props.editModelVariant}
                      disabled={props.busy}
                    >
                      Edit
                    </Button>
                  </div>
                </div>

                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
                  <div class="flex items-start justify-between gap-4">
                    <div>
                      <div class="text-sm font-medium text-white">Updates</div>
                      <div class="text-xs text-zinc-500">Keep OpenWork up to date.</div>
                    </div>
                    <div class="text-xs text-zinc-600 font-mono">{props.appVersion ? `v${props.appVersion}` : ""}</div>
                  </div>

                  <Show
                    when={!isTauriRuntime()}
                    fallback={
                      <Show
                        when={props.updateEnv && props.updateEnv.supported === false}
                        fallback={
                          <>
                            <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                              <div class="space-y-0.5">
                                <div class="text-sm text-white">Automatic checks</div>
                                <div class="text-xs text-zinc-600">Once per day (quiet)</div>
                              </div>
                              <button
                                class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                                  props.updateAutoCheck
                                    ? "bg-white/10 text-white border-white/20"
                                    : "text-zinc-500 border-zinc-800 hover:text-white"
                                }`}
                                onClick={props.toggleUpdateAutoCheck}
                              >
                                {props.updateAutoCheck ? "On" : "Off"}
                              </button>
                            </div>

                            <div class="flex items-center justify-between gap-3 bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                              <div class="space-y-0.5">
                                <div class="text-sm text-white">
                                  <Switch>
                                    <Match when={updateState() === "checking"}>Checking...</Match>
                                    <Match when={updateState() === "available"}>
                                      Update available: v{updateVersion()}
                                    </Match>
                                    <Match when={updateState() === "downloading"}>Downloading...</Match>
                                    <Match when={updateState() === "ready"}>
                                      Ready to install: v{updateVersion()}
                                    </Match>
                                    <Match when={updateState() === "error"}>Update check failed</Match>
                                    <Match when={true}>Up to date</Match>
                                  </Switch>
                                </div>
                                <Show
                                  when={updateState() === "idle" && updateLastCheckedAt()}
                                >
                                  <div class="text-xs text-zinc-600">
                                    Last checked {formatRelativeTime(updateLastCheckedAt() as number)}
                                  </div>
                                </Show>
                                <Show when={updateState() === "available" && updateDate()}>
                                  <div class="text-xs text-zinc-600">Published {updateDate()}</div>
                                </Show>
                                <Show when={updateState() === "downloading"}>
                                  <div class="text-xs text-zinc-600">
                                    {formatBytes((updateDownloadedBytes() as number) ?? 0)}
                                    <Show when={updateTotalBytes() != null}>
                                      {` / ${formatBytes(updateTotalBytes() as number)}`}
                                    </Show>
                                  </div>
                                </Show>
                                <Show when={updateState() === "error"}>
                                  <div class="text-xs text-red-300">{updateErrorMessage()}</div>
                                </Show>
                              </div>

                              <div class="flex items-center gap-2">
                                <Button
                                  variant="outline"
                                  class="text-xs h-8 py-0 px-3"
                                  onClick={props.checkForUpdates}
                                  disabled={props.busy || updateState() === "checking" || updateState() === "downloading"}
                                >
                                  Check
                                </Button>

                                <Show when={updateState() === "available"}>
                                  <Button
                                    variant="secondary"
                                    class="text-xs h-8 py-0 px-3"
                                    onClick={props.downloadUpdate}
                                    disabled={props.busy || updateState() === "downloading"}
                                  >
                                    Download
                                  </Button>
                                </Show>

                                <Show when={updateState() === "ready"}>
                                  <Button
                                    variant="secondary"
                                    class="text-xs h-8 py-0 px-3"
                                    onClick={props.installUpdateAndRestart}
                                    disabled={props.busy || props.anyActiveRuns}
                                    title={props.anyActiveRuns ? "Stop active runs to update" : ""}
                                  >
                                    Install & Restart
                                  </Button>
                                </Show>
                              </div>
                            </div>

                            <Show when={updateState() === "available" && updateNotes()}>
                              <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-400 whitespace-pre-wrap max-h-40 overflow-auto">
                                {updateNotes()}
                              </div>
                            </Show>
                          </>
                        }
                      >
                        <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-sm text-zinc-400">
                          {props.updateEnv?.reason ?? "Updates are not supported in this environment."}
                        </div>
                      </Show>
                    }
                  >
                    <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-sm text-zinc-400">
                      Updates are only available in the desktop app.
                    </div>
                  </Show>
                </div>

                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
                  <div class="text-sm font-medium text-white">Startup</div>

                  <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                    <div class="flex items-center gap-3">
                      <div
                        class={`p-2 rounded-lg ${
                          props.mode === "host"
                            ? "bg-indigo-500/10 text-indigo-400"
                            : "bg-emerald-500/10 text-emerald-400"
                        }`}
                      >
                        <Show when={props.mode === "host"} fallback={<Smartphone size={18} />}>
                          <HardDrive size={18} />
                        </Show>
                      </div>
                      <span class="capitalize text-sm font-medium text-white">{props.mode} mode</span>
                    </div>
                    <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={props.stopHost} disabled={props.busy}>
                      Switch
                    </Button>
                  </div>

                  <Button
                    variant="secondary"
                    class="w-full justify-between group"
                    onClick={props.onResetStartupPreference}
                  >
                    <span class="text-zinc-300">Reset default startup mode</span>
                    <RefreshCcw size={14} class="text-zinc-500 group-hover:rotate-180 transition-transform" />
                  </Button>

                  <p class="text-xs text-zinc-600">
                    This clears your saved preference and shows mode selection on next launch.
                  </p>
                </div>

                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-white">Advanced</div>
                    <div class="text-xs text-zinc-500">Reset OpenWork local state to retest onboarding.</div>
                  </div>

                  <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-zinc-200">Reset onboarding</div>
                      <div class="text-xs text-zinc-600">Clears OpenWork preferences and restarts the app.</div>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => props.openResetModal("onboarding")}
                      disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
                      title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
                    >
                      Reset
                    </Button>
                  </div>

                  <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-zinc-200">Reset app data</div>
                      <div class="text-xs text-zinc-600">More aggressive. Clears OpenWork cache + app data.</div>
                    </div>
                    <Button
                      variant="danger"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => props.openResetModal("all")}
                      disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
                      title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
                    >
                      Reset
                    </Button>
                  </div>

                  <div class="text-xs text-zinc-600">
                    Requires typing <span class="font-mono text-zinc-400">RESET</span> and will restart the app.
                  </div>
                </div>

                <Show when={props.developerMode}>
                  <section>
                    <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">Developer</h3>

                    <div class="grid md:grid-cols-2 gap-4">
                      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4">
                        <div class="text-xs text-zinc-500 mb-2">Pending permissions</div>
                        <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                          {props.safeStringify(props.pendingPermissions)}
                        </pre>
                      </div>
                      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4">
                        <div class="text-xs text-zinc-500 mb-2">Recent events</div>
                        <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                          {props.safeStringify(props.events)}
                        </pre>
                      </div>
                    </div>
                  </section>
                </Show>
              </section>
            </Match>
          </Switch>
        </div>

        <Show when={props.error}>
          <div class="mx-auto max-w-5xl px-6 md:px-10 pb-24 md:pb-10">
            <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
              {props.error}
            </div>
          </div>
        </Show>

        <WorkspacePicker
          open={props.workspacePickerOpen}
          workspaces={props.filteredWorkspaces}
          activeWorkspaceId={props.activeWorkspaceId}
          search={props.workspaceSearch}
          onSearch={props.setWorkspaceSearch}
          onClose={() => props.setWorkspacePickerOpen(false)}
          onSelect={props.activateWorkspace}
          onCreateNew={() => props.setCreateWorkspaceOpen(true)}
        />

        <CreateWorkspaceModal
          open={props.createWorkspaceOpen}
          onClose={() => props.setCreateWorkspaceOpen(false)}
          onConfirm={(preset) => props.createWorkspaceFlow(preset)}
        />

        <nav class="md:hidden fixed bottom-0 left-0 right-0 border-t border-zinc-800 bg-zinc-950/90 backdrop-blur-md">
          <div class="mx-auto max-w-5xl px-4 py-3 grid grid-cols-6 gap-2">
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "home" ? "text-white" : "text-zinc-500"
              }`}
              onClick={() => props.setTab("home")}
            >
              <Command size={18} />
              Home
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "sessions" ? "text-white" : "text-zinc-500"
              }`}
              onClick={() => props.setTab("sessions")}
            >
              <Play size={18} />
              Runs
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "templates" ? "text-white" : "text-zinc-500"
              }`}
              onClick={() => props.setTab("templates")}
            >
              <FileText size={18} />
              Templates
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "skills" ? "text-white" : "text-zinc-500"
              }`}
              onClick={() => props.setTab("skills")}
            >
              <Package size={18} />
              Skills
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "plugins" ? "text-white" : "text-zinc-500"
              }`}
              onClick={() => props.setTab("plugins")}
            >
              <Cpu size={18} />
              Plugins
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "settings" ? "text-white" : "text-zinc-500"
              }`}
              onClick={() => props.setTab("settings")}
            >
              <Shield size={18} />
              Settings
            </button>
          </div>
        </nav>
      </main>
    </div>
  );
}
