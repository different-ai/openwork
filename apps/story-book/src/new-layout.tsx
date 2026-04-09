import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Redo2, Search, Undo2, X } from "lucide-solid";

import Button from "../../app/src/app/components/button";
import DenSettingsPanel from "../../app/src/app/components/den-settings-panel";
import ModelPickerModal from "../../app/src/app/components/model-picker-modal";
import StatusBar from "../../app/src/app/components/status-bar";
import Composer from "../../app/src/app/components/session/composer";
import MessageList from "../../app/src/app/components/session/message-list";
import WorkspaceSessionList from "../../app/src/app/components/session/workspace-session-list";
import {
  CreateWorkspaceModal,
  ShareWorkspaceModal,
} from "../../app/src/app/workspace";
import { MCP_QUICK_CONNECT, SUGGESTED_PLUGINS } from "../../app/src/app/constants";
import { createWorkspaceShellLayout } from "../../app/src/app/lib/workspace-shell-layout";
import { getModelBehaviorSummary, sanitizeModelBehaviorValue } from "../../app/src/app/lib/model-behavior";
import type { OpenworkServerClient } from "../../app/src/app/lib/openwork-server";
import ExtensionsView from "../../app/src/app/pages/extensions";
import IdentitiesView from "../../app/src/app/pages/identities";
import AutomationsView from "../../app/src/app/pages/automations";
import {
  applyThemeMode,
  getInitialThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "../../app/src/app/theme";
import type {
  ComposerDraft,
  HubSkillCard,
  HubSkillRepo,
  McpServerEntry,
  McpStatusMap,
  MessageWithParts,
  ModelOption,
  ModelRef,
  PluginScope,
  ProviderListItem,
  ScheduledJob,
  SlashCommandOption,
  SkillCard,
  WorkspaceConnectionState,
  WorkspacePreset,
  WorkspaceSessionGroup,
} from "../../app/src/app/types";
import { sessionMessages, storyWorkspaces } from "./mock-data";

type CommandPaletteMode = "root" | "sessions";
type SettingsTab = "general" | "den" | "model" | "automations" | "skills" | "extensions" | "messaging" | "advanced" | "appearance" | "updates" | "recovery" | "debug";

type CommandPaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  action: () => void;
};

const localWorkspace = storyWorkspaces[0] ?? {
  id: "local-foundation",
  name: "Local Foundation",
  displayName: "OpenWork App",
  path: "~/OpenWork/app",
  preset: "starter",
  workspaceType: "local" as const,
};

const remoteWorkspace = storyWorkspaces[1] ?? {
  id: "remote-worker",
  name: "Remote Worker",
  displayName: "Ops Worker",
  path: "remote://ops-worker",
  preset: "automation",
  workspaceType: "remote" as const,
  remoteType: "openwork" as const,
  baseUrl: "https://worker.openworklabs.com/opencode",
  openworkHostUrl: "https://worker.openworklabs.com",
  openworkWorkspaceName: "Ops Worker",
  sandboxBackend: "docker" as const,
  sandboxContainerName: "openwork-ops-worker",
};

const now = Date.now();

const workspaceSessionGroups: WorkspaceSessionGroup[] = [
  {
    workspace: localWorkspace,
    status: "ready",
    sessions: [
      {
        id: "sb-session-shell",
        title: "Story shell parity with session.tsx",
        slug: "story-shell-parity",
        time: { updated: now - 2 * 60 * 1000, created: now - 22 * 60 * 1000 },
      },
      {
        id: "sb-session-provider",
        title: "Provider states and status rail",
        slug: "provider-states",
        time: { updated: now - 18 * 60 * 1000, created: now - 56 * 60 * 1000 },
      },
      {
        id: "sb-session-mobile",
        title: "Mobile shell spacing pass",
        slug: "mobile-shell-pass",
        time: { updated: now - 56 * 60 * 1000, created: now - 3 * 60 * 60 * 1000 },
      },
    ],
  },
  {
    workspace: remoteWorkspace,
    status: "ready",
    sessions: [
      {
        id: "sb-session-remote",
        title: "Remote worker onboarding",
        slug: "remote-worker-onboarding",
        time: { updated: now - 7 * 60 * 1000, created: now - 2 * 60 * 60 * 1000 },
      },
      {
        id: "sb-session-inbox",
        title: "Inbox upload behavior",
        slug: "inbox-upload",
        time: { updated: now - 35 * 60 * 1000, created: now - 6 * 60 * 60 * 1000 },
      },
    ],
  },
];

const workspaceConnectionStateById: Record<string, WorkspaceConnectionState> = {
  [localWorkspace.id]: { status: "connected", message: "Local engine ready" },
  [remoteWorkspace.id]: { status: "connected", message: "Connected via token" },
};

const sessionStatusById: Record<string, string> = {
  "sb-session-shell": "running",
  "sb-session-provider": "idle",
  "sb-session-mobile": "idle",
  "sb-session-remote": "idle",
  "sb-session-inbox": "idle",
};

const mcpStatuses: McpStatusMap = {
  "chrome-devtools": { status: "connected" },
  notion: { status: "connected" },
  linear: { status: "needs_auth" },
};

const workingFiles = [
  "apps/story-book/src/story-book.tsx",
  "apps/app/src/app/pages/session.tsx",
  "apps/app/src/app/components/session/workspace-session-list.tsx",
  "apps/app/src/app/components/session/inbox-panel.tsx",
];

const commandOptions: SlashCommandOption[] = [
  { id: "design-review", name: "design-review", description: "Open a design review pass", source: "command" },
  { id: "test-flow", name: "test-flow", description: "Run shell flow checks", source: "skill" },
];

const storyModels: Array<{
  ref: ModelRef;
  title: string;
  description: string;
  isConnected: boolean;
  model: ProviderListItem["models"][string];
}> = [
  {
    ref: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
    title: "Claude Sonnet 4.5",
    description: "Anthropic",
    isConnected: true,
    model: {
      id: "claude-sonnet-4-5-20250929",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      variants: { high: {}, max: {} },
    } as unknown as ProviderListItem["models"][string],
  },
  {
    ref: { providerID: "openai", modelID: "gpt-5" },
    title: "GPT-5",
    description: "OpenAI",
    isConnected: true,
    model: {
      id: "gpt-5",
      name: "GPT-5",
      reasoning: true,
      variants: { none: {}, minimal: {}, low: {}, medium: {}, high: {}, xhigh: {} },
    } as unknown as ProviderListItem["models"][string],
  },
  {
    ref: { providerID: "deepseek", modelID: "deepseek-r1" },
    title: "DeepSeek R1",
    description: "DeepSeek",
    isConnected: true,
    model: {
      id: "deepseek-r1",
      name: "DeepSeek R1",
      reasoning: true,
      variants: {},
    } as unknown as ProviderListItem["models"][string],
  },
  {
    ref: { providerID: "openrouter", modelID: "grok-4" },
    title: "Grok 4",
    description: "OpenRouter",
    isConnected: false,
    model: {
      id: "grok-4",
      name: "Grok 4",
      reasoning: false,
      variants: {},
    } as unknown as ProviderListItem["models"][string],
  },
];

const mockShareFields = [
  {
    label: "Worker URL",
    value: "https://worker.openworklabs.com/opencode",
    hint: "Paste this into Add worker -> Connect remote.",
  },
  {
    label: "Password",
    value: "ow_story_worker_owner_password_7f9a1b3c",
    secret: true,
    hint: "Use when the remote client must answer permission prompts.",
  },
  {
    label: "Collaborator token",
    value: "ow_story_worker_collab_token_1c4d2e8a",
    secret: true,
    hint: "Routine access when you do not need owner-only actions.",
  },
] as const;

const initialScheduledJobs: ScheduledJob[] = [
  {
    slug: "design-review-sweep",
    name: "Design review sweep",
    schedule: "30 9 * * 1,3,5",
    workdir: "/Users/benjaminshafii/openwork-enterprise/_repos/openwork",
    createdAt: new Date(now - 9 * 24 * 60 * 60 * 1000).toISOString(),
    lastRunAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    lastRunStatus: "success",
    source: "story-book",
    run: {
      prompt: "Review the Storybook shell changes and summarize layout regressions before lunch.",
      agent: "openwork-factory",
      model: "gpt-5",
      attachUrl: "https://share.openworklabs.com/runs/design-review-sweep",
    },
  },
  {
    slug: "worker-onboarding-smoke",
    name: "Worker onboarding smoke",
    schedule: "0 */6 * * *",
    workdir: "/Users/benjaminshafii/openwork-enterprise/_repos/openwork",
    createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
    lastRunAt: new Date(now - 90 * 60 * 1000).toISOString(),
    lastRunStatus: "running",
    source: "story-book",
    run: {
      command: "pnpm",
      arguments: "--filter @openwork/app test remote-onboarding",
      agent: "openwork-factory",
      model: "claude-sonnet-4-5",
    },
  },
];

const initialSkills: SkillCard[] = [
  {
    name: "workspace-guide",
    path: ".opencode/skills/workspace-guide/SKILL.md",
    description: "Guide users through workspace onboarding.",
    trigger: "workspace guide",
  },
  {
    name: "design-review",
    path: ".opencode/skills/design-review/SKILL.md",
    description: "Run a design review pass over the current shell.",
    trigger: "review this design",
  },
  {
    name: "test-flow",
    path: ".opencode/skills/test-flow/SKILL.md",
    description: "Exercise the Storybook flow before shipping.",
    trigger: "test the flow",
  },
];

const initialSkillContents: Record<string, string> = {
  "workspace-guide": "# Workspace Guide\n\nHelp users connect a worker, open settings, and understand the shell layout.",
  "design-review": "# Design Review\n\nReview the current screen for hierarchy, spacing, and state clarity.",
  "test-flow": "# Test Flow\n\nRun the visible Storybook flow and note any interaction regressions.",
};

const initialHubRepo: HubSkillRepo = {
  owner: "different-ai",
  repo: "openwork-hub",
  ref: "main",
};

const initialHubSkills: HubSkillCard[] = [
  {
    name: "worker-smoke",
    description: "Smoke-test remote worker setup and report any blockers.",
    trigger: "worker smoke",
    source: { owner: "different-ai", repo: "openwork-hub", ref: "main", path: "skills/worker-smoke/SKILL.md" },
  },
  {
    name: "share-review",
    description: "Review share links, field labeling, and copy clarity.",
    trigger: "share review",
    source: { owner: "different-ai", repo: "openwork-hub", ref: "main", path: "skills/share-review/SKILL.md" },
  },
];

const initialMcpServers: McpServerEntry[] = [
  {
    name: "notion",
    config: { type: "remote", url: "https://mcp.notion.com/mcp", enabled: true },
  },
  {
    name: "linear",
    config: { type: "remote", url: "https://mcp.linear.app/mcp", enabled: true },
  },
  {
    name: "chrome-devtools",
    config: { type: "local", command: ["npx", "-y", "chrome-devtools-mcp@latest"], enabled: true },
  },
];

function toMessageParts(id: string, role: "user" | "assistant", text: string): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "story-shell-session",
      role,
      time: { created: Date.now() },
    } as MessageWithParts["info"],
    parts: [{ type: "text", text } as MessageWithParts["parts"][number]],
  };
}

export default function NewLayoutApp() {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = createSignal(localWorkspace.id);
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>("sb-session-shell");

  const [themeMode] = createSignal<ThemeMode>(getInitialThemeMode());
  const [composerPrompt, setComposerPrompt] = createSignal(
    "Use this mock shell to design layout changes before touching the live session runtime.",
  );
  const [composerToast, setComposerToast] = createSignal<string | null>(null);
  const [selectedAgent, setSelectedAgent] = createSignal<string | null>(null);
  const [selectedModel, setSelectedModel] = createSignal<ModelRef>(storyModels[0].ref);
  const [modelVariant, setModelVariant] = createSignal<string | null>("medium");
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<"default" | "session">("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);
  const [createWorkspaceSubmitting, setCreateWorkspaceSubmitting] = createSignal(false);
  const [mockFolderPickCount, setMockFolderPickCount] = createSignal(0);
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] = createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<string | null>(null);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(null);
  const [messageRows, setMessageRows] = createSignal<MessageWithParts[]>(sessionMessages);
  const [expandedStepIds, setExpandedStepIds] = createSignal(new Set<string>());
  const [headerActionBusy, setHeaderActionBusy] = createSignal<"undo" | "redo" | "compact" | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
  const [commandPaletteMode, setCommandPaletteMode] = createSignal<CommandPaletteMode>("root");
  const [commandPaletteQuery, setCommandPaletteQuery] = createSignal("");
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] = createSignal(0);
  let commandPaletteInputEl: HTMLInputElement | undefined;
  const commandPaletteOptionRefs: HTMLButtonElement[] = [];
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>(initialScheduledJobs);
  const [skills, setSkills] = createSignal<SkillCard[]>(initialSkills);
  const [skillContents, setSkillContents] = createSignal<Record<string, string>>(initialSkillContents);
  const [hubRepo, setHubRepo] = createSignal<HubSkillRepo | null>(initialHubRepo);
  const [hubRepos, setHubRepos] = createSignal<HubSkillRepo[]>([initialHubRepo]);
  const [hubSkills] = createSignal<HubSkillCard[]>(initialHubSkills);
  const [pluginScope, setPluginScope] = createSignal<PluginScope>("project");
  const [pluginInput, setPluginInput] = createSignal("");
  const [pluginList, setPluginList] = createSignal<string[]>(["opencode-scheduler", "@openwork/browser-mcp"]);
  const [pluginStatus, setPluginStatus] = createSignal<string | null>("Sandbox plugin config loaded.");
  const [activePluginGuide, setActivePluginGuide] = createSignal<string | null>(null);
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>("notion");
  const [storyMcpServers, setStoryMcpServers] = createSignal<McpServerEntry[]>(initialMcpServers);
  const [storyMcpStatuses, setStoryMcpStatuses] = createSignal<McpStatusMap>(mcpStatuses);
  const [messagingModuleEnabled, setMessagingModuleEnabled] = createSignal(true);
  const [telegramIdentityRows, setTelegramIdentityRows] = createSignal([
    { id: "telegram-story", enabled: true, running: true, access: "private", pairingRequired: false },
  ]);
  const [slackIdentityRows, setSlackIdentityRows] = createSignal([
    { id: "slack-story", enabled: true, running: true },
  ]);
  const [routerAgentContent, setRouterAgentContent] = createSignal(
    "# OpenCodeRouter Messaging Agent\n\nKeep responses concise and route follow-ups to the right worker.",
  );
  const [routerAgentUpdatedAt, setRouterAgentUpdatedAt] = createSignal(now);

  const {
    leftSidebarWidth,
    startLeftSidebarResize,
  } = createWorkspaceShellLayout({ expandedRightWidth: 320 });

  createEffect(() => {
    const mode = themeMode();
    persistThemeMode(mode);
    applyThemeMode(mode);
  });

  createEffect(() => {
    const unsubscribeSystemTheme = subscribeToSystemTheme(() => {
      if (themeMode() === "system") {
        applyThemeMode("system");
      }
    });
    onCleanup(() => unsubscribeSystemTheme());
  });

  const selectedSessionTitle = createMemo(() => {
    const target = selectedSessionId();
    if (!target) return "New session";
    for (const group of workspaceSessionGroups) {
      const found = group.sessions.find((session) => session.id === target);
      if (found) return found.title;
    }
    return "New session";
  });
  const [showingSettings, setShowingSettings] = createSignal(false);
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general");

  const workspaceTabs = createMemo<SettingsTab[]>(() => [
    "general",
    "model",
    "automations",
    "skills",
    "extensions",
    "messaging",
    "advanced",
  ]);
  const globalTabs = createMemo<SettingsTab[]>(() => ["den", "appearance", "updates", "recovery", "debug"]);

  const tabLabel = (tab: SettingsTab) => {
    switch (tab) {
      case "den":
        return "Cloud";
      case "model":
        return "Model";
      case "automations":
        return "Automations";
      case "skills":
        return "Skills";
      case "extensions":
        return "Extensions";
      case "messaging":
        return "Messaging";
      case "advanced":
        return "Advanced";
      case "appearance":
        return "Appearance";
      case "updates":
        return "Updates";
      case "recovery":
        return "Recovery";
      case "debug":
        return "Debug";
      default:
        return "General";
    }
  };

  const tabDescription = (tab: SettingsTab) => {
    switch (tab) {
      case "den":
        return "Manage your OpenWork Cloud connection, hosted workers, and workspace access.";
      case "model":
        return "Tune the default model, runtime behavior, and assistant output settings.";
      case "automations":
        return "Review automation flows that used to live in the shell sidebar.";
      case "skills":
        return "Browse skill surfaces and pinned shortcuts for this workspace.";
      case "extensions":
        return "Inspect extension-style integrations for this workspace shell.";
      case "messaging":
        return "Keep messaging and inbox tools inside workspace settings instead of the right rail.";
      case "advanced":
        return "Inspect runtime health, connection state, and developer-facing controls.";
      case "appearance":
        return "Adjust how OpenWork looks across desktop, system theme, and app chrome.";
      case "updates":
        return "Keep the app current with quiet background checks and install controls.";
      case "recovery":
        return "Repair migration state, reset workspace defaults, and recover local settings.";
      case "debug":
        return "Review runtime diagnostics, logs, and low-level debugging utilities.";
      default:
        return "Connect providers, authorize folders, and control the active OpenWork workspace.";
    }
  };

  const settingsRailClass = "rounded-[24px] border border-dls-border bg-dls-sidebar p-3";
  const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
  const settingsPanelSoftClass = "rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4";

  const activeWorkspace = createMemo(
    () => workspaceSessionGroups.find((group) => group.workspace.id === selectedWorkspaceId())?.workspace ?? localWorkspace,
  );
  const shareWorkspace = createMemo(
    () => storyWorkspaces.find((workspace) => workspace.id === shareWorkspaceId()) ?? null,
  );
  const shareWorkspaceName = createMemo(
    () => shareWorkspace()?.displayName?.trim() || shareWorkspace()?.name?.trim() || "Workspace",
  );
  const shareWorkspaceDetail = createMemo(() => {
    const workspace = shareWorkspace();
    if (!workspace) return null;
    if (workspace.workspaceType === "remote") return workspace.baseUrl ?? workspace.path ?? null;
    return workspace.path ?? null;
  });
  const selectedWorkspaceRoot = createMemo(() => activeWorkspace().path?.trim() || "");

  const openChatWithPrompt = (prompt: string, toast?: string) => {
    setComposerPrompt(prompt);
    setShowingSettings(false);
    if (toast) setComposerToast(toast);
  };

  const refreshScheduledJobs = () => setComposerToast("Story-book: refreshed automations.");

  const deleteScheduledJob = async (name: string) => {
    setScheduledJobs((current) => current.filter((job) => job.slug !== name));
    setComposerToast(`Story-book: removed automation ${name}.`);
  };

  const createSessionAndOpen = () => {
    setShowingSettings(false);
    setComposerToast("Story-book: routed this action back to chat.");
  };

  const refreshSkills = () => setComposerToast("Story-book: refreshed skills.");
  const refreshHubSkills = () => setComposerToast("Story-book: refreshed hub skills.");

  const installSkillCreator = async () => {
    if (!skills().some((skill) => skill.name === "skill-creator")) {
      setSkills((current) => [
        ...current,
        {
          name: "skill-creator",
          path: ".opencode/skills/skill-creator/SKILL.md",
          description: "Create new skills from chat.",
          trigger: "create a skill",
        },
      ]);
      setSkillContents((current) => ({
        ...current,
        "skill-creator": "# Skill Creator\n\nCreate a new OpenCode skill from a prompt.",
      }));
    }
    return { ok: true, message: "Installed skill-creator in the Storybook sandbox." };
  };

  const installHubSkill = async (name: string) => {
    const hubSkill = initialHubSkills.find((item) => item.name === name);
    if (!hubSkill) return { ok: false, message: `Skill ${name} not found.` };
    if (!skills().some((skill) => skill.name === name)) {
      setSkills((current) => [
        ...current,
        {
          name: hubSkill.name,
          path: `.opencode/skills/${hubSkill.name}/SKILL.md`,
          description: hubSkill.description,
          trigger: hubSkill.trigger,
        },
      ]);
      setSkillContents((current) => ({
        ...current,
        [hubSkill.name]: `# ${hubSkill.name}\n\n${hubSkill.description ?? "Imported from the hub."}`,
      }));
    }
    return { ok: true, message: `Installed ${name} from the Storybook hub.` };
  };

  const addHubRepo = (repo: Partial<HubSkillRepo>) => {
    const next: HubSkillRepo = {
      owner: repo.owner?.trim() || initialHubRepo.owner,
      repo: repo.repo?.trim() || initialHubRepo.repo,
      ref: repo.ref?.trim() || initialHubRepo.ref,
    };
    setHubRepos((current) => {
      if (current.some((item) => item.owner === next.owner && item.repo === next.repo && item.ref === next.ref)) {
        return current;
      }
      return [...current, next];
    });
    setHubRepo(next);
  };

  const removeHubRepo = (repo: Partial<HubSkillRepo>) => {
    setHubRepos((current) =>
      current.filter((item) => !(item.owner === repo.owner && item.repo === repo.repo && item.ref === repo.ref)),
    );
    if (hubRepo()?.owner === repo.owner && hubRepo()?.repo === repo.repo && hubRepo()?.ref === repo.ref) {
      setHubRepo(initialHubRepo);
    }
  };

  const revealSkillsFolder = () => setComposerToast("Story-book: reveal skills folder is mocked.");

  const uninstallSkill = (name: string) => {
    setSkills((current) => current.filter((skill) => skill.name !== name));
    setSkillContents((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const readSkill = async (name: string) => {
    const skill = skills().find((item) => item.name === name);
    if (!skill) return null;
    return {
      name,
      path: skill.path,
      content: skillContents()[name] ?? `# ${name}\n\nStory-book skill content.`,
    };
  };

  const saveSkill = (input: { name: string; content: string; description?: string }) => {
    const path = `.opencode/skills/${input.name}/SKILL.md`;
    setSkills((current) => {
      const existing = current.find((skill) => skill.name === input.name);
      if (existing) {
        return current.map((skill) =>
          skill.name === input.name
            ? { ...skill, description: input.description ?? skill.description, path }
            : skill,
        );
      }
      return [...current, { name: input.name, path, description: input.description }];
    });
    setSkillContents((current) => ({ ...current, [input.name]: input.content }));
  };

  const importLocalSkill = () => {
    saveSkill({
      name: "imported-local-skill",
      content: "# Imported Local Skill\n\nThis came from the Storybook sandbox import action.",
      description: "Imported into the sandbox.",
    });
    setComposerToast("Story-book: imported a local skill.");
  };

  const refreshPlugins = (scopeOverride?: PluginScope) => {
    setPluginStatus(`Refreshed ${scopeOverride ?? pluginScope()} plugins in Storybook.`);
  };

  const isPluginInstalled = (name: string, aliases?: string[]) => {
    const installed = new Set(pluginList());
    if (installed.has(name)) return true;
    return (aliases ?? []).some((alias) => installed.has(alias));
  };

  const addPlugin = (pluginNameOverride?: string) => {
    const nextName = (pluginNameOverride ?? pluginInput()).trim();
    if (!nextName) return;
    if (!isPluginInstalled(nextName)) {
      setPluginList((current) => [...current, nextName]);
    }
    setPluginInput("");
    setPluginStatus(`${nextName} added in Storybook.`);
  };

  const removePlugin = (pluginName: string) => {
    setPluginList((current) => current.filter((item) => item !== pluginName));
    setPluginStatus(`${pluginName} removed in Storybook.`);
  };

  const refreshMcpServers = () => setComposerToast("Story-book: refreshed MCP servers.");

  const connectMcp = (entry: (typeof MCP_QUICK_CONNECT)[number]) => {
    const key = entry.id ?? entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!storyMcpServers().some((server) => server.name === key)) {
      setStoryMcpServers((current) => [
        ...current,
        {
          name: key,
          config: {
            type: entry.type ?? "remote",
            ...(entry.url ? { url: entry.url } : {}),
            ...(entry.command ? { command: entry.command } : {}),
            enabled: true,
          },
        },
      ]);
    }
    setStoryMcpStatuses((current) => ({ ...current, [key]: { status: entry.oauth ? "needs_auth" : "connected" } }));
    setSelectedMcp(key);
  };

  const authorizeMcp = (entry: McpServerEntry) => {
    setStoryMcpStatuses((current) => ({ ...current, [entry.name]: { status: "connected" } }));
  };

  const logoutMcpAuth = async (name: string) => {
    setStoryMcpStatuses((current) => ({ ...current, [name]: { status: "needs_auth" } }));
  };

  const removeMcp = (name: string) => {
    setStoryMcpServers((current) => current.filter((entry) => entry.name !== name));
    setStoryMcpStatuses((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    if (selectedMcp() === name) setSelectedMcp(null);
  };

  const buildRouterHealth = () => ({
    ok: true,
    opencode: {
      url: "https://worker.openworklabs.com/opencode",
      healthy: true,
      version: "0.1.0-story",
    },
    channels: {
      telegram: telegramIdentityRows().some((item) => item.enabled),
      whatsapp: false,
      slack: slackIdentityRows().some((item) => item.enabled),
    },
    config: {
      groupsEnabled: true,
    },
    activity: {
      dayStart: now - 12 * 60 * 60 * 1000,
      inboundToday: 4,
      outboundToday: 9,
      lastMessageAt: now - 12 * 60 * 1000,
    },
    agent: {
      scope: "workspace" as const,
      path: ".opencode/agents/opencode-router.md",
      loaded: true,
      selected: "openwork-router",
    },
  });

  const mockOpenworkServerClient = {
    getConfig: async () => ({ openwork: { messaging: { enabled: messagingModuleEnabled() } } }),
    getOpenCodeRouterHealth: async () => ({ ok: true, status: 200, json: buildRouterHealth() }),
    getOpenCodeRouterTelegramIdentities: async () => ({ ok: true, items: telegramIdentityRows() }),
    getOpenCodeRouterSlackIdentities: async () => ({ ok: true, items: slackIdentityRows() }),
    getOpenCodeRouterTelegram: async () => ({
      ok: true,
      configured: true,
      enabled: messagingModuleEnabled(),
      bot: { id: 1, username: "openwork_storybot", name: "OpenWork Story Bot" },
    }),
    readWorkspaceFile: async (_workspaceId: string, path: string) => ({
      path,
      content: routerAgentContent(),
      bytes: routerAgentContent().length,
      updatedAt: routerAgentUpdatedAt(),
    }),
    writeWorkspaceFile: async (_workspaceId: string, input: { path: string; content: string }) => {
      const updatedAt = Date.now();
      setRouterAgentContent(input.content);
      setRouterAgentUpdatedAt(updatedAt);
      return { ok: true, path: input.path, bytes: input.content.length, updatedAt };
    },
    sendOpenCodeRouterMessage: async (
      _workspaceId: string,
      input: { channel: string; text: string; directory?: string; peerId?: string },
    ) => ({
      ok: true,
      channel: input.channel,
      directory: input.directory ?? selectedWorkspaceRoot(),
      peerId: input.peerId,
      attempted: 1,
      sent: 1,
      reason: "Delivered by the Storybook sandbox client.",
    }),
    patchConfig: async (
      _workspaceId: string,
      payload: { openwork?: { messaging?: { enabled?: boolean } } },
    ) => {
      const enabled = payload.openwork?.messaging?.enabled;
      if (typeof enabled === "boolean") setMessagingModuleEnabled(enabled);
      return { ok: true };
    },
    upsertOpenCodeRouterTelegramIdentity: async (
      _workspaceId: string,
      input: { enabled: boolean; access?: "public" | "private"; pairingRequired?: boolean },
    ) => {
      const next = {
        id: "telegram-story",
        enabled: input.enabled,
        running: true,
        access: input.access ?? "private",
        pairingRequired: input.pairingRequired ?? false,
      };
      setTelegramIdentityRows([next]);
      return {
        ok: true,
        telegram: {
          id: next.id,
          enabled: next.enabled,
          access: next.access,
          pairingRequired: next.pairingRequired,
          pairingCode: next.pairingRequired ? "STORY42" : undefined,
          bot: { id: 1, username: "openwork_storybot", name: "OpenWork Story Bot" },
        },
      };
    },
    deleteOpenCodeRouterTelegramIdentity: async (_workspaceId: string, identityId: string) => {
      setTelegramIdentityRows((current) => current.filter((item) => item.id !== identityId));
      return { ok: true, telegram: { id: identityId, deleted: true } };
    },
    upsertOpenCodeRouterSlackIdentity: async (_workspaceId: string, input: { enabled: boolean }) => {
      const next = { id: "slack-story", enabled: input.enabled, running: true };
      setSlackIdentityRows([next]);
      return { ok: true, slack: { id: next.id, enabled: next.enabled } };
    },
    deleteOpenCodeRouterSlackIdentity: async (_workspaceId: string, identityId: string) => {
      setSlackIdentityRows((current) => current.filter((item) => item.id !== identityId));
      return { ok: true, slack: { id: identityId, deleted: true } };
    },
  } as unknown as OpenworkServerClient;

  const agentLabel = createMemo(() => {
    const name = selectedAgent() ?? "Default agent";
    return name.charAt(0).toUpperCase() + name.slice(1);
  });

  const selectedStoryModel = createMemo(
    () => storyModels.find((entry) => entry.ref.providerID === selectedModel().providerID && entry.ref.modelID === selectedModel().modelID)
      ?? storyModels[0],
  );

  const selectedBehavior = createMemo(() =>
    getModelBehaviorSummary(
      selectedStoryModel().ref.providerID,
      selectedStoryModel().model,
      modelVariant(),
    ),
  );

  const selectedModelLabel = createMemo(() => selectedStoryModel().title);

  const storyModelOptions = createMemo<ModelOption[]>(() =>
    storyModels.map((entry) => {
      const behavior = getModelBehaviorSummary(entry.ref.providerID, entry.model, modelVariant());
      return {
        providerID: entry.ref.providerID,
        modelID: entry.ref.modelID,
        title: entry.title,
        description: entry.description,
        footer: entry.ref.providerID === selectedModel().providerID && entry.ref.modelID === selectedModel().modelID
          ? "Current model"
          : undefined,
        behaviorTitle: behavior.title,
        behaviorLabel: behavior.label,
        behaviorDescription: behavior.description,
        behaviorValue: sanitizeModelBehaviorValue(entry.ref.providerID, entry.model, modelVariant()),
        behaviorOptions: behavior.options,
        isFree: false,
        isConnected: entry.isConnected,
        isRecommended: entry.title.includes("GPT-5") || entry.title.includes("Claude") || entry.title.includes("DeepSeek"),
      };
    }),
  );

  const filteredStoryModelOptions = createMemo(() => {
    const query = modelPickerQuery().trim().toLowerCase();
    if (!query) return storyModelOptions();
    return storyModelOptions().filter((option) =>
      [
        option.title,
        option.description ?? "",
        option.footer ?? "",
        option.behaviorTitle,
        option.behaviorLabel,
        option.behaviorDescription,
        `${option.providerID}/${option.modelID}`,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  });

  const openModelPicker = (target: "default" | "session" = "session") => {
    setModelPickerTarget(target);
    setModelPickerQuery("");
    setModelPickerOpen(true);
  };

  const openMockCreateWorkspaceModal = () => {
    setCreateWorkspaceSubmitting(false);
    setCreateWorkspaceOpen(true);
  };

  const pickMockWorkspaceFolder = async () => {
    const folders = [
      "/Users/demo/OpenWork/client-foundation",
      "/Users/demo/OpenWork/automation-lab",
      "/Users/demo/OpenWork/starter-sandbox",
    ];
    const next = folders[mockFolderPickCount() % folders.length] ?? folders[0];
    setMockFolderPickCount((count) => count + 1);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return next;
  };

  const confirmMockWorkspaceCreate = (preset: WorkspacePreset, folder: string | null) => {
    if (!folder || createWorkspaceSubmitting()) return;
    setCreateWorkspaceSubmitting(true);
    window.setTimeout(() => {
      setCreateWorkspaceSubmitting(false);
      setCreateWorkspaceOpen(false);
      setComposerToast(`Story-book: create workspace is mocked with preset \"${preset}\" at ${folder}.`);
    }, 320);
  };

  const applyStoryModelSelection = (next: ModelRef) => {
    const entry = storyModels.find((item) => item.ref.providerID === next.providerID && item.ref.modelID === next.modelID);
    setSelectedModel(next);
    if (entry) {
      setModelVariant(sanitizeModelBehaviorValue(next.providerID, entry.model, modelVariant()) ?? null);
    }
    setModelPickerOpen(false);
  };

  const handleDraftChange = (draft: ComposerDraft) => {
    setComposerPrompt(draft.text);
  };

  const handleSend = (draft: ComposerDraft) => {
    const text = (draft.resolvedText ?? draft.text ?? "").trim();
    if (!text) return;
    const nowStamp = Date.now();
    setMessageRows((current) => [
      ...current,
      toMessageParts(`sb-user-${nowStamp}`, "user", text),
      toMessageParts(
        `sb-assistant-${nowStamp}`,
        "assistant",
        "Story-book mock response: message accepted. This uses app MessageList + Composer with local mock state.",
      ),
    ]);
    setComposerPrompt("");
  };

  const runMockHeaderAction = (action: "undo" | "redo" | "compact", label: string) => {
    if (headerActionBusy()) return;
    setHeaderActionBusy(action);
    setComposerToast(`Story-book: ${label} is mocked in this shell.`);
    window.setTimeout(() => setHeaderActionBusy(null), 240);
  };

  const openMockShareModal = (workspaceId?: string | null) => {
    const nextId = workspaceId?.trim() || selectedWorkspaceId();
    setShareWorkspaceId(nextId);
    setShareWorkspaceProfileUrl(null);
    setShareSkillsSetUrl(null);
  };

  const publishMockWorkspaceProfile = () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    window.setTimeout(() => {
      const workspace = shareWorkspace();
      const slug = (workspace?.name || "workspace").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      setShareWorkspaceProfileUrl(`https://share.openworklabs.com/workspaces/${slug || "workspace"}`);
      setShareWorkspaceProfileBusy(false);
    }, 260);
  };

  const publishMockSkillsSet = () => {
    if (shareSkillsSetBusy()) return;
    setShareSkillsSetBusy(true);
    window.setTimeout(() => {
      const workspace = shareWorkspace();
      const slug = (workspace?.name || "workspace").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      setShareSkillsSetUrl(`https://share.openworklabs.com/skills/${slug || "workspace"}`);
      setShareSkillsSetBusy(false);
    }, 260);
  };

  const totalSessionCount = createMemo(() =>
    workspaceSessionGroups.reduce((count, group) => count + group.sessions.length, 0),
  );

  const commandPaletteSessionOptions = createMemo(() => {
    const out: Array<{
      workspaceId: string;
      sessionId: string;
      title: string;
      workspaceTitle: string;
      updatedAt: number;
      searchText: string;
    }> = [];

    for (const group of workspaceSessionGroups) {
      const workspaceId = group.workspace.id?.trim() ?? "";
      if (!workspaceId) continue;
      const workspaceTitle = group.workspace.displayName?.trim() || group.workspace.name;
      for (const session of group.sessions) {
        const sessionId = session.id?.trim() ?? "";
        if (!sessionId) continue;
        const title = session.title;
        const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
        out.push({
          workspaceId,
          sessionId,
          title,
          workspaceTitle,
          updatedAt,
          searchText: `${title} ${workspaceTitle}`.toLowerCase(),
        });
      }
    }

    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  });

  const focusCommandPaletteInput = () => {
    queueMicrotask(() => {
      commandPaletteInputEl?.focus();
      commandPaletteInputEl?.select();
    });
  };

  const openCommandPalette = (mode: CommandPaletteMode = "root") => {
    setCommandPaletteMode(mode);
    setCommandPaletteOpen(true);
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    focusCommandPaletteInput();
  };

  const closeCommandPalette = () => {
    setCommandPaletteOpen(false);
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
  };

  const returnToCommandRoot = () => {
    if (commandPaletteMode() === "root") return;
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    focusCommandPaletteInput();
  };

  const commandPaletteRootItems = createMemo<CommandPaletteItem[]>(() => {
    const selectedTitle = selectedSessionTitle().trim() || "Give your selected session a clearer name";
    const items: CommandPaletteItem[] = [
      {
        id: "new-session",
        title: "Create new session",
        detail: "Start a fresh task in the current workspace",
        meta: "Create",
        action: () => {
          closeCommandPalette();
          setComposerToast("Story-book: create new session is mocked in this shell.");
        },
      },
      {
        id: "workspace",
        title: "Create workspace",
        detail: "Open the real workspace-creation modal in the shell",
        meta: "Open",
        action: () => {
          closeCommandPalette();
          openMockCreateWorkspaceModal();
        },
      },
      {
        id: "rename-session",
        title: "Rename current session",
        detail: selectedTitle,
        meta: "Rename",
        action: () => {
          closeCommandPalette();
          setComposerToast("Story-book: rename session flow is mocked in this shell.");
        },
      },
      {
        id: "sessions",
        title: "Search sessions",
        detail: `${totalSessionCount().toLocaleString()} available across workspaces`,
        meta: "Jump",
        action: () => {
          setCommandPaletteMode("sessions");
          setCommandPaletteQuery("");
          setCommandPaletteActiveIndex(0);
          focusCommandPaletteInput();
        },
      },
      {
        id: "model",
        title: "Change model",
        detail: `${selectedModelLabel()} · ${selectedBehavior().label}`,
        meta: "Open",
        action: () => {
          closeCommandPalette();
          openModelPicker("session");
        },
      },
      {
        id: "provider",
        title: "Connect provider",
        detail: "Open provider connection flow",
        meta: "Open",
        action: () => {
          closeCommandPalette();
          setComposerToast("Story-book: provider connection flow is mocked in this shell.");
        },
      },
      {
        id: "settings",
        title: "Open settings",
        detail: "Show the real settings panel in the shell",
        meta: "Open",
        action: () => {
          closeCommandPalette();
          setShowingSettings(true);
        },
      },
      {
        id: "share",
        title: "Share current workspace",
        detail: activeWorkspace().displayName ?? activeWorkspace().name,
        meta: "Share",
        action: () => {
          closeCommandPalette();
          openMockShareModal(selectedWorkspaceId());
        },
      },
    ];

    const query = commandPaletteQuery().trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => `${item.title} ${item.detail ?? ""}`.toLowerCase().includes(query));
  });

  const commandPaletteSessionItems = createMemo<CommandPaletteItem[]>(() => {
    const query = commandPaletteQuery().trim().toLowerCase();
    const candidates = query
      ? commandPaletteSessionOptions().filter((item) => item.searchText.includes(query))
      : commandPaletteSessionOptions();

    return candidates.slice(0, 80).map((item) => ({
      id: `session:${item.workspaceId}:${item.sessionId}`,
      title: item.title,
      detail: item.workspaceTitle,
      meta: item.workspaceId === selectedWorkspaceId() ? "Current workspace" : "Switch",
      action: () => {
        closeCommandPalette();
        setSelectedWorkspaceId(item.workspaceId);
        setSelectedSessionId(item.sessionId);
      },
    }));
  });

  const commandPaletteItems = createMemo<CommandPaletteItem[]>(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return commandPaletteSessionItems();
    return commandPaletteRootItems();
  });

  const commandPaletteTitle = createMemo(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return "Search sessions";
    return "Quick actions";
  });

  const commandPalettePlaceholder = createMemo(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return "Find by session title or workspace";
    return "Search actions";
  });

  const runCommandPaletteItem = (item: CommandPaletteItem) => {
    closeCommandPalette();
    item.action();
  };

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (commandPaletteOpen()) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
        return;
      }

      if (!commandPaletteOpen()) return;

      if (event.key === "Escape") {
        event.preventDefault();
        closeCommandPalette();
        return;
      }

      if (event.key === "Backspace" && !commandPaletteQuery().trim() && commandPaletteMode() !== "root") {
        event.preventDefault();
        returnToCommandRoot();
        return;
      }

      const items = commandPaletteItems();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!items.length) return;
        setCommandPaletteActiveIndex((index) => (index + 1) % items.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!items.length) return;
        setCommandPaletteActiveIndex((index) => (index - 1 + items.length) % items.length);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const item = items[commandPaletteActiveIndex()];
        if (!item) return;
        runCommandPaletteItem(item);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  createEffect(() => {
    const items = commandPaletteItems();
    const index = commandPaletteActiveIndex();
    if (items.length === 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    if (index >= items.length) {
      setCommandPaletteActiveIndex(items.length - 1);
    }
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const index = commandPaletteActiveIndex();
    queueMicrotask(() => {
      commandPaletteOptionRefs[index]?.scrollIntoView({ block: "nearest" });
    });
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    commandPaletteMode();
    commandPaletteQuery();
    commandPaletteOptionRefs.length = 0;
    setCommandPaletteActiveIndex(0);
  });



  return (
    <div class="h-[100dvh] min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] p-3 md:p-4 text-gray-12 font-sans">
      <div class="flex h-full w-full gap-3 md:gap-4">
        <aside
          class="relative hidden lg:flex shrink-0 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar p-2.5"
          style={{
            width: `${leftSidebarWidth()}px`,
            "min-width": `${leftSidebarWidth()}px`,
          }}
        >
          <div class="min-h-0 flex-1">
            <WorkspaceSessionList
              developerMode
              workspaceSessionGroups={workspaceSessionGroups}
              selectedWorkspaceId={selectedWorkspaceId()}
              selectedSessionId={selectedSessionId()}
              showSessionActions
              sessionStatusById={sessionStatusById}
              connectingWorkspaceId={null}
              workspaceConnectionStateById={workspaceConnectionStateById}
              newTaskDisabled={false}
              importingWorkspaceConfig={false}
              onSelectWorkspace={(workspaceId) => {
                setSelectedWorkspaceId(workspaceId);
                return true;
              }}
              onOpenSession={(workspaceId, sessionId) => {
                setSelectedWorkspaceId(workspaceId);
                setSelectedSessionId(sessionId);
              }}
              onCreateTaskInWorkspace={(workspaceId) => {
                setSelectedWorkspaceId(workspaceId);
              }}
              onOpenRenameSession={() => undefined}
              onOpenDeleteSession={() => undefined}
              onOpenRenameWorkspace={() => undefined}
              onShareWorkspace={(workspaceId) => openMockShareModal(workspaceId)}
              onRevealWorkspace={() => undefined}
              onRecoverWorkspace={() => true}
              onTestWorkspaceConnection={() => true}
              onEditWorkspaceConnection={() => undefined}
              onForgetWorkspace={() => undefined}
              onOpenCreateWorkspace={() => openMockCreateWorkspaceModal()}
              onOpenCreateRemoteWorkspace={() => undefined}
              onImportWorkspaceConfig={() => undefined}
            />
          </div>
          <div
            class="absolute right-0 top-3 hidden h-[calc(100%-24px)] w-2 translate-x-1/2 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-gray-6/40 lg:block"
            onPointerDown={startLeftSidebarResize}
            title="Resize workspace column"
            aria-label="Resize workspace column"
          />
        </aside>

        <main class="min-w-0 flex-1 flex flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
          <header class="z-10 flex h-12 shrink-0 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6">
            <div class="flex min-w-0 items-center gap-3">
              <h1 class="truncate text-[15px] font-semibold text-dls-text">
                {showingSettings() ? "Settings" : selectedSessionTitle()}
              </h1>
              <Show when={showingSettings()}>
                <span class="hidden truncate text-[13px] text-dls-secondary lg:inline">
                  {activeWorkspace().displayName ?? activeWorkspace().name}
                </span>
              </Show>
            </div>

            <div class="flex items-center gap-1.5 text-gray-10">
              <button
                type="button"
                class="hidden items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text sm:flex"
                onClick={() => openCommandPalette()}
                title="Open command palette"
                aria-label="Open command palette"
              >
                <span>Palette</span>
                <span class="ml-1 rounded border border-dls-border px-1 text-[10px] text-gray-9">⌘K</span>
              </button>
              <button
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
                onClick={() => setComposerToast("Story-book: search is mocked in this shell.")}
                title="Search conversation (Ctrl/Cmd+F)"
                aria-label="Search conversation"
              >
                <Search size={16} />
              </button>
              <div class="hidden h-4 w-px bg-dls-border sm:block" />
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => runMockHeaderAction("undo", "undo")}
                disabled={headerActionBusy() !== null}
                title="Undo last message"
                aria-label="Undo last message"
              >
                <Show when={headerActionBusy() === "undo"} fallback={<Undo2 size={16} />}>
                  <span class="h-4 w-4 animate-spin rounded-full border-2 border-gray-8 border-t-transparent" />
                </Show>
                <span class="hidden lg:inline">Revert</span>
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => runMockHeaderAction("redo", "redo")}
                disabled={headerActionBusy() !== null}
                title="Redo last reverted message"
                aria-label="Redo last reverted message"
              >
                <Show when={headerActionBusy() === "redo"} fallback={<Redo2 size={16} />}>
                  <span class="h-4 w-4 animate-spin rounded-full border-2 border-gray-8 border-t-transparent" />
                </Show>
                <span class="hidden lg:inline">Redo</span>
              </button>
              <Show when={showingSettings()}>
                <div class="hidden h-4 w-px bg-dls-border sm:block" />
                <button
                  type="button"
                  class="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
                  onClick={() => setShowingSettings(false)}
                  title="Close settings"
                  aria-label="Close settings"
                >
                  <X size={18} />
                </button>
              </Show>
            </div>
          </header>

          <div class="flex-1 min-h-0 overflow-hidden">
            <div class="h-full overflow-y-auto bg-dls-surface px-4 pt-6 pb-4 sm:px-6 lg:px-10">
              <div class={showingSettings() ? "w-full" : "mx-auto w-full max-w-[800px]"}>
                <Show
                  when={showingSettings()}
                  fallback={
                    <MessageList
                      messages={messageRows()}
                      developerMode
                      showThinking={false}
                      isStreaming={false}
                      expandedStepIds={expandedStepIds()}
                      setExpandedStepIds={(updater) => setExpandedStepIds((current) => updater(current))}
                      workspaceRoot="/Users/benjaminshafii/openwork-enterprise/_repos/openwork"
                    />
                  }
                >
                  <section class="space-y-6 md:grid md:grid-cols-[220px_minmax(0,1fr)] md:gap-8 md:space-y-0">
                    <aside class="space-y-6 md:sticky md:top-4 md:self-start">
                      <div class={settingsRailClass}>
                        <div class="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-8">
                          Workspace
                        </div>
                        <div class="space-y-1">
                          <For each={workspaceTabs()}>
                            {(tab) => (
                              <button
                                type="button"
                                class={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors ${
                                  settingsTab() === tab
                                    ? "bg-dls-surface text-dls-text shadow-sm"
                                    : "text-gray-10 hover:bg-dls-surface/50 hover:text-dls-text"
                                }`}
                                onClick={() => setSettingsTab(tab)}
                              >
                                <span>{tabLabel(tab)}</span>
                              </button>
                            )}
                          </For>
                        </div>
                      </div>

                      <div class={settingsRailClass}>
                        <div class="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-8">
                          Global
                        </div>
                        <div class="space-y-1">
                          <For each={globalTabs()}>
                            {(tab) => (
                              <button
                                type="button"
                                class={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors ${
                                  settingsTab() === tab
                                    ? "bg-dls-surface text-dls-text shadow-sm"
                                    : "text-gray-10 hover:bg-dls-surface/50 hover:text-dls-text"
                                }`}
                                onClick={() => setSettingsTab(tab)}
                              >
                                <span>{tabLabel(tab)}</span>
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    </aside>

                    <div class="min-w-0 space-y-6">
                      <div class={`${settingsPanelClass} flex flex-col gap-3 md:flex-row md:items-center md:justify-between`}>
                        <div class="space-y-1">
                          <h2 class="text-lg font-semibold tracking-tight text-gray-12">
                            {tabLabel(settingsTab())}
                          </h2>
                          <p class="text-sm text-gray-9">
                            {tabDescription(settingsTab())}
                          </p>
                        </div>
                      </div>

                      <Show when={settingsTab() === "general"}>
                        <div class={`${settingsPanelSoftClass} text-sm text-dls-secondary`}>
                          General settings view mocked here.
                        </div>
                      </Show>

                      <Show when={settingsTab() === "automations"}>
                        <AutomationsView
                          jobs={scheduledJobs()}
                          source="remote"
                          sourceReady={true}
                          status="Story-book sandbox schedules loaded."
                          busy={false}
                          lastUpdatedAt={now}
                          refreshJobs={refreshScheduledJobs}
                          deleteJob={deleteScheduledJob}
                          isWindows={false}
                          selectedWorkspaceRoot={selectedWorkspaceRoot()}
                          createSessionAndOpen={createSessionAndOpen}
                          setPrompt={(value) => openChatWithPrompt(value, "Automation draft moved to chat.")}
                          newTaskDisabled={false}
                          schedulerInstalled={true}
                          canEditPlugins={true}
                          addPlugin={addPlugin}
                          reloadWorkspaceEngine={async () => {
                            setComposerToast("Story-book: reloaded workspace engine.");
                          }}
                          reloadBusy={false}
                          canReloadWorkspace
                        />
                      </Show>

                      <Show when={settingsTab() === "skills"}>
                        <div class="rounded-[20px] border border-dls-border bg-dls-surface p-6 text-[14px] text-dls-secondary">
                          Skills (installed, team catalog, GitHub hub) runs in the full app with{" "}
                          <code class="rounded bg-dls-hover px-1 py-0.5 font-mono text-[12px]">ExtensionsProvider</code>.
                          Use the OpenWork app shell to exercise this surface.
                        </div>
                      </Show>

                      <Show when={settingsTab() === "extensions"}>
                        <ExtensionsView
                          initialSection="all"
                          setDashboardTab={() => undefined}
                          busy={false}
                          selectedWorkspaceRoot={selectedWorkspaceRoot()}
                          isRemoteWorkspace={activeWorkspace().workspaceType === "remote"}
                          refreshMcpServers={refreshMcpServers}
                          mcpServers={storyMcpServers()}
                          mcpStatus="Story-book MCP sandbox ready."
                          mcpLastUpdatedAt={now}
                          mcpConnectingName={null}
                          selectedMcp={selectedMcp()}
                          setSelectedMcp={setSelectedMcp}
                          quickConnect={MCP_QUICK_CONNECT}
                          connectMcp={connectMcp}
                          authorizeMcp={authorizeMcp}
                          logoutMcpAuth={logoutMcpAuth}
                          removeMcp={removeMcp}
                          showMcpReloadBanner={false}
                          reloadBlocked={false}
                          reloadMcpEngine={() => setComposerToast("Story-book: reloaded MCP engine.")}
                          canEditPlugins={true}
                          canUseGlobalScope={true}
                          accessHint={null}
                          pluginScope={pluginScope()}
                          setPluginScope={setPluginScope}
                          pluginConfigPath={`${selectedWorkspaceRoot() || "."}/opencode.json`}
                          pluginList={pluginList()}
                          pluginInput={pluginInput()}
                          setPluginInput={setPluginInput}
                          pluginStatus={pluginStatus()}
                          activePluginGuide={activePluginGuide()}
                          setActivePluginGuide={setActivePluginGuide}
                          isPluginInstalled={isPluginInstalled}
                          suggestedPlugins={SUGGESTED_PLUGINS}
                          refreshPlugins={refreshPlugins}
                          addPlugin={addPlugin}
                          removePlugin={removePlugin}
                        />
                      </Show>

                      <Show when={settingsTab() === "messaging"}>
                        <div class="space-y-4">
                          <IdentitiesView
                            busy={false}
                            openworkServerStatus="connected"
                            openworkServerUrl="https://worker.openworklabs.com/opencode"
                            openworkServerClient={mockOpenworkServerClient}
                            openworkReconnectBusy={false}
                            reconnectOpenworkServer={async () => true}
                            restartLocalServer={async () => true}
                            runtimeWorkspaceId={selectedWorkspaceId()}
                            selectedWorkspaceRoot={selectedWorkspaceRoot()}
                            developerMode
                          />
                          <Show when={selectedWorkspaceId() === remoteWorkspace.id}>
                            <div class="rounded-[20px] border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)] text-sm text-dls-secondary">
                              Remote inbox preview has been removed from the app shell.
                            </div>
                          </Show>
                          <Show when={selectedWorkspaceId() !== remoteWorkspace.id}>
                            <div class={`${settingsPanelSoftClass} text-sm text-dls-secondary`}>
                              Switch to the remote workspace to preview the inbox panel inside Messaging.
                            </div>
                          </Show>
                        </div>
                      </Show>

                      <Show when={settingsTab() === "den"}>
                        <DenSettingsPanel
                          developerMode
                          connectRemoteWorkspace={async () => true}
                          openTeamBundle={async () => {}}
                        />
                      </Show>

                      <Show when={settingsTab() === "model"}>
                        <div class="space-y-4">
                          <div class="rounded-[20px] border border-dls-border bg-dls-surface p-4 shadow-[var(--dls-card-shadow)] space-y-3">
                            <div>
                              <div class="text-sm font-medium text-dls-text">Model preferences</div>
                              <div class="text-xs text-dls-secondary mt-1">
                                This preview mirrors the default model and reasoning controls from the app picker.
                              </div>
                            </div>
                            <div class="rounded-2xl border border-dls-border bg-dls-sidebar px-4 py-3 flex items-center justify-between gap-3">
                              <div class="min-w-0">
                                <div class="text-sm text-dls-text truncate">{selectedModelLabel()}</div>
                                <div class="text-xs text-dls-secondary truncate">
                                  {selectedModel().providerID}/{selectedModel().modelID}
                                </div>
                              </div>
                              <Button variant="outline" onClick={() => openModelPicker("default")}>
                                Open picker
                              </Button>
                            </div>
                            <div class="rounded-2xl border border-dls-border bg-dls-sidebar px-4 py-3">
                              <div class="text-sm text-dls-text">{selectedBehavior().title}</div>
                              <div class="mt-1 text-xs font-medium text-dls-text">{selectedBehavior().label}</div>
                              <div class="mt-1 text-xs text-dls-secondary">{selectedBehavior().description}</div>
                            </div>
                          </div>
                        </div>
                      </Show>

                      <Show when={settingsTab() === "advanced"}>
                        <div class={`${settingsPanelSoftClass} text-sm text-dls-secondary`}>
                          Advanced settings view mocked here.
                        </div>
                      </Show>

                      <Show when={settingsTab() === "appearance"}>
                        <div class={`${settingsPanelSoftClass} text-sm text-dls-secondary`}>
                          Appearance settings view mocked here.
                        </div>
                      </Show>

                      <Show when={settingsTab() === "updates"}>
                        <div class={`${settingsPanelSoftClass} text-sm text-dls-secondary`}>
                          Updates settings view mocked here.
                        </div>
                      </Show>

                      <Show when={settingsTab() === "recovery"}>
                        <div class={`${settingsPanelSoftClass} text-sm text-dls-secondary`}>
                          Recovery settings view mocked here.
                        </div>
                      </Show>

                      <Show when={settingsTab() === "debug"}>
                        <div class={`${settingsPanelSoftClass} text-sm text-dls-secondary`}>
                          Debug settings view mocked here.
                        </div>
                      </Show>
                    </div>
                  </section>
                </Show>
              </div>
            </div>
          </div>

          <Show when={!showingSettings()}>
            <Composer
              prompt={composerPrompt()}
              draftMode="prompt"
              draftScopeKey="story-book-new-layout-composer"
              developerMode
              busy={false}
              isStreaming={false}
              onSend={handleSend}
              onStop={() => undefined}
              onDraftChange={handleDraftChange}
              selectedModelLabel={selectedModelLabel()}
              onModelClick={() => openModelPicker("session")}
              modelVariantLabel={`${selectedBehavior().title} · ${selectedBehavior().label}`}
              modelVariant={modelVariant()}
              modelBehaviorOptions={selectedBehavior().options}
              onModelVariantChange={(value) => setModelVariant(value)}
              agentLabel={agentLabel()}
              selectedAgent={selectedAgent()}
              agentPickerOpen={agentPickerOpen()}
              agentPickerBusy={false}
              agentPickerError={null}
              agentOptions={[]}
              onToggleAgentPicker={() => setAgentPickerOpen((current) => !current)}
              onSelectAgent={(agent) => {
                setSelectedAgent(agent);
                setAgentPickerOpen(false);
              }}
              setAgentPickerRef={() => undefined}
              notice={composerToast() ? { title: composerToast() } : null}
              onNotice={(notice) => setComposerToast(notice.title)}
              listAgents={async () => []}
              recentFiles={workingFiles}
              searchFiles={async (query) => {
                const normalized = query.trim().toLowerCase();
                if (!normalized) return workingFiles.slice(0, 8);
                return workingFiles.filter((path) => path.toLowerCase().includes(normalized)).slice(0, 8);
              }}
              isRemoteWorkspace={selectedWorkspaceId() === remoteWorkspace.id}
              isSandboxWorkspace={selectedWorkspaceId() === remoteWorkspace.id}
              attachmentsEnabled
              attachmentsDisabledReason={null}
              skills={[]}
              listCommands={async () => commandOptions}
              onOpenSettings={() => undefined}
            />
          </Show>

          <StatusBar
            clientConnected
            openworkServerStatus="connected"
            developerMode
            settingsOpen={showingSettings()}
            showSettingsButton={true}
            onSendFeedback={() => undefined}
            onOpenSettings={() => {
              setSettingsTab("general");
              setShowingSettings((prev) => !prev);
            }}
            providerConnectedIds={["anthropic", "openai"]}
            statusLabel="Session Ready"
          />
        </main>
      </div>

      <Show when={commandPaletteOpen()}>
        <div
          class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
          onClick={closeCommandPalette}
        >
          <div
            class="w-full max-w-2xl mt-12 rounded-2xl border border-dls-border bg-dls-surface shadow-2xl overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="border-b border-dls-border px-4 py-3 space-y-2">
              <div class="flex items-center gap-2">
                <Show when={commandPaletteMode() !== "root"}>
                  <button
                    type="button"
                    class="h-8 px-2 rounded-md text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                    onClick={returnToCommandRoot}
                  >
                    Back
                  </button>
                </Show>
                <Search size={14} class="text-dls-secondary shrink-0" />
                <input
                  ref={(el) => (commandPaletteInputEl = el)}
                  type="text"
                  value={commandPaletteQuery()}
                  onInput={(event) => {
                    setCommandPaletteQuery(event.currentTarget.value);
                    setCommandPaletteActiveIndex(0);
                  }}
                  placeholder={commandPalettePlaceholder()}
                  class="min-w-0 flex-1 bg-transparent text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
                  aria-label={commandPaletteTitle()}
                />
                <button
                  type="button"
                  class="h-8 w-8 flex items-center justify-center rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                  onClick={closeCommandPalette}
                  aria-label="Close quick actions"
                >
                  <X size={14} />
                </button>
              </div>
              <div class="text-[11px] text-dls-secondary">{commandPaletteTitle()}</div>
            </div>

            <div class="max-h-[56vh] overflow-y-auto p-2">
              <Show
                when={commandPaletteItems().length > 0}
                fallback={<div class="px-3 py-6 text-sm text-dls-secondary text-center">No matches.</div>}
              >
                <For each={commandPaletteItems()}>
                  {(item, idx) => (
                    <button
                      ref={(el) => {
                        commandPaletteOptionRefs[idx()] = el;
                      }}
                      type="button"
                      class={`w-full text-left rounded-xl px-3 py-2.5 transition-colors ${
                        idx() === commandPaletteActiveIndex()
                          ? "bg-dls-active text-dls-text"
                          : "text-dls-text hover:bg-dls-hover"
                      }`}
                      onMouseEnter={() => setCommandPaletteActiveIndex(idx())}
                      onClick={() => runCommandPaletteItem(item)}
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-sm font-medium truncate">{item.title}</div>
                          <Show when={item.detail}>
                            <div class="text-xs text-dls-secondary mt-1 truncate">{item.detail}</div>
                          </Show>
                        </div>
                        <Show when={item.meta}>
                          <span class="text-[10px] uppercase tracking-wide text-dls-secondary shrink-0">
                            {item.meta}
                          </span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </div>

            <div class="border-t border-dls-border px-3 py-2 text-[11px] text-dls-secondary flex items-center justify-between gap-2">
              <span>Arrow keys to navigate</span>
              <span>Enter to run · Esc to close</span>
            </div>
          </div>
        </div>
      </Show>

      <ShareWorkspaceModal
        open={Boolean(shareWorkspaceId())}
        onClose={() => setShareWorkspaceId(null)}
        workspaceName={shareWorkspaceName()}
        workspaceDetail={shareWorkspaceDetail()}
        fields={[...mockShareFields]}
        note="This is the real share modal from the app, mounted with safe mock values for shell review."
        onShareWorkspaceProfile={publishMockWorkspaceProfile}
        shareWorkspaceProfileBusy={shareWorkspaceProfileBusy()}
        shareWorkspaceProfileUrl={shareWorkspaceProfileUrl()}
        shareWorkspaceProfileError={null}
        shareWorkspaceProfileDisabledReason={null}
        onShareSkillsSet={publishMockSkillsSet}
        shareSkillsSetBusy={shareSkillsSetBusy()}
        shareSkillsSetUrl={shareSkillsSetUrl()}
        shareSkillsSetError={null}
        shareSkillsSetDisabledReason={null}
        onExportConfig={() => setComposerToast("Story-book: export config is mocked in this shell.")}
        exportDisabledReason={null}
        onOpenBots={() => setComposerToast("Story-book: bots sharing flow is mocked in this shell.")}
      />

      <CreateWorkspaceModal
        open={createWorkspaceOpen()}
        onClose={() => {
          if (createWorkspaceSubmitting()) return;
          setCreateWorkspaceOpen(false);
        }}
        onConfirm={confirmMockWorkspaceCreate}
        onPickFolder={pickMockWorkspaceFolder}
        submitting={createWorkspaceSubmitting()}
      />

      <ModelPickerModal
        open={modelPickerOpen()}
        options={storyModelOptions()}
        filteredOptions={filteredStoryModelOptions()}
        query={modelPickerQuery()}
        setQuery={setModelPickerQuery}
        target={modelPickerTarget()}
        current={selectedModel()}
        onSelect={applyStoryModelSelection}
        onBehaviorChange={(model, value) => {
          if (model.providerID !== selectedModel().providerID || model.modelID !== selectedModel().modelID) return;
          const entry = storyModels.find((item) => item.ref.providerID === model.providerID && item.ref.modelID === model.modelID);
          if (!entry) return;
          setModelVariant(sanitizeModelBehaviorValue(model.providerID, entry.model, value) ?? null);
        }}
        onOpenSettings={() => {
          setModelPickerOpen(false);
          setShowingSettings(true);
        }}
        onClose={() => setModelPickerOpen(false)}
      />
    </div>
  );
}
