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
  Upload,
  X,
  Zap,
} from "lucide-solid";

import Button from "./components/Button";
import OpenWorkLogo from "./components/OpenWorkLogo";
import PartView from "./components/PartView";
import TextInput from "./components/TextInput";
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
  writeOpencodeConfig,
  type EngineDoctorResult,
  type EngineInfo,
  type OpencodeConfigFile,
} from "./lib/tauri";

type Client = ReturnType<typeof createClient>;

type MessageWithParts = {
  info: Message;
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

type PendingPermission = ApiPermissionRequest & {
  receivedAt: number;
};

type ModelRef = {
  providerID: string;
  modelID: string;
};

type ModelOption = ModelRef & {
  label: string;
  description: string;
  recommended?: boolean;
};

const MODEL_PREF_KEY = "openwork.defaultModel";
const ZEN_PROVIDER_ID = "opencode";
const ZEN_PROVIDER_LABEL = "Zen";

const DEFAULT_MODEL: ModelRef = {
  providerID: ZEN_PROVIDER_ID,
  modelID: "gpt-5-nano",
};

const ZEN_MODEL_OPTIONS: ModelOption[] = [
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "gpt-5-nano",
    label: "Zen · GPT-5 Nano",
    description: "Fast, free, and works out of the box.",
    recommended: true,
  },
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "big-pickle",
    label: "Zen · Big Pickle",
    description: "Free Zen model.",
  },
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "glm-4.7-free",
    label: "Zen · GLM 4.7 Free",
    description: "Free Zen model.",
  },
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "grok-code",
    label: "Zen · Grok Code",
    description: "Free Zen model.",
  },
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "minimax-m2.1-free",
    label: "Zen · MiniMax M2.1 Free",
    description: "Free Zen model.",
  },
];

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

function formatModelLabel(model: ModelRef) {
  if (model.providerID === ZEN_PROVIDER_ID) {
    const match = ZEN_MODEL_OPTIONS.find((opt) => opt.modelID === model.modelID);
    return match?.label ?? `${ZEN_PROVIDER_LABEL} · ${model.modelID}`;
  }

  return `${model.providerID} · ${model.modelID}`;
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
    return list;
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

function modelFromUserMessage(info: Message): ModelRef | null {
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

  const [projectDir, setProjectDir] = createSignal("");
  const [authorizedDirs, setAuthorizedDirs] = createSignal<string[]>([]);
  const [newAuthorizedDir, setNewAuthorizedDir] = createSignal("");

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

  const [templates, setTemplates] = createSignal<Template[]>([]);
  const [templateModalOpen, setTemplateModalOpen] = createSignal(false);
  const [templateDraftTitle, setTemplateDraftTitle] = createSignal("");
  const [templateDraftDescription, setTemplateDraftDescription] = createSignal("");
  const [templateDraftPrompt, setTemplateDraftPrompt] = createSignal("");

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

  const [events, setEvents] = createSignal<OpencodeEvent[]>([]);
  const [developerMode, setDeveloperMode] = createSignal(false);

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<"session" | "default">("session");
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<Record<string, ModelRef>>({});
  const [sessionModelById, setSessionModelById] = createSignal<Record<string, ModelRef>>({});

  const [busy, setBusy] = createSignal(false);
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

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

  const selectedSessionModelLabel = createMemo(() => formatModelLabel(selectedSessionModel()));

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel(),
  );

  function openSessionModelPicker() {
    setModelPickerTarget("session");
    setModelPickerOpen(true);
  }

  function openDefaultModelPicker() {
    setModelPickerTarget("default");
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

      setSelectedSessionId(null);
      setMessages([]);
      setTodos([]);

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

  async function startHost() {
    if (!isTauriRuntime()) {
      setError("Host mode requires the Tauri app runtime. Use `pnpm dev`.");
      return false;
    }

    const dir = projectDir().trim();
    if (!dir) {
      setError("Pick a folder path to start OpenCode in.");
      return false;
    }

    try {
      const result = await engineDoctor();
      setEngineDoctorResult(result);
      setEngineDoctorCheckedAt(Date.now());

      if (!result.found) {
        setError(
          "OpenCode CLI not found. Install with `npm install -g opencode-ai` or visit https://opencode.ai/install, then retry.",
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
      const info = await engineStart(dir);
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

      unwrap(
        await c.session.prompt({
          sessionID,
          model,
          parts: [{ type: "text", text: content }],
        }),
      );

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

      const msgs = unwrap(await c.session.messages({ sessionID }));
      setMessages(msgs);

      try {
        setTodos(unwrap(await c.session.todo({ sessionID })));
      } catch {
        setTodos([]);
      }

      await loadSessions(c);
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
    setTemplateModalOpen(true);
  }

  function saveTemplate() {
    const title = templateDraftTitle().trim();
    const promptText = templateDraftPrompt().trim();
    const description = templateDraftDescription().trim();

    if (!title || !promptText) {
      setError("Template title and prompt are required.");
      return;
    }

    const template: Template = {
      id: `tmpl_${Date.now()}`,
      title,
      description,
      prompt: promptText,
      createdAt: Date.now(),
    };

    setTemplates((current) => [template, ...current]);
    setTemplateModalOpen(false);
  }

  function deleteTemplate(templateId: string) {
    setTemplates((current) => current.filter((t) => t.id !== templateId));
  }

  async function runTemplate(template: Template) {
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

      unwrap(
        await c.session.prompt({
          sessionID: session.id,
          model,
          parts: [{ type: "text", text: template.prompt }],
        }),
      );

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
      const nodes = unwrap(await c.file.list({ path: ".opencode/skill" }));
      const dirs = nodes.filter((n) => n.type === "directory" && !n.ignored);

      const next: SkillCard[] = [];

      for (const dir of dirs) {
        let description: string | undefined;

        try {
          const skillDoc = unwrap(
            await c.file.read({ path: `.opencode/skill/${dir.name}/SKILL.md` }),
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
      return;
    }

    const scope = scopeOverride ?? pluginScope();
    const targetDir = projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus("Pick a project folder to manage project plugins.");
      setPluginList([]);
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      setPluginConfig(config);

      if (!config.exists) {
        setPluginList([]);
        setPluginStatus("No opencode.json found yet. Add a plugin to create one.");
        return;
      }

      loadPluginsFromConfig(config);
    } catch (e) {
      setPluginConfig(null);
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : "Failed to load opencode.json");
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

  function addAuthorizedDir() {
    const next = newAuthorizedDir().trim();
    if (!next) return;

    setAuthorizedDirs((current) => {
      if (current.includes(next)) return current;
      return [...current, next];
    });
    setNewAuthorizedDir("");
  }

  function removeAuthorizedDir(index: number) {
    setAuthorizedDirs((current) => current.filter((_, i) => i !== index));
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

        const storedProjectDir = window.localStorage.getItem("openwork.projectDir");
        if (storedProjectDir) {
          setProjectDir(storedProjectDir);
        }

        const storedAuthorized = window.localStorage.getItem("openwork.authorizedDirs");
        if (storedAuthorized) {
          const parsed = JSON.parse(storedAuthorized) as unknown;
          if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
            setAuthorizedDirs(parsed);
          }
        }

        const storedTemplates = window.localStorage.getItem("openwork.templates");
        if (storedTemplates) {
          const parsed = JSON.parse(storedTemplates) as unknown;
          if (Array.isArray(parsed)) {
            setTemplates(parsed as Template[]);
          }
        }

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
      } catch {
        // ignore
      }
    }

    await refreshEngine();
    await refreshEngineDoctor();

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

      if (isTauriRuntime() && projectDir().trim()) {
        if (!authorizedDirs().length && projectDir().trim()) {
          setAuthorizedDirs([projectDir().trim()]);
        }

        setOnboardingStep("connecting");
        const ok = await startHost();
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
    try {
      window.localStorage.setItem("openwork.projectDir", projectDir());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.authorizedDirs", JSON.stringify(authorizedDirs()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.templates", JSON.stringify(templates()));
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
                  setMessages((current) => upsertPart(current, part));
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
                <div class="w-12 h-12 bg-zinc-900 rounded-2xl mx-auto flex items-center justify-center border border-zinc-800 mb-6">
                  <Shield class="text-zinc-400" />
                </div>
                <h2 class="text-2xl font-bold tracking-tight">Authorized Workspaces</h2>
                <p class="text-zinc-400 text-sm leading-relaxed">
                  OpenWork runs locally. Select which folders it is allowed to access.
                </p>
              </div>

              <div class="space-y-4">
                <div>
                  <div class="mb-1 flex items-center justify-between gap-3">
                    <div class="text-xs font-medium text-zinc-300">Project folder</div>
                  </div>
                  <div class="flex gap-2">
                    <input
                      class="w-full bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-white/20 rounded-xl"
                      placeholder="/path/to/project"
                      value={projectDir()}
                      onInput={(e) => setProjectDir(e.currentTarget.value)}
                    />
                    <Show when={isTauriRuntime()}>
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          try {
                            const selection = await pickDirectory({ title: "Select project folder" });
                            const path =
                              typeof selection === "string"
                                ? selection
                                : Array.isArray(selection)
                                  ? selection[0]
                                  : null;
                            if (path) {
                              setProjectDir(path);
                            }
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Unknown error");
                          }
                        }}
                        disabled={busy()}
                      >
                        Browse
                      </Button>
                    </Show>
                  </div>
                  <div class="mt-1 text-xs text-neutral-500">
                    {isTauriRuntime()
                      ? "Engine will start in this folder."
                      : "Host mode requires the Tauri app runtime."}
                  </div>
                </div>

                <div class="space-y-3">
                  <For each={authorizedDirs()}>
                    {(folder, idx) => (
                      <div class="group flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl border border-zinc-800/80 hover:border-zinc-700 transition-colors">
                        <div class="flex items-center gap-3 overflow-hidden">
                          <Folder size={18} class="text-indigo-400 shrink-0" />
                          <span class="font-mono text-sm text-zinc-300 truncate">{folder}</span>
                        </div>
                        <button
                          onClick={() => removeAuthorizedDir(idx())}
                          class="text-zinc-600 hover:text-red-400 p-1 opacity-0 group-hover:opacity-100 transition-all"
                          title="Remove"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    )}
                  </For>

                  <Show when={!authorizedDirs().length}>
                    <div class="text-xs text-zinc-600">
                      No authorized folders yet. Add at least your project folder.
                    </div>
                  </Show>

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
                        onClick={async () => {
                          try {
                            const selection = await pickDirectory({ title: "Add authorized folder" });
                            const path =
                              typeof selection === "string"
                                ? selection
                                : Array.isArray(selection)
                                  ? selection[0]
                                  : null;
                            if (path) {
                              setAuthorizedDirs((current) =>
                                current.includes(path) ? current : [...current, path],
                              );
                            }
                          } catch (e) {
                            setError(e instanceof Error ? e.message : safeStringify(e));
                          }
                        }}
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

                  <Show when={isTauriRuntime()}>
                    <div class="rounded-2xl bg-zinc-900/40 border border-zinc-800 p-4">
                      <div class="flex items-start justify-between gap-4">
                        <div class="min-w-0">
                          <div class="text-sm font-medium text-white">OpenCode CLI</div>
                          <div class="mt-1 text-xs text-zinc-500">
                            <Show
                              when={engineDoctorResult()}
                              fallback={<span>Checking install…</span>}
                            >
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
                            npm install -g opencode-ai
                          </div>
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
                                    setError(
                                      result.stderr.trim() || "OpenCode install failed. See logs above.",
                                    );
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
                      if (!authorizedDirs().length && projectDir().trim()) {
                        setAuthorizedDirs([projectDir().trim()]);
                      }

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
                    class="w-full"
                  >
                    Back
                  </Button>

                  <p class="text-center text-xs text-zinc-600">
                    You can change these later in Settings.
                  </p>
                </div>
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

    const quickTemplates = createMemo(() => templates().slice(0, 3));

    createEffect(() => {
      if (tab() === "skills") {
        refreshSkills().catch(() => undefined);
      }
      if (tab() === "plugins") {
        refreshPlugins().catch(() => undefined);
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
                  No templates yet. Save one from a session.
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
              when={templates().length}
              fallback={
                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-6 text-sm text-zinc-500">
                  No templates yet. Save one from a session, or create one here.
                </div>
              }
            >
              <div class="space-y-3">
                <For each={templates()}>
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
            </div>

            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
              <div class="text-sm font-medium text-white">Model</div>
              <div class="text-xs text-zinc-500">Default model for new sessions.</div>

              <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-zinc-200 truncate">{formatModelLabel(defaultModel())}</div>
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
                        <div class={`flex ${msg.info.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div
                            class={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed ${
                              msg.info.role === "user"
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
                                    tone={msg.info.role === "user" ? "dark" : "light"}
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
                <span>Execution Plan</span>
                <span class="text-xs bg-zinc-800 px-2 py-0.5 rounded text-zinc-500">
                  {todos().filter((t) => t.status === "completed").length}/{todos().length}
                </span>
              </div>
              <div class="p-4 space-y-4 overflow-y-auto flex-1">
                <Show
                  when={todos().length}
                  fallback={
                    <div class="text-zinc-600 text-sm text-center py-10 italic">
                      Plan will appear here...
                    </div>
                  }
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
                        onClick={() => respondPermission(activePermission()!.id, "always")}
                        disabled={permissionReplyBusy()}
                      >
                        Allow
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
        <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-white">
                    {modelPickerTarget() === "default" ? "Default model" : "Model"}
                  </h3>
                  <p class="text-sm text-zinc-400 mt-1">
                    Zen models work without setup. This selection {modelPickerTarget() === "default"
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

              <div class="mt-6 space-y-2">
                <For each={ZEN_MODEL_OPTIONS}>
                  {(opt) => {
                    const active = () => modelEquals(modelPickerCurrent(), opt);

                    return (
                      <button
                        class={`w-full text-left rounded-2xl border px-4 py-3 transition-colors ${
                          active()
                            ? "border-white/20 bg-white/5"
                            : "border-zinc-800/70 bg-zinc-950/40 hover:bg-zinc-950/60"
                        }`}
                        onClick={() => applyModelSelection(opt)}
                      >
                        <div class="flex items-start justify-between gap-3">
                          <div>
                            <div class="text-sm font-medium text-zinc-100 flex items-center gap-2">
                              {opt.label}
                              <Show when={opt.recommended}>
                                <span class="text-[10px] uppercase tracking-wide text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                                  Recommended
                                </span>
                              </Show>
                            </div>
                            <div class="text-xs text-zinc-500 mt-1">{opt.description}</div>
                            <div class="text-[11px] text-zinc-600 font-mono mt-2">
                              {formatModelRef(opt)}
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

              <div class="mt-6 flex justify-end">
                <Button variant="outline" onClick={() => setModelPickerOpen(false)}>
                  Done
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
