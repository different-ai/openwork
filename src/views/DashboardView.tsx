import { For, Match, Show, Switch, createEffect, createMemo } from "solid-js";
import type { CuratedPackage, DashboardTab, PluginScope, SkillCard, WorkspaceTemplate } from "../app/types";
import type { WorkspaceInfo } from "../lib/tauri";
import { formatRelativeTime } from "../app/utils";

import Button from "../components/Button";
import CreateWorkspaceModal from "../components/CreateWorkspaceModal";
import OpenWorkLogo from "../components/OpenWorkLogo";
import WorkspaceChip from "../components/WorkspaceChip";
import WorkspacePicker from "../components/WorkspacePicker";
import PluginsView from "./PluginsView";
import SettingsView from "./SettingsView";
import SkillsView from "./SkillsView";
import TemplatesView from "./TemplatesView";
import { Command, Cpu, FileText, Package, Play, Plus, Shield, Smartphone } from "lucide-solid";

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
  demoMode: boolean;
  toggleDemoMode: () => void;
  demoSequence: "cold-open" | "scheduler" | "summaries" | "groceries";
  setDemoSequence: (value: "cold-open" | "scheduler" | "summaries" | "groceries") => void;
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
            <Show when={props.developerMode}>
              <span class="text-xs text-zinc-600">{props.headerStatus}</span>
            </Show>
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
              <TemplatesView
                busy={props.busy}
                workspaceTemplates={props.workspaceTemplates}
                globalTemplates={props.globalTemplates}
                setTemplateDraftTitle={props.setTemplateDraftTitle}
                setTemplateDraftDescription={props.setTemplateDraftDescription}
                setTemplateDraftPrompt={props.setTemplateDraftPrompt}
                setTemplateDraftScope={props.setTemplateDraftScope}
                openTemplateModal={props.openTemplateModal}
                resetTemplateDraft={props.resetTemplateDraft}
                runTemplate={props.runTemplate}
                deleteTemplate={props.deleteTemplate}
              />
            </Match>

            <Match when={props.tab === "skills"}>
              <SkillsView
                busy={props.busy}
                mode={props.mode}
                refreshSkills={props.refreshSkills}
                skills={props.skills}
                skillsStatus={props.skillsStatus}
                openPackageSource={props.openPackageSource}
                setOpenPackageSource={props.setOpenPackageSource}
                installFromOpenPackage={props.installFromOpenPackage}
                importLocalSkill={props.importLocalSkill}
                packageSearch={props.packageSearch}
                setPackageSearch={props.setPackageSearch}
                filteredPackages={props.filteredPackages}
                useCuratedPackage={props.useCuratedPackage}
              />
            </Match>

            <Match when={props.tab === "plugins"}>
              <PluginsView
                busy={props.busy}
                activeWorkspaceRoot={props.activeWorkspaceRoot}
                pluginScope={props.pluginScope}
                setPluginScope={props.setPluginScope}
                pluginConfigPath={props.pluginConfigPath}
                pluginList={props.pluginList}
                pluginInput={props.pluginInput}
                setPluginInput={props.setPluginInput}
                pluginStatus={props.pluginStatus}
                activePluginGuide={props.activePluginGuide}
                setActivePluginGuide={props.setActivePluginGuide}
                isPluginInstalled={props.isPluginInstalled}
                suggestedPlugins={props.suggestedPlugins}
                refreshPlugins={props.refreshPlugins}
                addPlugin={props.addPlugin}
              />
            </Match>

            <Match when={props.tab === "settings"}>
              <SettingsView
                mode={props.mode}
                baseUrl={props.baseUrl}
                headerStatus={props.headerStatus}
                busy={props.busy}
                developerMode={props.developerMode}
                toggleDeveloperMode={props.toggleDeveloperMode}
                stopHost={props.stopHost}
                engineSource={props.engineSource}
                setEngineSource={props.setEngineSource}
                isWindows={props.isWindows}
                defaultModelLabel={props.defaultModelLabel}
                defaultModelRef={props.defaultModelRef}
                openDefaultModelPicker={props.openDefaultModelPicker}
                showThinking={props.showThinking}
                toggleShowThinking={props.toggleShowThinking}
                modelVariantLabel={props.modelVariantLabel}
                editModelVariant={props.editModelVariant}
                updateAutoCheck={props.updateAutoCheck}
                toggleUpdateAutoCheck={props.toggleUpdateAutoCheck}
                updateStatus={props.updateStatus}
                updateEnv={props.updateEnv}
                appVersion={props.appVersion}
                checkForUpdates={props.checkForUpdates}
                downloadUpdate={props.downloadUpdate}
                installUpdateAndRestart={props.installUpdateAndRestart}
                anyActiveRuns={props.anyActiveRuns}
                onResetStartupPreference={props.onResetStartupPreference}
                openResetModal={props.openResetModal}
                resetModalBusy={props.resetModalBusy}
                pendingPermissions={props.pendingPermissions}
                events={props.events}
                safeStringify={props.safeStringify}
                demoMode={props.demoMode}
                toggleDemoMode={props.toggleDemoMode}
                demoSequence={props.demoSequence}
                setDemoSequence={props.setDemoSequence}
              />
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
