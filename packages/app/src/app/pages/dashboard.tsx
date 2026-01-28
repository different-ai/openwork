import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type {
  DashboardTab,
  McpServerEntry,
  McpStatusMap,
  PluginScope,
  SkillCard,
  WorkspaceCommand,
  View,
} from "../types";
import type { McpDirectoryInfo } from "../constants";
import { formatRelativeTime, normalizeDirectoryPath } from "../utils";
import type { OpenworkServerSettings, OpenworkServerStatus } from "../lib/openwork-server";
import type { OpenworkServerInfo } from "../lib/tauri";

import Button from "../components/button";
import OpenWorkLogo from "../components/openwork-logo";
import WorkspaceChip from "../components/workspace-chip";
import McpView from "./mcp";
import PluginsView from "./plugins";
import SettingsView from "./settings";
import type { KeybindSetting } from "../components/settings-keybinds";
import SkillsView from "./skills";
import CommandsView from "./commands";
import {
  Command,
  Cpu,
  Package,
  Play,
  Plus,
  Settings,
  Server,
  Terminal,
} from "lucide-solid";

export type DashboardViewProps = {
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  view: View;
  setView: (view: View, sessionId?: string) => void;
  mode: "host" | "client" | null;
  baseUrl: string;
  clientConnected: boolean;
  busy: boolean;
  busyHint: string | null;
  busyLabel: string | null;
  newTaskDisabled: boolean;
  headerStatus: string;
  error: string | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerHostInfo: OpenworkServerInfo | null;
  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  resetOpenworkServerSettings: () => void;
  testOpenworkServerConnection: (next: OpenworkServerSettings) => Promise<boolean>;
  keybindItems: KeybindSetting[];
  onOverrideKeybind: (id: string, keybind: string | null) => void;
  onResetKeybind: (id: string) => void;
  onResetAllKeybinds: () => void;
  activeWorkspaceDisplay: WorkspaceInfo;
  workspaceSearch: string;
  setWorkspaceSearch: (value: string) => void;
  workspacePickerOpen: boolean;
  setWorkspacePickerOpen: (open: boolean) => void;
  connectingWorkspaceId: string | null;
  workspaces: WorkspaceInfo[];
  filteredWorkspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  activateWorkspace: (id: string) => Promise<boolean> | boolean;
  exportWorkspaceConfig: () => void;
  exportWorkspaceBusy: boolean;
  createWorkspaceOpen: boolean;
  setCreateWorkspaceOpen: (open: boolean) => void;
  createWorkspaceFlow: (
    preset: "starter" | "automation" | "minimal",
    folder: string | null
  ) => void;
  pickWorkspaceFolder: () => Promise<string | null>;
  sessions: Array<{
    id: string;
    slug?: string | null;
    title: string;
    time: { updated: number };
    directory?: string | null;
  }>;
  sessionStatusById: Record<string, string>;
  activeWorkspaceRoot: string;
  workspaceCommands: WorkspaceCommand[];
  globalCommands: WorkspaceCommand[];
  otherCommands: WorkspaceCommand[];
  setCommandDraftName: (value: string) => void;
  setCommandDraftDescription: (value: string) => void;
  setCommandDraftTemplate: (value: string) => void;
  setCommandDraftScope: (value: "workspace" | "global") => void;
  openCommandModal: () => void;
  resetCommandDraft?: (scope?: "workspace" | "global") => void;
  runCommand: (command: WorkspaceCommand) => void;
  deleteCommand: (command: WorkspaceCommand) => void;
  justSavedCommand?: { name: string; scope: string } | null;
  clearJustSavedCommand?: () => void;
  refreshSkills: (options?: { force?: boolean }) => void;
  refreshPlugins: (scopeOverride?: PluginScope) => void;
  refreshMcpServers: () => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  skillsAccessHint?: string | null;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  importLocalSkill: () => void;
  installSkillCreator: () => void;
  revealSkillsFolder: () => void;
  uninstallSkill: (name: string) => void;
  pluginsAccessHint?: string | null;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
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
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  setSelectedMcp: (value: string | null) => void;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => void;
  showMcpReloadBanner: boolean;
  mcpReloadBlocked: boolean;
  reloadMcpEngine: () => void;
  createSessionAndOpen: () => void;
  setPrompt: (value: string) => void;
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
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
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
  repairOpencodeCache: () => void;
  cacheRepairBusy: boolean;
  cacheRepairResult: string | null;
  notionStatus: "disconnected" | "connecting" | "connected" | "error";
  notionStatusDetail: string | null;
  notionError: string | null;
  notionBusy: boolean;
  connectNotion: () => void;
};

export default function DashboardView(props: DashboardViewProps) {
  const title = createMemo(() => {
    switch (props.tab) {
      case "sessions":
        return "Sessions";
      case "commands":
        return "Commands";
      case "skills":
        return "Skills";
      case "plugins":
        return "Plugins";
      case "mcp":
        return "MCPs";
      case "settings":
        return "Settings";
      default:
        return "Dashboard";
    }
  });

  const quickCommands = createMemo(() => props.workspaceCommands.slice(0, 3));
  const canExportWorkspace = createMemo(() => props.activeWorkspaceDisplay.workspaceType !== "remote");
  const workspaceDirectoryMap = createMemo(() =>
    props.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.displayName ?? workspace.name,
      path: normalizeDirectoryPath(
        workspace.workspaceType === "remote"
          ? workspace.directory ?? ""
          : workspace.path
      ),
    }))
  );

  const workspaceLabelForSession = (directory?: string | null) => {
    if (!directory) return null;
    const normalized = normalizeDirectoryPath(directory);
    if (!normalized) return null;
    return workspaceDirectoryMap().find((workspace) => workspace.path === normalized)?.name ?? null;
  };

  const openSessionFromList = (sessionId: string) => {
    // Defer view switch to avoid click-through on the same event frame.
    window.setTimeout(() => {
      void props.selectSession(sessionId);
      props.setTab("sessions");
      props.setView("session", sessionId);
    }, 0);
  };

  // Track last refreshed tab to avoid duplicate calls
  const [lastRefreshedTab, setLastRefreshedTab] = createSignal<string | null>(null);
  const [refreshInProgress, setRefreshInProgress] = createSignal(false);
  const [taskDraft, setTaskDraft] = createSignal("");

  const canCreateTask = createMemo(
    () => !props.newTaskDisabled && taskDraft().trim().length > 0
  );

  const startTask = () => {
    const value = taskDraft().trim();
    if (!value || props.newTaskDisabled) return;
    props.setPrompt(value);
    props.createSessionAndOpen();
    setTaskDraft("");
  };

  createEffect(() => {
    const currentTab = props.tab;

    // Skip if we already refreshed this tab or a refresh is in progress
    if (lastRefreshedTab() === currentTab || refreshInProgress()) {
      return;
    }

    // Track that we're refreshing this tab
    setRefreshInProgress(true);
    setLastRefreshedTab(currentTab);

    // Use a cancelled flag to prevent stale updates after navigation
    let cancelled = false;

    const doRefresh = async () => {
      try {
        if (currentTab === "skills" && !cancelled) {
          await props.refreshSkills();
        }
        if (currentTab === "plugins" && !cancelled) {
          await props.refreshPlugins();
        }
        if (currentTab === "mcp" && !cancelled) {
          await props.refreshMcpServers();
        }
        if (currentTab === "sessions" && !cancelled) {
          // Stagger these calls to avoid request stacking
          await props.refreshSkills();
          if (!cancelled) {
            await props.refreshPlugins("project");
          }
        }
      } catch {
        // Ignore errors during navigation
      } finally {
        if (!cancelled) {
          setRefreshInProgress(false);
        }
      }
    };

    doRefresh();

    onCleanup(() => {
      cancelled = true;
      setRefreshInProgress(false);
    });
  });

  const navItem = (t: DashboardTab, label: any, icon: any) => {
    const active = () => props.tab === t;
    return (
      <button
        class={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
          active()
            ? "bg-gray-2 text-gray-12"
            : "text-gray-10 hover:text-gray-12 hover:bg-gray-2/50"
        }`}
        onClick={() => props.setTab(t)}
      >
        {icon}
        {label}
      </button>
    );
  };

  const opencodeStatusMeta = createMemo(() => ({
    dot: props.clientConnected ? "bg-green-9" : "bg-gray-6",
    text: props.clientConnected ? "text-green-11" : "text-gray-10",
    label: props.clientConnected ? "Connected" : "Not connected",
  }));

  const openworkStatusMeta = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return { dot: "bg-green-9", text: "text-green-11", label: "Ready" };
      case "limited":
        return { dot: "bg-amber-9", text: "text-amber-11", label: "Limited access" };
      default:
        return { dot: "bg-gray-6", text: "text-gray-10", label: "Unavailable" };
    }
  });

  return (
    <div class="flex h-screen bg-gray-1 text-gray-12 overflow-hidden">
      <aside class="w-64 border-r border-gray-6 p-6 hidden md:flex flex-col justify-between bg-gray-1">
        <div>
            <div class="flex items-center gap-3 mb-10 px-2">
            <div class="">
              <OpenWorkLogo size={32} />
            </div>
            <span class="font-bold text-lg tracking-tight">OpenWork</span>
          </div>

          <nav class="space-y-1">
            {navItem("home", "Dashboard", <Command size={18} />)}
            {navItem("sessions", "Sessions", <Play size={18} />)}
            {navItem("commands", "Commands", <Terminal size={18} />)}
            {navItem("skills", "Skills", <Package size={18} />)}
            {navItem("plugins", "Plugins", <Cpu size={18} />)}
            {navItem(
              "mcp",
              <span class="inline-flex items-center gap-2">
                MCPs
                <span class="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-7/20 text-amber-12">
                  Alpha
                </span>
              </span>,
              <Server size={18} />,
            )}
            {navItem("settings", "Settings", <Settings size={18} />)}
          </nav>
        </div>

        <div class="space-y-4">

          <Show when={props.mode === "client" && props.openworkServerStatus === "disconnected"}>
            <div class="text-[11px] text-gray-9 px-1">
              OpenWork server is offline — remote tasks still run.
            </div>
          </Show>

          <Show when={!props.clientConnected}>
            <Button
              variant="secondary"
              onClick={() => props.setView("onboarding")}
              disabled={props.busy}
              class="w-full"
            >
              Connect
            </Button>
          </Show>
        </div>
      </aside>

      <main class="flex-1 overflow-y-auto relative pb-24 md:pb-12">
        <header class="h-16 flex items-center justify-between px-6 md:px-10 border-b border-gray-6 sticky top-0 bg-gray-1/80 backdrop-blur-md z-10">
          <div class="flex items-center gap-3">
            <WorkspaceChip
              workspace={props.activeWorkspaceDisplay}
              connecting={props.connectingWorkspaceId === props.activeWorkspaceDisplay.id}
              onClick={() => {
                props.setWorkspaceSearch("");
                props.setWorkspacePickerOpen(true);
              }}
            />
            <h1 class="text-lg font-medium">{title()}</h1>
            <Show when={props.developerMode}>
              <span class="text-xs text-gray-7">{props.headerStatus}</span>
            </Show>
            <Show when={props.busyHint}>
              <span class="text-xs text-gray-10">{props.busyHint}</span>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <Show when={props.tab === "home" || props.tab === "sessions"}>
              <Button
                variant="outline"
                class="text-xs h-9"
                onClick={props.exportWorkspaceConfig}
                disabled={!canExportWorkspace() || props.exportWorkspaceBusy}
                title={
                  !canExportWorkspace()
                    ? "Export is only available for local workspaces"
                    : "Export workspace config"
                }
              >
                Share config
              </Button>
              <Button
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                }}
                onPointerUp={() => {
                  console.log("[DEBUG] new task button pointerup");
                  props.createSessionAndOpen();
                }}
                disabled={props.newTaskDisabled}
                title={props.newTaskDisabled ? props.busyHint ?? "Busy" : ""}
              >
                <Play size={16} />
                New Task
              </Button>
            </Show>

            <Show when={props.tab === "commands"}>
              <Button
                variant="secondary"
                onClick={() => {
                  const reset = props.resetCommandDraft;
                  if (reset) {
                    reset("workspace");
                  } else {
                    props.setCommandDraftName("");
                    props.setCommandDraftDescription("");
                    props.setCommandDraftTemplate("");
                    props.setCommandDraftScope("workspace");
                  }
                  props.openCommandModal();
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
                <div class="bg-gradient-to-r from-gray-2 to-gray-4 rounded-3xl p-1 ">
                  <div class="bg-gray-1 rounded-[22px] p-6 md:p-8 flex flex-col md:flex-row items-center justify-between gap-6">
                    <div class="space-y-2 text-center md:text-left">
                      <h2 class="text-2xl font-semibold text-gray-12">
                        What should we do today?
                      </h2>
                      <p class="text-gray-11">
                        Describe an outcome. OpenWork will run it and keep an
                        audit trail.
                      </p>
                    </div>
                    <div class="w-full md:w-[360px]">
                      <div class="flex items-center gap-2 rounded-2xl border border-gray-6/60 bg-gray-2/50 px-4 py-3 shadow-lg shadow-gray-12/5 focus-within:border-gray-7 focus-within:bg-gray-2 transition-all">
                        <input
                          value={taskDraft()}
                          onInput={(event) => setTaskDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              startTask();
                            }
                          }}
                          placeholder="Draft a task to run..."
                          class="flex-1 bg-transparent border-none p-0 text-sm text-gray-12 placeholder-gray-7 focus:ring-0"
                          aria-label="Describe a task"
                          disabled={props.newTaskDisabled}
                        />
                        <button
                          type="button"
                          onClick={startTask}
                          disabled={!canCreateTask()}
                          class="rounded-xl bg-gray-12 px-3 py-1.5 text-xs font-semibold text-gray-1 shadow-md transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
                          title={
                            props.newTaskDisabled ? props.busyHint ?? "Busy" : ""
                          }
                        >
                          Run
                        </button>
                      </div>
                      <div class="mt-2 text-[11px] text-gray-9 text-center md:text-left">
                        Press Enter to start a new session.
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section>
                <div class="flex items-center justify-between mb-4">
                  <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider">
                    Quick Start Commands
                  </h3>
                  <button
                    class="text-sm text-gray-10 hover:text-gray-12"
                    onClick={() => props.setTab("commands")}
                  >
                    View all
                  </button>
                </div>

                <Show
                  when={quickCommands().length}
                  fallback={
                    <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-6 text-sm text-gray-10">
                      No commands yet. Starter commands will appear here.
                    </div>
                  }
                >
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <For each={quickCommands()}>
                      {(command) => (
                        <button
                          onClick={() => props.runCommand(command)}
                          class="group p-5 rounded-2xl bg-gray-2/30 border border-gray-6/50 hover:bg-gray-2 hover:border-gray-7 transition-all text-left"
                        >
                          <div class="w-10 h-10 rounded-full bg-gray-4 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                            <Terminal size={20} class="text-indigo-11" />
                          </div>
                          <h4 class="font-medium text-gray-12 mb-1">/{command.name}</h4>
                          <p class="text-sm text-gray-10">
                            {command.description || "Run a saved command"}
                          </p>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </section>

              <section>
                <div class="flex items-center justify-between mb-4">
                  <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider">
                    Workspaces
                  </h3>
                  <div class="flex items-center gap-2">
                    <Button
                      variant="outline"
                      class="text-xs h-8 px-3"
                      onClick={props.exportWorkspaceConfig}
                      disabled={!canExportWorkspace() || props.exportWorkspaceBusy}
                      title={
                        !canExportWorkspace()
                          ? "Export is only available for local workspaces"
                          : "Export workspace config"
                      }
                    >
                      Share config
                    </Button>
                    <Button
                      variant="secondary"
                      class="text-xs h-8 px-3"
                      onClick={() => props.setWorkspacePickerOpen(true)}
                    >
                      <Plus size={14} />
                      Add workspace
                    </Button>
                  </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <For each={props.workspaces}>
                    {(workspace) => (
                      <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-3">
                        <div class="flex items-start justify-between">
                          <div class="space-y-1 min-w-0">
                            <div class="text-sm font-semibold text-gray-12 truncate">
                              {workspace.displayName ?? workspace.name}
                            </div>
                            <div class="text-xs text-gray-10 font-mono truncate">
                              {workspace.workspaceType === "remote"
                                ? workspace.baseUrl ?? workspace.path
                                : workspace.path}
                            </div>
                          </div>
                          <span class="text-[11px] text-gray-9">
                            {workspace.workspaceType === "remote" ? "Remote" : "Local"}
                          </span>
                        </div>
                        <div class="flex items-center justify-between text-xs text-gray-9">
                          <span>
                            {workspace.id === props.activeWorkspaceId ? "Active" : "Inactive"}
                          </span>
                          <Button
                            variant="ghost"
                            class="text-xs px-2 py-1"
                            onClick={() => props.activateWorkspace(workspace.id)}
                            disabled={
                              workspace.id === props.activeWorkspaceId ||
                              props.connectingWorkspaceId === workspace.id
                            }
                          >
                            {workspace.id === props.activeWorkspaceId
                              ? "Active"
                              : props.connectingWorkspaceId === workspace.id
                                ? "Switching..."
                                : "Switch"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </section>

              <section>
                <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">
                  Recent Sessions
                </h3>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl overflow-hidden">
                  <For each={props.sessions.slice(0, 3)}>
                    {(s, idx) => (
                      <button
                        class={`w-full p-4 flex items-center justify-between hover:bg-gray-4/50 transition-colors text-left ${
                          idx() !== Math.min(props.sessions.length, 3) - 1
                            ? "border-b border-gray-6/50"
                            : ""
                        }`}
                        onPointerDown={(e) => {
                          e.currentTarget.setPointerCapture?.(e.pointerId);
                        }}
                        onPointerUp={() => {
                          openSessionFromList(s.id);
                        }}
                      >
                        <div class="flex items-center gap-4">
                          <div class="w-8 h-8 rounded-full bg-gray-4 flex items-center justify-center text-xs text-gray-10 font-mono">
                            #{s.slug?.slice(0, 2) ?? ".."}
                          </div>
                          <div>
                            <div class="font-medium text-sm text-gray-12">
                              {s.title}
                            </div>
                            <div class="text-xs text-gray-10 flex items-center gap-2">
                              <span class="flex items-center gap-1">
                                {formatRelativeTime(s.time.updated)}
                              </span>
                              <Show when={workspaceLabelForSession(s.directory)}>
                                {(label) => (
                                  <span class="text-[11px] px-2 py-0.5 rounded-full border border-gray-7/60 text-gray-10">
                                    {label()}
                                  </span>
                                )}
                              </Show>
                            </div>
                          </div>
                        </div>
                        <div class="flex items-center gap-4">
                          <span class="text-xs px-2 py-0.5 rounded-full border border-gray-7/60 text-gray-11 flex items-center gap-1.5">
                            <span class="w-1.5 h-1.5 rounded-full bg-current" />
                            {props.sessionStatusById[s.id] ?? "idle"}
                          </span>
                        </div>
                      </button>
                    )}
                  </For>

                  <Show when={!props.sessions.length}>
                    <div class="p-6 text-sm text-gray-10">
                      No sessions yet.
                    </div>
                  </Show>
                </div>
              </section>
            </Match>

            <Match when={props.tab === "sessions"}>
              <section>
                <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">
                  Recent Sessions
                </h3>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl overflow-hidden">
                  <For each={props.sessions.slice(0, 3)}>
                    {(s, idx) => (
                      <button
                        class={`w-full p-4 flex items-center justify-between hover:bg-gray-4/50 transition-colors text-left ${
                          idx() !== Math.min(props.sessions.length, 3) - 1
                            ? "border-b border-gray-6/50"
                            : ""
                        }`}
                        onPointerDown={(e) => {
                          e.currentTarget.setPointerCapture?.(e.pointerId);
                        }}
                        onPointerUp={() => {
                          openSessionFromList(s.id);
                        }}
                      >
                        <div class="flex items-center gap-4">
                          <div class="w-8 h-8 rounded-full bg-gray-4 flex items-center justify-center text-xs text-gray-10 font-mono">
                            #{s.slug?.slice(0, 2) ?? ".."}
                          </div>
                          <div>
                            <div class="font-medium text-sm text-gray-12">
                              {s.title}
                            </div>
                            <div class="text-xs text-gray-10 flex items-center gap-2">
                              <span class="flex items-center gap-1">
                                {formatRelativeTime(s.time.updated)}
                              </span>
                              <Show when={workspaceLabelForSession(s.directory)}>
                                {(label) => (
                                  <span class="text-[11px] px-2 py-0.5 rounded-full border border-gray-7/60 text-gray-10">
                                    {label()}
                                  </span>
                                )}
                              </Show>
                            </div>
                          </div>
                        </div>
                        <div class="flex items-center gap-4">
                          <span class="text-xs px-2 py-0.5 rounded-full border border-gray-7/60 text-gray-11 flex items-center gap-1.5">
                            <span class="w-1.5 h-1.5 rounded-full bg-current" />
                            {props.sessionStatusById[s.id] ?? "idle"}
                          </span>
                        </div>
                      </button>
                    )}
                  </For>

                  <Show when={!props.sessions.length}>
                    <div class="p-6 text-sm text-gray-10">
                      No sessions yet.
                    </div>
                  </Show>
                </div>
              </section>
            </Match>

            <Match when={props.tab === "commands"}>
              <CommandsView
                busy={props.busy}
                workspaceCommands={props.workspaceCommands}
                globalCommands={props.globalCommands}
                otherCommands={props.otherCommands}
                setCommandDraftName={props.setCommandDraftName}
                setCommandDraftDescription={props.setCommandDraftDescription}
                setCommandDraftTemplate={props.setCommandDraftTemplate}
                setCommandDraftScope={props.setCommandDraftScope}
                openCommandModal={props.openCommandModal}
                resetCommandDraft={props.resetCommandDraft}
                runCommand={props.runCommand}
                deleteCommand={props.deleteCommand}
                justSavedCommand={props.justSavedCommand}
                clearJustSavedCommand={props.clearJustSavedCommand}
              />
            </Match>

            <Match when={props.tab === "skills"}>
              <SkillsView
                busy={props.busy}
                mode={props.mode}
                canInstallSkillCreator={props.canInstallSkillCreator}
                canUseDesktopTools={props.canUseDesktopTools}
                accessHint={props.skillsAccessHint}
                refreshSkills={props.refreshSkills}
                skills={props.skills}
                skillsStatus={props.skillsStatus}
                importLocalSkill={props.importLocalSkill}
                installSkillCreator={props.installSkillCreator}
                revealSkillsFolder={props.revealSkillsFolder}
                uninstallSkill={props.uninstallSkill}
              />
            </Match>

            <Match when={props.tab === "plugins"}>
              <PluginsView
                busy={props.busy}
                activeWorkspaceRoot={props.activeWorkspaceRoot}
                canEditPlugins={props.canEditPlugins}
                canUseGlobalScope={props.canUseGlobalPluginScope}
                accessHint={props.pluginsAccessHint}
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

            <Match when={props.tab === "mcp"}>
              <McpView
                mode={props.mode}
                busy={props.busy}
                activeWorkspaceRoot={props.activeWorkspaceRoot}
                mcpServers={props.mcpServers}
                mcpStatus={props.mcpStatus}
                mcpLastUpdatedAt={props.mcpLastUpdatedAt}
                mcpStatuses={props.mcpStatuses}
                mcpConnectingName={props.mcpConnectingName}
                selectedMcp={props.selectedMcp}
                setSelectedMcp={props.setSelectedMcp}
                quickConnect={props.quickConnect}
                connectMcp={props.connectMcp}
                showMcpReloadBanner={props.showMcpReloadBanner}
                reloadBlocked={props.mcpReloadBlocked}
                reloadMcpEngine={props.reloadMcpEngine}
              />
            </Match>

            <Match when={props.tab === "settings"}>
                <SettingsView
                  mode={props.mode}
                  baseUrl={props.baseUrl}
                  headerStatus={props.headerStatus}
                  busy={props.busy}
                  openworkServerStatus={props.openworkServerStatus}
                  openworkServerUrl={props.openworkServerUrl}
                  openworkServerSettings={props.openworkServerSettings}
                  openworkServerHostInfo={props.openworkServerHostInfo}
                  updateOpenworkServerSettings={props.updateOpenworkServerSettings}
                  resetOpenworkServerSettings={props.resetOpenworkServerSettings}
                  testOpenworkServerConnection={props.testOpenworkServerConnection}
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
                  keybindItems={props.keybindItems}
                  onOverrideKeybind={props.onOverrideKeybind}
                  onResetKeybind={props.onResetKeybind}
                  onResetAllKeybinds={props.onResetAllKeybinds}
                  updateAutoCheck={props.updateAutoCheck}
                  toggleUpdateAutoCheck={props.toggleUpdateAutoCheck}
                  themeMode={props.themeMode}
                  setThemeMode={props.setThemeMode}
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
                  repairOpencodeCache={props.repairOpencodeCache}
                  cacheRepairBusy={props.cacheRepairBusy}
                  cacheRepairResult={props.cacheRepairResult}
                  notionStatus={props.notionStatus}
                  notionStatusDetail={props.notionStatusDetail}
                  notionError={props.notionError}
                  notionBusy={props.notionBusy}
                  connectNotion={props.connectNotion}
                />

            </Match>
          </Switch>
        </div>

        <Show when={props.error}>
          <div class="mx-auto max-w-5xl px-6 md:px-10 pb-24 md:pb-10">
            <div class="rounded-2xl bg-red-1/40 px-5 py-4 text-sm text-red-12 border border-red-7/20 space-y-3">
              <div>{props.error}</div>
              <Show when={props.developerMode}>
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.repairOpencodeCache}
                    disabled={props.cacheRepairBusy || !props.developerMode}
                  >
                    {props.cacheRepairBusy ? "Repairing cache" : "Repair cache"}
                  </Button>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    Retry
                  </Button>
                  <Show when={props.cacheRepairResult}>
                    <span class="text-xs text-red-12/80">
                      {props.cacheRepairResult}
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        <div class="fixed bottom-0 left-0 right-0">
          <div class="border-t border-gray-6 bg-gray-1/90 backdrop-blur-md">
            <div class="mx-auto max-w-5xl px-4 py-2 flex flex-wrap items-center gap-3 text-xs">
              <div class="flex items-center gap-2">
                <span class={`w-2 h-2 rounded-full ${opencodeStatusMeta().dot}`} />
                <span class="text-gray-11 font-medium">OpenCode Engine</span>
                <span class={opencodeStatusMeta().text}>{opencodeStatusMeta().label}</span>
              </div>
              <div class="w-px h-4 bg-gray-6/70" />
              <div class="flex items-center gap-2">
                <span class={`w-2 h-2 rounded-full ${openworkStatusMeta().dot}`} />
                <span class="text-gray-11 font-medium">OpenWork Server</span>
                <span class={openworkStatusMeta().text}>{openworkStatusMeta().label}</span>
              </div>
              <div class="ml-auto flex items-center gap-2">
                <Show when={props.mode === "host"}>
                  <Button
                    variant="danger"
                    onClick={props.stopHost}
                    disabled={props.busy}
                    class="text-xs h-7 px-3"
                  >
                    Stop & Disconnect
                  </Button>
                </Show>
                <Show when={props.mode === "client"}>
                  <Button
                    variant="outline"
                    onClick={props.stopHost}
                    disabled={props.busy}
                    class="text-xs h-7 px-3"
                  >
                    Disconnect
                  </Button>
                </Show>
              </div>
            </div>
          </div>
          <nav class="md:hidden border-t border-gray-6 bg-gray-1/90 backdrop-blur-md">
            <div class="mx-auto max-w-5xl px-4 py-3 grid grid-cols-6 gap-2">
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "home" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => props.setTab("home")}
              >
                <Command size={18} />
                Home
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "sessions" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => props.setTab("sessions")}
              >
                <Play size={18} />
                Runs
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "commands" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => props.setTab("commands")}
              >
                <Terminal size={18} />
                Commands
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "skills" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => props.setTab("skills")}
              >
                <Package size={18} />
                Skills
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "plugins" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => props.setTab("plugins")}
              >
                <Cpu size={18} />
                Plugins
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "mcp" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => props.setTab("mcp")}
              >
                <Server size={18} />
                MCPs
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "settings" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => props.setTab("settings")}
              >
                <Settings size={18} />
                Settings
              </button>
            </div>
          </nav>
        </div>
      </main>
    </div>
  );
}
