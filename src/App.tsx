import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { applyEdits, modify, parse } from "jsonc-parser";

import type {
  Message,
  Part,
  PermissionRequest as ApiPermissionRequest,
  Provider,
  Session,
} from "@opencode-ai/sdk/v2/client";

import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Command,
  Cpu,
  FileText,
  Folder,
  HardDrive,
  Menu,
  Package,
  Play,
  Plus,
  RefreshCcw,
  Settings,
  Shield,
  Smartphone,
  Trash2,
  Search,
  Upload,
  X,
  Zap,
} from "lucide-solid";

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

import Button from "./components/Button";
import CreateWorkspaceModal from "./components/CreateWorkspaceModal";
import OpenWorkLogo from "./components/OpenWorkLogo";
import PartView from "./components/PartView";
import ThinkingBlock, { type ThinkingStep } from "./components/ThinkingBlock";
import TextInput from "./components/TextInput";
import WorkspaceChip from "./components/WorkspaceChip";
import WorkspacePicker from "./components/WorkspacePicker";
import { createClient, unwrap, waitForHealthy } from "./lib/opencode";
import {
  engineDoctor,
  engineInfo,
  engineInstall,
  engineStart,
  engineStop,
  importSkill,
  opkgInstall,
  pickDirectory,
  readOpencodeConfig,
  updaterEnvironment,

  workspaceBootstrap,
  workspaceCreate,
  workspaceSetActive,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  workspaceTemplateDelete,
  workspaceTemplateWrite,
  writeOpencodeConfig,
  resetOpenworkState,
  type EngineDoctorResult,
  type EngineInfo,
  type OpencodeConfigFile,
  type UpdaterEnvironment,
  type WorkspaceInfo,
} from "./lib/tauri";

type Client = ReturnType<typeof createClient>;

type PlaceholderAssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};

type MessageInfo = Message | PlaceholderAssistantMessage;

type MessageWithParts = {
  info: MessageInfo;
  parts: Part[];
};

type OpencodeEvent = {
  type: string;
  properties?: unknown;
};

type View = "onboarding" | "dashboard" | "session";

type Mode = "host" | "client";

type OnboardingStep = "mode" | "host" | "client" | "connecting";

type DashboardTab = "home" | "sessions" | "templates" | "skills" | "plugins" | "settings";

type WorkspacePreset = "starter" | "automation" | "minimal";

type ResetOpenworkMode = "onboarding" | "all";

type WorkspaceTemplate = Template & {
  scope: "workspace" | "global";
};

type WorkspaceOpenworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
};

type Template = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  createdAt: number;
};

type SkillCard = {
  name: string;
  path: string;
  description?: string;
};

type CuratedPackage = {
  name: string;
  source: string;
  description: string;
  tags: string[];
  installable: boolean;
};

type PluginInstallStep = {
  title: string;
  description: string;
  command?: string;
  url?: string;
  path?: string;
  note?: string;
};

type SuggestedPlugin = {
  name: string;
  packageName: string;
  description: string;
  tags: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: PluginInstallStep[];
};

type PluginScope = "project" | "global";

type ReloadReason = "plugins" | "skills";

type PendingPermission = ApiPermissionRequest & {
  receivedAt: number;
};

type ModelRef = {
  providerID: string;
  modelID: string;
};

type ModelOption = {
  providerID: string;
  modelID: string;
  title: string;
  description?: string;
  footer?: string;
  disabled?: boolean;
  isFree: boolean;
  isConnected: boolean;
};

const MODEL_PREF_KEY = "openwork.defaultModel";
const THINKING_PREF_KEY = "openwork.showThinking";
const VARIANT_PREF_KEY = "openwork.modelVariant";

const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "gpt-5-nano",
};

function formatModelRef(model: ModelRef) {
  return `${model.providerID}/${model.modelID}`;
}

function parseModelRef(raw: string | null): ModelRef | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [providerID, ...rest] = trimmed.split("/");
  if (!providerID || rest.length === 0) return null;
  return { providerID, modelID: rest.join("/") };
}

function modelEquals(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

function formatModelLabel(model: ModelRef, providers: Provider[] = []) {
  const provider = providers.find((p) => p.id === model.providerID);
  const modelInfo = provider?.models?.[model.modelID];

  const providerLabel = provider?.name ?? model.providerID;
  const modelLabel = modelInfo?.name ?? model.modelID;

  return `${providerLabel} · ${modelLabel}`;
}

const CURATED_PACKAGES: CuratedPackage[] = [
  {
    name: "OpenPackage Essentials",
    source: "essentials",
    description: "Starter rules, commands, and skills from the OpenPackage registry.",
    tags: ["registry", "starter"],
    installable: true,
  },
  {
    name: "Claude Code Plugins",
    source: "github:anthropics/claude-code",
    description: "Official Claude Code plugin pack from GitHub.",
    tags: ["github", "claude"],
    installable: true,
  },
  {
    name: "Claude Code Commit Commands",
    source: "github:anthropics/claude-code#subdirectory=plugins/commit-commands",
    description: "Commit message helper commands (Claude Code plugin).",
    tags: ["github", "workflow"],
    installable: true,
  },
  {
    name: "Awesome OpenPackage",
    source: "git:https://github.com/enulus/awesome-openpackage.git",
    description: "Community collection of OpenPackage examples and templates.",
    tags: ["community"],
    installable: true,
  },
  {
    name: "Awesome Claude Skills",
    source: "https://github.com/ComposioHQ/awesome-claude-skills",
    description: "Curated list of Claude skills and prompts (not an OpenPackage yet).",
    tags: ["community", "list"],
    installable: false,
  },
];

const SUGGESTED_PLUGINS: SuggestedPlugin[] = [
  {
    name: "opencode-scheduler",
    packageName: "opencode-scheduler",
    description: "Run scheduled jobs with the OpenCode scheduler plugin.",
    tags: ["automation", "jobs"],
    installMode: "simple",
  },
  {
    name: "opencode-browser",
    packageName: "@different-ai/opencode-browser",
    description: "Browser automation with a local extension + native host.",
    tags: ["browser", "extension"],
    aliases: ["opencode-browser"],
    installMode: "guided",
    steps: [
      {
        title: "Run the installer",
        description: "Installs the extension + native host and prepares the local broker.",
        command: "bunx @different-ai/opencode-browser@latest install",
        note: "Use npx @different-ai/opencode-browser@latest install if you do not have bunx.",
      },
      {
        title: "Load the extension",
        description:
          "Open chrome://extensions, enable Developer mode, click Load unpacked, and select the extension folder.",
        url: "chrome://extensions",
        path: "~/.opencode-browser/extension",
      },
      {
        title: "Pin the extension",
        description: "Pin OpenCode Browser Automation in your browser toolbar.",
      },
      {
        title: "Add plugin to config",
        description: "Click Add to write @different-ai/opencode-browser into opencode.json.",
      },
    ],
  },
];

function isTauriRuntime() {
  return typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ != null;
}

function readModePreference(): Mode | null {
  if (typeof window === "undefined") return null;

  try {
    const pref =
      window.localStorage.getItem("openwork.modePref") ??
      window.localStorage.getItem("openwork_mode_pref");

    if (pref === "host" || pref === "client") {
      // Migrate legacy key if needed.
      try {
        window.localStorage.setItem("openwork.modePref", pref);
      } catch {
        // ignore
      }
      return pref;
    }
  } catch {
    // ignore
  }

  return null;
}

function writeModePreference(nextMode: Mode) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem("openwork.modePref", nextMode);
    // Keep legacy key for now.
    window.localStorage.setItem("openwork_mode_pref", nextMode);
  } catch {
    // ignore
  }
}

function clearModePreference() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem("openwork.modePref");
    window.localStorage.removeItem("openwork_mode_pref");
  } catch {
    // ignore
  }
}

function safeStringify(value: unknown) {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (val && typeof val === "object") {
          if (seen.has(val as object)) {
            return "<circular>";
          }
          seen.add(val as object);
        }

        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "reasoningencryptedcontent" ||
          lowerKey.includes("api_key") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("access_token") ||
          lowerKey.includes("refresh_token") ||
          lowerKey.includes("token") ||
          lowerKey.includes("authorization") ||
          lowerKey.includes("cookie") ||
          lowerKey.includes("secret")
        ) {
          return "[redacted]";
        }

        return val;
      },
      2,
    );
  } catch {
    return "<unserializable>";
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, idx);
  const rounded = idx === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

function normalizeEvent(raw: unknown): OpencodeEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.type === "string") {
    return {
      type: record.type,
      properties: record.properties,
    };
  }

  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return {
        type: payload.type,
        properties: payload.properties,
      };
    }
  }

  return null;
}

function formatRelativeTime(timestampMs: number) {
  const delta = Date.now() - timestampMs;

  if (delta < 0) {
    return "just now";
  }

  if (delta < 60_000) {
    return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  }

  if (delta < 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  }

  if (delta < 24 * 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / (60 * 60_000)))}h ago`;
  }

  return new Date(timestampMs).toLocaleDateString();
}

function templatePathFromWorkspaceRoot(workspaceRoot: string, templateId: string) {
  const root = workspaceRoot.trim().replace(/\/+$/, "");
  const id = templateId.trim();
  if (!root || !id) return null;
  return `${root}/.openwork/templates/${id}.json`;
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function upsertSession(list: Session[], next: Session) {
  const idx = list.findIndex((s) => s.id === next.id);
  if (idx === -1) return [...list, next];

  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

function upsertMessage(list: MessageWithParts[], nextInfo: Message) {
  const idx = list.findIndex((m) => m.info.id === nextInfo.id);
  if (idx === -1) {
    return list.concat({ info: nextInfo, parts: [] });
  }

  const copy = list.slice();
  copy[idx] = { ...copy[idx], info: nextInfo };
  return copy;
}

function upsertPart(list: MessageWithParts[], nextPart: Part) {
  const msgIdx = list.findIndex((m) => m.info.id === nextPart.messageID);
  if (msgIdx === -1) {
    // Streaming events can arrive before we receive `message.updated`.
    // Create a placeholder assistant message so the UI renders the part
    // immediately, then `message.updated` will fill in the rest.
    const placeholder: PlaceholderAssistantMessage = {
      id: nextPart.messageID,
      sessionID: nextPart.sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "",
      providerID: "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    return list.concat({ info: placeholder, parts: [nextPart] });
  }

  const copy = list.slice();
  const msg = copy[msgIdx];
  const parts = msg.parts.slice();
  const partIdx = parts.findIndex((p) => p.id === nextPart.id);

  if (partIdx === -1) {
    parts.push(nextPart);
  } else {
    parts[partIdx] = nextPart;
  }

  copy[msgIdx] = { ...msg, parts };
  return copy;
}

function removePart(list: MessageWithParts[], messageID: string, partID: string) {
  const msgIdx = list.findIndex((m) => m.info.id === messageID);
  if (msgIdx === -1) return list;

  const copy = list.slice();
  const msg = copy[msgIdx];
  copy[msgIdx] = { ...msg, parts: msg.parts.filter((p) => p.id !== partID) };
  return copy;
}

function normalizeSessionStatus(status: unknown) {
  if (!status || typeof status !== "object") return "idle";
  const record = status as Record<string, unknown>;
  if (record.type === "busy") return "running";
  if (record.type === "retry") return "retry";
  if (record.type === "idle") return "idle";
  return "idle";
}

function modelFromUserMessage(info: MessageInfo): ModelRef | null {
  if (!info || typeof info !== "object") return null;
  if ((info as any).role !== "user") return null;

  const model = (info as any).model as unknown;
  if (!model || typeof model !== "object") return null;

  const providerID = (model as any).providerID;
  const modelID = (model as any).modelID;

  if (typeof providerID !== "string" || typeof modelID !== "string") return null;
  return { providerID, modelID };
}

function lastUserModelFromMessages(list: MessageWithParts[]): ModelRef | null {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const model = modelFromUserMessage(list[i]?.info);
    if (model) return model;
  }

  return null;
}

export default function App() {
  const [view, setView] = createSignal<View>("onboarding");
  const [mode, setMode] = createSignal<Mode | null>(null);
  const [onboardingStep, setOnboardingStep] = createSignal<OnboardingStep>("mode");
  const [rememberModeChoice, setRememberModeChoice] = createSignal(false);
  const [tab, setTab] = createSignal<DashboardTab>("home");

  const [engine, setEngine] = createSignal<EngineInfo | null>(null);
  const [engineDoctorResult, setEngineDoctorResult] = createSignal<EngineDoctorResult | null>(null);
  const [engineDoctorCheckedAt, setEngineDoctorCheckedAt] = createSignal<number | null>(null);
  const [engineInstallLogs, setEngineInstallLogs] = createSignal<string | null>(null);
  const [engineSource, setEngineSource] = createSignal<"path" | "sidecar">("path");

  const [projectDir, setProjectDir] = createSignal("");

  const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>("starter");

  const [authorizedDirs, setAuthorizedDirs] = createSignal<string[]>([]);
  const [newAuthorizedDir, setNewAuthorizedDir] = createSignal("");

  const [workspaceConfig, setWorkspaceConfig] = createSignal<WorkspaceOpenworkConfig | null>(null);
  const [workspaceConfigLoaded, setWorkspaceConfigLoaded] = createSignal(false);

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [client, setClient] = createSignal<Client | null>(null);
  const [connectedVersion, setConnectedVersion] = createSignal<string | null>(null);
  const [sseConnected, setSseConnected] = createSignal(false);

  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [sessionStatusById, setSessionStatusById] = createSignal<Record<string, string>>({});

  const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
  const [todos, setTodos] = createSignal<
    Array<{ id: string; content: string; status: string; priority: string }>
  >([]);
  const [pendingPermissions, setPendingPermissions] = createSignal<PendingPermission[]>([]);
  const [permissionReplyBusy, setPermissionReplyBusy] = createSignal(false);

  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  const [templates, setTemplates] = createSignal<WorkspaceTemplate[]>([]);
  const [workspaceTemplatesLoaded, setWorkspaceTemplatesLoaded] = createSignal(false);
  const [globalTemplatesLoaded, setGlobalTemplatesLoaded] = createSignal(false);

  const [templateModalOpen, setTemplateModalOpen] = createSignal(false);
  const [templateDraftTitle, setTemplateDraftTitle] = createSignal("");
  const [templateDraftDescription, setTemplateDraftDescription] = createSignal("");
  const [templateDraftPrompt, setTemplateDraftPrompt] = createSignal("");
  const [templateDraftScope, setTemplateDraftScope] = createSignal<"workspace" | "global">("workspace");

  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatus] = createSignal<string | null>(null);
  const [openPackageSource, setOpenPackageSource] = createSignal("");
  const [packageSearch, setPackageSearch] = createSignal("");

  const [pluginScope, setPluginScope] = createSignal<PluginScope>("project");
  const [pluginConfig, setPluginConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [pluginList, setPluginList] = createSignal<string[]>([]);
  const [pluginInput, setPluginInput] = createSignal("");
  const [pluginStatus, setPluginStatus] = createSignal<string | null>(null);
  const [activePluginGuide, setActivePluginGuide] = createSignal<string | null>(null);

  const activeWorkspace = createMemo(() => {
    const id = activeWorkspaceId();
    return workspaces().find((w) => w.id === id) ?? null;
  });

  const activeWorkspacePath = createMemo(() => activeWorkspace()?.path ?? "");

  const activeWorkspaceRoot = createMemo(() => {
    const ws = activeWorkspace();
    if (!ws) return "";
    const path = ws.path.trim();
    if (!path) return "";
    return path.replace(/\/+$/, "");
  });

  const defaultWorkspaceTemplates = createMemo<WorkspaceTemplate[]>(() => [
    {
      id: "tmpl_understand_workspace",
      title: "Understand this workspace",
      description: "Explains local vs global tools",
      prompt:
        "Explain how this workspace is configured and what tools are available locally. Be concise and actionable.",
      createdAt: 0,
      scope: "workspace",
    },
    {
      id: "tmpl_create_skill",
      title: "Create a new skill",
      description: "Guide to adding capabilities",
      prompt: "I want to create a new skill for this workspace. Guide me through it.",
      createdAt: 0,
      scope: "workspace",
    },
    {
      id: "tmpl_run_scheduled_task",
      title: "Run a scheduled task",
      description: "Demo of the scheduler plugin",
      prompt: "Show me how to schedule a task to run every morning.",
      createdAt: 0,
      scope: "workspace",
    },
    {
      id: "tmpl_task_to_template",
      title: "Turn task into template",
      description: "Save workflow for later",
      prompt: "Help me turn the last task into a reusable template.",
      createdAt: 0,
      scope: "workspace",
    },
  ]);

  const workspaceTemplates = createMemo(() => {
    const explicit = templates().filter((t) => t.scope === "workspace");
    if (explicit.length) return explicit;
    return workspaceTemplatesLoaded() ? [] : defaultWorkspaceTemplates();
  });

  const globalTemplates = createMemo(() => templates().filter((t) => t.scope === "global"));

  const activeWorkspaceDisplay = createMemo(() => {
    const ws = activeWorkspace();
    if (!ws) {
      return {
        id: "starter",
        name: "Workspace",
        path: "",
        preset: "starter",
      } satisfies WorkspaceInfo;
    }
    return ws;
  });

  const showWorkspacePicker = createSignal(false);
  const showCreateWorkspaceModal = createSignal(false);

  const [workspacePickerOpen, setWorkspacePickerOpen] = showWorkspacePicker;
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = showCreateWorkspaceModal;

  const [workspaceSearch, setWorkspaceSearch] = createSignal("");

  const filteredWorkspaces = createMemo(() => {
    const query = workspaceSearch().trim().toLowerCase();
    if (!query) return workspaces();

    return workspaces().filter((w) => {
      const haystack = `${w.name} ${w.path}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  async function activateWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return;

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return;

    setActiveWorkspaceId(id);
    setProjectDir(next.path);

    // Load workspace-scoped OpenWork config (authorized roots, metadata).
    if (isTauriRuntime()) {
      setWorkspaceConfigLoaded(false);
      try {
        const cfg = await workspaceOpenworkRead({ workspacePath: next.path });
        setWorkspaceConfig(cfg);
        setWorkspaceConfigLoaded(true);

        const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
        if (roots.length) {
          setAuthorizedDirs(roots);
        } else {
          setAuthorizedDirs([next.path]);
        }
      } catch {
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([next.path]);
      }

      try {
        await workspaceSetActive(id);
      } catch {
        // ignore
      }
    } else {
      // Web runtime: at least keep the current workspace root in memory.
      if (!authorizedDirs().includes(next.path)) {
        setAuthorizedDirs((current) => {
          const merged = current.length ? current.slice() : [];
          if (!merged.includes(next.path)) merged.push(next.path);
          return merged;
        });
      }
    }

    await loadWorkspaceTemplates({ workspaceRoot: next.path }).catch(() => undefined);

    if (mode() === "host" && engine()?.running && engine()?.baseUrl) {
      // Already connected to an engine; keep current connection for now.
      // Future: support multi-workspace host connections.
      return;
    }
  }

  async function loadWorkspaceTemplates(options?: { workspaceRoot?: string; quiet?: boolean }) {
    const c = client();
    const root = (options?.workspaceRoot ?? activeWorkspaceRoot()).trim();
    if (!c || !root) return;

    try {
      const templatesPath = ".openwork/templates";
      const nodes = unwrap(await c.file.list({ directory: root, path: templatesPath }));
      const jsonFiles = nodes
        .filter((n) => n.type === "file" && !n.ignored)
        .filter((n) => n.name.toLowerCase().endsWith(".json"));

      const loaded: WorkspaceTemplate[] = [];

      for (const node of jsonFiles) {
        const content = unwrap(await c.file.read({ directory: root, path: node.path }));
        if (content.type !== "text") continue;

        const parsed = safeParseJson<Partial<WorkspaceTemplate> & Record<string, unknown>>(content.content);
        if (!parsed) continue;

        const title = typeof parsed.title === "string" ? parsed.title : "Untitled";
        const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
        if (!prompt.trim()) continue;

        loaded.push({
          id: typeof parsed.id === "string" ? parsed.id : node.name.replace(/\.json$/i, ""),
          title,
          description: typeof parsed.description === "string" ? parsed.description : "",
          prompt,
          createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
          scope: "workspace",
        });
      }

      const stable = loaded.slice().sort((a, b) => b.createdAt - a.createdAt);

      setTemplates((current) => {
        const globals = current.filter((t) => t.scope === "global");
        return [...stable, ...globals];
      });
      setWorkspaceTemplatesLoaded(true);
    } catch (e) {
      setWorkspaceTemplatesLoaded(true);
      if (!options?.quiet) {
        setError(e instanceof Error ? e.message : safeStringify(e));
      }
    }
  }

  async function createWorkspaceFlow(preset: WorkspacePreset) {
    if (!isTauriRuntime()) {
      setError("Workspace creation requires the Tauri app runtime.");
      return;
    }

    try {
      const selection = await pickDirectory({ title: "Choose workspace folder" });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!folder) return;

      setBusy(true);
      setBusyLabel("Creating workspace");
      setBusyStartedAt(Date.now());
      setError(null);

      const name = folder.split("/").filter(Boolean).pop() ?? "Workspace";
      const ws = await workspaceCreate({ folderPath: folder, name, preset });
      setWorkspaces(ws.workspaces);
      setActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
      if (active) {
        setProjectDir(active.path);
        setAuthorizedDirs([active.path]);
        await loadWorkspaceTemplates({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
      }

      setWorkspacePickerOpen(false);
      setCreateWorkspaceOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  const [sidebarPluginList, setSidebarPluginList] = createSignal<string[]>([]);
  const [sidebarPluginStatus, setSidebarPluginStatus] = createSignal<string | null>(null);

  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [reloadReasons, setReloadReasons] = createSignal<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = createSignal<number | null>(null);
  const [reloadBusy, setReloadBusy] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string | null>(null);

  const [events, setEvents] = createSignal<OpencodeEvent[]>([]);
  const [developerMode, setDeveloperMode] = createSignal(false);

  const [providers, setProviders] = createSignal<Provider[]>([]);
  const [providerDefaults, setProviderDefaults] = createSignal<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = createSignal<string[]>([]);

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<"session" | "default">("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<Record<string, ModelRef>>({});
  const [sessionModelById, setSessionModelById] = createSignal<Record<string, ModelRef>>({});

  const [showThinking, setShowThinking] = createSignal(true);
  const [modelVariant, setModelVariant] = createSignal<string | null>(null);

  const [busy, setBusy] = createSignal(false);
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const [appVersion, setAppVersion] = createSignal<string | null>(null);

  const [updateAutoCheck, setUpdateAutoCheck] = createSignal(true);

  const [updateEnv, setUpdateEnv] = createSignal<UpdaterEnvironment | null>(null);

  const [resetModalOpen, setResetModalOpen] = createSignal(false);
  const [resetModalMode, setResetModalMode] = createSignal<ResetOpenworkMode>("onboarding");
  const [resetModalText, setResetModalText] = createSignal("");
  const [resetModalBusy, setResetModalBusy] = createSignal(false);

  type UpdateHandle = {
    available: boolean;
    currentVersion: string;
    version: string;
    date?: string;
    body?: string;
    rawJson: Record<string, unknown>;
    close: () => Promise<void>;
    download: (onEvent?: (event: any) => void) => Promise<void>;
    install: () => Promise<void>;
    downloadAndInstall: (onEvent?: (event: any) => void) => Promise<void>;
  };

  const [updateStatus, setUpdateStatus] = createSignal<
    | { state: "idle"; lastCheckedAt: number | null }
    | { state: "checking"; startedAt: number }
    | { state: "available"; lastCheckedAt: number; version: string; date?: string; notes?: string }
    | { state: "downloading"; lastCheckedAt: number; version: string; totalBytes: number | null; downloadedBytes: number; notes?: string }
    | { state: "ready"; lastCheckedAt: number; version: string; notes?: string }
    | { state: "error"; lastCheckedAt: number | null; message: string }
  >({ state: "idle", lastCheckedAt: null });

  const [pendingUpdate, setPendingUpdate] = createSignal<
    | null
    | { update: UpdateHandle; version: string; notes?: string }
  >(null);

  const busySeconds = createMemo(() => {
    const start = busyStartedAt();
    if (!start) return 0;
    return Math.max(0, Math.round((Date.now() - start) / 1000));
  });

  const newTaskDisabled = createMemo(() => {
    const label = busyLabel();
    // Allow creating a new session even while a run is in progress.
    if (busy() && label === "Running") return false;

    // Otherwise, block during engine / connection transitions.
    if (busy() && (label === "Connecting" || label === "Starting engine" || label === "Disconnecting")) {
      return true;
    }

    return busy();
  });

  const filteredPackages = createMemo(() => {
    const query = packageSearch().trim().toLowerCase();
    if (!query) return CURATED_PACKAGES;

    return CURATED_PACKAGES.filter((pkg) => {
      const haystack = [pkg.name, pkg.source, pkg.description, pkg.tags.join(" ")]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  });

  const normalizePluginList = (value: unknown) => {
    if (!value) return [] as string[];
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }
    return [] as string[];
  };

  const stripPluginVersion = (spec: string) => {
    const trimmed = spec.trim();
    if (!trimmed) return "";

    const looksLikeVersion = (suffix: string) =>
      /^(latest|next|beta|alpha|canary|rc|stable|\d)/i.test(suffix);

    if (trimmed.startsWith("@")) {
      const slashIndex = trimmed.indexOf("/");
      if (slashIndex === -1) return trimmed;

      const atIndex = trimmed.indexOf("@", slashIndex + 1);
      if (atIndex === -1) return trimmed;

      const suffix = trimmed.slice(atIndex + 1);
      return looksLikeVersion(suffix) ? trimmed.slice(0, atIndex) : trimmed;
    }

    const atIndex = trimmed.indexOf("@");
    if (atIndex === -1) return trimmed;

    const suffix = trimmed.slice(atIndex + 1);
    return looksLikeVersion(suffix) ? trimmed.slice(0, atIndex) : trimmed;
  };

  const pluginNamesLower = createMemo(() => {
    const normalized = pluginList().flatMap((entry) => {
      const raw = entry.toLowerCase();
      const stripped = stripPluginVersion(entry).toLowerCase();
      return stripped && stripped !== raw ? [raw, stripped] : [raw];
    });

    return new Set(normalized);
  });

  const isPluginInstalled = (pluginName: string, aliases: string[] = []) => {
    const list = pluginNamesLower();
    return [pluginName, ...aliases].some((entry) => list.has(entry.toLowerCase()));
  };

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    if (!config?.content) {
      setPluginList([]);
      return;
    }

    try {
      const parsed = parse(config.content) as Record<string, unknown> | undefined;
      const next = normalizePluginList(parsed?.plugin);
      setPluginList(next);
    } catch (e) {
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : "Failed to parse opencode.json");
    }
  };

  const selectedSession = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return null;
    return sessions().find((s) => s.id === id) ?? null;
  });

  const selectedSessionStatus = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return "idle";
    return sessionStatusById()[id] ?? "idle";
  });

  const selectedSessionModel = createMemo<ModelRef>(() => {
    const id = selectedSessionId();
    if (!id) return defaultModel();

    const override = sessionModelOverrideById()[id];
    if (override) return override;

    const known = sessionModelById()[id];
    if (known) return known;

    const fromMessages = lastUserModelFromMessages(messages());
    if (fromMessages) return fromMessages;

    return defaultModel();
  });

  const selectedSessionModelLabel = createMemo(() => formatModelLabel(selectedSessionModel(), providers()));

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel(),
  );

  const modelOptions = createMemo<ModelOption[]>(() => {
    const allProviders = providers();
    const defaults = providerDefaults();

     if (!allProviders.length) {
       return [
         {
           providerID: DEFAULT_MODEL.providerID,
           modelID: DEFAULT_MODEL.modelID,
           title: DEFAULT_MODEL.modelID,
           description: DEFAULT_MODEL.providerID,
           footer: "Fallback",
           isFree: false,
           isConnected: true,
         },
       ];
     }

    const sortedProviders = allProviders.slice().sort((a, b) => {
      const aIsOpencode = a.id === "opencode";
      const bIsOpencode = b.id === "opencode";
      if (aIsOpencode !== bIsOpencode) return aIsOpencode ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const next: ModelOption[] = [];

     for (const provider of sortedProviders) {
       const defaultModelID = defaults[provider.id];
       const isConnected = providerConnectedIds().includes(provider.id);
       const models = Object.values(provider.models ?? {}).filter((m) => m.status !== "deprecated");
 
       models.sort((a, b) => {
         const aFree = a.cost?.input === 0 && a.cost?.output === 0;
         const bFree = b.cost?.input === 0 && b.cost?.output === 0;
         if (aFree !== bFree) return aFree ? -1 : 1;
         return (a.name ?? a.id).localeCompare(b.name ?? b.id);
       });
 
       for (const model of models) {
         const isFree = model.cost?.input === 0 && model.cost?.output === 0;
         const footerBits: string[] = [];
         if (defaultModelID === model.id) footerBits.push("Default");
         if (isFree) footerBits.push("Free");
         if (model.capabilities?.reasoning) footerBits.push("Reasoning");
 
         next.push({
           providerID: provider.id,
           modelID: model.id,
           title: model.name ?? model.id,
           description: provider.name,
           footer: footerBits.length ? footerBits.slice(0, 2).join(" · ") : undefined,
           disabled: !isConnected,
           isFree,
           isConnected,
         });
       }
     }
 
     next.sort((a, b) => {
       if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
       if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
       return a.title.localeCompare(b.title);
     });
 
     return next;
  });

  const filteredModelOptions = createMemo(() => {
    const q = modelPickerQuery().trim().toLowerCase();
    const options = modelOptions();
    if (!q) return options;

    return options.filter((opt) => {
      const haystack = [
        opt.title,
        opt.description ?? "",
        opt.footer ?? "",
        `${opt.providerID}/${opt.modelID}`,
        opt.isConnected ? "connected" : "disconnected",
        opt.isFree ? "free" : "paid",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  function openSessionModelPicker() {
    setModelPickerTarget("session");
    setModelPickerQuery("");
    setModelPickerOpen(true);
  }

  function openDefaultModelPicker() {
    setModelPickerTarget("default");
    setModelPickerQuery("");
    setModelPickerOpen(true);
  }

  function applyModelSelection(next: ModelRef) {
    if (modelPickerTarget() === "default") {
      setDefaultModel(next);
      setModelPickerOpen(false);
      return;
    }

    const id = selectedSessionId();
    if (!id) {
      setModelPickerOpen(false);
      return;
    }

    setSessionModelOverrideById((current) => ({ ...current, [id]: next }));
    setModelPickerOpen(false);
  }

  const activePermission = createMemo(() => {
    const id = selectedSessionId();
    const list = pendingPermissions();

    if (id) {
      return list.find((p) => p.sessionID === id) ?? null;
    }

    return list[0] ?? null;
  });

  async function refreshEngine() {
    if (!isTauriRuntime()) return;

    try {
      const info = await engineInfo();
      setEngine(info);

      if (info.projectDir) {
        setProjectDir(info.projectDir);
      }
      if (info.baseUrl) {
        setBaseUrl(info.baseUrl);
      }
    } catch {
      // ignore
    }
  }

  function anyActiveRuns() {
    const statuses = sessionStatusById();
    return sessions().some((s) => statuses[s.id] === "running" || statuses[s.id] === "retry");
  }

  function clearOpenworkLocalStorage() {
    if (typeof window === "undefined") return;

    try {
      const keys = Object.keys(window.localStorage);
      for (const key of keys) {
        if (key.startsWith("openwork.")) {
          window.localStorage.removeItem(key);
        }
      }
      // Legacy compatibility key
      window.localStorage.removeItem("openwork_mode_pref");
    } catch {
      // ignore
    }
  }

  function openResetModal(mode: ResetOpenworkMode) {
    if (anyActiveRuns()) {
      setError("Stop active runs before resetting.");
      return;
    }

    setError(null);
    setResetModalMode(mode);
    setResetModalText("");
    setResetModalOpen(true);
  }

  async function confirmReset() {
    if (resetModalBusy()) return;

    if (anyActiveRuns()) {
      setError("Stop active runs before resetting.");
      return;
    }

    if (resetModalText().trim().toUpperCase() !== "RESET") return;

    setResetModalBusy(true);
    setError(null);

    try {
      if (isTauriRuntime()) {
        await resetOpenworkState(resetModalMode());
      }

      clearOpenworkLocalStorage();

      if (isTauriRuntime()) {
        await relaunch();
      } else {
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
      setResetModalBusy(false);
    }
  }

  function markReloadRequired(reason: ReloadReason) {
    setReloadRequired(true);
    setReloadLastTriggeredAt(Date.now());
    setReloadReasons((current) => (current.includes(reason) ? current : [...current, reason]));
  }

  function clearReloadRequired() {
    setReloadRequired(false);
    setReloadReasons([]);
    setReloadError(null);
  }

  const reloadCopy = createMemo(() => {
    const reasons = reloadReasons();
    if (!reasons.length) {
      return {
        title: "Reload required",
        body: "OpenWork detected changes that require reloading the OpenCode instance.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "plugins") {
      return {
        title: "Reload required",
        body: "OpenCode loads npm plugins at startup. Reload the engine to apply opencode.json changes.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "skills") {
      return {
        title: "Reload required",
        body: "OpenCode can cache skill discovery/state. Reload the engine to make newly installed skills available.",
      };
    }

    return {
      title: "Reload required",
      body: "OpenWork detected plugin/skill changes. Reload the engine to apply them.",
    };
  });

  const canReloadEngine = createMemo(() => {
    if (!reloadRequired()) return false;
    if (!client()) return false;
    if (reloadBusy()) return false;
    if (anyActiveRuns()) return false;
    if (mode() !== "host") return false;
    return true;
  });

  // Keep this mounted so the reload banner UX remains in the app.
  createEffect(() => {
    reloadRequired();
  });

  async function reloadEngineInstance() {
    const c = client();
    if (!c) return;

    if (mode() !== "host") {
      setReloadError("Reload is only available in Host mode.");
      return;
    }

    if (anyActiveRuns()) {
      setReloadError("A run is in progress. Stop it before reloading the engine.");
      return;
    }

    setReloadBusy(true);
    setReloadError(null);

    try {
      unwrap(await c.instance.dispose());
      await waitForHealthy(c, { timeoutMs: 12_000 });

      try {
        const providerList = unwrap(await c.provider.list());
        setProviders(providerList.all as unknown as Provider[]);
        setProviderDefaults(providerList.default);
        setProviderConnectedIds(providerList.connected);
      } catch {
        try {
          const cfg = unwrap(await c.config.providers());
          setProviders(cfg.providers);
          setProviderDefaults(cfg.default);
          setProviderConnectedIds([]);
        } catch {
          setProviders([]);
          setProviderDefaults({});
          setProviderConnectedIds([]);
        }
      }

      await refreshPlugins().catch(() => undefined);
      await refreshSkills().catch(() => undefined);

      clearReloadRequired();
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setReloadBusy(false);
    }
  }

  async function checkForUpdates(options?: { quiet?: boolean }) {
    if (!isTauriRuntime()) return;

    const env = updateEnv();
    if (env && !env.supported) {
      if (!options?.quiet) {
        setUpdateStatus({
          state: "error",
          lastCheckedAt:
            updateStatus().state === "idle"
              ? (updateStatus() as { state: "idle"; lastCheckedAt: number | null }).lastCheckedAt
              : null,
          message: env.reason ?? "Updates are not supported in this environment.",
        });
      }
      return;
    }

    const prev = updateStatus();
    setUpdateStatus({ state: "checking", startedAt: Date.now() });

    try {
      const update = (await check({
        timeout: 8_000,
      })) as unknown as UpdateHandle | null;
      const checkedAt = Date.now();

      if (!update) {
        setPendingUpdate(null);
        setUpdateStatus({ state: "idle", lastCheckedAt: checkedAt });
        return;
      }

      const notes = typeof update.body === "string" ? update.body : undefined;
      setPendingUpdate({ update, version: update.version, notes });
      setUpdateStatus({
        state: "available",
        lastCheckedAt: checkedAt,
        version: update.version,
        date: update.date,
        notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);

      if (options?.quiet) {
        setUpdateStatus(prev);
        return;
      }

      setPendingUpdate(null);
      setUpdateStatus({ state: "error", lastCheckedAt: null, message });
    }
  }

  async function downloadUpdate() {
    const pending = pendingUpdate();
    if (!pending) return;

    setError(null);

    const state = updateStatus();
    const lastCheckedAt = state.state === "available" ? state.lastCheckedAt : Date.now();

    setUpdateStatus({
      state: "downloading",
      lastCheckedAt,
      version: pending.version,
      totalBytes: null,
      downloadedBytes: 0,
      notes: pending.notes,
    });

    try {
      await pending.update.download((event: any) => {
        if (!event || typeof event !== "object") return;
        const record = event as Record<string, any>;

        setUpdateStatus((current) => {
          if (current.state !== "downloading") return current;

          if (record.event === "Started") {
            const total =
              record.data && typeof record.data.contentLength === "number" ? record.data.contentLength : null;
            return { ...current, totalBytes: total };
          }

          if (record.event === "Progress") {
            const chunk =
              record.data && typeof record.data.chunkLength === "number" ? record.data.chunkLength : 0;
            return { ...current, downloadedBytes: current.downloadedBytes + chunk };
          }

          return current;
        });
      });

      setUpdateStatus({
        state: "ready",
        lastCheckedAt,
        version: pending.version,
        notes: pending.notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setUpdateStatus({ state: "error", lastCheckedAt, message });
    }
  }

  async function installUpdateAndRestart() {
    const pending = pendingUpdate();
    if (!pending) return;

    if (anyActiveRuns()) {
      setError("Stop active runs before installing an update.");
      return;
    }

    setError(null);
    try {
      await pending.update.install();
      await pending.update.close();
      await relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setUpdateStatus({ state: "error", lastCheckedAt: null, message });
    }
  }

  async function refreshEngineDoctor() {
    if (!isTauriRuntime()) return;

    try {
      const result = await engineDoctor();
      setEngineDoctorResult(result);
      setEngineDoctorCheckedAt(Date.now());
    } catch (e) {
      setEngineDoctorResult(null);
      setEngineDoctorCheckedAt(Date.now());
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function loadSessions(c: Client) {
    const list = unwrap(await c.session.list());
    setSessions(list);
  }

  async function refreshPendingPermissions(c: Client) {
    const list = unwrap(await c.permission.list());

    setPendingPermissions((current) => {
      const now = Date.now();
      const byId = new Map(current.map((p) => [p.id, p] as const));
      return list.map((p) => ({ ...p, receivedAt: byId.get(p.id)?.receivedAt ?? now }));
    });
  }

  async function connectToServer(nextBaseUrl: string, directory?: string) {
    setError(null);
    setBusy(true);
    setBusyLabel("Connecting");
    setBusyStartedAt(Date.now());
    setSseConnected(false);

    try {
      const nextClient = createClient(nextBaseUrl, directory);
      const health = await waitForHealthy(nextClient, { timeoutMs: 12_000 });

      setClient(nextClient);
      setConnectedVersion(health.version);
      setBaseUrl(nextBaseUrl);

      await loadSessions(nextClient);
      await refreshPendingPermissions(nextClient);

      try {
        const providerList = unwrap(await nextClient.provider.list());
        setProviders(providerList.all as unknown as Provider[]);
        setProviderDefaults(providerList.default);
        setProviderConnectedIds(providerList.connected);
      } catch {
        // Backwards compatibility: older servers may not support provider.list
        try {
          const cfg = unwrap(await nextClient.config.providers());
          setProviders(cfg.providers);
          setProviderDefaults(cfg.default);
          setProviderConnectedIds([]);
        } catch {
          setProviders([]);
          setProviderDefaults({});
          setProviderConnectedIds([]);
        }
      }

      setSelectedSessionId(null);
      setMessages([]);
      setTodos([]);

      // Auto-create a first-run onboarding session in the active workspace.
      try {
        if (isTauriRuntime() && activeWorkspaceRoot().trim()) {
          const wsRoot = activeWorkspaceRoot().trim();
          const storedKey = `openwork.welcomeSessionCreated:${wsRoot}`;

          let already = false;
          try {
            already = window.localStorage.getItem(storedKey) === "1";
          } catch {
            // ignore
          }

          if (!already) {
            const session = unwrap(await nextClient.session.create({ directory: wsRoot, title: "Welcome to OpenWork" }));
            await nextClient.session.promptAsync({
              directory: wsRoot,
              sessionID: session.id,
              model: defaultModel(),
              variant: modelVariant() ?? undefined,
              parts: [
                {
                  type: "text",
                  text:
                    "Load the `workspace_guide` skill from this workspace and explain, in plain language, what lives in this folder (skills/plugins/templates) and what’s global. Then suggest 2 quick next actions the user can do in OpenWork.",
                },
              ],
            });

            try {
              window.localStorage.setItem(storedKey, "1");
            } catch {
              // ignore
            }

            await loadSessions(nextClient).catch(() => undefined);
          }
        }
      } catch {
        // ignore onboarding session failures
      }

      setView("dashboard");
      setTab("home");
      refreshSkills().catch(() => undefined);
      return true;
    } catch (e) {
      setClient(null);
      setConnectedVersion(null);
      setError(e instanceof Error ? e.message : safeStringify(e));
      return false;
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function startHost(options?: { workspacePath?: string }) {
    if (!isTauriRuntime()) {
      setError("Host mode requires the Tauri app runtime. Use `pnpm dev`.");
      return false;
    }

    const dir = (options?.workspacePath ?? activeWorkspacePath() ?? projectDir()).trim();
    if (!dir) {
      setError("Pick a workspace folder to start OpenCode in.");
      return false;
    }

    try {
      const result = await engineDoctor();
      setEngineDoctorResult(result);
      setEngineDoctorCheckedAt(Date.now());

      if (!result.found) {
        setError(
          "OpenCode CLI not found. Install with `brew install anomalyco/tap/opencode` or `curl -fsSL https://opencode.ai/install | bash`, then retry.",
        );
        return false;
      }

      if (!result.supportsServe) {
        setError("OpenCode CLI is installed, but `opencode serve` is unavailable. Update OpenCode and retry.");
        return false;
      }
    } catch (e) {
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }

    setError(null);
    setBusy(true);
    setBusyLabel("Starting engine");
    setBusyStartedAt(Date.now());

    try {
      // Keep legacy state in sync for now.
      setProjectDir(dir);
      if (!authorizedDirs().length) {
        setAuthorizedDirs([dir]);
      }

      const info = await engineStart(dir, { preferSidecar: engineSource() === "sidecar" });
      setEngine(info);

      if (info.baseUrl) {
        const ok = await connectToServer(info.baseUrl, info.projectDir ?? undefined);
        if (!ok) return false;
      }

      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
      return false;
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function stopHost() {
    setError(null);
    setBusy(true);
    setBusyLabel("Disconnecting");
    setBusyStartedAt(Date.now());

    try {
      if (isTauriRuntime()) {
        const info = await engineStop();
        setEngine(info);
      }

      setClient(null);
      setConnectedVersion(null);
      setSessions([]);
      setSelectedSessionId(null);
      setMessages([]);
      setTodos([]);
      setPendingPermissions([]);
      setSessionStatusById({});
      setSseConnected(false);

      setMode(null);
      setOnboardingStep("mode");
      setView("onboarding");
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function selectSession(sessionID: string) {
    const c = client();
    if (!c) return;

    setSelectedSessionId(sessionID);
    setError(null);

    const msgs = unwrap(await c.session.messages({ sessionID }));
    setMessages(msgs);

    const model = lastUserModelFromMessages(msgs);
    if (model) {
      setSessionModelById((current) => ({
        ...current,
        [sessionID]: model,
      }));

      setSessionModelOverrideById((current) => {
        if (!current[sessionID]) return current;
        const copy = { ...current };
        delete copy[sessionID];
        return copy;
      });
    }

    try {
      setTodos(unwrap(await c.session.todo({ sessionID })));
    } catch {
      setTodos([]);
    }

    try {
      await refreshPendingPermissions(c);
    } catch {
      // ignore
    }
  }

  async function createSessionAndOpen() {
    const c = client();
    if (!c) return;

    setBusy(true);
    setBusyLabel("Creating session");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      const session = unwrap(await c.session.create({ title: "New task" }));
      await loadSessions(c);
      await selectSession(session.id);
      setView("session");
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function sendPrompt() {
    const c = client();
    const sessionID = selectedSessionId();
    if (!c || !sessionID) return;

    const content = prompt().trim();
    if (!content) return;

    setBusy(true);
    setBusyLabel("Running");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      setLastPromptSent(content);
      setPrompt("");

      const model = selectedSessionModel();

       await c.session.promptAsync({
         sessionID,
         model,
         variant: modelVariant() ?? undefined,
         parts: [{ type: "text", text: content }],
       });

       setSessionModelById((current) => ({
         ...current,
         [sessionID]: model,
       }));

       setSessionModelOverrideById((current) => {
         if (!current[sessionID]) return current;
         const copy = { ...current };
         delete copy[sessionID];
         return copy;
       });

       // Streaming UI is driven by SSE; do not block on fetching the full
       // message list here.
       await loadSessions(c).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  function openTemplateModal() {
    const seedTitle = selectedSession()?.title ?? "";
    const seedPrompt = lastPromptSent() || prompt();

    setTemplateDraftTitle(seedTitle);
    setTemplateDraftDescription("");
    setTemplateDraftPrompt(seedPrompt);
    setTemplateDraftScope("workspace");
    setTemplateModalOpen(true);
  }

  async function saveTemplate() {
    const title = templateDraftTitle().trim();
    const promptText = templateDraftPrompt().trim();
    const description = templateDraftDescription().trim();
    const scope = templateDraftScope();

    if (!title || !promptText) {
      setError("Template title and prompt are required.");
      return;
    }

    if (scope === "workspace") {
      if (!isTauriRuntime()) {
        setError("Workspace templates require the desktop app.");
        return;
      }
      if (!activeWorkspacePath().trim()) {
        setError("Pick a workspace folder first.");
        return;
      }
    }

    setBusy(true);
    setBusyLabel(scope === "workspace" ? "Saving workspace template" : "Saving template");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      const template: WorkspaceTemplate = {
        id: `tmpl_${Date.now()}`,
        title,
        description,
        prompt: promptText,
        createdAt: Date.now(),
        scope,
      };

      if (scope === "workspace") {
        const workspaceRoot = activeWorkspacePath().trim();
        await workspaceTemplateWrite({ workspacePath: workspaceRoot, template });
        await loadWorkspaceTemplates({ workspaceRoot, quiet: true });
      } else {
        setTemplates((current) => [template, ...current]);
        setGlobalTemplatesLoaded(true);
      }

      setTemplateModalOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function deleteTemplate(templateId: string) {
    const scope = templates().find((t) => t.id === templateId)?.scope;

    if (scope === "workspace") {
      if (!isTauriRuntime()) return;
      const workspaceRoot = activeWorkspacePath().trim();
      if (!workspaceRoot) return;

      setBusy(true);
      setBusyLabel("Deleting template");
      setBusyStartedAt(Date.now());
      setError(null);

      try {
        await workspaceTemplateDelete({ workspacePath: workspaceRoot, templateId });
        await loadWorkspaceTemplates({ workspaceRoot, quiet: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : safeStringify(e));
      } finally {
        setBusy(false);
        setBusyLabel(null);
        setBusyStartedAt(null);
      }

      return;
    }

    setTemplates((current) => current.filter((t) => t.id !== templateId));
    setGlobalTemplatesLoaded(true);
  }

  async function runTemplate(template: WorkspaceTemplate) {
    const c = client();
    if (!c) return;

    setBusy(true);
    setError(null);

    try {
      const session = unwrap(await c.session.create({ title: template.title }));
      await loadSessions(c);
      await selectSession(session.id);
      setView("session");

      const model = defaultModel();

       await c.session.promptAsync({
         sessionID: session.id,
         model,
         variant: modelVariant() ?? undefined,
         parts: [{ type: "text", text: template.prompt }],
       });

      setSessionModelById((current) => ({
        ...current,
        [session.id]: model,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function refreshSkills() {
    const c = client();
    if (!c) return;

    try {
      setSkillsStatus(null);
      const nodes = unwrap(await c.file.list({ directory: activeWorkspaceRoot().trim(), path: ".opencode/skill" }));
      const dirs = nodes.filter((n) => n.type === "directory" && !n.ignored);

      const next: SkillCard[] = [];

      for (const dir of dirs) {
        let description: string | undefined;

        try {
            const skillDoc = unwrap(
              await c.file.read({
                directory: activeWorkspaceRoot().trim(),
                path: `.opencode/skill/${dir.name}/SKILL.md`,
              }),
            );

          if (skillDoc.type === "text") {
            const lines = skillDoc.content.split("\n");
            const first = lines
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith("#"))
              .slice(0, 2)
              .join(" ");
            if (first) {
              description = first;
            }
          }
        } catch {
          // ignore missing SKILL.md
        }

        next.push({ name: dir.name, path: dir.path, description });
      }

      setSkills(next);
      if (!next.length) {
        setSkillsStatus("No skills found in .opencode/skill");
      }
    } catch (e) {
      setSkills([]);
      setSkillsStatus(e instanceof Error ? e.message : "Failed to load skills");
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    if (!isTauriRuntime()) {
      setPluginStatus("Plugin management is only available in Host mode.");
      setPluginList([]);
      setSidebarPluginStatus("Plugins are only available in Host mode.");
      setSidebarPluginList([]);
      return;
    }

    const scope = scopeOverride ?? pluginScope();
    const targetDir = projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus("Pick a project folder to manage project plugins.");
      setPluginList([]);
      setSidebarPluginStatus("Pick a project folder to load active plugins.");
      setSidebarPluginList([]);
      return;
    }

    try {
      setPluginStatus(null);
      setSidebarPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      setPluginConfig(config);

      if (!config.exists) {
        setPluginList([]);
        setPluginStatus("No opencode.json found yet. Add a plugin to create one.");
        setSidebarPluginList([]);
        setSidebarPluginStatus("No opencode.json in this workspace yet.");
        return;
      }

      try {
        const parsed = parse(config.content ?? "") as Record<string, unknown> | undefined;
        const next = normalizePluginList(parsed?.plugin);
        setSidebarPluginList(next);
      } catch {
        setSidebarPluginList([]);
        setSidebarPluginStatus("Failed to parse opencode.json");
      }

      loadPluginsFromConfig(config);
    } catch (e) {
      setPluginConfig(null);
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : "Failed to load opencode.json");
      setSidebarPluginStatus("Failed to load active plugins.");
      setSidebarPluginList([]);
    }
  }

  async function addPlugin(pluginNameOverride?: string) {
    if (!isTauriRuntime()) {
      setPluginStatus("Plugin management is only available in Host mode.");
      return;
    }

    const pluginName = (pluginNameOverride ?? pluginInput()).trim();
    const isManualInput = pluginNameOverride == null;

    if (!pluginName) {
      if (isManualInput) {
        setPluginStatus("Enter a plugin package name.");
      }
      return;
    }

    const scope = pluginScope();
    const targetDir = projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus("Pick a project folder to manage project plugins.");
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";

      if (!raw.trim()) {
        const payload = {
          $schema: "https://opencode.ai/config.json",
          plugin: [pluginName],
        };
        await writeOpencodeConfig(scope, targetDir, `${JSON.stringify(payload, null, 2)}\n`);
        markReloadRequired("plugins");
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins(scope);
        return;
      }

      const parsed = parse(raw) as Record<string, unknown> | undefined;
      const plugins = normalizePluginList(parsed?.plugin);

      const desired = stripPluginVersion(pluginName).toLowerCase();
      if (plugins.some((entry) => stripPluginVersion(entry).toLowerCase() === desired)) {
        setPluginStatus("Plugin already listed in opencode.json.");
        return;
      }

      const next = [...plugins, pluginName];
      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);

      await writeOpencodeConfig(scope, targetDir, updated);
      markReloadRequired("plugins");
      if (isManualInput) {
        setPluginInput("");
      }
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : "Failed to update opencode.json");
    }
  }

  async function installFromOpenPackage(sourceOverride?: string) {
    if (mode() !== "host" || !isTauriRuntime()) {
      setError("OpenPackage installs are only available in Host mode.");
      return;
    }

    const targetDir = projectDir().trim();
    const pkg = (sourceOverride ?? openPackageSource()).trim();

    if (!targetDir) {
      setError("Pick a project folder first.");
      return;
    }

    if (!pkg) {
      setError("Enter an OpenPackage source (e.g. github:anthropics/claude-code).");
      return;
    }

    setOpenPackageSource(pkg);
    setBusy(true);
    setError(null);
    setSkillsStatus("Installing OpenPackage...");

    try {
      const result = await opkgInstall(targetDir, pkg);
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || `opkg failed (${result.status})`);
      } else {
        setSkillsStatus(result.stdout || "Installed.");
        markReloadRequired("skills");
      }

      await refreshSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
    }
  }

  async function useCuratedPackage(pkg: CuratedPackage) {
    if (pkg.installable) {
      await installFromOpenPackage(pkg.source);
      return;
    }

    setOpenPackageSource(pkg.source);
    setSkillsStatus(
      "This is a curated list, not an OpenPackage yet. Copy the link or watch the PRD for planned registry search integration.",
    );
  }

  async function importLocalSkill() {
    if (mode() !== "host" || !isTauriRuntime()) {
      setError("Skill import is only available in Host mode.");
      return;
    }

    const targetDir = projectDir().trim();
    if (!targetDir) {
      setError("Pick a project folder first.");
      return;
    }

    setBusy(true);
    setError(null);
    setSkillsStatus(null);

    try {
      const selection = await pickDirectory({ title: "Select skill folder" });
      const sourceDir =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!sourceDir) {
        return;
      }

      const result = await importSkill(targetDir, sourceDir, { overwrite: false });
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || `Import failed (${result.status})`);
      } else {
        setSkillsStatus(result.stdout || "Imported.");
        markReloadRequired("skills");
      }

      await refreshSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function respondPermission(requestID: string, reply: "once" | "always" | "reject") {
    const c = client();
    if (!c || permissionReplyBusy()) return;

    setPermissionReplyBusy(true);
    setError(null);

    try {
      unwrap(await c.permission.reply({ requestID, reply }));
      await refreshPendingPermissions(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setPermissionReplyBusy(false);
    }
  }

  async function respondPermissionAndRemember(requestID: string, reply: "once" | "always" | "reject") {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermission(requestID, reply);
  }

  async function persistAuthorizedRoots(nextRoots: string[]) {
    if (!isTauriRuntime()) return;
    const root = activeWorkspacePath().trim();
    if (!root) return;

    const existing = workspaceConfig();
    const cfg: WorkspaceOpenworkConfig = {
      version: existing?.version ?? 1,
      workspace: existing?.workspace ?? null,
      authorizedRoots: nextRoots,
    };

    await workspaceOpenworkWrite({ workspacePath: root, config: cfg });
    setWorkspaceConfig(cfg);
  }

  function normalizeRoots(list: string[]) {
    const out: string[] = [];
    for (const entry of list) {
      const trimmed = entry.trim().replace(/\/+$/, "");
      if (!trimmed) continue;
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }

  async function addAuthorizedDir() {
    const next = newAuthorizedDir().trim();
    if (!next) return;

    const roots = normalizeRoots([...authorizedDirs(), next]);
    setAuthorizedDirs(roots);
    setNewAuthorizedDir("");

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function addAuthorizedDirFromPicker(options?: { persistToWorkspace?: boolean }) {
    if (!isTauriRuntime()) return;

    try {
      const selection = await pickDirectory({ title: "Add folder" });
      const path =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!path) return;

      const roots = normalizeRoots([...authorizedDirs(), path]);
      setAuthorizedDirs(roots);

      if (options?.persistToWorkspace) {
        await persistAuthorizedRoots(roots);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function removeAuthorizedDir(index: number) {
    const roots = authorizedDirs().filter((_, i) => i !== index);
    setAuthorizedDirs(roots);

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  onMount(async () => {
    const modePref = readModePreference();
    if (modePref) {
      setRememberModeChoice(true);
    }

    if (typeof window !== "undefined") {
      try {
        const storedBaseUrl = window.localStorage.getItem("openwork.baseUrl");
        if (storedBaseUrl) {
          setBaseUrl(storedBaseUrl);
        }

        const storedClientDir = window.localStorage.getItem("openwork.clientDirectory");
        if (storedClientDir) {
          setClientDirectory(storedClientDir);
        }

        // Legacy: projectDir is now derived from the active workspace.
        const storedProjectDir = window.localStorage.getItem("openwork.projectDir");
        if (storedProjectDir && !projectDir().trim()) {
          setProjectDir(storedProjectDir);
        }

        const storedEngineSource = window.localStorage.getItem("openwork.engineSource");
        if (storedEngineSource === "path" || storedEngineSource === "sidecar") {
          setEngineSource(storedEngineSource);
        }

        const storedAuthorized = window.localStorage.getItem("openwork.authorizedDirs");
        if (storedAuthorized) {
          const parsed = JSON.parse(storedAuthorized) as unknown;
          if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
            setAuthorizedDirs(parsed);
          }
        }

        // Legacy (pre-workspace templates): normalize any stored templates into global templates.
        const storedTemplates = window.localStorage.getItem("openwork.templates");
         if (storedTemplates) {
           const parsed = JSON.parse(storedTemplates) as unknown;
           if (Array.isArray(parsed)) {
             const normalized = (parsed as unknown[])
               .filter((v) => v && typeof v === "object")
               .map((entry) => {
                 const record = entry as Record<string, unknown>;
                 return {
                   id: typeof record.id === "string" ? record.id : `tmpl_${Date.now()}`,
                   title: typeof record.title === "string" ? record.title : "Untitled",
                   description: typeof record.description === "string" ? record.description : "",
                   prompt: typeof record.prompt === "string" ? record.prompt : "",
                   createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
                   scope: "global" as const,
                 } satisfies WorkspaceTemplate;
               })
               .filter((t) => t.prompt.trim().length > 0);

             setTemplates(normalized);
           }
         }

         setGlobalTemplatesLoaded(true);

        const storedDefaultModel = window.localStorage.getItem(MODEL_PREF_KEY);
        const parsedDefaultModel = parseModelRef(storedDefaultModel);
        if (parsedDefaultModel) {
          setDefaultModel(parsedDefaultModel);
        } else {
          setDefaultModel(DEFAULT_MODEL);
          try {
            window.localStorage.setItem(MODEL_PREF_KEY, formatModelRef(DEFAULT_MODEL));
          } catch {
            // ignore
          }
        }

        const storedThinking = window.localStorage.getItem(THINKING_PREF_KEY);
        if (storedThinking != null) {
          try {
            const parsed = JSON.parse(storedThinking);
            if (typeof parsed === "boolean") {
              setShowThinking(parsed);
            }
          } catch {
            // ignore
          }
        }

        const storedVariant = window.localStorage.getItem(VARIANT_PREF_KEY);
        if (storedVariant && storedVariant.trim()) {
          setModelVariant(storedVariant.trim());
        }

        const storedUpdateAutoCheck = window.localStorage.getItem("openwork.updateAutoCheck");
        if (storedUpdateAutoCheck === "0" || storedUpdateAutoCheck === "1") {
          setUpdateAutoCheck(storedUpdateAutoCheck === "1");
        }

        const storedUpdateCheckedAt = window.localStorage.getItem("openwork.updateLastCheckedAt");
        if (storedUpdateCheckedAt) {
          const parsed = Number(storedUpdateCheckedAt);
          if (Number.isFinite(parsed) && parsed > 0) {
            setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
          }
        }
      } catch {
        // ignore
      }
    }

    if (isTauriRuntime()) {
      try {
        setAppVersion(await getVersion());
      } catch {
        // ignore
      }

      // Mark global templates as loaded even if nothing was stored.
      setGlobalTemplatesLoaded(true);

      try {
        setUpdateEnv(await updaterEnvironment());
      } catch {
        // ignore
      }

      if (updateAutoCheck()) {
        const state = updateStatus();
        const lastCheckedAt = state.state === "idle" ? state.lastCheckedAt : null;
        if (!lastCheckedAt || Date.now() - lastCheckedAt > 24 * 60 * 60_000) {
          checkForUpdates({ quiet: true }).catch(() => undefined);
        }
      }
    }

    await refreshEngine();
    await refreshEngineDoctor();

     // Bootstrap workspaces (Host mode only).
     if (isTauriRuntime()) {
       try {
          const ws = await workspaceBootstrap();
          setWorkspaces(ws.workspaces);
          setActiveWorkspaceId(ws.activeId);
          const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
          if (active) {
            setProjectDir(active.path);
            if (isTauriRuntime()) {
              try {
                const cfg = await workspaceOpenworkRead({ workspacePath: active.path });
                setWorkspaceConfig(cfg);
                setWorkspaceConfigLoaded(true);
                const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
                setAuthorizedDirs(roots.length ? roots : [active.path]);
              } catch {
                setWorkspaceConfig(null);
                setWorkspaceConfigLoaded(true);
                setAuthorizedDirs([active.path]);
              }
            } else if (!authorizedDirs().length) {
              setAuthorizedDirs([active.path]);
            }

            await loadWorkspaceTemplates({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
          }
       } catch {
         // ignore
       }
     }

     const info = engine();
     if (info?.baseUrl) {
       setBaseUrl(info.baseUrl);
     }

     // Auto-continue based on saved preference.
     if (!modePref) return;


    if (modePref === "host") {
      setMode("host");

      if (info?.running && info.baseUrl) {
        setOnboardingStep("connecting");
        const ok = await connectToServer(info.baseUrl, info.projectDir ?? undefined);
        if (!ok) {
          setMode(null);
          setOnboardingStep("mode");
        }
        return;
      }

       if (isTauriRuntime() && activeWorkspacePath().trim()) {
         if (!authorizedDirs().length && activeWorkspacePath().trim()) {
           setAuthorizedDirs([activeWorkspacePath().trim()]);
         }

         setOnboardingStep("connecting");
         const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
         if (!ok) {
           setOnboardingStep("host");
         }
         return;
       }

       // Missing required info; take them directly to Host setup.
       setOnboardingStep("host");
       return;
     }

    // Client preference.
    setMode("client");
    if (!baseUrl().trim()) {
      setOnboardingStep("client");
      return;
    }

    setOnboardingStep("connecting");
    const ok = await connectToServer(
      baseUrl().trim(),
      clientDirectory().trim() ? clientDirectory().trim() : undefined,
    );

    if (!ok) {
      setOnboardingStep("client");
    }
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (onboardingStep() !== "host") return;
    void refreshEngineDoctor();
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.baseUrl", baseUrl());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.clientDirectory", clientDirectory());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    // Legacy key: keep for backwards compatibility.
    try {
      window.localStorage.setItem("openwork.projectDir", projectDir());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.engineSource", engineSource());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    // Legacy persistence; workspace config is authoritative in the desktop app.
    try {
      window.localStorage.setItem("openwork.authorizedDirs", JSON.stringify(authorizedDirs()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!globalTemplatesLoaded()) return;

    try {
      const payload = templates()
        .filter((t) => t.scope === "global")
        .map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          prompt: t.prompt,
          createdAt: t.createdAt,
          scope: t.scope,
        }));

      window.localStorage.setItem("openwork.templates", JSON.stringify(payload));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MODEL_PREF_KEY, formatModelRef(defaultModel()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.updateAutoCheck", updateAutoCheck() ? "1" : "0");
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(THINKING_PREF_KEY, JSON.stringify(showThinking()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const value = modelVariant();
      if (value) {
        window.localStorage.setItem(VARIANT_PREF_KEY, value);
      } else {
        window.localStorage.removeItem(VARIANT_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    const state = updateStatus();
    if (typeof window === "undefined") return;
    if (state.state === "idle" && state.lastCheckedAt) {
      try {
        window.localStorage.setItem("openwork.updateLastCheckedAt", String(state.lastCheckedAt));
      } catch {
        // ignore
      }
    }
  });


  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const value = modelVariant();
      if (value) {
        window.localStorage.setItem(VARIANT_PREF_KEY, value);
      } else {
        window.localStorage.removeItem(VARIANT_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    const c = client();
    if (!c) return;

    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const sub = await c.event.subscribe(undefined, { signal: controller.signal });

        for await (const raw of sub.stream) {
          if (cancelled) break;

          const event = normalizeEvent(raw);
          if (!event) continue;

          if (event.type === "server.connected") {
            setSseConnected(true);
          }

          if (developerMode()) {
            setEvents((current) => {
              const next = [{ type: event.type, properties: event.properties }, ...current];
              return next.slice(0, 150);
            });
          }

          if (event.type === "session.updated" || event.type === "session.created") {
            if (event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              if (record.info && typeof record.info === "object") {
                setSessions((current) => upsertSession(current, record.info as Session));
              }
            }
          }

          if (event.type === "session.deleted") {
            if (event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              const info = record.info as Session | undefined;
              if (info?.id) {
                setSessions((current) => current.filter((s) => s.id !== info.id));
              }
            }
          }

          if (event.type === "session.status") {
            if (event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
              if (sessionID) {
                setSessionStatusById((current) => ({
                  ...current,
                  [sessionID]: normalizeSessionStatus(record.status),
                }));
              }
            }
          }

          if (event.type === "session.idle") {
            if (event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
              if (sessionID) {
                setSessionStatusById((current) => ({
                  ...current,
                  [sessionID]: "idle",
                }));
              }
            }
          }

          if (event.type === "message.updated") {
            if (event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              if (record.info && typeof record.info === "object") {
                const info = record.info as Message;

                const model = modelFromUserMessage(info);
                if (model) {
                  setSessionModelById((current) => ({
                    ...current,
                    [info.sessionID]: model,
                  }));

                  setSessionModelOverrideById((current) => {
                    if (!current[info.sessionID]) return current;
                    const copy = { ...current };
                    delete copy[info.sessionID];
                    return copy;
                  });
                }

                if (selectedSessionId() && info.sessionID === selectedSessionId()) {
                  setMessages((current) => upsertMessage(current, info));
                }
              }
            }
          }

          if (event.type === "message.removed") {
            if (event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              if (
                selectedSessionId() &&
                record.sessionID === selectedSessionId() &&
                typeof record.messageID === "string"
              ) {
                setMessages((current) => current.filter((m) => m.info.id !== record.messageID));
              }
            }
          }

          if (event.type === "message.part.updated") {
            if (event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              if (record.part && typeof record.part === "object") {
                const part = record.part as Part;
                 if (selectedSessionId() && part.sessionID === selectedSessionId()) {
                   setMessages((current) => {
                     const next = upsertPart(current, part);

                     // Some streaming servers only send `delta` updates and keep
                     // `part.text` as the full aggregation; others send the
                     // full part each time. If we have a delta, apply it to the
                     // latest text part to ensure visible streaming.
                     if (typeof record.delta === "string" && record.delta && part.type === "text") {
                       const msgIdx = next.findIndex((m) => m.info.id === part.messageID);
                       if (msgIdx !== -1) {
                         const msg = next[msgIdx];
                         const parts = msg.parts.slice();
                         const pIdx = parts.findIndex((p) => p.id === part.id);
                         if (pIdx !== -1) {
                           const currentPart = parts[pIdx] as any;
                           if (typeof currentPart.text === "string" && currentPart.text.endsWith(record.delta) === false) {
                             parts[pIdx] = { ...(parts[pIdx] as any), text: `${currentPart.text}${record.delta}` };
                             const copy = next.slice();
                             copy[msgIdx] = { ...msg, parts };
                             return copy;
                           }
                         }
                       }
                     }

                     return next;
                   });
                 }
              }
            }
          }

          if (event.type === "message.part.removed") {
            if (event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
              const messageID = typeof record.messageID === "string" ? record.messageID : null;
              const partID = typeof record.partID === "string" ? record.partID : null;

              if (sessionID && selectedSessionId() && sessionID === selectedSessionId() && messageID && partID) {
                setMessages((current) => removePart(current, messageID, partID));
              }
            }
          }

          if (event.type === "todo.updated") {
            const id = selectedSessionId();
            if (id && event.properties && typeof event.properties === "object") {
              const record = event.properties as Record<string, unknown>;
              if (record.sessionID === id && Array.isArray(record.todos)) {
                setTodos(record.todos as any);
              }
            }
          }

          if (event.type === "permission.asked" || event.type === "permission.replied") {
            try {
              await refreshPendingPermissions(c);
            } catch {
              // ignore
            }
          }
        }
      } catch (e) {
        if (cancelled) return;

        const message = e instanceof Error ? e.message : String(e);
        if (message.toLowerCase().includes("abort")) return;

        setError(message);
      }
    })();

    onCleanup(() => {
      cancelled = true;
      controller.abort();
    });
  });

  const headerStatus = createMemo(() => {
    if (!client() || !connectedVersion()) return "Disconnected";
    const bits = [`Connected · ${connectedVersion()}`];
    if (sseConnected()) bits.push("Live");
    return bits.join(" · ");
  });

  const busyHint = createMemo(() => {
    if (!busy() || !busyLabel()) return null;
    const seconds = busySeconds();
    return seconds > 0 ? `${busyLabel()} · ${seconds}s` : busyLabel();
  });

  const localHostLabel = createMemo(() => {
    const info = engine();
    if (info?.hostname && info?.port) {
      return `${info.hostname}:${info.port}`;
    }

    try {
      return new URL(baseUrl()).host;
    } catch {
      return "localhost:4096";
    }
  });

  function OnboardingView() {
    return (
      <Switch>
        <Match when={onboardingStep() === "connecting"}>
          <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative overflow-hidden">
            <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-zinc-900 via-black to-black opacity-50" />
            <div class="z-10 flex flex-col items-center gap-6">
              <div class="relative">
                <div class="w-16 h-16 rounded-full border-2 border-zinc-800 flex items-center justify-center animate-spin-slow">
                  <div class="w-12 h-12 rounded-full border-2 border-t-white border-zinc-800 animate-spin flex items-center justify-center bg-black">
                    <OpenWorkLogo size={20} class="text-white" />
                  </div>
                </div>
              </div>
              <div class="text-center">
                <h2 class="text-xl font-medium mb-2">
                  {mode() === "host" ? "Starting OpenCode Engine..." : "Searching for Host..."}
                </h2>
                <p class="text-zinc-500 text-sm">
                  {mode() === "host" ? `Initializing ${localHostLabel()}` : "Verifying secure handshake"}
                </p>
              </div>
            </div>
          </div>
        </Match>

        <Match when={onboardingStep() === "host"}>
          <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
            <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />

            <div class="max-w-md w-full z-10 space-y-8">
              <div class="text-center space-y-2">
                <div class="w-12 h-12 bg-white rounded-2xl mx-auto flex items-center justify-center shadow-2xl shadow-white/10 mb-6">
                  <Folder size={22} class="text-black" />
                </div>
                <h2 class="text-2xl font-bold tracking-tight">Create your first workspace</h2>
                <p class="text-zinc-400 text-sm leading-relaxed">
                  A workspace is a <span class="font-semibold text-white">folder</span> with its own skills, plugins, and templates.
                </p>
              </div>

              <div class="space-y-4">
                <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-2xl p-5 space-y-3">
                  <div class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Workspace</div>

                  <div class="space-y-2">
                    <div class="text-sm font-medium text-white">Starter Workspace</div>
                    <div class="text-xs text-zinc-500">
                      OpenWork will create a ready-to-run folder and start OpenCode inside it.
                    </div>
                    <div class="text-xs text-zinc-600 font-mono break-all">{activeWorkspacePath() || "(initializing...)"}</div>
                  </div>

                  <div class="pt-3 border-t border-zinc-800/60 space-y-2">
                    <div class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">What you get</div>
                    <div class="space-y-2">
                      <div class="flex items-center gap-3 text-sm text-zinc-300">
                        <div class="w-2 h-2 rounded-full bg-emerald-500" />
                        Scheduler plugin (workspace-scoped)
                      </div>
                      <div class="flex items-center gap-3 text-sm text-zinc-300">
                        <div class="w-2 h-2 rounded-full bg-emerald-500" />
                        Starter templates ("Understand this workspace", etc.)
                      </div>
                      <div class="flex items-center gap-3 text-sm text-zinc-300">
                        <div class="w-2 h-2 rounded-full bg-emerald-500" />
                        You can add more folders when prompted
                      </div>
                    </div>
                  </div>
                </div>

                <Button
                  onClick={async () => {
                    setMode("host");
                    setOnboardingStep("connecting");
                    const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
                    if (!ok) {
                      setOnboardingStep("host");
                    }
                  }}
                  disabled={busy() || !activeWorkspacePath().trim()}
                  class="w-full py-3 text-base"
                >
                  Start Engine
                </Button>

                <div class="text-xs text-zinc-600">
                  Authorized folders live in <span class="font-mono">.opencode/openwork.json</span> and can be updated here anytime.
                </div>

                <div class="space-y-3">
                  <div class="flex gap-2">
                    <input
                      class="w-full bg-zinc-900/50 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                      placeholder="Add folder path…"
                      value={newAuthorizedDir()}
                      onInput={(e) => setNewAuthorizedDir(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          addAuthorizedDir();
                        }
                      }}
                    />
                    <Show when={isTauriRuntime()}>
                      <Button
                        variant="outline"
                        onClick={() => addAuthorizedDirFromPicker({ persistToWorkspace: true })}
                        disabled={busy()}
                      >
                        Pick
                      </Button>
                    </Show>
                    <Button
                      variant="secondary"
                      onClick={addAuthorizedDir}
                      disabled={!newAuthorizedDir().trim()}
                    >
                      <Plus size={16} />
                      Add
                    </Button>
                  </div>

                  <Show when={authorizedDirs().length}>
                    <div class="space-y-2">
                      <For each={authorizedDirs()}>
                        {(dir, idx) => (
                          <div class="flex items-center justify-between gap-3 rounded-xl bg-black/20 border border-zinc-800 px-3 py-2">
                            <div class="min-w-0 text-xs font-mono text-zinc-300 truncate">{dir}</div>
                            <Button
                              variant="ghost"
                              class="!p-2 rounded-lg"
                              onClick={() => removeAuthorizedDir(idx())}
                              disabled={busy()}
                              title="Remove"
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                <Show when={isTauriRuntime()}>
                  <div class="rounded-2xl bg-zinc-900/40 border border-zinc-800 p-4">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-white">OpenCode CLI</div>
                        <div class="mt-1 text-xs text-zinc-500">
                          <Show when={engineDoctorResult()} fallback={<span>Checking install…</span>}>
                            <Show
                              when={engineDoctorResult()?.found}
                              fallback={<span>Not found. Install to run Host mode.</span>}
                            >
                              <span class="font-mono">
                                {engineDoctorResult()?.version ?? "Installed"}
                              </span>
                              <Show when={engineDoctorResult()?.resolvedPath}>
                                <span class="text-zinc-600"> · </span>
                                <span class="font-mono text-zinc-600 truncate">
                                  {engineDoctorResult()?.resolvedPath}
                                </span>
                              </Show>
                            </Show>
                          </Show>
                        </div>
                      </div>

                      <Button
                        variant="secondary"
                        onClick={async () => {
                          setEngineInstallLogs(null);
                          await refreshEngineDoctor();
                        }}
                        disabled={busy()}
                      >
                        Re-check
                      </Button>
                    </div>

                    <Show when={engineDoctorResult() && !engineDoctorResult()!.found}>
                      <div class="mt-4 space-y-2">
                        <div class="text-xs text-zinc-500">Install one of these:</div>
                        <div class="rounded-xl bg-black/40 border border-zinc-800 px-3 py-2 font-mono text-xs text-zinc-300">
                          brew install anomalyco/tap/opencode
                        </div>
                        <div class="rounded-xl bg-black/40 border border-zinc-800 px-3 py-2 font-mono text-xs text-zinc-300">
                          curl -fsSL https://opencode.ai/install | bash
                        </div>

                        <div class="flex gap-2 pt-2">
                          <Button
                            onClick={async () => {
                              setError(null);
                              setEngineInstallLogs(null);
                              setBusy(true);
                              setBusyLabel("Installing OpenCode");
                              setBusyStartedAt(Date.now());

                              try {
                                const result = await engineInstall();
                                const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
                                setEngineInstallLogs(combined || null);

                                if (!result.ok) {
                                  setError(result.stderr.trim() || "OpenCode install failed. See logs above.");
                                }

                                await refreshEngineDoctor();
                              } catch (e) {
                                setError(e instanceof Error ? e.message : safeStringify(e));
                              } finally {
                                setBusy(false);
                                setBusyLabel(null);
                                setBusyStartedAt(null);
                              }
                            }}
                            disabled={busy()}
                          >
                            Install OpenCode
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => {
                              const notes = engineDoctorResult()?.notes?.join("\n") ?? "";
                              setEngineInstallLogs(notes || null);
                            }}
                            disabled={busy()}
                          >
                            Show search notes
                          </Button>
                        </div>
                      </div>
                    </Show>

                    <Show when={engineInstallLogs()}>
                      <pre class="mt-4 max-h-48 overflow-auto rounded-xl bg-black/50 border border-zinc-800 p-3 text-xs text-zinc-300 whitespace-pre-wrap">{engineInstallLogs()}</pre>
                    </Show>

                    <Show when={engineDoctorCheckedAt()}>
                      <div class="mt-3 text-[11px] text-zinc-600">
                        Last checked {new Date(engineDoctorCheckedAt()!).toLocaleTimeString()}
                      </div>
                    </Show>
                  </div>
                </Show>

                <Button
                  onClick={async () => {

                    setMode("host");
                    setOnboardingStep("connecting");
                    const ok = await startHost();
                    if (!ok) {
                      setOnboardingStep("host");
                    }
                  }}
                  disabled={
                    busy() ||
                    (isTauriRuntime() &&
                      (engineDoctorResult()?.found === false ||
                        engineDoctorResult()?.supportsServe === false))
                  }
                  class="w-full py-3 text-base"
                >
                  Confirm & Start Engine
                </Button>

                <Button
                  variant="ghost"
                  onClick={() => {
                    setMode(null);
                    setOnboardingStep("mode");
                  }}
                  disabled={busy()}
                  class="text-zinc-600 hover:text-zinc-400 text-sm font-medium transition-colors flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-zinc-900/50"
                >
                  Back
                </Button>
              </div>

              <Show when={error()}>
                <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
                  {error()}
                </div>
              </Show>
            </div>
          </div>
        </Match>

        <Match when={onboardingStep() === "client"}>
          <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
            <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />

            <div class="max-w-md w-full z-10 space-y-8">
              <div class="text-center space-y-2">
                <div class="w-12 h-12 bg-zinc-900 rounded-2xl mx-auto flex items-center justify-center border border-zinc-800 mb-6">
                  <Smartphone class="text-zinc-400" />
                </div>
                <h2 class="text-2xl font-bold tracking-tight">Connect to Host</h2>
                <p class="text-zinc-400 text-sm leading-relaxed">
                  Pair with an existing OpenCode server (LAN or tunnel).
                </p>
              </div>

              <div class="space-y-4">
                <TextInput
                  label="Server URL"
                  placeholder="http://127.0.0.1:4096"
                  value={baseUrl()}
                  onInput={(e) => setBaseUrl(e.currentTarget.value)}
                />
                <TextInput
                  label="Directory (optional)"
                  placeholder="/path/to/project"
                  value={clientDirectory()}
                  onInput={(e) => setClientDirectory(e.currentTarget.value)}
                  hint="Use if your host runs multiple workspaces."
                />

                <Button
                  onClick={async () => {
                    setMode("client");
                    setOnboardingStep("connecting");

                    const ok = await connectToServer(
                      baseUrl().trim(),
                      clientDirectory().trim() ? clientDirectory().trim() : undefined,
                    );

                    if (!ok) {
                      setOnboardingStep("client");
                    }
                  }}
                  disabled={busy() || !baseUrl().trim()}
                  class="w-full py-3 text-base"
                >
                  Connect
                </Button>

                <Button
                  variant="ghost"
                  onClick={() => {
                    setMode(null);
                    setOnboardingStep("mode");
                  }}
                  disabled={busy()}
                  class="w-full"
                >
                  Back
                </Button>

                <Show when={error()}>
                  <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
                    {error()}
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </Match>

        <Match when={true}>
          <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
            <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />

            <div class="max-w-xl w-full z-10 space-y-12">
              <div class="text-center space-y-4">
                <div class="flex items-center justify-center gap-3 mb-6">
                  <div class="w-12 h-12 bg-white rounded-xl flex items-center justify-center">
                    <OpenWorkLogo size={24} class="text-black" />
                  </div>
                  <h1 class="text-3xl font-bold tracking-tight">OpenWork</h1>
                </div>
                <h2 class="text-xl text-zinc-400 font-light">How would you like to run OpenWork today?</h2>
              </div>

              <div class="space-y-4">
                <button
                  onClick={() => {
                    if (rememberModeChoice()) {
                      writeModePreference("host");
                    }
                    setMode("host");
                    setOnboardingStep("host");
                  }}
                  class="group w-full relative bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 p-6 md:p-8 rounded-3xl text-left transition-all duration-300 hover:shadow-2xl hover:shadow-indigo-500/10 hover:-translate-y-0.5 flex items-start gap-6"
                >
                  <div class="shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center border border-indigo-500/20 group-hover:border-indigo-500/40 transition-colors">
                    <HardDrive class="text-indigo-400 w-7 h-7" />
                  </div>
                  <div>
                    <h3 class="text-xl font-medium text-white mb-2">Start Host Engine</h3>
                    <p class="text-zinc-500 text-sm leading-relaxed mb-4">
                      Run OpenCode locally. Best for your primary computer.
                    </p>
                    <div class="flex items-center gap-2 text-xs font-mono text-indigo-400/80 bg-indigo-900/10 w-fit px-2 py-1 rounded border border-indigo-500/10">
                      <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                      {localHostLabel()}
                    </div>
                  </div>
                  <div class="absolute top-8 right-8 text-zinc-700 group-hover:text-zinc-500 transition-colors">
                    <ArrowRight size={24} />
                  </div>
                </button>

                <Show when={engine()?.running && engine()?.baseUrl}>
                  <div class="rounded-2xl bg-zinc-900/40 border border-zinc-800 p-5 flex items-center justify-between">
                    <div>
                      <div class="text-sm text-white font-medium">Engine already running</div>
                      <div class="text-xs text-zinc-500 font-mono truncate max-w-[14rem] md:max-w-[22rem]">
                        {engine()?.baseUrl}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        setMode("host");
                        setOnboardingStep("connecting");
                        const ok = await connectToServer(
                          engine()!.baseUrl!,
                          engine()!.projectDir ?? undefined,
                        );
                        if (!ok) {
                          setMode(null);
                          setOnboardingStep("mode");
                        }
                      }}
                      disabled={busy()}
                    >
                      Attach
                    </Button>
                  </div>
                </Show>

                <div class="flex items-center gap-2 px-2 py-1">
                  <button
                    onClick={() => setRememberModeChoice((v) => !v)}
                    class="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group"
                  >
                    <div
                      class={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                        rememberModeChoice()
                          ? "bg-indigo-500 border-indigo-500 text-black"
                          : "border-zinc-700 bg-transparent group-hover:border-zinc-500"
                      }`}
                    >
                      <Show when={rememberModeChoice()}>
                        <CheckCircle2 size={10} />
                      </Show>
                    </div>
                    Remember my choice for next time
                  </button>
                </div>

                <div class="pt-6 border-t border-zinc-900 flex justify-center">
                  <button
                    onClick={() => {
                      if (rememberModeChoice()) {
                        writeModePreference("client");
                      }
                      setMode("client");
                      setOnboardingStep("client");
                    }}
                    class="text-zinc-600 hover:text-zinc-400 text-sm font-medium transition-colors flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-zinc-900/50"
                  >
                    <Smartphone size={16} />
                    Or connect as a Client (Remote Pairing)
                  </button>
                </div>

                <Show when={error()}>
                  <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
                    {error()}
                  </div>
                </Show>

                <div class="text-center text-xs text-zinc-700">{headerStatus()}</div>
              </div>
            </div>
          </div>
        </Match>
      </Switch>
    );
  }

  function DashboardView() {
    const title = createMemo(() => {
      switch (tab()) {
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

    const quickTemplates = createMemo(() => workspaceTemplates().slice(0, 3));

    createEffect(() => {
      if (tab() === "skills") {
        refreshSkills().catch(() => undefined);
      }
      if (tab() === "plugins") {
        refreshPlugins().catch(() => undefined);
      }

      // Keep session sidebar context fresh.
      if (tab() === "sessions" || view() === "session") {
        refreshSkills().catch(() => undefined);
        refreshPlugins("project").catch(() => undefined);
      }
    });

    const navItem = (t: DashboardTab, label: string, icon: any) => {
      const active = () => tab() === t;
      return (
        <button
          class={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
            active() ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-white hover:bg-zinc-900/50"
          }`}
          onClick={() => setTab(t)}
        >
          {icon}
          {label}
        </button>
      );
    };


    const content = () => (
      <Switch>
        <Match when={tab() === "home"}>
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
                  onClick={createSessionAndOpen}
                  disabled={newTaskDisabled()}
                  title={newTaskDisabled() ? busyHint() ?? "Busy" : ""}
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
                onClick={() => setTab("templates")}
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
                      onClick={() => runTemplate(t)}
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
              <For each={sessions().slice(0, 12)}>
                {(s, idx) => (
                  <button
                    class={`w-full p-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors text-left ${
                      idx() !== Math.min(sessions().length, 12) - 1 ? "border-b border-zinc-800/50" : ""
                    }`}
                    onClick={async () => {
                      await selectSession(s.id);
                      setView("session");
                      setTab("sessions");
                    }}
                  >
                    <div class="flex items-center gap-4">
                      <div class="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-500 font-mono">
                        #{s.slug?.slice(0, 2) ?? ".."}
                      </div>
                      <div>
                        <div class="font-medium text-sm text-zinc-200">{s.title}</div>
                        <div class="text-xs text-zinc-500 flex items-center gap-2">
                          <Clock size={10} /> {formatRelativeTime(s.time.updated)}
                          <Show when={activeWorkspaceRoot().trim() && s.directory === activeWorkspaceRoot().trim()}>
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
                        {sessionStatusById()[s.id] ?? "idle"}
                      </span>
                      <ChevronRight size={16} class="text-zinc-600" />
                    </div>
                  </button>
                )}
              </For>

              <Show when={!sessions().length}>
                <div class="p-6 text-sm text-zinc-500">No sessions yet.</div>
              </Show>
            </div>
          </section>
        </Match>

        <Match when={tab() === "sessions"}>
          <section>
            <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">All Sessions</h3>

            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl overflow-hidden">
              <For each={sessions()}>
                {(s, idx) => (
                  <button
                    class={`w-full p-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors text-left ${
                      idx() !== sessions().length - 1 ? "border-b border-zinc-800/50" : ""
                    }`}
                    onClick={async () => {
                      await selectSession(s.id);
                      setView("session");
                    }}
                  >
                    <div class="flex items-center gap-4">
                      <div class="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-500 font-mono">
                        #{s.slug?.slice(0, 2) ?? ".."}
                      </div>
                      <div>
                        <div class="font-medium text-sm text-zinc-200">{s.title}</div>
                        <div class="text-xs text-zinc-500 flex items-center gap-2">
                          <Clock size={10} /> {formatRelativeTime(s.time.updated)}
                          <Show when={activeWorkspaceRoot().trim() && s.directory === activeWorkspaceRoot().trim()}>
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
                        {sessionStatusById()[s.id] ?? "idle"}
                      </span>
                      <ChevronRight size={16} class="text-zinc-600" />
                    </div>
                  </button>
                )}
              </For>

              <Show when={!sessions().length}>
                <div class="p-6 text-sm text-zinc-500">No sessions yet.</div>
              </Show>
            </div>
          </section>
        </Match>

        <Match when={tab() === "templates"}>
          <section class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider">Templates</h3>
              <Button
                variant="secondary"
                onClick={() => {
                  setTemplateDraftTitle("");
                  setTemplateDraftDescription("");
                  setTemplateDraftPrompt("");
                  setTemplateModalOpen(true);
                }}
                disabled={busy()}
              >
                <Plus size={16} />
                New
              </Button>
            </div>

            <Show
              when={workspaceTemplates().length || globalTemplates().length}
              fallback={
                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-6 text-sm text-zinc-500">
                  Starter templates will appear here. Create one or save from a session.
                </div>
              }
            >
              <div class="space-y-6">
                <Show when={workspaceTemplates().length}>
                  <div class="space-y-3">
                    <div class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Workspace</div>
                    <For each={workspaceTemplates()}>
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
                            <Button variant="secondary" onClick={() => runTemplate(t)} disabled={busy()}>
                              <Play size={16} />
                              Run
                            </Button>
                            <Button variant="danger" onClick={() => deleteTemplate(t.id)} disabled={busy()}>
                              <Trash2 size={16} />
                            </Button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={globalTemplates().length}>
                  <div class="space-y-3">
                    <div class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Global</div>
                    <For each={globalTemplates()}>
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
                            <Button variant="secondary" onClick={() => runTemplate(t)} disabled={busy()}>
                              <Play size={16} />
                              Run
                            </Button>
                            <Button variant="danger" onClick={() => deleteTemplate(t.id)} disabled={busy()}>
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

        <Match when={tab() === "skills"}>
          <section class="space-y-6">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider">Skills</h3>
              <Button variant="secondary" onClick={() => refreshSkills()} disabled={busy()}>
                Refresh
              </Button>
            </div>

            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-center justify-between gap-3">
                <div class="text-sm font-medium text-white">Install from OpenPackage</div>
                <Show when={mode() !== "host"}>
                  <div class="text-xs text-zinc-500">Host mode only</div>
                </Show>
              </div>
              <div class="flex flex-col md:flex-row gap-2">
                <input
                  class="w-full bg-zinc-900/50 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                  placeholder="github:anthropics/claude-code"
                  value={openPackageSource()}
                  onInput={(e) => setOpenPackageSource(e.currentTarget.value)}
                />
                <Button
                  onClick={() => installFromOpenPackage()}
                  disabled={busy() || mode() !== "host" || !isTauriRuntime()}
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
                  onClick={importLocalSkill}
                  disabled={busy() || mode() !== "host" || !isTauriRuntime()}
                >
                  <Upload size={16} />
                  Import
                </Button>
              </div>

              <Show when={skillsStatus()}>
                <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-300 whitespace-pre-wrap break-words">
                  {skillsStatus()}
                </div>
              </Show>
            </div>

            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium text-white">Curated packages</div>
                <div class="text-xs text-zinc-500">{filteredPackages().length}</div>
              </div>

              <input
                class="w-full bg-zinc-900/50 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
                placeholder="Search packages or lists (e.g. claude, registry, community)"
                value={packageSearch()}
                onInput={(e) => setPackageSearch(e.currentTarget.value)}
              />

              <Show
                when={filteredPackages().length}
                fallback={
                  <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-400">
                    No curated matches. Try a different search.
                  </div>
                }
              >
                <div class="space-y-3">
                  <For each={filteredPackages()}>
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
                            onClick={() => useCuratedPackage(pkg)}
                            disabled={
                              busy() ||
                              (pkg.installable && (mode() !== "host" || !isTauriRuntime()))
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
                <div class="text-xs text-zinc-500">{skills().length}</div>
              </div>

              <Show
                when={skills().length}
                fallback={
                  <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-6 text-sm text-zinc-500">
                    No skills detected in `.opencode/skill`.
                  </div>
                }
              >
                <div class="grid gap-3">
                  <For each={skills()}>
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

        <Match when={tab() === "plugins"}>
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
                      pluginScope() === "project"
                        ? "bg-white/10 text-white border-white/20"
                        : "text-zinc-500 border-zinc-800 hover:text-white"
                    }`}
                    onClick={() => {
                      setPluginScope("project");
                      refreshPlugins("project").catch(() => undefined);
                    }}
                  >
                    Project
                  </button>
                  <button
                    class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                      pluginScope() === "global"
                        ? "bg-white/10 text-white border-white/20"
                        : "text-zinc-500 border-zinc-800 hover:text-white"
                    }`}
                    onClick={() => {
                      setPluginScope("global");
                      refreshPlugins("global").catch(() => undefined);
                    }}
                  >
                    Global
                  </button>
                  <Button variant="ghost" onClick={() => refreshPlugins().catch(() => undefined)}>
                    Refresh
                  </Button>
                </div>
              </div>

              <div class="flex flex-col gap-1 text-xs text-zinc-500">
                <div>Config</div>
                <div class="text-zinc-600 font-mono truncate">
                  {pluginConfig()?.path ?? "Not loaded yet"}
                </div>
              </div>

              <div class="space-y-3">
                <div class="text-xs font-medium text-zinc-400 uppercase tracking-wider">Suggested plugins</div>
                <div class="grid gap-3">
                  <For each={SUGGESTED_PLUGINS}>
                    {(plugin) => {
                      const isGuided = () => plugin.installMode === "guided";
                      const isInstalled = () =>
                        isPluginInstalled(plugin.packageName, plugin.aliases ?? []);
                      const isGuideOpen = () => activePluginGuide() === plugin.packageName;

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
                                    setActivePluginGuide(isGuideOpen() ? null : plugin.packageName)
                                  }
                                >
                                  {isGuideOpen() ? "Hide setup" : "Setup"}
                                </Button>
                              </Show>
                              <Button
                                variant={isInstalled() ? "outline" : "secondary"}
                                onClick={() => addPlugin(plugin.packageName)}
                                disabled={
                                  busy() ||
                                  isInstalled() ||
                                  !isTauriRuntime() ||
                                  (pluginScope() === "project" && !projectDir().trim())
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
                when={pluginList().length}
                fallback={
                  <div class="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-sm text-zinc-500">
                    No plugins configured yet.
                  </div>
                }
              >
                <div class="grid gap-2">
                  <For each={pluginList()}>
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
                      value={pluginInput()}
                      onInput={(e) => setPluginInput(e.currentTarget.value)}
                      hint="Add npm package names, e.g. opencode-wakatime"
                    />
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => addPlugin()}
                    disabled={busy() || !pluginInput().trim()}
                    class="md:mt-6"
                  >
                    Add
                  </Button>
                </div>
                <Show when={pluginStatus()}>
                  <div class="text-xs text-zinc-500">{pluginStatus()}</div>
                </Show>
              </div>
            </div>
          </section>
        </Match>

        <Match when={tab() === "settings"}>
          <section class="space-y-6">
            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
              <div class="text-sm font-medium text-white">Connection</div>
              <div class="text-xs text-zinc-500">{headerStatus()}</div>
              <div class="text-xs text-zinc-600 font-mono">{baseUrl()}</div>
              <div class="pt-2 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setDeveloperMode((v) => !v)}>
                  <Shield size={16} />
                  {developerMode() ? "Developer On" : "Developer Off"}
                </Button>
                <Show when={mode() === "host"}>
                  <Button variant="danger" onClick={stopHost} disabled={busy()}>
                    Stop engine
                  </Button>
                </Show>
                <Show when={mode() === "client"}>
                  <Button variant="outline" onClick={stopHost} disabled={busy()}>
                    Disconnect
                  </Button>
                </Show>
              </div>

              <Show when={isTauriRuntime() && mode() === "host"}>
                <div class="pt-4 border-t border-zinc-800/60 space-y-3">
                  <div class="text-xs text-zinc-500">Engine source</div>
                  <div class="grid grid-cols-2 gap-2">
                    <Button
                      variant={engineSource() === "path" ? "secondary" : "outline"}
                      onClick={() => setEngineSource("path")}
                      disabled={busy()}
                    >
                      PATH
                    </Button>
                    <Button
                      variant={engineSource() === "sidecar" ? "secondary" : "outline"}
                      onClick={() => setEngineSource("sidecar")}
                      disabled={busy()}
                    >
                      Sidecar
                    </Button>
                  </div>
                  <div class="text-[11px] text-zinc-600">
                    PATH uses your installed OpenCode (default). Sidecar will use a bundled binary when available.
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
                  <div class="text-sm text-zinc-200 truncate">{formatModelLabel(defaultModel(), providers())}</div>
                  <div class="text-xs text-zinc-600 font-mono truncate">{formatModelRef(defaultModel())}</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={openDefaultModelPicker}
                  disabled={busy()}
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
                  onClick={() => setShowThinking((v) => !v)}
                  disabled={busy()}
                >
                  {showThinking() ? "On" : "Off"}
                </Button>
              </div>

              <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-zinc-200">Model variant</div>
                  <div class="text-xs text-zinc-600 font-mono truncate">
                    {modelVariant() ? modelVariant() : "(default)"}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={() => {
                    const next = window.prompt(
                      "Model variant (provider-specific, e.g. high/max/minimal). Leave blank to clear.",
                      modelVariant() ?? "",
                    );
                    if (next == null) return;
                    const trimmed = next.trim();
                    setModelVariant(trimmed ? trimmed : null);
                  }}
                  disabled={busy()}
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
                <div class="text-xs text-zinc-600 font-mono">{appVersion() ? `v${appVersion()}` : ""}</div>
              </div>

              <Show
                when={!isTauriRuntime()}
                fallback={
                  <Show
                    when={updateEnv() && !updateEnv()!.supported}
                    fallback={
                      <>
                        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                          <div class="space-y-0.5">
                            <div class="text-sm text-white">Automatic checks</div>
                            <div class="text-xs text-zinc-600">Once per day (quiet)</div>
                          </div>
                          <button
                            class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                              updateAutoCheck()
                                ? "bg-white/10 text-white border-white/20"
                                : "text-zinc-500 border-zinc-800 hover:text-white"
                            }`}
                            onClick={() => setUpdateAutoCheck((v) => !v)}
                          >
                            {updateAutoCheck() ? "On" : "Off"}
                          </button>
                        </div>

                        <div class="flex items-center justify-between gap-3 bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                          <div class="space-y-0.5">
                            <div class="text-sm text-white">
                              <Switch>
                                <Match when={updateStatus().state === "checking"}>Checking…</Match>
                                <Match when={updateStatus().state === "available"}>
                                  Update available: v{(updateStatus() as any).version}
                                </Match>
                                <Match when={updateStatus().state === "downloading"}>Downloading…</Match>
                                <Match when={updateStatus().state === "ready"}>
                                  Ready to install: v{(updateStatus() as any).version}
                                </Match>
                                <Match when={updateStatus().state === "error"}>Update check failed</Match>
                                <Match when={true}>Up to date</Match>
                              </Switch>
                            </div>
                            <Show
                              when={
                                updateStatus().state === "idle" &&
                                (updateStatus() as { state: "idle"; lastCheckedAt: number | null }).lastCheckedAt
                              }
                            >
                              <div class="text-xs text-zinc-600">
                                Last checked {formatRelativeTime((updateStatus() as { state: "idle"; lastCheckedAt: number | null }).lastCheckedAt!)}
                              </div>
                            </Show>
                            <Show when={updateStatus().state === "available" && (updateStatus() as any).date}>
                              <div class="text-xs text-zinc-600">Published {(updateStatus() as any).date}</div>
                            </Show>
                            <Show when={updateStatus().state === "downloading"}>
                              <div class="text-xs text-zinc-600">
                                {formatBytes((updateStatus() as any).downloadedBytes)}
                                <Show when={(updateStatus() as any).totalBytes != null}>
                                  {` / ${formatBytes((updateStatus() as any).totalBytes)}`}
                                </Show>
                              </div>
                            </Show>
                            <Show when={updateStatus().state === "error"}>
                              <div class="text-xs text-red-300">{(updateStatus() as any).message}</div>
                            </Show>
                          </div>

                          <div class="flex items-center gap-2">
                            <Button
                              variant="outline"
                              class="text-xs h-8 py-0 px-3"
                              onClick={() => checkForUpdates()}
                              disabled={busy() || updateStatus().state === "checking" || updateStatus().state === "downloading"}
                            >
                              Check
                            </Button>

                            <Show when={updateStatus().state === "available"}>
                              <Button
                                variant="secondary"
                                class="text-xs h-8 py-0 px-3"
                                onClick={() => downloadUpdate()}
                                disabled={busy() || updateStatus().state === "downloading"}
                              >
                                Download
                              </Button>
                            </Show>

                            <Show when={updateStatus().state === "ready"}>
                              <Button
                                variant="secondary"
                                class="text-xs h-8 py-0 px-3"
                                onClick={() => installUpdateAndRestart()}
                                disabled={busy() || anyActiveRuns()}
                                title={anyActiveRuns() ? "Stop active runs to update" : ""}
                              >
                                Install & Restart
                              </Button>
                            </Show>
                          </div>
                        </div>

                        <Show when={updateStatus().state === "available" && (updateStatus() as any).notes}>
                          <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-400 whitespace-pre-wrap max-h-40 overflow-auto">
                            {(updateStatus() as any).notes}
                          </div>
                        </Show>
                      </>
                    }
                  >
                    <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-sm text-zinc-400">
                      {updateEnv()?.reason ?? "Updates are not supported in this environment."}
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
                      mode() === "host"
                        ? "bg-indigo-500/10 text-indigo-400"
                        : "bg-emerald-500/10 text-emerald-400"
                    }`}
                  >
                    <Show when={mode() === "host"} fallback={<Smartphone size={18} />}>
                      <HardDrive size={18} />
                    </Show>
                  </div>
                  <span class="capitalize text-sm font-medium text-white">{mode()} mode</span>
                </div>
                <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={stopHost} disabled={busy()}>
                  Switch
                </Button>
              </div>

              <Button
                variant="secondary"
                class="w-full justify-between group"
                onClick={() => {
                  clearModePreference();
                }}
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
                  onClick={() => openResetModal("onboarding")}
                  disabled={busy() || resetModalBusy() || anyActiveRuns()}
                  title={anyActiveRuns() ? "Stop active runs to reset" : ""}
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
                  onClick={() => openResetModal("all")}
                  disabled={busy() || resetModalBusy() || anyActiveRuns()}
                  title={anyActiveRuns() ? "Stop active runs to reset" : ""}
                >
                  Reset
                </Button>
              </div>

              <div class="text-xs text-zinc-600">
                Requires typing <span class="font-mono text-zinc-400">RESET</span> and will restart the app.
              </div>
            </div>

            <Show when={developerMode()}>
              <section>
                <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">Developer</h3>

                <div class="grid md:grid-cols-2 gap-4">
                  <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4">
                    <div class="text-xs text-zinc-500 mb-2">Pending permissions</div>
                    <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                      {safeStringify(pendingPermissions())}
                    </pre>
                  </div>
                  <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4">
                    <div class="text-xs text-zinc-500 mb-2">Recent events</div>
                    <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                      {safeStringify(events())}
                    </pre>
                  </div>
                </div>
              </section>
            </Show>
          </section>
        </Match>
      </Switch>
    );

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
              {navItem("settings", "Settings", <Settings size={18} />)}
            </nav>
          </div>

          <div class="space-y-4">
            <div class="px-3 py-3 rounded-xl bg-zinc-900/50 border border-zinc-800">
              <div class="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
                {mode() === "host" ? <Cpu size={12} /> : <Smartphone size={12} />}
                {mode() === "host" ? "Local Engine" : "Client Mode"}
              </div>
              <div class="flex items-center gap-2">
                <div
                  class={`w-2 h-2 rounded-full ${
                    client() ? "bg-emerald-500 animate-pulse" : "bg-zinc-600"
                  }`}
                />
                <span
                  class={`text-sm font-mono ${client() ? "text-emerald-500" : "text-zinc-500"}`}
                >
                  {client() ? "Connected" : "Disconnected"}
                </span>
              </div>
              <div class="mt-2 text-[11px] text-zinc-600 font-mono truncate">{baseUrl()}</div>
            </div>

            <Show when={mode() === "host"}>
              <Button variant="danger" onClick={stopHost} disabled={busy()} class="w-full">
                Stop & Disconnect
              </Button>
            </Show>

            <Show when={mode() === "client"}>
              <Button variant="outline" onClick={stopHost} disabled={busy()} class="w-full">
                Disconnect
              </Button>
            </Show>
          </div>
        </aside>

        <main class="flex-1 overflow-y-auto relative pb-24 md:pb-0">
          <header class="h-16 flex items-center justify-between px-6 md:px-10 border-b border-zinc-800 sticky top-0 bg-zinc-950/80 backdrop-blur-md z-10">
            <div class="flex items-center gap-3">
              <div class="md:hidden">
                <Menu class="text-zinc-400" />
              </div>
              <WorkspaceChip
                workspace={activeWorkspaceDisplay()}
                onClick={() => {
                  setWorkspaceSearch("");
                  setWorkspacePickerOpen(true);
                }}
              />
              <h1 class="text-lg font-medium">{title()}</h1>
              <span class="text-xs text-zinc-600">{headerStatus()}</span>
              <Show when={busyHint()}>
                <span class="text-xs text-zinc-500">· {busyHint()}</span>
              </Show>
            </div>
            <div class="flex items-center gap-2">
              <Show when={tab() === "home" || tab() === "sessions"}>
                <Button onClick={createSessionAndOpen} disabled={newTaskDisabled()} title={newTaskDisabled() ? busyHint() ?? "Busy" : ""}>
                  <Play size={16} />
                  New Task
                </Button>
              </Show>
              <Show when={tab() === "templates"}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTemplateDraftTitle("");
                    setTemplateDraftDescription("");
                    setTemplateDraftPrompt("");
                    setTemplateModalOpen(true);
                  }}
                  disabled={busy()}
                >
                  <Plus size={16} />
                  New
                </Button>
              </Show>
              <Button variant="ghost" onClick={() => setDeveloperMode((v) => !v)}>
                <Shield size={16} />
              </Button>
            </div>
          </header>

          <div class="p-6 md:p-10 max-w-5xl mx-auto space-y-10">{content()}</div>

          <Show when={error()}>
            <div class="mx-auto max-w-5xl px-6 md:px-10 pb-24 md:pb-10">
              <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
                {error()}
              </div>
            </div>
          </Show>

          <WorkspacePicker
            open={workspacePickerOpen()}
            workspaces={filteredWorkspaces()}
            activeWorkspaceId={activeWorkspaceId()}
            search={workspaceSearch()}
            onSearch={setWorkspaceSearch}
            onClose={() => setWorkspacePickerOpen(false)}
            onSelect={activateWorkspace}
            onCreateNew={() => setCreateWorkspaceOpen(true)}
          />

          <CreateWorkspaceModal
            open={createWorkspaceOpen()}
            onClose={() => setCreateWorkspaceOpen(false)}
            onConfirm={(preset) => createWorkspaceFlow(preset)}
          />

          <nav class="md:hidden fixed bottom-0 left-0 right-0 border-t border-zinc-800 bg-zinc-950/90 backdrop-blur-md">
            <div class="mx-auto max-w-5xl px-4 py-3 grid grid-cols-6 gap-2">
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  tab() === "home" ? "text-white" : "text-zinc-500"
                }`}
                onClick={() => setTab("home")}
              >
                <Command size={18} />
                Home
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  tab() === "sessions" ? "text-white" : "text-zinc-500"
                }`}
                onClick={() => setTab("sessions")}
              >
                <Play size={18} />
                Runs
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  tab() === "templates" ? "text-white" : "text-zinc-500"
                }`}
                onClick={() => setTab("templates")}
              >
                <FileText size={18} />
                Templates
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  tab() === "skills" ? "text-white" : "text-zinc-500"
                }`}
                onClick={() => setTab("skills")}
              >
                <Package size={18} />
                Skills
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  tab() === "plugins" ? "text-white" : "text-zinc-500"
                }`}
                onClick={() => setTab("plugins")}
              >
                <Cpu size={18} />
                Plugins
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  tab() === "settings" ? "text-white" : "text-zinc-500"
                }`}
                onClick={() => setTab("settings")}
              >
                <Settings size={18} />
                Settings
              </button>
            </div>
          </nav>
        </main>
      </div>
    );
  }

  function SessionView() {
    let messagesEndEl: HTMLDivElement | undefined;

    createEffect(() => {
      messages();
      todos();
      messagesEndEl?.scrollIntoView({ behavior: "smooth" });
    });

    return (
      <Show
        when={selectedSessionId()}
        fallback={
          <div class="min-h-screen flex items-center justify-center bg-zinc-950 text-white p-6">
            <div class="text-center space-y-4">
              <div class="text-lg font-medium">No session selected</div>
              <Button
                onClick={() => {
                  setView("dashboard");
                  setTab("sessions");
                }}
              >
                Back to dashboard
              </Button>
            </div>
          </div>
        }
      >
        <div class="h-screen flex flex-col bg-zinc-950 text-white relative">
          <header class="h-16 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-950/80 backdrop-blur-md z-10 sticky top-0">
            <div class="flex items-center gap-4">
              <Button
                variant="ghost"
                class="!p-2 rounded-full"
                onClick={() => {
                  setView("dashboard");
                  setTab("sessions");
                }}
              >
                <ArrowRight class="rotate-180 w-5 h-5" />
              </Button>
              <div>
                <h2 class="font-semibold text-sm">{selectedSession()?.title ?? "Session"}</h2>
                <div class="flex items-center gap-2 text-xs text-zinc-400">
                  <span
                    class={`w-2 h-2 rounded-full ${
                      selectedSessionStatus() === "running"
                        ? "bg-blue-500 animate-pulse"
                        : selectedSessionStatus() === "retry"
                          ? "bg-amber-500"
                          : selectedSessionStatus() === "idle"
                            ? "bg-emerald-500"
                            : "bg-zinc-600"
                    }`}
                  />
                  {selectedSessionStatus()}
                </div>
              </div>
            </div>

            <div class="flex gap-2 items-center">
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/60 border border-zinc-800 text-xs text-zinc-200 hover:bg-zinc-900/80 transition-colors max-w-[220px]"
                onClick={openSessionModelPicker}
                title="Change model"
              >
                <span class="truncate">{selectedSessionModelLabel()}</span>
                <ChevronRight size={14} class="text-zinc-500" />
              </button>

              <Button variant="ghost" class="text-xs" onClick={openTemplateModal} disabled={busy()}>
                <FileText size={14} />
              </Button>
              <Button variant="ghost" class="text-xs" onClick={() => setDeveloperMode((v) => !v)}>
                <Shield size={14} />
              </Button>
            </div>
          </header>

          <div class="flex-1 flex overflow-hidden">
            <div class="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth">
               <div class="max-w-2xl mx-auto space-y-6 pb-32">
                <Show when={messages().length === 0}>
                  <div class="text-center py-20 space-y-4">
                    <div class="w-16 h-16 bg-zinc-900 rounded-3xl mx-auto flex items-center justify-center border border-zinc-800">
                      <Zap class="text-zinc-600" />
                    </div>
                    <h3 class="text-xl font-medium">Ready to work</h3>
                    <p class="text-zinc-500 text-sm max-w-xs mx-auto">
                      Describe a task. I’ll show progress and ask for permissions when needed.
                    </p>
                  </div>
                </Show>

                <Show when={busyLabel() === "Running"}>
                  <ThinkingBlock steps={[{ status: "running", text: "Working…" } satisfies ThinkingStep]} />
                </Show>

                <For each={messages()}>
                  {(msg) => {
                    const renderableParts = () =>
                      msg.parts.filter((p) => {
                        if (p.type === "reasoning") {
                          return developerMode();
                        }

                        if (p.type === "step-start" || p.type === "step-finish") {
                          // Too noisy for normal users.
                          return developerMode();
                        }

                        if (p.type === "text" || p.type === "tool") {
                          return true;
                        }

                        return developerMode();
                      });

                    return (
                      <Show when={renderableParts().length > 0}>
                         <div class={`flex ${(msg.info as any).role === "user" ? "justify-end" : "justify-start"}`}>
                          <div
                            class={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed ${
                               (msg.info as any).role === "user"
                                 ? "bg-white text-black rounded-tr-sm shadow-xl shadow-white/5"
                                 : "bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-tl-sm"
                            }`}
                          >
                            <For each={renderableParts()}>
                              {(p, idx) => (
                                <div class={idx() === renderableParts().length - 1 ? "" : "mb-2"}>
                                    <PartView
                                      part={p}
                                      developerMode={developerMode()}
                                      showThinking={showThinking()}
                                      tone={(msg.info as any).role === "user" ? "dark" : "light"}
                                    />
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    );
                  }}
                </For>

                <div ref={(el) => (messagesEndEl = el)} />
              </div>
            </div>

            <div class="hidden lg:flex w-80 border-l border-zinc-800 bg-zinc-950 flex-col">
              <div class="p-4 border-b border-zinc-800 font-medium text-sm text-zinc-400 flex items-center justify-between">
                <span>Workspace</span>
              </div>
              <div class="p-4 space-y-5 overflow-y-auto flex-1">
                <div>
                  <div class="flex items-center justify-between text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    <span>Skills</span>
                    <span class="text-[11px] text-zinc-600">{skills().length}</span>
                  </div>
                  <div class="mt-3 space-y-2">
                    <Show when={skills().length} fallback={<div class="text-xs text-zinc-600 italic">No skills found</div>}>
                      <For each={skills().slice(0, 12)}>
                        {(s) => (
                          <div class="rounded-xl border border-zinc-800/70 bg-zinc-900/30 px-3 py-2">
                            <div class="text-sm text-zinc-200 truncate">{s.name}</div>
                            <Show when={s.description}>
                              <div class="mt-1 text-xs text-zinc-500 line-clamp-2">{s.description}</div>
                            </Show>
                          </div>
                        )}
                      </For>
                      <Show when={skills().length > 12}>
                        <div class="text-xs text-zinc-600">+{skills().length - 12} more</div>
                      </Show>
                    </Show>
                  </div>
                </div>

                <div>
                  <div class="flex items-center justify-between text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    <span>Plugins</span>
                    <span class="text-[11px] text-zinc-600">{sidebarPluginList().length}</span>
                  </div>
                  <div class="mt-3 space-y-2">
                    <Show
                      when={sidebarPluginList().length}
                      fallback={<div class="text-xs text-zinc-600 italic">{sidebarPluginStatus() ?? "No plugins configured"}</div>}
                    >
                      <For each={sidebarPluginList().slice(0, 16)}>
                        {(p) => (
                          <div class="rounded-xl border border-zinc-800/70 bg-zinc-900/30 px-3 py-2">
                            <div class="text-sm text-zinc-200 font-mono truncate">{p}</div>
                          </div>
                        )}
                      </For>
                      <Show when={sidebarPluginList().length > 16}>
                        <div class="text-xs text-zinc-600">+{sidebarPluginList().length - 16} more</div>
                      </Show>
                    </Show>
                  </div>
                </div>

                <div>
                  <div class="flex items-center justify-between text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    <span>Execution Plan</span>
                    <span class="text-xs bg-zinc-800 px-2 py-0.5 rounded text-zinc-500">
                      {todos().filter((t) => t.status === "completed").length}/{todos().length}
                    </span>
                  </div>
                  <div class="mt-3 space-y-2">
                    <Show
                      when={todos().length}
                      fallback={<div class="text-xs text-zinc-600 italic">Plan will appear here…</div>}
                    >
                      <For each={todos()}>
                        {(t, idx) => (
                          <div class="relative pl-6 pb-6 last:pb-0">
                            <Show when={idx() !== todos().length - 1}>
                              <div
                                class={`absolute left-[9px] top-6 bottom-0 w-px ${
                                  t.status === "completed" ? "bg-emerald-500/20" : "bg-zinc-800"
                                }`}
                              />
                            </Show>

                            <div
                              class={`absolute left-0 top-1 w-5 h-5 rounded-full border flex items-center justify-center bg-zinc-950 z-10 ${
                                t.status === "completed"
                                  ? "border-emerald-500 text-emerald-500"
                                  : t.status === "in_progress"
                                    ? "border-blue-500 text-blue-500"
                                    : t.status === "cancelled"
                                      ? "border-zinc-600 text-zinc-600"
                                      : "border-zinc-700 text-zinc-700"
                              }`}
                            >
                              <Show
                                when={t.status === "completed"}
                                fallback={
                                  <Show
                                    when={t.status === "in_progress"}
                                    fallback={
                                      <Show
                                        when={t.status === "cancelled"}
                                        fallback={<Circle size={10} />}
                                      >
                                        <X size={12} />
                                      </Show>
                                    }
                                  >
                                    <div class="w-2 h-2 rounded-full bg-current animate-pulse" />
                                  </Show>
                                }
                              >
                                <CheckCircle2 size={12} />
                              </Show>
                            </div>

                            <div
                              class={`text-sm ${
                                t.status === "completed"
                                  ? "text-zinc-400"
                                  : t.status === "in_progress"
                                    ? "text-blue-100"
                                    : "text-zinc-500"
                              }`}
                            >
                              {t.content}
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="p-4 border-t border-zinc-800 bg-zinc-950 sticky bottom-0 z-20">
            <div class="max-w-2xl mx-auto relative">
              <input
                type="text"
                disabled={busy()}
                value={prompt()}
                onInput={(e) => setPrompt(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    sendPrompt().catch(() => undefined);
                  }
                }}
                placeholder={busy() ? "Working..." : "Ask OpenWork to do something..."}
                class="w-full bg-zinc-900 border border-zinc-800 rounded-2xl py-4 pl-5 pr-14 text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all disabled:opacity-50"
              />
              <button
                disabled={!prompt().trim() || busy()}
                onClick={() => sendPrompt().catch(() => undefined)}
                class="absolute right-2 top-2 p-2 bg-white text-black rounded-xl hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-75"
                title="Run"
              >
                <ArrowRight size={20} />
              </button>
            </div>
          </div>

          <Show when={activePermission()}>
            <div class="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
              <div class="bg-zinc-900 border border-amber-500/30 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
                <div class="p-6">
                  <div class="flex items-start gap-4 mb-4">
                    <div class="p-3 bg-amber-500/10 rounded-full text-amber-500">
                      <Shield size={24} />
                    </div>
                    <div>
                      <h3 class="text-lg font-semibold text-white">Permission Required</h3>
                      <p class="text-sm text-zinc-400 mt-1">
                        OpenCode is requesting permission to continue.
                      </p>
                    </div>
                  </div>

                  <div class="bg-zinc-950/50 rounded-xl p-4 border border-zinc-800 mb-6">
                    <div class="text-xs text-zinc-500 uppercase tracking-wider mb-2 font-semibold">
                      Permission
                    </div>
                    <div class="text-sm text-zinc-200 font-mono">{activePermission()!.permission}</div>

                    <div class="text-xs text-zinc-500 uppercase tracking-wider mt-4 mb-2 font-semibold">
                      Scope
                    </div>
                    <div class="flex items-center gap-2 text-sm font-mono text-amber-200 bg-amber-950/30 px-2 py-1 rounded border border-amber-500/20">
                      <HardDrive size={12} />
                      {activePermission()!.patterns.join(", ")}
                    </div>

                    <Show when={Object.keys(activePermission()!.metadata ?? {}).length > 0}>
                      <details class="mt-4 rounded-lg bg-black/20 p-2">
                        <summary class="cursor-pointer text-xs text-zinc-400">Details</summary>
                        <pre class="mt-2 whitespace-pre-wrap break-words text-xs text-zinc-200">
                          {safeStringify(activePermission()!.metadata)}
                        </pre>
                      </details>
                    </Show>
                  </div>

                  <div class="grid grid-cols-2 gap-3">
                    <Button
                      variant="outline"
                      class="w-full border-red-500/20 text-red-400 hover:bg-red-950/30"
                      onClick={() => respondPermission(activePermission()!.id, "reject")}
                      disabled={permissionReplyBusy()}
                    >
                      Deny
                    </Button>
                    <div class="grid grid-cols-2 gap-2">
                      <Button
                        variant="secondary"
                        class="text-xs"
                        onClick={() => respondPermission(activePermission()!.id, "once")}
                        disabled={permissionReplyBusy()}
                      >
                        Once
                      </Button>
                      <Button
                        variant="primary"
                        class="text-xs font-bold bg-amber-500 hover:bg-amber-400 text-black border-none shadow-amber-500/20"
                         onClick={() => respondPermissionAndRemember(activePermission()!.id, "always")}
                         disabled={permissionReplyBusy()}
                       >
                         Allow for session
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    );
  }

  return (
    <>
      <Show when={client()} fallback={<OnboardingView />}>
        <Switch>
          <Match when={view() === "dashboard"}>
            <DashboardView />
          </Match>
          <Match when={view() === "session"}>
            <SessionView />
          </Match>
          <Match when={true}>
            <DashboardView />
          </Match>
        </Switch>
      </Show>

      <Show when={modelPickerOpen()}>
        <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
          <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
            <div class="p-6 flex flex-col min-h-0">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-white">
                    {modelPickerTarget() === "default" ? "Default model" : "Model"}
                  </h3>
                  <p class="text-sm text-zinc-400 mt-1">
                    Choose from your configured providers. This selection {modelPickerTarget() === "default"
                      ? "will be used for new sessions"
                      : "applies to your next message"}.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  class="!p-2 rounded-full"
                  onClick={() => setModelPickerOpen(false)}
                >
                  <X size={16} />
                </Button>
              </div>

              <div class="mt-5">
                <div class="relative">
                  <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="text"
                    value={modelPickerQuery()}
                    onInput={(e) => setModelPickerQuery(e.currentTarget.value)}
                    placeholder="Search models…"
                    class="w-full bg-zinc-950/40 border border-zinc-800 rounded-xl py-2.5 pl-9 pr-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600"
                  />
                </div>
                <Show when={modelPickerQuery().trim()}>
                  <div class="mt-2 text-xs text-zinc-500">
                    Showing {filteredModelOptions().length} of {modelOptions().length}
                  </div>
                </Show>
              </div>

              <div class="mt-4 space-y-2 overflow-y-auto pr-1 -mr-1 min-h-0">
                 <For each={filteredModelOptions()}>
                   {(opt) => {
                     const active = () =>
                       modelEquals(modelPickerCurrent(), {
                         providerID: opt.providerID,
                         modelID: opt.modelID,
                       });

                     return (
                       <button
                         class={`w-full text-left rounded-2xl border px-4 py-3 transition-colors ${
                           active()
                             ? "border-white/20 bg-white/5"
                             : "border-zinc-800/70 bg-zinc-950/40 hover:bg-zinc-950/60"
                         }`}
                         onClick={() =>
                           applyModelSelection({
                             providerID: opt.providerID,
                             modelID: opt.modelID,
                           })
                         }
                       >
                         <div class="flex items-start justify-between gap-3">
                           <div class="min-w-0">
                             <div class="text-sm font-medium text-zinc-100 flex items-center gap-2">
                               <span class="truncate">{opt.title}</span>
                             </div>
                             <Show when={opt.description}>
                               <div class="text-xs text-zinc-500 mt-1 truncate">{opt.description}</div>
                             </Show>
                             <Show when={opt.footer}>
                               <div class="text-[11px] text-zinc-600 mt-2">{opt.footer}</div>
                             </Show>
                             <div class="text-[11px] text-zinc-600 font-mono mt-2">
                               {opt.providerID}/{opt.modelID}
                             </div>
                           </div>

                           <div class="pt-0.5 text-zinc-500">
                             <Show when={active()} fallback={<Circle size={14} />}>
                               <CheckCircle2 size={14} class="text-emerald-400" />
                             </Show>
                           </div>
                         </div>
                       </button>
                     );
                   }}
                 </For>
              </div>

              <div class="mt-5 flex justify-end shrink-0">
                <Button variant="outline" onClick={() => setModelPickerOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={resetModalOpen()}>
        <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-white">
                    <Switch>
                      <Match when={resetModalMode() === "onboarding"}>Reset onboarding</Match>
                      <Match when={true}>Reset app data</Match>
                    </Switch>
                  </h3>
                  <p class="text-sm text-zinc-400 mt-1">
                    Type <span class="font-mono">RESET</span> to confirm. OpenWork will restart.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  class="!p-2 rounded-full"
                  onClick={() => setResetModalOpen(false)}
                  disabled={resetModalBusy()}
                >
                  <X size={16} />
                </Button>
              </div>

              <div class="mt-6 space-y-4">
                <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-400">
                  <Switch>
                    <Match when={resetModalMode() === "onboarding"}>
                      Clears OpenWork local preferences and workspace onboarding markers.
                    </Match>
                    <Match when={true}>
                      Clears OpenWork cache and app data on this device.
                    </Match>
                  </Switch>
                </div>

                <Show when={anyActiveRuns()}>
                  <div class="text-xs text-red-300">Stop active runs before resetting.</div>
                </Show>

                <TextInput
                  label="Confirmation"
                  placeholder="Type RESET"
                  value={resetModalText()}
                  onInput={(e) => setResetModalText(e.currentTarget.value)}
                  disabled={resetModalBusy()}
                />
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setResetModalOpen(false)} disabled={resetModalBusy()}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={confirmReset}
                  disabled={resetModalBusy() || anyActiveRuns() || resetModalText().trim().toUpperCase() !== "RESET"}
                >
                  Reset & Restart
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={templateModalOpen()}>
         <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
              <div class="p-6">
                <div class="flex items-start justify-between gap-4">
                 <div>
                   <h3 class="text-lg font-semibold text-white">Save Template</h3>
                   <p class="text-sm text-zinc-400 mt-1">Reuse a workflow with one tap.</p>
                 </div>
                 <Button
                   variant="ghost"
                   class="!p-2 rounded-full"
                   onClick={() => setTemplateModalOpen(false)}
                 >
                   <X size={16} />
                 </Button>
               </div>


              <div class="mt-6 space-y-4">
                <TextInput
                  label="Title"
                  value={templateDraftTitle()}
                  onInput={(e) => setTemplateDraftTitle(e.currentTarget.value)}
                  placeholder="e.g. Daily standup summary"
                />

                <TextInput
                  label="Description (optional)"
                  value={templateDraftDescription()}
                  onInput={(e) => setTemplateDraftDescription(e.currentTarget.value)}
                  placeholder="What does this template do?"
                />

                <div class="grid grid-cols-2 gap-2">
                  <button
                    class={`px-3 py-2 rounded-xl border text-sm transition-colors ${
                      templateDraftScope() === "workspace"
                        ? "bg-white/10 text-white border-white/20"
                        : "text-zinc-400 border-zinc-800 hover:text-white"
                    }`}
                    onClick={() => setTemplateDraftScope("workspace")}
                    type="button"
                  >
                    Workspace
                  </button>
                  <button
                    class={`px-3 py-2 rounded-xl border text-sm transition-colors ${
                      templateDraftScope() === "global"
                        ? "bg-white/10 text-white border-white/20"
                        : "text-zinc-400 border-zinc-800 hover:text-white"
                    }`}
                    onClick={() => setTemplateDraftScope("global")}
                    type="button"
                  >
                    Global
                  </button>
                </div>

                <label class="block">
                  <div class="mb-1 text-xs font-medium text-neutral-300">Prompt</div>
                  <textarea
                    class="w-full min-h-40 rounded-xl bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-white/20"
                    value={templateDraftPrompt()}
                    onInput={(e) => setTemplateDraftPrompt(e.currentTarget.value)}
                    placeholder="Write the instructions you want to reuse…"
                  />
                  <div class="mt-1 text-xs text-neutral-500">This becomes the first user message.</div>
                </label>
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setTemplateModalOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={saveTemplate}>Save</Button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
