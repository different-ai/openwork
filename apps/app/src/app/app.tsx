import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { useLocation, useNavigate } from "@solidjs/router";

import type {
  Agent,
  Part,
  ProviderAuthAuthorization,
  Session,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from "@opencode-ai/sdk/v2/client";

import { getVersion } from "@tauri-apps/api/app";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { parse } from "jsonc-parser";

import ModelPickerModal from "./components/model-picker-modal";
import ResetModal from "./components/reset-modal";
import WorkspaceSwitchOverlay from "./components/workspace-switch-overlay";
import CreateRemoteWorkspaceModal from "./components/create-remote-workspace-modal";
import CreateWorkspaceModal from "./components/create-workspace-modal";
import SharedSkillDestinationModal from "./components/shared-skill-destination-modal";
import SharedBundleImportModal from "./components/shared-bundle-import-modal";
import StartWithTemplateModal from "./components/start-with-template-modal";
import RenameWorkspaceModal from "./components/rename-workspace-modal";
import McpAuthModal from "./components/mcp-auth-modal";
import ReloadWorkspaceToast from "./components/reload-workspace-toast";
import StatusToast from "./components/status-toast";
import OnboardingView from "./pages/onboarding";
import DashboardView from "./pages/dashboard";
import SessionView from "./pages/session";
import ProtoWorkspacesView from "./pages/proto-workspaces";
import ProtoV1UxView from "./pages/proto-v1-ux";
import { createClient, unwrap, waitForHealthy, type OpencodeAuth } from "./lib/opencode";
import { createDenClient, normalizeDenBaseUrl, writeDenSettings, DEFAULT_DEN_BASE_URL } from "./lib/den";
import {
  abortSession as abortSessionTyped,
  abortSessionSafe,
  compactSession as compactSessionTyped,
  revertSession,
  unrevertSession,
  shellInSession,
  listCommands as listCommandsTyped,
} from "./lib/opencode-session";
import { clearPerfLogs, finishPerf, perfNow, recordPerfLog } from "./lib/perf-log";
import { deepLinkBridgeEvent, drainPendingDeepLinks, type DeepLinkBridgeDetail } from "./lib/deep-link-bridge";
import {
  CHROME_DEVTOOLS_MCP_ID,
  DEFAULT_MODEL,
  HIDE_TITLEBAR_PREF_KEY,
  MCP_QUICK_CONNECT,
  MODEL_PREF_KEY,
  SESSION_MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "./constants";
import {
  parseMcpServersFromContent,
  removeMcpFromConfig,
  usesChromeDevtoolsAutoConnect,
  validateMcpServerName,
} from "./mcp";
import {
  compareProviders,
  filterProviderList,
  mapConfigProvidersToList,
  providerPriorityRank,
} from "./utils/providers";
import {
  blueprintMaterializedSessions,
  blueprintSessions,
  buildDefaultWorkspaceBlueprint,
  normalizeWorkspaceOpenworkConfig,
} from "./lib/workspace-blueprints";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "./types";
import type {
  Client,
  DashboardTab,
  MessageWithParts,
  PlaceholderAssistantMessage,
  PlaceholderMessageInfo,
  StartupPreference,
  EngineRuntime,
  ModelOption,
  ModelRef,
  OnboardingStep,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  ResetOpenworkMode,
  SettingsTab,
  SkillCard,
  SidebarSessionItem,
  TodoItem,
  View,
  WorkspaceSessionGroup,
  WorkspaceDisplay,
  McpServerEntry,
  McpStatusMap,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  ProviderListItem,
  SessionErrorTurn,
  UpdateHandle,
  OpencodeConnectStatus,
  ScheduledJob,
  WorkspacePreset,
  WorkspaceOpenworkConfig,
} from "./types";
import {
  clearStartupPreference,
  deriveArtifacts,
  deriveWorkingFiles,
  formatBytes,
  formatModelLabel,
  formatModelRef,
  formatRelativeTime,
  groupMessageParts,
  isVisibleTextPart,
  isTauriRuntime,
  modelEquals,
  normalizeDirectoryQueryPath,
  normalizeDirectoryPath,
} from "./utils";
import { currentLocale, setLocale, t, type Language } from "../i18n";
import {
  isWindowsPlatform,
  lastUserModelFromMessages,
  // normalizeDirectoryPath,
  parseModelRef,
  readStartupPreference,
  safeStringify,
  summarizeStep,
  addOpencodeCacheHint,
} from "./utils";
import {
  applyThemeMode,
  getInitialThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "./theme";
import { createSystemState } from "./system-state";
import { relaunch } from "@tauri-apps/plugin-process";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createSessionStore } from "./context/session";
import {
  formatGenericBehaviorLabel,
  getModelBehaviorSummary,
  normalizeModelBehaviorValue,
  sanitizeModelBehaviorValue,
} from "./lib/model-behavior";
import {
  describeDirectoryScope,
  shouldApplyScopedSessionLoad,
  shouldRedirectMissingSessionAfterScopedLoad,
  toSessionTransportDirectory,
} from "./lib/session-scope";

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read attachment: ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
import { createExtensionsStore } from "./context/extensions";
import { useGlobalSync } from "./context/global-sync";
import { createWorkspaceStore } from "./context/workspace";
import {
  updaterEnvironment,
  readOpencodeConfig,
  writeOpencodeConfig,
  openworkServerRestart,
  schedulerDeleteJob,
  schedulerListJobs,
  openworkServerInfo,
  orchestratorStatus,
  opencodeRouterInfo,
  pickDirectory,
  setWindowDecorations,
  type OrchestratorStatus,
  type OpenworkServerInfo,
  type OpenCodeRouterInfo,
  type WorkspaceInfo,
} from "./lib/tauri";
import {
  FONT_ZOOM_STEP,
  applyWebviewZoom,
  applyFontZoom,
  normalizeFontZoom,
  parseFontZoomShortcut,
  persistFontZoom,
  readStoredFontZoom,
} from "./lib/font-zoom";
import {
  parseOpenworkWorkspaceIdFromUrl,
  readOpenworkBundleInviteFromSearch,
  readOpenworkConnectInviteFromSearch,
  stripOpenworkBundleInviteFromUrl,
  stripOpenworkConnectInviteFromUrl,
  createOpenworkServerClient,
  hydrateOpenworkServerSettingsFromEnv,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
  clearOpenworkServerSettings,
  type OpenworkAuditEntry,
  type OpenworkServerCapabilities,
  type OpenworkServerDiagnostics,
  type OpenworkServerStatus,
  type OpenworkServerSettings,
  type OpenworkServerClient,
  type OpenworkWorkspaceExport,
  OpenworkServerError,
} from "./lib/openwork-server";

type RemoteWorkspaceDefaults = {
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
  autoConnect?: boolean;
};

type SharedSkillItem = {
  name: string;
  description?: string;
  content: string;
  trigger?: string;
};

type SharedSkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  description?: string;
  trigger?: string;
  content: string;
};

type SharedSkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description?: string;
  skills: SharedSkillItem[];
};

type SharedWorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description?: string;
  workspace: OpenworkWorkspaceExport;
};

type SharedBundleV1 =
  | SharedSkillBundleV1
  | SharedSkillsSetBundleV1
  | SharedWorkspaceProfileBundleV1;

type SharedBundleImportIntent = "new_worker" | "import_current";

type SharedBundleDeepLink = {
  bundleUrl: string;
  intent: SharedBundleImportIntent;
  source?: string;
  orgId?: string;
  label?: string;
};

type SharedBundleCreateWorkerRequest = {
  request: SharedBundleDeepLink;
  bundle: SharedBundleV1;
  defaultPreset: WorkspacePreset;
};

type SharedTemplateStartRequest = {
  request: SharedBundleDeepLink;
  bundle: SharedWorkspaceProfileBundleV1;
  defaultPreset: WorkspacePreset;
};

type SharedSkillDestinationRequest = {
  request: SharedBundleDeepLink;
  bundle: SharedSkillBundleV1;
};

type SharedSkillSuccessToast = {
  title: string;
  description: string;
};

type SharedBundleImportTarget = {
  workspaceId?: string | null;
  localRoot?: string | null;
  directoryHint?: string | null;
};

type SharedBundleImportChoice = {
  request: SharedBundleDeepLink;
  bundle: SharedBundleV1;
};

type SettingsReturnTarget = {
  view: View;
  tab: DashboardTab;
  sessionId: string | null;
};

function normalizeSharedBundleImportIntent(value: string | null | undefined): SharedBundleImportIntent {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "new_worker" || normalized === "new-worker" || normalized === "newworker") {
    return "new_worker";
  }
  return "import_current";
}

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const normalized = protocol.toLowerCase();
  return (
    normalized === "openwork:" ||
    normalized === "openwork-dev:" ||
    normalized === "https:" ||
    normalized === "http:"
  );
}

function describeSharedBundleImport(bundle: SharedBundleV1): { title: string; description: string; items: string[] } {
  if (bundle.type === "skill") {
    return {
      title: "Import 1 skill",
      description: bundle.description?.trim() || `Add \`${bundle.name}\` to an existing worker or create a new one for it.`,
      items: [bundle.name],
    };
  }

  if (bundle.type === "skills-set") {
    const count = bundle.skills.length;
    return {
      title: `Import ${count} skill${count === 1 ? "" : "s"}`,
      description:
        bundle.description?.trim() ||
        `${bundle.name || "Shared skills"} is ready to import into an existing worker or a new worker.`,
      items: bundle.skills.map((skill) => skill.name),
    };
  }

  return {
    title: bundle.name?.trim() || "Open workspace template",
    description:
      bundle.description?.trim() ||
      `${bundle.name || "This shared workspace template"} is ready to start in a new worker or import into an existing one.`,
    items: Array.isArray(bundle.workspace.skills) ? bundle.workspace.skills.map((skill) => skill.name) : [],
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSkillItem(value: unknown): SharedSkillItem | null {
  const record = readRecord(value);
  if (!record) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!name || !content) return null;
  return {
    name,
    description: typeof record.description === "string" ? record.description : undefined,
    trigger: typeof record.trigger === "string" ? record.trigger : undefined,
    content,
  };
}

function readTemplateFileItem(value: unknown): { path: string; content: string } | null {
  const record = readRecord(value);
  if (!record) return null;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!path) return null;
  return { path, content };
}

function readWorkspacePreset(value: unknown): WorkspacePreset {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "automation" || normalized === "minimal") {
    return normalized;
  }
  return "starter";
}

function defaultPresetFromTemplateBundle(bundle: SharedWorkspaceProfileBundleV1): WorkspacePreset {
  const openwork = bundle.workspace?.openwork;
  if (!openwork || typeof openwork !== "object") return "starter";
  const workspace = (openwork as Record<string, unknown>).workspace;
  if (!workspace || typeof workspace !== "object") return "starter";
  return readWorkspacePreset((workspace as Record<string, unknown>).preset);
}

function parseSharedBundle(value: unknown): SharedBundleV1 {
  const record = readRecord(value);
  if (!record) {
    throw new Error("Invalid shared bundle payload.");
  }

  const schemaVersion = typeof record.schemaVersion === "number" ? record.schemaVersion : null;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";

  if (schemaVersion !== 1) {
    throw new Error("Unsupported bundle schema version.");
  }

  if (type === "skill") {
    const content = typeof record.content === "string" ? record.content : "";
    if (!name || !content) {
      throw new Error("Invalid skill bundle payload.");
    }
    return {
      schemaVersion: 1,
      type: "skill",
      name,
      description: typeof record.description === "string" ? record.description : undefined,
      trigger: typeof record.trigger === "string" ? record.trigger : undefined,
      content,
    };
  }

  if (type === "skills-set") {
    const skills = Array.isArray(record.skills)
      ? record.skills.map(readSkillItem).filter((item): item is SharedSkillItem => Boolean(item))
      : [];
    if (!skills.length) {
      throw new Error("Skills set bundle has no importable skills.");
    }
    return {
      schemaVersion: 1,
      type: "skills-set",
      name: name || "Shared skills",
      description: typeof record.description === "string" ? record.description : undefined,
      skills,
    };
  }

  if (type === "workspace-profile") {
    const workspace = readRecord(record.workspace);
    if (!workspace) {
      throw new Error("Workspace profile bundle is missing workspace payload.");
    }
    const files = Array.isArray(workspace.files)
      ? workspace.files.map(readTemplateFileItem).filter((item): item is { path: string; content: string } => Boolean(item))
      : [];
    return {
      schemaVersion: 1,
      type: "workspace-profile",
      name: name || "Shared workspace profile",
      description: typeof record.description === "string" ? record.description : undefined,
      workspace: {
        ...(workspace as OpenworkWorkspaceExport),
        ...(files.length ? { files } : {}),
      },
    };
  }

  throw new Error(`Unsupported bundle type: ${type || "unknown"}`);
}

async function fetchSharedBundle(bundleUrl: string, serverClient?: OpenworkServerClient | null): Promise<SharedBundleV1> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(bundleUrl);
  } catch {
    throw new Error("Invalid shared bundle URL.");
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new Error("Shared bundle URL must use http(s).");
  }

  const segments = targetUrl.pathname.split("/").filter(Boolean);
  if (segments[0] === "b" && segments[1] && segments.length === 2) {
    targetUrl.pathname = `/b/${segments[1]}/data`;
    targetUrl.searchParams.delete("format");
  } else if (segments[0] === "b" && segments[1] && segments[2] === "data") {
    targetUrl.searchParams.delete("format");
  }

  if (!targetUrl.searchParams.has("format")) {
    targetUrl.searchParams.set("format", "json");
  }

  if (serverClient) {
    return parseSharedBundle(await serverClient.fetchBundle(targetUrl.toString()));
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);

  try {
    let response: Response;
    try {
      response = isTauriRuntime()
        ? await tauriFetch(targetUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          })
        : await fetch(targetUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      throw new Error(`Failed to load shared bundle from ${targetUrl.toString()}: ${message}`);
    }
    if (!response.ok) {
      const details = (await response.text()).trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to fetch bundle from ${targetUrl.toString()} (${response.status})${suffix}`);
    }
    return parseSharedBundle(await response.json());
  } finally {
    window.clearTimeout(timeout);
  }
}

function buildImportPayloadFromBundle(bundle: SharedBundleV1): {
  payload: Record<string, unknown>;
  importedSkillsCount: number;
} {
  if (bundle.type === "skill") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: [
          {
            name: bundle.name,
            description: bundle.description,
            trigger: bundle.trigger,
            content: bundle.content,
          },
        ],
      },
      importedSkillsCount: 1,
    };
  }

  if (bundle.type === "skills-set") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: bundle.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
      },
      importedSkillsCount: bundle.skills.length,
    };
  }

  const workspace = bundle.workspace;
  const payload: Record<string, unknown> = {
    mode: {
      opencode: "merge",
      openwork: "merge",
      skills: "merge",
      commands: "merge",
    },
  };
  if (workspace.opencode && typeof workspace.opencode === "object") payload.opencode = workspace.opencode;
  if (workspace.openwork && typeof workspace.openwork === "object") payload.openwork = workspace.openwork;
  if (Array.isArray(workspace.skills) && workspace.skills.length) payload.skills = workspace.skills;
  if (Array.isArray(workspace.commands) && workspace.commands.length) payload.commands = workspace.commands;
  if (Array.isArray(workspace.files) && workspace.files.length) payload.files = workspace.files;

  const importedSkillsCount = Array.isArray(workspace.skills) ? workspace.skills.length : 0;
  return { payload, importedSkillsCount };
}

function parseSharedBundleDeepLink(rawUrl: string): SharedBundleDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  const looksLikeImportRoute =
    routeHost === "import-bundle" ||
    routePath === "import-bundle" ||
    routeTail === "import-bundle";

  const rawBundleUrl =
    url.searchParams.get("ow_bundle") ??
    url.searchParams.get("bundleUrl") ??
    "";

  if (!looksLikeImportRoute && !rawBundleUrl.trim()) {
    return null;
  }

  try {
    if ((protocol === "https:" || protocol === "http:") && !rawBundleUrl.trim()) {
      const host = url.hostname.toLowerCase();
      const path = url.pathname.replace(/^\/+/, "");
      const segments = path.split("/").filter(Boolean);
      if (
        (host === "share.openworklabs.com"
          || host.endsWith(".openworklabs.com")
          || host === "share.openwork.software"
          || host.endsWith(".openwork.software"))
        && segments[0] === "b"
        && segments[1]
      ) {
        const intent = normalizeSharedBundleImportIntent(url.searchParams.get("ow_intent") ?? url.searchParams.get("intent"));
        const source = url.searchParams.get("ow_source")?.trim() ?? url.searchParams.get("source")?.trim() ?? "";
        const orgId = url.searchParams.get("ow_org")?.trim() ?? "";
        const label = url.searchParams.get("ow_label")?.trim() ?? url.searchParams.get("label")?.trim() ?? "";
        return {
          bundleUrl: url.toString(),
          intent,
          source: source || undefined,
          orgId: orgId || undefined,
          label: label || undefined,
        };
      }
    }

    const parsedBundleUrl = new URL(rawBundleUrl.trim());
    if (parsedBundleUrl.protocol !== "https:" && parsedBundleUrl.protocol !== "http:") {
      return null;
    }
    const intent = normalizeSharedBundleImportIntent(url.searchParams.get("ow_intent") ?? url.searchParams.get("intent"));
    const source = url.searchParams.get("ow_source")?.trim() ?? url.searchParams.get("source")?.trim() ?? "";
    const orgId = url.searchParams.get("ow_org")?.trim() ?? "";
    const label = url.searchParams.get("ow_label")?.trim() ?? "";
    return {
      bundleUrl: parsedBundleUrl.toString(),
      intent,
      source: source || undefined,
      orgId: orgId || undefined,
      label: label || undefined,
    };
  } catch {
    return null;
  }
}

function stripSharedBundleQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of ["ow_bundle", "bundleUrl", "ow_intent", "intent", "ow_source", "source", "ow_org", "ow_label"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

function parseRemoteConnectDeepLink(rawUrl: string): RemoteWorkspaceDefaults | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "connect-remote" && routePath !== "connect-remote" && routeTail !== "connect-remote") {
    return null;
  }

  const hostUrlRaw = url.searchParams.get("openworkHostUrl") ?? url.searchParams.get("openworkUrl") ?? "";
  const tokenRaw = url.searchParams.get("openworkToken") ?? url.searchParams.get("accessToken") ?? "";
  const normalizedHostUrl = normalizeOpenworkServerUrl(hostUrlRaw);
  const token = tokenRaw.trim();
  if (!normalizedHostUrl || !token) {
    return null;
  }

  const workerName = url.searchParams.get("workerName")?.trim() ?? "";
  const workerId = url.searchParams.get("workerId")?.trim() ?? "";
  const displayName = workerName || (workerId ? `Worker ${workerId.slice(0, 8)}` : "");
  const autoConnectRaw =
    url.searchParams.get("autoConnect") ??
    url.searchParams.get("bypassModal") ??
    url.searchParams.get("bypassAddWorkerModal") ??
    "";
  const autoConnect = ["1", "true", "yes", "on"].includes(autoConnectRaw.trim().toLowerCase());

  return {
    openworkHostUrl: normalizedHostUrl,
    openworkToken: token,
    directory: null,
    displayName: displayName || null,
    autoConnect,
  };
}

type DenAuthDeepLink = {
  grant: string;
  denBaseUrl: string;
};

function parseDenAuthDeepLink(rawUrl: string): DenAuthDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "den-auth" && routePath !== "den-auth" && routeTail !== "den-auth") {
    return null;
  }

  const grant = url.searchParams.get("grant")?.trim() ?? "";
  const denBaseUrl = normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ?? DEFAULT_DEN_BASE_URL;
  if (!grant) {
    return null;
  }

  return { grant, denBaseUrl };
}

function normalizeDebugDeepLinkInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const directMatch = trimmed.match(/(?:openwork-dev|openwork|https?):\/\/[^\s"'<>]+/i);
  if (directMatch) return directMatch[0];

  const bareShareMatch = trimmed.match(/share\.openwork(?:labs\.com|\.software)\/b\/[^\s"'<>]+/i);
  if (bareShareMatch) return `https://${bareShareMatch[0]}`;

  return trimmed;
}

function parseDebugDeepLinkInput(rawValue: string):
  | { kind: "bundle"; link: SharedBundleDeepLink }
  | { kind: "remote"; link: RemoteWorkspaceDefaults }
  | { kind: "auth"; link: DenAuthDeepLink }
  | null {
  const normalized = normalizeDebugDeepLinkInput(rawValue);
  if (!normalized) return null;

  const denAuthLink = parseDenAuthDeepLink(normalized);
  if (denAuthLink) {
    return { kind: "auth", link: denAuthLink };
  }

  const sharedBundleLink = parseSharedBundleDeepLink(normalized);
  if (sharedBundleLink) {
    return { kind: "bundle", link: sharedBundleLink };
  }

  const remoteConnectLink = parseRemoteConnectDeepLink(normalized);
  if (remoteConnectLink) {
    return { kind: "remote", link: remoteConnectLink };
  }

  const bundleMatch = normalized.match(/ow_bundle=([^&\s]+)/i);
  if (bundleMatch?.[1]) {
    try {
      const bundleUrl = decodeURIComponent(bundleMatch[1]);
      const intentMatch = normalized.match(/(?:ow_intent|intent)=([^&\s]+)/i);
      const labelMatch = normalized.match(/ow_label=([^&\s]+)/i);
      const sourceMatch = normalized.match(/(?:ow_source|source)=([^&\s]+)/i);
      return {
        kind: "bundle",
        link: {
          bundleUrl,
          intent: normalizeSharedBundleImportIntent(intentMatch?.[1] ? decodeURIComponent(intentMatch[1]) : undefined),
          label: labelMatch?.[1] ? decodeURIComponent(labelMatch[1]) : undefined,
          source: sourceMatch?.[1] ? decodeURIComponent(sourceMatch[1]) : undefined,
        },
      };
    } catch {
      // ignore fallback parsing errors
    }
  }

  const shareIdMatch = normalized.match(/share\.openwork(?:labs\.com|\.software)\/b\/([^\s/?#"'<>]+)/i);
  if (shareIdMatch?.[1]) {
    return {
      kind: "bundle",
      link: {
        bundleUrl: `https://share.openworklabs.com/b/${shareIdMatch[1]}`,
        intent: "new_worker",
      },
    };
  }

  return null;
}

function stripRemoteConnectQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "openworkHostUrl",
    "openworkUrl",
    "openworkToken",
    "accessToken",
    "workerId",
    "workerName",
    "autoConnect",
    "bypassModal",
    "bypassAddWorkerModal",
    "source",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export default function App() {
  const envOpenworkWorkspaceId =
    typeof import.meta.env?.VITE_OPENWORK_WORKSPACE_ID === "string"
      ? import.meta.env.VITE_OPENWORK_WORKSPACE_ID.trim() || null
      : null;

  // Workspace switch tracing is noisy, so only emit in developer mode.
  // (OpenWork already has a developer mode toggle in Settings.)
  const wsDebugEnabled = () => developerMode();

  const wsDebug = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };
  type ProviderAuthMethod = {
    type: "oauth" | "api";
    label: string;
    methodIndex?: number;
  };
  type ProviderOAuthStartResult = {
    methodIndex: number;
    authorization: ProviderAuthAuthorization;
  };

  const location = useLocation();
  const navigate = useNavigate();

  const [creatingSession, setCreatingSession] = createSignal(false);
  const [sessionViewLockUntil, setSessionViewLockUntil] = createSignal(0);
  const currentView = createMemo<View>(() => {
    const path = location.pathname.toLowerCase();
    if (path.startsWith("/onboarding")) return "onboarding";
    if (path.startsWith("/session")) return "session";
    if (path.startsWith("/proto")) return "proto";
    return "dashboard";
  });
  const isProtoV1Ux = createMemo(() =>
    location.pathname.toLowerCase().startsWith("/proto-v1-ux")
  );

  const [tab, setTabState] = createSignal<DashboardTab>("scheduled");
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general");

  const goToDashboard = (nextTab: DashboardTab, options?: { replace?: boolean }) => {
    setTabState(nextTab);
    navigate(`/dashboard/${nextTab}`, options);
  };

  const setTab = (nextTab: DashboardTab) => {
    if (currentView() === "dashboard") {
      goToDashboard(nextTab);
      return;
    }
    setTabState(nextTab);
  };

  const setView = (next: View, sessionId?: string) => {
    if (next === "dashboard" && creatingSession()) {
      return;
    }
    if (next === "dashboard" && Date.now() < sessionViewLockUntil()) {
      return;
    }
    if (next === "proto") {
      navigate("/proto/workspaces");
      return;
    }
    if (next === "onboarding") {
      navigate("/onboarding");
      return;
    }
    if (next === "session") {
      if (sessionId) {
        goToSession(sessionId);
        return;
      }
      navigate("/session");
      return;
    }
    goToDashboard(tab());
  };

  const goToSession = (sessionId: string, options?: { replace?: boolean }) => {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      navigate("/session", options);
      return;
    }
    navigate(`/session/${trimmed}`, options);
  };

  const [startupPreference, setStartupPreference] = createSignal<StartupPreference | null>(null);
  const [onboardingStep, setOnboardingStep] =
    createSignal<OnboardingStep>("welcome");
  const [rememberStartupChoice, setRememberStartupChoice] = createSignal(false);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(getInitialThemeMode());

  const [engineSource, setEngineSource] = createSignal<"path" | "sidecar" | "custom">(
    isTauriRuntime() ? "sidecar" : "path"
  );

  const [engineCustomBinPath, setEngineCustomBinPath] = createSignal("");

  const [engineRuntime, setEngineRuntime] = createSignal<EngineRuntime>("openwork-orchestrator");
  const [opencodeEnableExa, setOpencodeEnableExa] = createSignal(false);

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [openworkServerSettings, setOpenworkServerSettings] = createSignal<OpenworkServerSettings>({});
  const [shareRemoteAccessBusy, setShareRemoteAccessBusy] = createSignal(false);
  const [shareRemoteAccessError, setShareRemoteAccessError] = createSignal<string | null>(null);
  const [openworkServerUrl, setOpenworkServerUrl] = createSignal("");
  const [openworkServerStatus, setOpenworkServerStatus] = createSignal<OpenworkServerStatus>("disconnected");
  const [openworkServerCapabilities, setOpenworkServerCapabilities] = createSignal<OpenworkServerCapabilities | null>(null);
  const [openworkServerCheckedAt, setOpenworkServerCheckedAt] = createSignal<number | null>(null);
  const [runtimeWorkspaceId, setRuntimeWorkspaceId] = createSignal<string | null>(null);
  const [openworkServerHostInfo, setOpenworkServerHostInfo] = createSignal<OpenworkServerInfo | null>(null);
  const [openworkServerDiagnostics, setOpenworkServerDiagnostics] = createSignal<OpenworkServerDiagnostics | null>(null);
  const [openworkReconnectBusy, setOpenworkReconnectBusy] = createSignal(false);
  const [opencodeRouterInfoState, setOpenCodeRouterInfoState] = createSignal<OpenCodeRouterInfo | null>(null);
  const [orchestratorStatusState, setOrchestratorStatusState] = createSignal<OrchestratorStatus | null>(null);
  const [openworkAuditEntries, setOpenworkAuditEntries] = createSignal<OpenworkAuditEntry[]>([]);
  const [openworkAuditStatus, setOpenworkAuditStatus] = createSignal<"idle" | "loading" | "error">("idle");
  const [openworkAuditError, setOpenworkAuditError] = createSignal<string | null>(null);
  const [devtoolsWorkspaceId, setDevtoolsWorkspaceId] = createSignal<string | null>(null);
  const [activeWorkspaceServerConfig, setActiveWorkspaceServerConfig] =
    createSignal<WorkspaceOpenworkConfig | null>(null);

  const openworkServerBaseUrl = createMemo(() => {
    const pref = startupPreference();
    const hostInfo = openworkServerHostInfo();
    const settingsUrl = normalizeOpenworkServerUrl(openworkServerSettings().urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  });

  const openworkServerAuth = createMemo(
    () => {
      const pref = startupPreference();
      const hostInfo = openworkServerHostInfo();
      const settingsToken = openworkServerSettings().token?.trim() ?? "";
      const clientToken = hostInfo?.clientToken?.trim() ?? "";
      const hostToken = hostInfo?.hostToken?.trim() ?? "";

      if (pref === "local") {
        return { token: clientToken || undefined, hostToken: hostToken || undefined };
      }
      if (pref === "server") {
        return { token: settingsToken || undefined, hostToken: undefined };
      }
      if (hostInfo?.baseUrl) {
        return { token: clientToken || undefined, hostToken: hostToken || undefined };
      }
      return { token: settingsToken || undefined, hostToken: undefined };
    },
    undefined,
    {
      equals: (prev, next) => prev?.token === next.token && prev?.hostToken === next.hostToken,
    },
  );

  const openworkServerClient = createMemo(() => {
    const baseUrl = openworkServerBaseUrl().trim();
    if (!baseUrl) return null;
    const auth = openworkServerAuth();
    return createOpenworkServerClient({ baseUrl, token: auth.token, hostToken: auth.hostToken });
  });

  const devtoolsOpenworkClient = createMemo(() => openworkServerClient());

  createEffect(() => {
    if (typeof window === "undefined") return;
    hydrateOpenworkServerSettingsFromEnv();

    const stored = readOpenworkServerSettings();
    const invite = readOpenworkConnectInviteFromSearch(window.location.search);
    const bundleInvite = readOpenworkBundleInviteFromSearch(window.location.search);

    if (!invite) {
      setOpenworkServerSettings(stored);
    } else {
      const merged: OpenworkServerSettings = {
        ...stored,
        urlOverride: invite.url,
        token: invite.token ?? stored.token,
      };

      const next = writeOpenworkServerSettings(merged);
      setOpenworkServerSettings(next);

      if (invite.startup === "server" && untrack(onboardingStep) === "welcome") {
        setStartupPreference("server");
        setOnboardingStep("server");
      }
    }

    if (bundleInvite?.bundleUrl) {
      setPendingSharedBundleInvite({
        bundleUrl: bundleInvite.bundleUrl,
        intent: normalizeSharedBundleImportIntent(bundleInvite.intent),
        source: bundleInvite.source,
        orgId: bundleInvite.orgId,
        label: bundleInvite.label,
      });
      setSharedBundleNoticeShown(false);
    }

    if (invite?.autoConnect) {
      setPendingRemoteConnectDeepLink({
        openworkHostUrl: invite.url,
        openworkToken: invite.token ?? null,
        directory: null,
        displayName: null,
        autoConnect: true,
      });
    }

    const cleanedConnect = stripOpenworkConnectInviteFromUrl(window.location.href);
    const cleaned = stripOpenworkBundleInviteFromUrl(cleanedConnect);
    if (cleaned !== window.location.href) {
      window.history.replaceState(window.history.state ?? null, "", cleaned);
    }
  });

  createEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    onCleanup(() => document.removeEventListener("visibilitychange", update));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!isTauriRuntime()) return;

    const applyAndPersistFontZoom = (value: number) => {
      const next = normalizeFontZoom(value);
      persistFontZoom(window.localStorage, next);

      try {
        const webview = getCurrentWebview();
        void applyWebviewZoom(webview, next)
          .then(() => {
            document.documentElement.style.removeProperty("--openwork-font-size");
          })
          .catch(() => {
            applyFontZoom(document.documentElement.style, next);
          });
      } catch {
        applyFontZoom(document.documentElement.style, next);
      }

      return next;
    };

    let fontZoom = applyAndPersistFontZoom(readStoredFontZoom(window.localStorage) ?? 1);

    const handleZoomShortcut = (event: KeyboardEvent) => {
      const action = parseFontZoomShortcut(event);
      if (!action) return;

      if (action === "in") {
        fontZoom = applyAndPersistFontZoom(fontZoom + FONT_ZOOM_STEP);
      } else if (action === "out") {
        fontZoom = applyAndPersistFontZoom(fontZoom - FONT_ZOOM_STEP);
      } else {
        fontZoom = applyAndPersistFontZoom(1);
      }

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleZoomShortcut, true);
    onCleanup(() => window.removeEventListener("keydown", handleZoomShortcut, true));
  });

  createEffect(() => {
    const pref = startupPreference();
    const info = openworkServerHostInfo();
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeOpenworkServerUrl(openworkServerSettings().urlOverride ?? "") ?? "";

    if (pref === "local") {
      setOpenworkServerUrl(hostUrl);
      return;
    }
    if (pref === "server") {
      setOpenworkServerUrl(settingsUrl);
      return;
    }
    setOpenworkServerUrl(hostUrl || settingsUrl);
  });

  const checkOpenworkServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createOpenworkServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      if (error instanceof OpenworkServerError && (error.status === 401 || error.status === 403)) {
        return { status: "limited" as OpenworkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenworkServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as OpenworkServerStatus, capabilities: null };
    }

    try {
      const caps = await client.capabilities();
      return { status: "connected" as OpenworkServerStatus, capabilities: caps };
    } catch (error) {
      if (error instanceof OpenworkServerError && (error.status === 401 || error.status === 403)) {
        return { status: "limited" as OpenworkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenworkServerStatus, capabilities: null };
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!documentVisible()) return;
    const url = openworkServerBaseUrl().trim();
    const auth = openworkServerAuth();
    const token = auth.token;
    const hostToken = auth.hostToken;

    if (!url) {
      setOpenworkServerStatus("disconnected");
      setOpenworkServerCapabilities(null);
      setOpenworkServerCheckedAt(Date.now());
      return;
    }

    let active = true;
    let busy = false;
    let timeoutId: number | undefined;
    let delayMs = 10_000;

    const scheduleNext = () => {
      if (!active) return;
      timeoutId = window.setTimeout(run, delayMs);
    };

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await checkOpenworkServer(url, token, hostToken);
        if (!active) return;
        setOpenworkServerStatus(result.status);
        setOpenworkServerCapabilities(result.capabilities);
        delayMs =
          result.status === "connected" || result.status === "limited"
            ? 10_000
            : Math.min(delayMs * 2, 60_000);
      } catch {
        delayMs = Math.min(delayMs * 2, 60_000);
      } finally {
        if (!active) return;
        setOpenworkServerCheckedAt(Date.now());
        busy = false;
        scheduleNext();
      }
    };

    run();
    onCleanup(() => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!documentVisible()) return;
    let active = true;

    const run = async () => {
      try {
        const info = await openworkServerInfo();
        if (active) setOpenworkServerHostInfo(info);
      } catch {
        if (active) setOpenworkServerHostInfo(null);
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    const hostInfo = openworkServerHostInfo();
    const port = hostInfo?.port;
    if (!port) return;

    const current = openworkServerSettings();
    if (current.portOverride === port) return;

    updateOpenworkServerSettings({
      ...current,
      portOverride: port,
    });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!documentVisible()) return;
    if (!developerMode()) {
      setOpenworkServerDiagnostics(null);
      return;
    }

    const client = openworkServerClient();
    if (!client || openworkServerStatus() === "disconnected") {
      setOpenworkServerDiagnostics(null);
      return;
    }

    let active = true;
    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const status = await client.status();
        if (active) setOpenworkServerDiagnostics(status);
      } catch {
        if (active) setOpenworkServerDiagnostics(null);
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) return;
    if (!documentVisible()) return;

    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        await workspaceStore.refreshEngine();
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) {
      setOpenCodeRouterInfoState(null);
      return;
    }
    if (!documentVisible()) return;

    let active = true;

    const run = async () => {
      try {
        const info = await opencodeRouterInfo();
        if (active) setOpenCodeRouterInfoState(info);
      } catch {
        if (active) setOpenCodeRouterInfoState(null);
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) {
      setOrchestratorStatusState(null);
      return;
    }
    if (!documentVisible()) return;

    let active = true;

    const run = async () => {
      try {
        const status = await orchestratorStatus();
        if (active) setOrchestratorStatusState(status);
      } catch {
        if (active) setOrchestratorStatusState(null);
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  const [client, setClient] = createSignal<Client | null>(null);
  const [connectedVersion, setConnectedVersion] = createSignal<string | null>(
    null
  );
  const [sseConnected, setSseConnected] = createSignal(false);

  const [busy, setBusy] = createSignal(false);
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [opencodeConnectStatus, setOpencodeConnectStatus] = createSignal<OpencodeConnectStatus | null>(null);
  const [booting, setBooting] = createSignal(true);
  const mountTime = Date.now();
  const [lastKnownConfigSnapshot, setLastKnownConfigSnapshot] = createSignal("");
  const [developerMode, setDeveloperMode] = createSignal(false);
  const [documentVisible, setDocumentVisible] = createSignal(true);

  createEffect(() => {
    if (developerMode()) return;
    clearPerfLogs();
  });

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    null
  );
  const [settingsReturnTarget, setSettingsReturnTarget] = createSignal<SettingsReturnTarget>({
    view: "dashboard",
    tab: "scheduled",
    sessionId: null,
  });
  const SESSION_BY_WORKSPACE_KEY = "openwork.workspace-last-session.v1";
  const readSessionByWorkspace = () => {
    if (typeof window === "undefined") return {} as Record<string, string>;
    try {
      const raw = window.localStorage.getItem(SESSION_BY_WORKSPACE_KEY);
      if (!raw) return {} as Record<string, string>;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {} as Record<string, string>;
      return parsed as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  };
  const writeSessionByWorkspace = (map: Record<string, string>) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SESSION_BY_WORKSPACE_KEY, JSON.stringify(map));
    } catch {
      // ignore
    }
  };
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [sessionModelById, setSessionModelById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [pendingSessionModel, setPendingSessionModel] = createSignal<ModelRef | null>(null);
  const [sessionModelOverridesReady, setSessionModelOverridesReady] = createSignal(false);
  const [workspaceDefaultModelReady, setWorkspaceDefaultModelReady] = createSignal(false);
  const [legacyDefaultModel, setLegacyDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [defaultModelExplicit, setDefaultModelExplicit] = createSignal(false);
  const [autoCompactContextReady, setAutoCompactContextReady] = createSignal(false);
  const [autoCompactContextDirty, setAutoCompactContextDirty] = createSignal(false);
  const [autoCompactContextApplied, setAutoCompactContextApplied] = createSignal(true);
  const [autoCompactContextSaving, setAutoCompactContextSaving] = createSignal(false);
  type PromptFocusReturnTarget = "none" | "composer";

  const [sessionAgentById, setSessionAgentById] = createSignal<Record<string, string>>({});
  const [providerAuthModalOpen, setProviderAuthModalOpen] = createSignal(false);
  const [providerAuthBusy, setProviderAuthBusy] = createSignal(false);
  const [providerAuthError, setProviderAuthError] = createSignal<string | null>(null);
  const [providerAuthMethods, setProviderAuthMethods] = createSignal<Record<string, ProviderAuthMethod[]>>({});
  const [providerAuthPreferredProviderId, setProviderAuthPreferredProviderId] = createSignal<string | null>(null);
  const [providerAuthReturnFocusTarget, setProviderAuthReturnFocusTarget] =
    createSignal<PromptFocusReturnTarget>("none");

  createEffect(() => {
    const view = currentView();
    const currentTab = tab();
    if (view === "dashboard" && currentTab === "settings") return;
    setSettingsReturnTarget({
      view,
      tab: currentTab,
      sessionId: selectedSessionId(),
    });
  });

  const restoreSettingsReturnTarget = () => {
    const target = settingsReturnTarget();
    if (target.view === "session") {
      if (target.sessionId) {
        goToSession(target.sessionId);
        return;
      }
      navigate("/session");
      return;
    }
    if (target.view === "onboarding") {
      navigate("/onboarding");
      return;
    }
    if (target.view === "proto") {
      navigate("/proto/workspaces");
      return;
    }
    goToDashboard(target.tab);
  };

  const toggleSettingsView = (nextTab: SettingsTab = "general") => {
    const settingsOpen = currentView() === "dashboard" && tab() === "settings";
    if (settingsOpen) {
      restoreSettingsReturnTarget();
      return;
    }
    setSettingsTab(nextTab);
    goToDashboard("settings");
  };

  let markReloadRequiredHandler: ((reason: ReloadReason, trigger?: ReloadTrigger) => void) | undefined;
  const markReloadRequired = (reason: ReloadReason, trigger?: ReloadTrigger) => {
    markReloadRequiredHandler?.(reason, trigger);
  };

  const sessionStore = createSessionStore({
    client,
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot().trim(),
    selectedSessionId,
    setSelectedSessionId,
    sessionModelState: () => ({
      overrides: sessionModelOverrideById(),
      resolved: sessionModelById(),
    }),
    setSessionModelState: (updater) => {
      const next = updater({
        overrides: sessionModelOverrideById(),
        resolved: sessionModelById(),
      });
      setSessionModelOverrideById(next.overrides);
      setSessionModelById(next.resolved);
      return next;
    },
    lastUserModelFromMessages,
    developerMode,
    setError,
    setSseConnected,
    markReloadRequired,
    onHotReloadApplied: () => {
      void refreshSkills({ force: true });
      void refreshPlugins(pluginScope());
      void refreshMcpServers();
    },
  });

  const {
    sessions,
    loadedScopeRoot: loadedSessionScopeRoot,
    sessionById,
    sessionStatusById,
    selectedSession,
    selectedSessionStatus,
    selectedSessionCompactionState,
    messages,
    messagesBySessionId,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    pendingQuestions,
    activeQuestion,
    questionReplyBusy,
    events,
    activePermission,
    loadSessions,
    ensureSessionLoaded,
    refreshPendingPermissions,
    refreshPendingQuestions,
    selectSession,
    loadEarlierMessages,
    renameSession,
    respondPermission,
    respondQuestion,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    sessionLoadingById,
  } = sessionStore;

  const ARTIFACT_SCAN_MESSAGE_WINDOW = 220;
  const artifacts = createMemo(() =>
    deriveArtifacts(messages(), { maxMessages: ARTIFACT_SCAN_MESSAGE_WINDOW }),
  );
  const workingFiles = createMemo(() => deriveWorkingFiles(artifacts()));
  const activeSessionId = createMemo(() => selectedSessionId());
  const activeSessions = createMemo(() => sessions());
  const activeSessionStatusById = createMemo(() => sessionStatusById());
  const activeMessages = createMemo(() => messages());
  const activeTodos = createMemo(() => todos());
  const activeWorkingFiles = createMemo(() => workingFiles());

  const sessionActivity = (session: Session) =>
    session.time?.updated ?? session.time?.created ?? 0;
  const sortSessionsByActivity = (list: Session[]) =>
    list
      .slice()
      .sort((a, b) => {
        const delta = sessionActivity(b) - sessionActivity(a);
        if (delta !== 0) return delta;
        return a.id.localeCompare(b.id);
      });

  const [sessionsLoaded, setSessionsLoaded] = createSignal(false);
  const loadSessionsWithReady = async (scopeRoot?: string) => {
    await loadSessions(scopeRoot);
    setSessionsLoaded(true);
  };

  createEffect(() => {
    if (!client()) {
      setSessionsLoaded(false);
    }
  });

  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  type PartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

  const attachmentToFilePart = async (attachment: ComposerAttachment): Promise<FilePartInput> => ({
    type: "file",
    url: await fileToDataUrl(attachment.file),
    filename: attachment.name,
    mime: attachment.mimeType,
  });

  const buildPromptParts = async (draft: ComposerDraft): Promise<PartInput[]> => {
    const parts: PartInput[] = [];
    const text = draft.resolvedText ?? draft.text;
    parts.push({ type: "text", text } as TextPartInput);

    const root = workspaceProjectDir().trim();
    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      // Windows absolute path, e.g. C:\foo\bar
      if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
      // Without a workspace root, we cannot safely resolve relative paths.
      // Returning "" avoids emitting invalid file:// URLs.
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };
    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name } as AgentPartInput);
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        parts.push({
          type: "file",
          mime: "text/plain",
          url: `file://${absolute}`,
          filename: filenameFromPath(part.path),
        } as FilePartInput);
      }
    }

    parts.push(...(await Promise.all(draft.attachments.map(attachmentToFilePart))));

    return parts;
  };

  const buildCommandFileParts = async (draft: ComposerDraft): Promise<FilePartInput[]> => {
    const parts: FilePartInput[] = [];
    const root = workspaceProjectDir().trim();

    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };

    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type !== "file") continue;
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${absolute}`,
        filename: filenameFromPath(part.path),
      } as FilePartInput);
    }

    parts.push(...(await Promise.all(draft.attachments.map(attachmentToFilePart))));

    return parts;
  };

  const assertNoClientError = (result: unknown) => {
    const maybe = result as { error?: unknown } | null | undefined;
    if (!maybe || maybe.error === undefined) return;
    throw new Error(describeProviderError(maybe.error, "Request failed"));
  };

  const describeProviderError = (error: unknown, fallback: string) => {
    const readString = (value: unknown, max = 700) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length <= max) return trimmed;
      return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
    };

    const records: Record<string, unknown>[] = [];
    const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    if (root) {
      records.push(root);
      if (root.data && typeof root.data === "object") records.push(root.data as Record<string, unknown>);
      if (root.cause && typeof root.cause === "object") {
        const cause = root.cause as Record<string, unknown>;
        records.push(cause);
        if (cause.data && typeof cause.data === "object") records.push(cause.data as Record<string, unknown>);
      }
    }

    const firstString = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = readString(record[key]);
          if (value) return value;
        }
      }
      return null;
    };

    const firstNumber = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
      }
      return null;
    };

    const status = firstNumber(["statusCode", "status"]);
    const provider = firstString(["providerID", "providerId", "provider"]);
    const code = firstString(["code", "errorCode"]);
    const response = firstString(["responseBody", "body", "response"]);
    const raw =
      (error instanceof Error ? readString(error.message) : null) ||
      firstString(["message", "detail", "reason", "error"]) ||
      (typeof error === "string" ? readString(error) : null);

    const generic = raw && /^unknown\s+error$/i.test(raw);
    const heading = (() => {
      if (status === 401 || status === 403) return "Authentication failed";
      if (status === 429) return "Rate limit exceeded";
      if (provider) return `Provider error (${provider})`;
      return fallback;
    })();

    const lines = [heading];
    if (raw && !generic && raw !== heading) lines.push(raw);
    if (status && !heading.includes(String(status))) lines.push(`Status: ${status}`);
    if (provider && !heading.includes(provider)) lines.push(`Provider: ${provider}`);
    if (code) lines.push(`Code: ${code}`);
    if (response) lines.push(`Response: ${response}`);
    if (lines.length > 1) return lines.join("\n");

    if (raw && !generic) return raw;
    if (error && typeof error === "object") {
      const serialized = safeStringify(error);
      if (serialized && serialized !== "{}") return serialized;
    }
    return fallback;
  };

  const ensureSelectedWorkspaceRuntime = async () => {
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    if (!workspaceId) return false;
    return await workspaceStore.ensureWorkspaceActivated(workspaceId);
  };

  async function sendPrompt(draft?: ComposerDraft) {
    const hasExplicitDraft = Boolean(draft);
    const fallbackText = prompt().trim();
    const resolvedDraft: ComposerDraft = draft ?? {
      mode: "prompt",
      parts: fallbackText ? [{ type: "text", text: fallbackText } as ComposerPart] : [],
      attachments: [] as ComposerAttachment[],
      text: fallbackText,
    };
    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length) return;

    const ready = await ensureSelectedWorkspaceRuntime();
    if (!ready) return;

    const c = client();
    if (!c) return;

    const compactShortcut = /^\/compact(?:\s+.*)?$/i.test(content);
    const compactCommand = resolvedDraft.command?.name === "compact" || compactShortcut;
    const commandName = compactCommand ? "compact" : (resolvedDraft.command?.name ?? null);
    if (compactCommand && !selectedSessionId()) {
      setError("Select a session with messages before running /compact.");
      return;
    }

    let sessionID = selectedSessionId();
    if (!sessionID) {
      await createSessionAndOpen();
      sessionID = selectedSessionId();
    }
    if (!sessionID) return;

    setBusy(true);
    setBusyLabel("status.running");
    setBusyStartedAt(Date.now());
    setError(null);

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const visible = messages();
    const visibleParts = visible.reduce((total, message) => total + message.parts.length, 0);
    recordPerfLog(perfEnabled, "session.prompt", "start", {
      sessionID,
      mode: resolvedDraft.mode,
      command: commandName,
      charCount: content.length,
      attachmentCount: resolvedDraft.attachments.length,
      messageCount: visible.length,
      partCount: visibleParts,
    });

    try {
      if (!compactCommand) {
        setLastPromptSent(content);
      }
      if (!hasExplicitDraft) {
        setPrompt("");
      }

      const model = selectedSessionModel();
      const agent = selectedSessionAgent();
      const parts = await buildPromptParts(resolvedDraft);
      const selectedVariant = sanitizeModelVariantForRef(model, getVariantFor(model)) ?? undefined;
      const reasoningEffort = resolveCodexReasoningEffort(model.modelID, selectedVariant ?? null);
      const requestVariant = reasoningEffort ? undefined : selectedVariant;
      const promptOverrides = reasoningEffort
        ? ({ reasoning_effort: reasoningEffort } as const)
        : undefined;

      if (resolvedDraft.mode === "shell") {
        await shellInSession(c, sessionID, content);
      } else if (resolvedDraft.command || compactCommand) {
        if (compactCommand) {
          await compactCurrentSession(sessionID);
          finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
            sessionID,
            mode: resolvedDraft.mode,
            command: commandName,
          });
          return;
        }

        const command = resolvedDraft.command;
        if (!command) {
          throw new Error("Command was not resolved.");
        }

        // Slash command: route through session.command() API
        const modelString = `${model.providerID}/${model.modelID}`;
        const files = await buildCommandFileParts(resolvedDraft);

        // session.command() expects `model` as a provider/model string and only supports file parts.
        unwrap(
          await c.session.command({
            sessionID,
            command: command.name,
            arguments: command.arguments,
            agent: agent ?? undefined,
            model: modelString,
            variant: requestVariant,
            ...(promptOverrides ?? {}),
            parts: files.length ? files : undefined,
          }),
        );

      } else {
        const result = await c.session.promptAsync({
          sessionID,
          model,
          agent: agent ?? undefined,
          variant: requestVariant,
          ...(promptOverrides ?? {}),
          parts,
        });
        assertNoClientError(result);

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

      finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
      });
    } catch (e) {
      finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message = e instanceof Error ? e.message : safeStringify(e);
      sessionStore.appendSessionErrorTurn(sessionID, addOpencodeCacheHint(message));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function abortSession(sessionID?: string) {
    const c = client();
    if (!c) return;
    const id = (sessionID ?? selectedSessionId() ?? "").trim();
    if (!id) return;
    // OpenCode exposes session.abort which interrupts the active prompt/run.
    // We intentionally don't mutate global busy state here; the SessionView
    // provides local UX (button disabled + toast) for cancellation.
    await abortSessionTyped(c, id);
  }

  function retryLastPrompt() {
    const text = lastPromptSent().trim();
    if (!text) return;
    void sendPrompt({
      mode: "prompt",
      text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
  }

  async function compactCurrentSession(sessionIdOverride?: string) {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const sessionID = (sessionIdOverride ?? selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("Select a session before compacting.");
    }

    const visible = messages();
    if (!visible.length) {
      throw new Error("Nothing to compact yet.");
    }

    const model = selectedSessionModel();
    const startedAt = perfNow();
    const modelLabel = `${model.providerID}/${model.modelID}`;
    recordPerfLog(developerMode(), "session.compact", "start", {
      sessionID,
      messageCount: visible.length,
      model: modelLabel,
      variant: sanitizeModelVariantForRef(model, getVariantFor(model)) ?? null,
    });

    try {
      await compactSessionTyped(c, sessionID, model, {
        directory: workspaceProjectDir().trim() || undefined,
      });
      finishPerf(developerMode(), "session.compact", "done", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
      });
    } catch (error) {
      finishPerf(developerMode(), "session.compact", "error", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      throw error;
    }
  }

  const messageIdFromInfo = (message: MessageWithParts) => {
    const id = (message.info as { id?: string | number }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
    return "";
  };

  const createSyntheticSessionErrorMessage = (
    sessionID: string,
    errorTurn: SessionErrorTurn,
  ): MessageWithParts => {
    const info: PlaceholderAssistantMessage = {
      id: errorTurn.id,
      sessionID,
      role: "assistant",
      time: { created: errorTurn.time, completed: errorTurn.time },
      parentID: errorTurn.afterMessageID ?? "",
      modelID: "",
      providerID: "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    return {
      info,
      parts: [
        {
          id: `${errorTurn.id}:text`,
          sessionID,
          messageID: errorTurn.id,
          type: "text",
          text: errorTurn.text,
        } as Part,
      ],
    };
  };

  const SYNTHETIC_BLUEPRINT_SEED_MESSAGE_PREFIX = "blueprint-seed:";

  const createSyntheticBlueprintSeedMessage = (
    sessionID: string,
    index: number,
    seed: { role?: "assistant" | "user" | null; text?: string | null },
  ): MessageWithParts => {
    const messageId = `${SYNTHETIC_BLUEPRINT_SEED_MESSAGE_PREFIX}${sessionID}:${index}`;
    const role = seed.role === "user" ? "user" : "assistant";
    const text = seed.text?.trim() ?? "";
    const createdAt = Math.max(1, index + 1);
    const info: PlaceholderMessageInfo = {
      id: messageId,
      sessionID,
      role,
      time: { created: createdAt, completed: createdAt },
      parentID: index > 0 ? `${SYNTHETIC_BLUEPRINT_SEED_MESSAGE_PREFIX}${sessionID}:${index - 1}` : "",
      modelID: "",
      providerID: "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    return {
      info,
      parts: [
        {
          id: `${messageId}:text`,
          sessionID,
          messageID: messageId,
          type: "text",
          text,
        } as Part,
      ],
    };
  };

  const [blueprintSeedMessagesBySessionId, setBlueprintSeedMessagesBySessionId] =
    createSignal<Record<string, Array<{ role?: "assistant" | "user" | null; text?: string | null }>>>({});

  const blueprintSeedMessagesForSelectedSession = createMemo(() => {
    const sessionID = selectedSessionId();
    if (!sessionID) return [];

    const fallback = blueprintSeedMessagesBySessionId()[sessionID];
    if (Array.isArray(fallback) && fallback.length > 0) {
      return fallback;
    }

    const materialized = blueprintMaterializedSessions(resolvedActiveWorkspaceConfig());
    const match = materialized.find((item) => item.sessionId?.trim() === sessionID);
    if (!match?.templateId) return [];

    const template = blueprintSessions(resolvedActiveWorkspaceConfig()).find(
      (entry) => entry.id?.trim() === match.templateId,
    );

    return Array.isArray(template?.messages)
      ? template!.messages!.filter((entry) => entry?.text?.trim())
      : [];
  });

  const insertSyntheticBlueprintSeedMessages = (
    list: MessageWithParts[],
    sessionID: string | null,
    seeds: Array<{ role?: "assistant" | "user" | null; text?: string | null }>,
  ) => {
    if (!sessionID || seeds.length === 0) return list;
    if (list.length > 0) return list;
    const existingIds = new Set(list.map((message) => messageIdFromInfo(message)));
    const synthetic = seeds
      .map((seed, index) => createSyntheticBlueprintSeedMessage(sessionID, index, seed))
      .filter((message) => !existingIds.has(messageIdFromInfo(message)));
    if (!synthetic.length) return list;
    return [...synthetic, ...list];
  };

  const insertSyntheticSessionErrors = (
    list: MessageWithParts[],
    sessionID: string | null,
    errorTurns: SessionErrorTurn[],
  ) => {
    if (!sessionID || errorTurns.length === 0) return list;

    const next = list.slice();
    errorTurns.forEach((errorTurn) => {
      if (next.some((message) => messageIdFromInfo(message) === errorTurn.id)) return;
      const syntheticMessage = createSyntheticSessionErrorMessage(sessionID, errorTurn);
      const anchorIndex = errorTurn.afterMessageID
        ? next.findIndex((message) => messageIdFromInfo(message) === errorTurn.afterMessageID)
        : -1;

      if (anchorIndex === -1) {
        next.push(syntheticMessage);
        return;
      }

      next.splice(anchorIndex + 1, 0, syntheticMessage);
    });

    return next;
  };

  const upsertLocalSession = (next: Session | null | undefined) => {
    const id = (next as { id?: string } | null)?.id ?? "";
    if (!id) return;

    const current = sessions();
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) {
      setSessions([...current, next as Session]);
      return;
    }
    const copy = current.slice();
    copy[index] = next as Session;
    setSessions(copy);
  };

  // OpenCode keeps reverted messages in the log and uses `session.revert.messageID`
  // as the visibility boundary. OpenWork mirrors that behavior by filtering the
  // displayed transcript.
  const visibleMessages = createMemo(() => {
    const sessionID = selectedSessionId();
    const errorTurns = sessionStore.selectedSessionErrorTurns();
    const blueprintSeeds = blueprintSeedMessagesForSelectedSession();
    const list = messages().filter((message) => {
      const id = messageIdFromInfo(message);
      return !id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX) && !id.startsWith(SYNTHETIC_BLUEPRINT_SEED_MESSAGE_PREFIX);
    });
    const revert = selectedSession()?.revert?.messageID ?? null;
    const visible = !revert ? list : list.filter((message) => {
      const id = messageIdFromInfo(message);
      return Boolean(id) && id < revert;
    });
    return insertSyntheticSessionErrors(
      insertSyntheticBlueprintSeedMessages(visible, sessionID, blueprintSeeds),
      sessionID,
      errorTurns,
    );
  });

  const restorePromptFromUserMessage = (message: MessageWithParts) => {
    const text = message.parts
      .filter(isVisibleTextPart)
      .map((part) => String((part as { text?: string }).text ?? ""))
      .join("");
    setPrompt(text);
  };

  async function undoLastUserMessage() {
    const c = client();
    const sessionID = (selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    // Revert is rejected while the session is busy. We *usually* have an accurate
    // session status via SSE, but to be resilient to transient desync we attempt
    // an abort even when we think we're idle.
    await abortSessionSafe(c, sessionID);

    const revertMessageID = selectedSession()?.revert?.messageID ?? null;
    const users = messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    let target: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (!id) continue;
      if (!revertMessageID || id < revertMessageID) {
        target = candidate;
        break;
      }
    }

    if (!target) return;
    const messageID = messageIdFromInfo(target);
    if (!messageID) return;

    const next = await revertSession(c, sessionID, messageID);
    upsertLocalSession(next);
    restorePromptFromUserMessage(target);
  }

  async function redoLastUserMessage() {
    const c = client();
    const sessionID = (selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    await abortSessionSafe(c, sessionID);

    const revertMessageID = selectedSession()?.revert?.messageID ?? null;
    if (!revertMessageID) return;

    const users = messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    const next = users.find((message) => {
      const id = messageIdFromInfo(message);
      return Boolean(id) && id > revertMessageID;
    });

    if (!next) {
      const session = await unrevertSession(c, sessionID);
      upsertLocalSession(session);
      setPrompt("");
      return;
    }

    const messageID = messageIdFromInfo(next);
    if (!messageID) return;

    const nextSession = await revertSession(c, sessionID, messageID);
    upsertLocalSession(nextSession);

    let prior: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (id && id < messageID) {
        prior = candidate;
        break;
      }
    }

    if (prior) {
      restorePromptFromUserMessage(prior);
      return;
    }

    setPrompt("");
  }

  async function renameSessionTitle(sessionID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }
    
    await renameSession(sessionID, trimmed);
    await refreshSidebarWorkspaceSessions(workspaceStore.selectedWorkspaceId()).catch(() => undefined);
  }

  async function deleteSessionById(sessionID: string) {
    const trimmed = sessionID.trim();
    if (!trimmed) return;
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const root = workspaceStore.selectedWorkspaceRoot().trim();
    const directory = toSessionTransportDirectory(root);
    const params = directory ? { sessionID: trimmed, directory } : { sessionID: trimmed };
    unwrap(await c.session.delete(params));

    // Remove the deleted session from the store and sidebar locally.
    // SSE will handle any further sync — calling loadSessions/refreshSidebarWorkspaceSessions
    // here races with SSE and can wipe unrelated sessions from the store.
    setSessions(sessions().filter((s) => s.id !== trimmed));
    const activeWsId = workspaceStore.selectedWorkspaceId();
    setSidebarSessionsByWorkspaceId((prev) => ({
      ...prev,
      [activeWsId]: (prev[activeWsId] ?? []).filter((s) => s.id !== trimmed),
    }));

    // If we're currently routed to the deleted session, navigate away immediately.
    // (Otherwise the route effect can try to re-select a session that no longer exists.)
    try {
      const path = location.pathname.toLowerCase();
      if (path === `/session/${trimmed.toLowerCase()}`) {
        navigate("/session", { replace: true });
      }
    } catch {
      // ignore
    }

    // If the deleted session was selected, clear selection so routing can fall back cleanly.
    if (selectedSessionId() === trimmed) {
      setSelectedSessionId(null);
      const activeWorkspace = workspaceStore.selectedWorkspaceId().trim();
      if (activeWorkspace) {
        const map = readSessionByWorkspace();
        if (map[activeWorkspace] === trimmed) {
          const next = { ...map };
          delete next[activeWorkspace];
          writeSessionByWorkspace(next);
        }
      }
    }

    const nextStatus = { ...sessionStatusById() };
    if (nextStatus[trimmed]) {
      delete nextStatus[trimmed];
      setSessionStatusById(nextStatus);
    }
  }


  async function listAgents(): Promise<Agent[]> {
    const c = client();
    if (!c) return [];
    const list = unwrap(await c.app.agents());
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }

  const BUILTIN_COMPACT_COMMAND = {
    id: "builtin:compact",
    name: "compact",
    description: "Summarize this session to reduce context size.",
    source: "command" as const,
  };

  async function listCommands(): Promise<{ id: string; name: string; description?: string; source?: "command" | "mcp" | "skill" }[]> {
    const c = client();
    if (!c) return [];
    const list = await listCommandsTyped(c, workspaceStore.selectedWorkspaceRoot().trim() || undefined);
    if (list.some((entry) => entry.name === "compact")) {
      return list;
    }
    return [BUILTIN_COMPACT_COMMAND, ...list];
  }

  function setSessionAgent(sessionID: string, agent: string | null) {
    const trimmed = agent?.trim() ?? "";
    setSessionAgentById((current) => {
      const next = { ...current };
      if (!trimmed) {
        delete next[sessionID];
        return next;
      }
      next[sessionID] = trimmed;
      return next;
    });
  }

  const buildProviderAuthMethods = (
    methods: Record<string, ProviderAuthMethod[]>,
    availableProviders: ProviderListItem[],
    workerType: "local" | "remote",
  ) => {
    const merged = Object.fromEntries(
      Object.entries(methods ?? {}).map(([id, providerMethods]) => [
        id,
        (providerMethods ?? []).map((method, methodIndex) => ({
          ...method,
          methodIndex,
        })),
      ]),
    ) as Record<string, ProviderAuthMethod[]>;
    for (const provider of availableProviders ?? []) {
      const id = provider.id?.trim();
      if (!id || id === "opencode") continue;
      if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
      const existing = merged[id] ?? [];
      if (existing.some((method) => method.type === "api")) continue;
      merged[id] = [...existing, { type: "api", label: "API key" }];
    }
    for (const [id, providerMethods] of Object.entries(merged)) {
      const provider = availableProviders.find((item) => item.id === id);
      const normalizedId = id.trim().toLowerCase();
      const normalizedName = provider?.name?.trim().toLowerCase() ?? "";
      const isOpenAiProvider = normalizedId === "openai" || normalizedName === "openai";
      if (!isOpenAiProvider) continue;
      merged[id] = providerMethods.filter((method) => {
        if (method.type !== "oauth") return true;
        const label = method.label.toLowerCase();
        const isHeadless = label.includes("headless") || label.includes("device");
        return workerType === "remote" ? isHeadless : !isHeadless;
      });
    }
    return merged;
  };

  const loadProviderAuthMethods = async (workerType: "local" | "remote") => {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }
    const methods = unwrap(await c.provider.auth());
    return buildProviderAuthMethods(
      methods as Record<string, ProviderAuthMethod[]>,
      providers(),
      workerType,
    );
  };

  async function startProviderAuth(
    providerId?: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> {
    setProviderAuthError(null);
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }
    try {
      const cachedMethods = providerAuthMethods();
      const workerType = selectedWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local";
      const authMethods = Object.keys(cachedMethods).length
        ? cachedMethods
        : await loadProviderAuthMethods(workerType);
      const providerIds = Object.keys(authMethods).sort();
      if (!providerIds.length) {
        throw new Error("No providers available");
      }

      const resolved = providerId?.trim() ?? "";
      if (!resolved) {
        throw new Error("Provider ID is required");
      }

      const methods = authMethods[resolved];
      if (!methods || !methods.length) {
        throw new Error(`Unknown provider: ${resolved}`);
      }

      const oauthIndex =
        methodIndex !== undefined
          ? methodIndex
          : methods.find((method) => method.type === "oauth")?.methodIndex ?? -1;
      if (oauthIndex === -1) {
        throw new Error(`No OAuth flow available for ${resolved}. Use an API key instead.`);
      }

      const selectedMethod = methods.find((method) => method.methodIndex === oauthIndex);
      if (!selectedMethod || selectedMethod.type !== "oauth") {
        throw new Error(`Selected auth method is not an OAuth flow for ${resolved}.`);
      }

      const auth = unwrap(await c.provider.oauth.authorize({ providerID: resolved, method: oauthIndex }));
      return {
        methodIndex: oauthIndex,
        authorization: auth,
      };
    } catch (error) {
      const message = describeProviderError(error, "Failed to connect provider");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function refreshProviders(options?: { dispose?: boolean }) {
    const c = client();
    if (!c) return null;

    if (options?.dispose) {
      try {
        unwrap(await c.instance.dispose());
      } catch {
        // ignore dispose failures and try reading current state anyway
      }

      try {
        await waitForHealthy(client() ?? c, { timeoutMs: 8_000, pollMs: 250 });
      } catch {
        // ignore health wait failures and still attempt provider reads
      }
    }

    const activeClient = client() ?? c;
    let disabledProviders = globalSync.data.config.disabled_providers ?? [];
    try {
      const config = unwrap(await activeClient.config.get());
      disabledProviders = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
    } catch {
      // ignore config read failures and continue with current store state
    }
    try {
      const updated = filterProviderList(
        unwrap(await activeClient.provider.list()),
        disabledProviders,
      );
      globalSync.set("provider", updated);
      return updated;
    } catch {
      try {
        const fallback = unwrap(await activeClient.config.providers());
        const mapped = mapConfigProvidersToList(fallback.providers);
        const previousConnected = providerConnectedIds();
        const next = filterProviderList(
          {
            all: mapped,
            connected: previousConnected.filter((id) => mapped.some((provider) => provider.id === id)),
            default: fallback.default,
          },
          disabledProviders,
        );
        globalSync.set("provider", next);
        return next;
      } catch {
        return null;
      }
    }
  }

  async function completeProviderAuthOAuth(providerId: string, methodIndex: number, code?: string) {
    setProviderAuthError(null);
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const resolved = providerId?.trim();
    if (!resolved) {
      throw new Error("Provider ID is required");
    }

    if (!Number.isInteger(methodIndex) || methodIndex < 0) {
      throw new Error("OAuth method is required");
    }

    const waitForProviderConnection = async (timeoutMs = 15_000, pollMs = 2_000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const updated = await refreshProviders({ dispose: true });
          if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
            return true;
          }
        } catch {
          // ignore and retry
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return false;
    };

    const isPendingOauthError = (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error ?? "");
      return /request timed out/i.test(text) || /ProviderAuthOauthMissing/i.test(text);
    };

    try {
      const trimmedCode = code?.trim();
      const result = await c.provider.oauth.callback({
        providerID: resolved,
        method: methodIndex,
        code: trimmedCode || undefined,
      });
      assertNoClientError(result);
      const updated = await refreshProviders({ dispose: true });
      const connectedNow = Array.isArray(updated?.connected) && updated.connected.includes(resolved);
      if (connectedNow) {
        return { connected: true, message: `Connected ${resolved}` };
      }
      const connected = await waitForProviderConnection();
      if (connected) {
        return { connected: true, message: `Connected ${resolved}` };
      }
      return { connected: false, pending: true };
    } catch (error) {
      if (isPendingOauthError(error)) {
        const updated = await refreshProviders({ dispose: true });
        if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
          return { connected: true, message: `Connected ${resolved}` };
        }
        const connected = await waitForProviderConnection();
        if (connected) {
          return { connected: true, message: `Connected ${resolved}` };
        }
        return { connected: false, pending: true };
      }
      const message = describeProviderError(error, "Failed to complete OAuth");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function submitProviderApiKey(providerId: string, apiKey: string) {
    setProviderAuthError(null);
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("API key is required");
    }

    try {
      await c.auth.set({
        providerID: providerId,
        auth: { type: "api", key: trimmed },
      });
      await refreshProviders({ dispose: true });
      return `Connected ${providerId}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to save API key");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function disconnectProvider(providerId: string) {
    setProviderAuthError(null);
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error("Provider ID is required");
    }

    const provider = providers().find((entry) => entry.id === resolved) as
      | (ProviderListItem & { source?: string })
      | undefined;
    const canDisableProvider =
      provider?.source === "config" || provider?.source === "custom";

    const removeProviderAuth = async () => {
      const authClient = c.auth as unknown as {
        remove?: (options: { providerID: string }) => Promise<unknown>;
        set?: (options: { providerID: string; auth: unknown }) => Promise<unknown>;
      };
      if (typeof authClient.remove === "function") {
        const result = await authClient.remove({ providerID: resolved });
        assertNoClientError(result);
        return;
      }

      const rawClient = (c as unknown as { client?: { delete?: (options: { url: string }) => Promise<unknown> } })
        .client;
      if (rawClient?.delete) {
        await rawClient.delete({ url: `/auth/${encodeURIComponent(resolved)}` });
        return;
      }

      if (typeof authClient.set === "function") {
        const result = await authClient.set({ providerID: resolved, auth: null });
        assertNoClientError(result);
        return;
      }

      throw new Error("Provider auth removal is not supported by this client.");
    };

    const disableProvider = async () => {
      const config = unwrap(await c.config.get());
      const disabledProviders = Array.isArray(config.disabled_providers)
        ? config.disabled_providers
        : [];
      if (disabledProviders.includes(resolved)) {
        return false;
      }

      const next = [...disabledProviders, resolved];
      globalSync.set("config", "disabled_providers", next);
      try {
        const result = await c.config.update({
          config: {
            ...config,
            disabled_providers: next,
          },
        });
        assertNoClientError(result);
        markOpencodeConfigReloadRequired();
      } catch (error) {
        globalSync.set("config", "disabled_providers", disabledProviders);
        throw error;
      }
      return true;
    };

    try {
      await removeProviderAuth();
      let updated = await refreshProviders({ dispose: true });
      if (
        canDisableProvider &&
        Array.isArray(updated?.connected) &&
        updated.connected.includes(resolved)
      ) {
        const disabled = await disableProvider();
        if (disabled) {
          updated = filterProviderList(updated, globalSync.data.config.disabled_providers ?? []);
          globalSync.set("provider", updated);
        }
        if (!Array.isArray(updated?.connected) || !updated.connected.includes(resolved)) {
          return disabled
            ? `Disconnected ${resolved} and disabled it in OpenCode config.`
            : `Disconnected ${resolved}.`;
        }
      }

      if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
        return `Removed stored credentials for ${resolved}, but the worker still reports it as connected. Clear any remaining API key or OAuth credentials and restart the worker to fully disconnect.`;
      }
      removeProviderFromState(resolved);
      return `Disconnected ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to disconnect provider");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  function focusSessionPromptSoon() {
    if (typeof window === "undefined" || currentView() !== "session") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("openwork:focusPrompt"));
      });
    });
  }

  async function openProviderAuthModal(options?: {
    returnFocusTarget?: PromptFocusReturnTarget;
    preferredProviderId?: string;
  }) {
    const workerType = selectedWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local";
    setProviderAuthReturnFocusTarget(options?.returnFocusTarget ?? "none");
    setProviderAuthPreferredProviderId(options?.preferredProviderId?.trim() || null);
    setProviderAuthBusy(true);
    setProviderAuthError(null);
    try {
      const methods = await loadProviderAuthMethods(workerType);
      setProviderAuthMethods(methods);
      setProviderAuthModalOpen(true);
    } catch (error) {
      setProviderAuthPreferredProviderId(null);
      setProviderAuthReturnFocusTarget("none");
      const message = describeProviderError(error, "Failed to load providers");
      setProviderAuthError(message);
      throw error;
    } finally {
      setProviderAuthBusy(false);
    }
  }

  function closeProviderAuthModal(options?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      options?.restorePromptFocus ??
      providerAuthReturnFocusTarget() === "composer";
    setProviderAuthModalOpen(false);
    setProviderAuthError(null);
    setProviderAuthPreferredProviderId(null);
    setProviderAuthReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      focusSessionPromptSoon();
    }
  }

  async function saveSessionExport(sessionID: string) {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const session = unwrap(await c.session.get({ sessionID }));
    const messages = unwrap(await c.session.messages({ sessionID }));
    let todos: TodoItem[] = [];
    try {
      todos = unwrap(await c.session.todo({ sessionID }));
    } catch {
      // ignore
    }

    const payload = {
      session,
      messages,
      todos,
      exportedAt: new Date().toISOString(),
      source: "openwork",
    };

    const baseName = session.title || session.slug || session.id;
    const safeName = baseName
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const fileName = `session-${safeName || session.id}.json`;
    return downloadSessionExport(payload, fileName);
  }

  function downloadSessionExport(payload: unknown, fileName: string) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return fileName;
  }


  async function respondPermissionAndRemember(
    requestID: string,
    reply: "once" | "always" | "reject"
  ) {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermission(requestID, reply);
  }

  const [notionStatus, setNotionStatus] = createSignal<"disconnected" | "connecting" | "connected" | "error">(
    "disconnected",
  );
  const [notionStatusDetail, setNotionStatusDetail] = createSignal<string | null>(null);
  const [notionError, setNotionError] = createSignal<string | null>(null);
  const [notionBusy, setNotionBusy] = createSignal(false);
  const [notionSkillInstalled, setNotionSkillInstalled] = createSignal(false);
  const [tryNotionPromptVisible, setTryNotionPromptVisible] = createSignal(false);
  const notionIsActive = createMemo(() => notionStatus() === "connected");
  const [mcpServers, setMcpServers] = createSignal<McpServerEntry[]>([]);
  const [mcpStatus, setMcpStatus] = createSignal<string | null>(null);
  const [mcpLastUpdatedAt, setMcpLastUpdatedAt] = createSignal<number | null>(null);
  const [mcpStatuses, setMcpStatuses] = createSignal<McpStatusMap>({});
  const [mcpConnectingName, setMcpConnectingName] = createSignal<string | null>(null);
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>(null);
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>([]);
  const [scheduledJobsStatus, setScheduledJobsStatus] = createSignal<string | null>(null);
  const [scheduledJobsBusy, setScheduledJobsBusy] = createSignal(false);
  const [scheduledJobsUpdatedAt, setScheduledJobsUpdatedAt] = createSignal<number | null>(null);

  // MCP OAuth modal state
  const [mcpAuthModalOpen, setMcpAuthModalOpen] = createSignal(false);
  const [mcpAuthEntry, setMcpAuthEntry] = createSignal<(typeof MCP_QUICK_CONNECT)[number] | null>(null);
  const [mcpAuthNeedsReload, setMcpAuthNeedsReload] = createSignal(false);

  const extensionsStore = createExtensionsStore({
    client,
    projectDir: () => workspaceProjectDir(),
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot(),
    workspaceType: () => workspaceStore.selectedWorkspaceDisplay().workspaceType,
    openworkServerClient,
    openworkServerStatus,
    openworkServerCapabilities,
    runtimeWorkspaceId,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
    markReloadRequired,
    onNotionSkillInstalled: () => {
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("openwork.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
      if (notionIsActive()) {
        setTryNotionPromptVisible(true);
      }
    },
  });

  const {
    skills,
    skillsStatus,
    hubSkills,
    hubSkillsStatus,
    hubRepo,
    hubRepos,
    pluginScope,
    setPluginScope,
    pluginConfig,
    pluginConfigPath,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    sidebarPluginList,
    sidebarPluginStatus,
    isPluginInstalledByName,
    refreshSkills,
    refreshHubSkills,
    setHubRepo,
    addHubRepo,
    removeHubRepo,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    installSkillCreator,
    installHubSkill,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    abortRefreshes,
  } = extensionsStore;

  const globalSync = useGlobalSync();
  const providers = createMemo(() => globalSync.data.provider.all ?? []);
  const providerDefaults = createMemo(() => globalSync.data.provider.default ?? {});
  const providerConnectedIds = createMemo(() => globalSync.data.provider.connected ?? []);
  const setProviders = (value: ProviderListItem[]) => {
    globalSync.set("provider", "all", value);
  };
  const setProviderDefaults = (value: Record<string, string>) => {
    globalSync.set("provider", "default", value);
  };
  const setProviderConnectedIds = (value: string[]) => {
    globalSync.set("provider", "connected", value);
  };

  const removeProviderFromState = (providerId: string) => {
    const resolved = providerId.trim();
    if (!resolved) return;
    setProviders(providers().filter((provider) => provider.id !== resolved));
    setProviderConnectedIds(providerConnectedIds().filter((id) => id !== resolved));
    setProviderDefaults(
      Object.fromEntries(Object.entries(providerDefaults()).filter(([id]) => id !== resolved)),
    );
  };

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const sessionModelOverridesKey = (workspaceId: string) =>
    `${SESSION_MODEL_PREF_KEY}.${workspaceId}`;

  const parseSessionModelOverrides = (raw: string | null) => {
    if (!raw) return {} as Record<string, ModelRef>;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {} as Record<string, ModelRef>;
      }
      const next: Record<string, ModelRef> = {};
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          const model = parseModelRef(value);
          if (model) next[sessionId] = model;
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        if (typeof record.providerID === "string" && typeof record.modelID === "string") {
          next[sessionId] = {
            providerID: record.providerID,
            modelID: record.modelID,
          };
        }
      }
      return next;
    } catch {
      return {} as Record<string, ModelRef>;
    }
  };

  const serializeSessionModelOverrides = (overrides: Record<string, ModelRef>) => {
    const entries = Object.entries(overrides);
    if (!entries.length) return null;
    const payload: Record<string, string> = {};
    for (const [sessionId, model] of entries) {
      payload[sessionId] = formatModelRef(model);
    }
    return JSON.stringify(payload);
  };

  const parseDefaultModelFromConfig = (content: string | null) => {
    if (!content) return null;
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      const rawModel = typeof parsed?.model === "string" ? parsed.model : null;
      return parseModelRef(rawModel);
    } catch {
      return null;
    }
  };

  const formatConfigWithDefaultModel = (content: string | null, model: ModelRef) => {
    let config: Record<string, unknown> = {};
    if (content?.trim()) {
      try {
        const parsed = parse(content) as Record<string, unknown> | undefined;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = { ...parsed };
        }
      } catch {
        config = {};
      }
    }

    if (!config["$schema"]) {
      config["$schema"] = "https://opencode.ai/config.json";
    }

    config.model = formatModelRef(model);
    return `${JSON.stringify(config, null, 2)}\n`;
  };

  const parseAutoCompactContextFromConfig = (content: string | null) => {
    if (!content) return null;
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const compaction = parsed.compaction;
      if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) {
        return null;
      }
      return typeof (compaction as Record<string, unknown>).auto === "boolean"
        ? ((compaction as Record<string, unknown>).auto as boolean)
        : null;
    } catch {
      return null;
    }
  };

  const formatConfigWithAutoCompactContext = (content: string | null, enabled: boolean) => {
    let config: Record<string, unknown> = {};
    if (content?.trim()) {
      try {
        const parsed = parse(content) as Record<string, unknown> | undefined;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = { ...parsed };
        }
      } catch {
        config = {};
      }
    }

    if (!config["$schema"]) {
      config["$schema"] = "https://opencode.ai/config.json";
    }

    const compaction =
      typeof config.compaction === "object" && config.compaction && !Array.isArray(config.compaction)
        ? { ...(config.compaction as Record<string, unknown>) }
        : {};

    compaction.auto = enabled;
    config.compaction = compaction;
    return `${JSON.stringify(config, null, 2)}\n`;
  };

  const getConfigSnapshot = (content: string | null) => {
    if (!content?.trim()) return "";
    try {
      const parsed = parse(content) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const copy = { ...parsed };
        delete copy.model;
        return JSON.stringify(copy);
      }
      return content;
    } catch {
      return content;
    }
  };

  const ensureRecord = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  };

  const readAutoCompactContextFromRecord = (value: unknown) => {
    const compaction = ensureRecord(ensureRecord(value).compaction);
    return typeof compaction.auto === "boolean" ? compaction.auto : null;
  };

  const normalizeAuthorizedFolderPath = (input: string | null | undefined) => {
    const trimmed = (input ?? "").trim();
    if (!trimmed) return "";
    const withoutWildcard = trimmed.replace(/[\\/]\*+$/, "");
    return normalizeDirectoryQueryPath(withoutWildcard);
  };

  const authorizedFolderToExternalDirectoryKey = (folder: string) => {
    const normalized = normalizeAuthorizedFolderPath(folder);
    if (!normalized) return "";
    return normalized === "/" ? "/*" : `${normalized}/*`;
  };

  const externalDirectoryKeyToAuthorizedFolder = (key: string, value: unknown) => {
    if (value !== "allow") return null;
    const trimmed = key.trim();
    if (!trimmed) return null;
    if (trimmed === "/*") return "/";
    if (!trimmed.endsWith("/*")) return null;
    return normalizeAuthorizedFolderPath(trimmed.slice(0, -2));
  };

  const readAuthorizedFoldersFromConfig = (opencodeConfig: Record<string, unknown>) => {
    const permission = ensureRecord(opencodeConfig.permission);
    const externalDirectory = ensureRecord(permission.external_directory);
    const folders: string[] = [];
    const hiddenEntries: Record<string, unknown> = {};
    const seen = new Set<string>();

    for (const [key, value] of Object.entries(externalDirectory)) {
      const folder = externalDirectoryKeyToAuthorizedFolder(key, value);
      if (!folder) {
        hiddenEntries[key] = value;
        continue;
      }
      if (seen.has(folder)) continue;
      seen.add(folder);
      folders.push(folder);
    }

    return { folders, hiddenEntries };
  };

  const buildAuthorizedFoldersStatus = (preservedCount: number, action?: string) => {
    const preservedLabel =
      preservedCount > 0
        ? `Preserving ${preservedCount} non-folder permission ${preservedCount === 1 ? "entry" : "entries"}.`
        : null;
    if (action && preservedLabel) return `${action} ${preservedLabel}`;
    return action ?? preservedLabel;
  };

  const mergeAuthorizedFoldersIntoExternalDirectory = (
    folders: string[],
    hiddenEntries: Record<string, unknown>,
  ): Record<string, unknown> | undefined => {
    const next: Record<string, unknown> = { ...hiddenEntries };
    for (const folder of folders) {
      const key = authorizedFolderToExternalDirectoryKey(folder);
      if (!key) continue;
      next[key] = "allow";
    }
    return Object.keys(next).length ? next : undefined;
  };
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<
    "session" | "default"
  >("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  const [modelPickerReturnFocusTarget, setModelPickerReturnFocusTarget] =
    createSignal<PromptFocusReturnTarget>("none");

  const [showThinking, setShowThinking] = createSignal(false);
  const [autoCompactContext, setAutoCompactContext] = createSignal(true);
  const [hideTitlebar, setHideTitlebar] = createSignal(false);
  const [modelVariantMap, setModelVariantMap] = createSignal<Record<string, string>>({});
  const modelVariant = () => getVariantFor(selectedSessionModel());
  const getVariantFor = (ref: ModelRef) => modelVariantMap()[`${ref.providerID}/${ref.modelID}`] ?? null;
  const updateModelVariant = (ref: ModelRef, value: string | null) => {
    const key = `${ref.providerID}/${ref.modelID}`;
    setModelVariantMap((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };
  const setModelVariant = (value: string | null) => updateModelVariant(selectedSessionModel(), value);
  const toggleAutoCompactContext = () => {
    if (autoCompactContextSaving()) return;
    setAutoCompactContext((value) => !value);
    setAutoCompactContextDirty(true);
  };
  const [authorizedFolders, setAuthorizedFolders] = createSignal<string[]>([]);
  const [authorizedFolderDraft, setAuthorizedFolderDraft] = createSignal("");
  const [, setAuthorizedFolderHiddenEntries] = createSignal<Record<string, unknown>>({});
  const [authorizedFoldersLoading, setAuthorizedFoldersLoading] = createSignal(false);
  const [authorizedFoldersSaving, setAuthorizedFoldersSaving] = createSignal(false);
  const [authorizedFoldersStatus, setAuthorizedFoldersStatus] = createSignal<string | null>(null);
  const [authorizedFoldersError, setAuthorizedFoldersError] = createSignal<string | null>(null);

  const resolveCodexReasoningEffort = (modelID: string, variant: string | null) => {
    if (!modelID.trim().toLowerCase().includes("codex")) return undefined;
    const normalized = normalizeModelBehaviorValue(variant);
    if (!normalized || normalized === "none") return undefined;
    if (normalized === "minimal") return "low";
    if (normalized === "xhigh" || normalized === "max") return "high";
    if (!["low", "medium", "high"].includes(normalized)) return undefined;
    return normalized;
  };

  const workspaceStore = createWorkspaceStore({
    startupPreference,
    setStartupPreference,
    onboardingStep,
    setOnboardingStep,
    rememberStartupChoice,
    setRememberStartupChoice,
    baseUrl,
    setBaseUrl,
    clientDirectory,
    setClientDirectory,
    client,
    setClient,
    setConnectedVersion,
    setSseConnected,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setOpencodeConnectStatus,
    loadSessions: loadSessionsWithReady,
    refreshPendingPermissions,
    selectedSessionId,
    selectSession,
    setSelectedSessionId,
    setMessages,
    setTodos,
    setPendingPermissions,
    setSessionStatusById,
    defaultModel,
    modelVariant,
    refreshSkills,
    refreshPlugins,
    engineSource,
    engineCustomBinPath,
    opencodeEnableExa,
    setEngineSource,
    setView,
    setTab,
    isWindowsPlatform,
    openworkServerSettings,
    updateOpenworkServerSettings,
    openworkServerClient,
    openworkServerStatus,
    ensureLocalOpenworkServerClient,
    runtimeWorkspaceId,
    onEngineStable: () => {},
    engineRuntime,
    developerMode,
  });

  type SidebarWorkspaceSessionsStatus = WorkspaceSessionGroup["status"];
  const [sidebarSessionsByWorkspaceId, setSidebarSessionsByWorkspaceId] = createSignal<
    Record<string, SidebarSessionItem[]>
  >({});
  const [sidebarSessionStatusByWorkspaceId, setSidebarSessionStatusByWorkspaceId] = createSignal<
    Record<string, SidebarWorkspaceSessionsStatus>
  >({});
  const [sidebarSessionErrorByWorkspaceId, setSidebarSessionErrorByWorkspaceId] = createSignal<
    Record<string, string | null>
  >({});

  const logWorkspaceScopeSnapshot = (label: string, extra?: Record<string, unknown>) => {
    if (!developerMode()) return;
    const activeWorkspace = workspaceStore.selectedWorkspaceInfo();
    const selectedWorkspaceId = workspaceStore.selectedWorkspaceId().trim();
    const selectedWorkspaceRoot = workspaceStore.selectedWorkspaceRoot().trim();
    const engineInfo = workspaceStore.engine();
    const map = readSessionByWorkspace();
    wsDebug(label, {
      selectedWorkspaceId: selectedWorkspaceId || null,
      activeWorkspaceType: activeWorkspace?.workspaceType ?? null,
      selectedWorkspacePath: activeWorkspace?.path?.trim() ?? null,
      activeWorkspaceDirectory: activeWorkspace?.directory?.trim() ?? null,
      selectedWorkspaceRoot: selectedWorkspaceRoot || null,
      activeWorkspaceScope: describeDirectoryScope(selectedWorkspaceRoot),
      clientDirectory: clientDirectory().trim() || null,
      clientDirectoryScope: describeDirectoryScope(clientDirectory().trim()),
      engineProjectDir: engineInfo?.projectDir?.trim() ?? null,
      engineProjectScope: describeDirectoryScope(engineInfo?.projectDir?.trim() ?? null),
      lastSessionForActiveWorkspace: selectedWorkspaceId ? map[selectedWorkspaceId] ?? null : null,
      lastSessionMapKeys: Object.keys(map),
      ...extra,
    });
  };

  const pruneSidebarSessionState = (workspaceIds: Set<string>) => {
    setSidebarSessionsByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarSessionItem[]> = {};
      for (const [id, list] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = list;
      }
      return changed ? next : prev;
    });
    setSidebarSessionStatusByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarWorkspaceSessionsStatus> = {};
      for (const [id, status] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = status;
      }
      return changed ? next : prev;
    });
    setSidebarSessionErrorByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, string | null> = {};
      for (const [id, error] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = error;
      }
      return changed ? next : prev;
    });
  };

  const resolveSidebarClientConfig = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) return null;

    if (workspace.workspaceType === "local") {
      const info = workspaceStore.engine();
      const baseUrl = info?.baseUrl?.trim() ?? "";
      const directory = toSessionTransportDirectory(workspace.path?.trim() ?? "");
      const username = info?.opencodeUsername?.trim() ?? "";
      const password = info?.opencodePassword?.trim() ?? "";
      const auth: OpencodeAuth | undefined = username && password ? { username, password } : undefined;
      return {
        baseUrl,
        directory,
        auth,
      };
    }

    const baseUrl = workspace.baseUrl?.trim() ?? "";
    const directory = workspace.directory?.trim() ?? "";
    if (workspace.remoteType === "openwork") {
      // Sidebar session listing should be per-workspace and should not implicitly depend on
      // global OpenWork server settings, otherwise switching between remotes can cause other
      // workspace task lists to appear/disappear.
      const token = workspace.openworkToken?.trim() ?? "";
      const auth: OpencodeAuth | undefined = token ? { token, mode: "openwork" } : undefined;
      return {
        baseUrl,
        directory,
        auth,
      };
    }
    return {
      baseUrl,
      directory,
      auth: undefined as OpencodeAuth | undefined,
    };
  };

  const sidebarRefreshSeqByWorkspaceId: Record<string, number> = {};
  const SIDEBAR_SESSION_LIMIT = 200;
  const refreshSidebarWorkspaceSessions = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;

    const config = resolveSidebarClientConfig(id);
    if (!config) return;

    // For local workspaces, avoid thrashing UI with errors if the engine is offline.
    if (!config.baseUrl) {
      let changed = false;
      setSidebarSessionStatusByWorkspaceId((prev) => {
        if (prev[id] === "idle") return prev;
        changed = true;
        return { ...prev, [id]: "idle" };
      });
      setSidebarSessionErrorByWorkspaceId((prev) => {
        if ((prev[id] ?? null) === null) return prev;
        changed = true;
        return { ...prev, [id]: null };
      });
      if (changed) {
        wsDebug("sidebar:skip", { id, reason: "no-baseUrl" });
      }
      return;
    }

    sidebarRefreshSeqByWorkspaceId[id] = (sidebarRefreshSeqByWorkspaceId[id] ?? 0) + 1;
    const seq = sidebarRefreshSeqByWorkspaceId[id];

    setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "loading" }));
    setSidebarSessionErrorByWorkspaceId((prev) => ({ ...prev, [id]: null }));

    try {
      const start = Date.now();
      let directory = config.directory;
      let c = createClient(config.baseUrl, directory || undefined, config.auth);
      wsDebug("sidebar:list:start", {
        id,
        directory: directory || null,
        directoryScope: describeDirectoryScope(directory),
        workspacePath: workspaceStore.workspaces().find((entry) => entry.id === id)?.path?.trim() ?? null,
      });

      if (!directory) {
        try {
          const pathInfo = unwrap(await c.path.get());
          const discovered = toSessionTransportDirectory(pathInfo.directory ?? "");
          if (discovered) {
            directory = discovered;
            c = createClient(config.baseUrl, directory, config.auth);
          }
        } catch {
          // ignore
        }
      }

      const queryDirectory = normalizeDirectoryQueryPath(directory) || undefined;

      // Fetch sessions scoped to the workspace directory to avoid loading the
      // full global session list for every workspace.
      const list = unwrap(
        await c.session.list({ directory: queryDirectory, roots: false, limit: SIDEBAR_SESSION_LIMIT }),
      );
      wsDebug("sidebar:list", {
        id,
        baseUrl: config.baseUrl,
        directory: directory || null,
        directoryScope: describeDirectoryScope(directory),
        queryDirectory: queryDirectory ?? null,
        queryScope: describeDirectoryScope(queryDirectory),
        count: list.length,
        ms: Date.now() - start,
        sessionDirectories: list.slice(0, 10).map((session) => ({
          id: session.id,
          directory: session.directory,
          directoryScope: describeDirectoryScope(session.directory),
        })),
      });
      if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;

      // Defensive client-side filter in case upstream ignores the directory query.
      const root = normalizeDirectoryPath(directory);
      const filtered = root ? list.filter((session) => normalizeDirectoryPath(session.directory) === root) : list;

      const sorted = sortSessionsByActivity(filtered);
      const items: SidebarSessionItem[] = sorted.map((session) => ({
        id: session.id,
        title: session.title,
        slug: session.slug,
        parentID: session.parentID,
        time: session.time,
        directory: session.directory,
      }));

      setSidebarSessionsByWorkspaceId((prev) => ({
        ...prev,
        [id]: items,
      }));
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "ready" }));
    } catch (error) {
      if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;
      const message = error instanceof Error ? error.message : safeStringify(error);
      wsDebug("sidebar:error", { id, message });
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "error" }));
      setSidebarSessionErrorByWorkspaceId((prev) => ({ ...prev, [id]: message }));
    }
  };

  const refreshAllSidebarWorkspaceSessions = async (prioritizeWorkspaceId?: string | null) => {
    const list = workspaceStore.workspaces();
    if (!list.length) return;
    const prioritize = (prioritizeWorkspaceId ?? "").trim();
    const ordered = prioritize
      ? [...list.filter((ws) => ws.id === prioritize), ...list.filter((ws) => ws.id !== prioritize)]
      : list;
    for (const ws of ordered) {
      await refreshSidebarWorkspaceSessions(ws.id);
      // Yield so long refresh passes don't block UI / timers.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  const refreshLocalSidebarWorkspaceSessions = async (prioritizeWorkspaceId?: string | null) => {
    const list = workspaceStore.workspaces().filter((ws) => ws.workspaceType === "local");
    if (!list.length) return;
    const prioritize = (prioritizeWorkspaceId ?? "").trim();
    const ordered = prioritize
      ? [...list.filter((ws) => ws.id === prioritize), ...list.filter((ws) => ws.id !== prioritize)]
      : list;
    for (const ws of ordered) {
      await refreshSidebarWorkspaceSessions(ws.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  let lastSidebarEngineKey = "";
  let lastSidebarWorkspaceKey = "";
  createEffect(() => {
    const engineInfo = workspaceStore.engine();
    const engineBaseUrl = engineInfo?.baseUrl?.trim() ?? "";
    const engineUser = engineInfo?.opencodeUsername?.trim() ?? "";
    const enginePass = engineInfo?.opencodePassword?.trim() ?? "";

    const engineKey = [engineBaseUrl, engineUser, enginePass].join("::");
    const workspaceKey = workspaceStore
      .workspaces()
      .map((ws) => {
        const root = ws.workspaceType === "local" ? ws.path?.trim() ?? "" : ws.directory?.trim() ?? "";
        const base = ws.workspaceType === "local" ? "" : ws.baseUrl?.trim() ?? "";
        const remoteType = ws.workspaceType === "remote" ? (ws.remoteType ?? "") : "";
        const token = ws.remoteType === "openwork" ? (ws.openworkToken?.trim() ?? "") : "";
        return [ws.id, ws.workspaceType, remoteType, root, base, token].join("|");
      })
      .join(";");

    // Sidebar session refreshes should only be driven by the engine auth/baseUrl or the workspace
    // definitions themselves. Global OpenWork server settings are intentionally excluded so that
    // connecting/activating a remote does not cause other workspace task lists to refresh (and
    // potentially disappear) due to auth fallback changes.
    if (engineKey === lastSidebarEngineKey && workspaceKey === lastSidebarWorkspaceKey) return;

    const engineChanged = engineKey !== lastSidebarEngineKey;
    const workspacesChanged = workspaceKey !== lastSidebarWorkspaceKey;

    lastSidebarEngineKey = engineKey;
    lastSidebarWorkspaceKey = workspaceKey;

    pruneSidebarSessionState(new Set(workspaceStore.workspaces().map((ws) => ws.id)));

    wsDebug("sidebar:refresh", {
      engineChanged,
      workspacesChanged,
      selectedWorkspaceId: workspaceStore.selectedWorkspaceId(),
      engineBaseUrl,
    });

    // Avoid refreshing remote workspace sessions when only the local engine auth/baseUrl changes.
    // Remote->local switches commonly change engineBaseUrl, and refreshing every remote workspace
    // at the same time can trigger large /session responses and UI hangs.
    if (engineChanged && !workspacesChanged) {
      void refreshLocalSidebarWorkspaceSessions(workspaceStore.selectedWorkspaceId()).catch(() => undefined);
      return;
    }

    void refreshAllSidebarWorkspaceSessions(workspaceStore.selectedWorkspaceId()).catch(() => undefined);
  });

  createEffect(() => {
    const id = workspaceStore.selectedWorkspaceId().trim();
    if (!id) return;
    const status = sidebarSessionStatusByWorkspaceId()[id] ?? "idle";
    // Only auto-load once per workspace activation.
    // If a remote is offline, repeated retries here can create an endless refresh loop.
    if (status !== "idle") return;
    refreshSidebarWorkspaceSessions(id).catch(() => undefined);
  });

  createEffect(() => {
    const allSessions = sessions(); // reactive dependency on session store
    // When switching workers, the session store can update before the selectedWorkspaceId flips.
    // Use connectingWorkspaceId as the authoritative target during the switch so we don't
    // accidentally overwrite another worker's sidebar sessions.
    const wsId = (workspaceStore.connectingWorkspaceId() ?? workspaceStore.selectedWorkspaceId()).trim();
    if (!wsId) return;
    const status = sidebarSessionStatusByWorkspaceId()[wsId];

    // Only sync if sidebar is already in 'ready' state (not during initial load)
    if (status === "ready") {
      const activeWorkspace = workspaceStore.workspaces().find((workspace) => workspace.id === wsId) ?? null;
      const selectedWorkspaceRoot = normalizeDirectoryPath(
        activeWorkspace?.workspaceType === "local"
          ? activeWorkspace.path
          : activeWorkspace?.directory ?? activeWorkspace?.path,
      );
      if (
        !shouldApplyScopedSessionLoad({
          loadedScopeRoot: loadedSessionScopeRoot(),
          workspaceRoot: selectedWorkspaceRoot,
        })
      ) {
        if (developerMode()) {
          console.log("[sidebar-sync] skip stale session scope", {
            wsId,
            loadedScopeRoot: loadedSessionScopeRoot(),
            selectedWorkspaceRoot,
          });
        }
        return;
      }
      const scopedSessions = selectedWorkspaceRoot
        ? allSessions.filter((session) => normalizeDirectoryPath(session.directory) === selectedWorkspaceRoot)
        : allSessions;
      const sorted = sortSessionsByActivity(scopedSessions);
      if (developerMode()) {
        console.log("[sidebar-sync] workspace session scope", {
          wsId,
          status,
          activeWorkspace,
          selectedWorkspaceRoot,
          allSessions: allSessions.map((session) => ({
            id: session.id,
            title: session.title,
            directory: session.directory,
            parentID: session.parentID,
          })),
          scopedSessions: scopedSessions.map((session) => ({
            id: session.id,
            title: session.title,
            directory: session.directory,
            parentID: session.parentID,
          })),
        });
      }
      const rootItems: SidebarSessionItem[] = sorted.map((s) => ({
        id: s.id,
        title: s.title,
        slug: s.slug,
        parentID: s.parentID,
        time: s.time,
        directory: s.directory,
      }));
      setSidebarSessionsByWorkspaceId((prev) => {
        const current = prev[wsId] ?? [];
        const hasCurrentChildren = current.some((item) => Boolean(item.parentID?.trim()));
        const incomingAreRootsOnly = rootItems.every((item) => !item.parentID?.trim());
        if (!hasCurrentChildren || !incomingAreRootsOnly) {
          return {
            ...prev,
            [wsId]: rootItems,
          };
        }

        const byId = new Map(current.map((item) => [item.id, item] as const));
        for (const item of rootItems) {
          byId.set(item.id, {
            ...(byId.get(item.id) ?? {}),
            ...item,
          });
        }

        const rootIDs = new Set(rootItems.map((item) => item.id));
        const keepChild = (item: SidebarSessionItem, seen = new Set<string>()) => {
          const parentID = item.parentID?.trim() ?? "";
          if (!parentID) return false;
          if (rootIDs.has(parentID)) return true;
          if (seen.has(parentID)) return false;
          const parent = byId.get(parentID);
          if (!parent) return false;
          seen.add(parentID);
          return keepChild(parent, seen);
        };

        return {
          ...prev,
          [wsId]: [
            ...rootItems,
            ...current.filter((item) => !rootIDs.has(item.id) && keepChild(item)),
          ],
        };
      });
    }
  });

  const sidebarWorkspaceGroups = createMemo<WorkspaceSessionGroup[]>(() => {
    const workspaces = workspaceStore.workspaces();
    const selectedWorkspaceId = workspaceStore.selectedWorkspaceId().trim();
    const connectingWorkspaceId = workspaceStore.connectingWorkspaceId()?.trim() ?? "";
    const sessionsById = sidebarSessionsByWorkspaceId();
    const statusById = sidebarSessionStatusByWorkspaceId();
    const errorById = sidebarSessionErrorByWorkspaceId();
    const dedupedWorkspaces: typeof workspaces = [];
    const dedupeKeyToIndex = new Map<string, number>();
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const hostKey =
        normalizeOpenworkServerUrl(workspace.openworkHostUrl?.trim() ?? "") ??
        normalizeOpenworkServerUrl(workspace.baseUrl?.trim() ?? "") ??
        "";
      const workspaceIdKey =
        workspace.openworkWorkspaceId?.trim() ||
        parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
        parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        "";
      const directoryKey = normalizeDirectoryPath(workspace.directory?.trim() ?? workspace.path?.trim() ?? "");
      const identityKey = workspaceIdKey ? `id:${workspaceIdKey}` : (directoryKey ? `dir:${directoryKey}` : "");
      if (!hostKey || !identityKey) {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const dedupeKey = `${workspace.remoteType ?? ""}|${hostKey}|${identityKey}`;
      const existingIndex = dedupeKeyToIndex.get(dedupeKey);
      if (existingIndex === undefined) {
        dedupeKeyToIndex.set(dedupeKey, dedupedWorkspaces.length);
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const existingWorkspace = dedupedWorkspaces[existingIndex];
      const existingIsPriority =
        existingWorkspace.id === selectedWorkspaceId || existingWorkspace.id === connectingWorkspaceId;
      const currentIsPriority =
        workspace.id === selectedWorkspaceId || workspace.id === connectingWorkspaceId;
      if (currentIsPriority && !existingIsPriority) {
        dedupedWorkspaces[existingIndex] = workspace;
      }
    }
    return dedupedWorkspaces.map((workspace) => {
      const groupSessions = sessionsById[workspace.id] ?? [];
      if (developerMode()) {
        console.log("[sidebar-groups] workspace group", {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceType: workspace.workspaceType,
          workspacePath: workspace.path,
          workspaceDirectory: workspace.directory,
          sessionCount: groupSessions.length,
          sessions: groupSessions.map((session) => ({
            id: session.id,
            title: session.title,
            directory: session.directory,
            parentID: session.parentID,
          })),
        });
      }
      return {
        workspace,
        sessions: groupSessions,
        status: statusById[workspace.id] ?? "idle",
        error: errorById[workspace.id] ?? null,
      };
    });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.selectedWorkspaceId();
    const sessionId = selectedSessionId();
    if (!workspaceId || !sessionId) return;
    const map = readSessionByWorkspace();
    if (map[workspaceId] === sessionId) return;
    map[workspaceId] = sessionId;
    writeSessionByWorkspace(map);
  });

  createEffect(() => {
    // Only auto-select on bare /session. If the URL already includes /session/:id,
    // let the route-driven selector own the fetch to avoid duplicate selection runs.
    if (currentView() !== "session") return;
    const normalizedPath = location.pathname.toLowerCase().replace(/\/+$/, "");
    if (normalizedPath !== "/session") return;
    if (!client()) return;
    if (!sessionsLoaded()) return;
    if (creatingSession()) return;
    if (selectedSessionId()) return;

    // Keep /session as a draft-ready empty state until the user picks a session
    // or sends a prompt. Avoid auto-selecting prior sessions on app launch.
    return;
  });

  createEffect(() => {
    const connectedWorkspaceId = workspaceStore.connectedWorkspaceId()?.trim() ?? "";
    const connectedWorkspace = workspaceStore.workspaces().find((workspace) => workspace.id === connectedWorkspaceId)
      ?? null;
    const client = openworkServerClient();

    if (!client || openworkServerStatus() !== "connected") {
      setRuntimeWorkspaceId(null);
      return;
    }

    if (!connectedWorkspace) {
      setRuntimeWorkspaceId(null);
      return;
    }

    if (connectedWorkspace.workspaceType === "remote" && connectedWorkspace.remoteType === "openwork") {
      const inferredWorkspaceId =
        parseOpenworkWorkspaceIdFromUrl(connectedWorkspace.openworkHostUrl ?? "") ??
        parseOpenworkWorkspaceIdFromUrl(connectedWorkspace.baseUrl ?? "") ??
        envOpenworkWorkspaceId;
      const storedId = connectedWorkspace.openworkWorkspaceId?.trim() || inferredWorkspaceId || null;
      if (storedId) {
        setRuntimeWorkspaceId(storedId);
        return;
      }

      let cancelled = false;
      const resolveWorkspace = async () => {
        try {
          const response = await client.listWorkspaces();
          if (cancelled) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const directoryHint = normalizeDirectoryPath(
            connectedWorkspace.directory?.trim() ?? connectedWorkspace.path?.trim() ?? "",
          );
          const match = directoryHint
            ? items.find((entry) => {
                const entryPath = normalizeDirectoryPath((entry.opencode?.directory ?? entry.directory ?? entry.path ?? "").trim());
                return Boolean(entryPath && entryPath === directoryHint);
              })
            : (response.activeId ? items.find((entry) => entry.id === response.activeId) : null) ?? items[0];
          setRuntimeWorkspaceId(match?.id ?? response.activeId ?? null);
        } catch {
          if (!cancelled) setRuntimeWorkspaceId(null);
        }
      };

      void resolveWorkspace();
      onCleanup(() => {
        cancelled = true;
      });
      return;
    }

    if (connectedWorkspace.workspaceType === "local") {
      let cancelled = false;
      const resolveWorkspace = async () => {
        try {
          const response = await client.listWorkspaces();
          if (cancelled) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId ? items.find((entry) => entry.id === response.activeId) : null;
          const pathMatch = items.find(
            (entry) => normalizeDirectoryPath(entry.path) === normalizeDirectoryPath(connectedWorkspace.path),
          );
          setRuntimeWorkspaceId(activeMatch?.id ?? pathMatch?.id ?? response.activeId ?? null);
        } catch {
          if (!cancelled) setRuntimeWorkspaceId(null);
        }
      };

      void resolveWorkspace();
      onCleanup(() => {
        cancelled = true;
      });
      return;
    }

    setRuntimeWorkspaceId(null);
  });

  const resolveSharedBundleWorkerTarget = () => {
    const pref = startupPreference();
    const hostInfo = openworkServerHostInfo();
    const settings = openworkServerSettings();

    const localHostUrl = normalizeOpenworkServerUrl(hostInfo?.baseUrl ?? "") ?? "";
    const localToken = hostInfo?.clientToken?.trim() ?? "";
    const serverHostUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
    const serverToken = settings.token?.trim() ?? "";

    if (pref === "server") {
      return {
        hostUrl: serverHostUrl || localHostUrl,
        token: serverToken || localToken,
      };
    }

    if (pref === "local") {
      return {
        hostUrl: localHostUrl || serverHostUrl,
        token: localToken || serverToken,
      };
    }

    if (localHostUrl) {
      return {
        hostUrl: localHostUrl,
        token: localToken || serverToken,
      };
    }

    return {
      hostUrl: serverHostUrl,
      token: serverToken || localToken,
    };
  };

  const isSharedBundleImportWorkspace = (workspace: WorkspaceDisplay | WorkspaceInfo | null) => {
    if (!workspace?.id?.trim()) return false;
    if (workspace.workspaceType === "local") {
      return Boolean(workspace.path?.trim());
    }
    return Boolean(
      workspace.remoteType === "openwork" ||
        workspace.openworkHostUrl?.trim() ||
        workspace.openworkWorkspaceId?.trim()
    );
  };

  const resolveSharedBundleImportTargetForWorkspace = (
    workspace: WorkspaceDisplay | WorkspaceInfo | null,
  ): SharedBundleImportTarget | undefined => {
    if (!workspace) return undefined;
    if (workspace.workspaceType === "local") {
      const localRoot = workspace.path?.trim() ?? "";
      return localRoot ? { localRoot } : undefined;
    }

    const workspaceId =
      workspace.openworkWorkspaceId?.trim() ||
      parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
      parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
      null;
    const directoryHint = workspace.directory?.trim() || workspace.path?.trim() || null;
    if (workspaceId || directoryHint) {
      return {
        workspaceId,
        directoryHint,
      };
    }
    return undefined;
  };

  const findSharedBundleImportWorkspaceId = (
    items: Array<{ id: string; path?: string | null; directory?: string | null; opencode?: { directory?: string | null } }>,
    target?: SharedBundleImportTarget,
  ) => {
    const explicitId = target?.workspaceId?.trim() ?? "";
    if (explicitId) {
      const match = items.find((entry) => entry.id === explicitId);
      if (match?.id) return match.id;
    }

    const localRoot = normalizeDirectoryPath(target?.localRoot?.trim() ?? "");
    if (localRoot) {
      const match = items.find((entry) => normalizeDirectoryPath(entry.path ?? "") === localRoot);
      if (match?.id) return match.id;
    }

    const directoryHint = normalizeDirectoryPath(target?.directoryHint?.trim() ?? "");
    if (directoryHint) {
      const match = items.find((entry) => {
        const entryPath = normalizeDirectoryPath((entry.opencode?.directory ?? entry.directory ?? entry.path ?? "").trim());
        return Boolean(entryPath && entryPath === directoryHint);
      });
      if (match?.id) return match.id;
    }

    return null;
  };

  const resolveActiveSharedBundleImportTarget = (): SharedBundleImportTarget => {
    const active = workspaceStore.selectedWorkspaceDisplay();
    if (active.workspaceType === "local") {
      return { localRoot: workspaceStore.selectedWorkspaceRoot().trim() };
    }

    return {
      workspaceId:
        active.openworkWorkspaceId?.trim() ||
        parseOpenworkWorkspaceIdFromUrl(active.openworkHostUrl ?? "") ||
        parseOpenworkWorkspaceIdFromUrl(active.baseUrl ?? "") ||
        null,
      directoryHint: active.directory?.trim() || active.path?.trim() || null,
    };
  };

  const waitForSharedBundleImportTarget = async (timeoutMs = 20_000, target?: SharedBundleImportTarget) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const client = openworkServerClient();
      if (client && openworkServerStatus() === "connected") {
        if (target?.workspaceId?.trim() || target?.localRoot?.trim() || target?.directoryHint?.trim()) {
          try {
            const response = await client.listWorkspaces();
            const items = Array.isArray(response.items) ? response.items : [];
            const matchId = findSharedBundleImportWorkspaceId(items, target);
            if (matchId) {
              setRuntimeWorkspaceId(matchId);
              return { client, workspaceId: matchId };
            }
          } catch {
            // ignore and keep polling
          }
        } else {
          const workspaceId = runtimeWorkspaceId();
          if (workspaceId) {
            return { client, workspaceId };
          }
        }
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 200);
      });
    }
    throw new Error("OpenWork worker is not ready yet.");
  };

  const importSharedBundlePayload = async (bundle: SharedBundleV1, target?: SharedBundleImportTarget) => {
    const { client, workspaceId } = await waitForSharedBundleImportTarget(20_000, target);
    const { payload, importedSkillsCount } = buildImportPayloadFromBundle(bundle);
    await client.importWorkspace(workspaceId, payload);
    await refreshActiveWorkspaceServerConfig(workspaceId);
    await refreshSkills({ force: true });
    await refreshHubSkills({ force: true });
    if (importedSkillsCount > 0) {
      markReloadRequired("skills", {
        type: "skill",
        name: bundle.name?.trim() || undefined,
        action: "added",
      });
      console.log(`[openwork] imported ${importedSkillsCount} skills from share bundle`);
    }
  };

  const importSharedBundleIntoActiveWorker = async (
    request: SharedBundleDeepLink,
    target?: SharedBundleImportTarget,
    bundleOverride?: SharedBundleV1,
  ) => {
    try {
      const bundle = bundleOverride ?? (await fetchSharedBundle(request.bundleUrl, openworkServerClient()));
      await importSharedBundlePayload(bundle, target);
      setError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setError(addOpencodeCacheHint(message));
      return false;
    }
  };

  const createWorkerForSharedBundle = async (request: SharedBundleDeepLink, bundle: SharedBundleV1) => {
    const target = resolveSharedBundleWorkerTarget();
    const hostUrl = target.hostUrl.trim();
    const token = target.token.trim();
    if (!hostUrl || !token) {
      throw new Error("Share link detected. Configure an OpenWork worker host and token, then open the link again.");
    }

    const label = (request.label?.trim() || bundle.name?.trim() || "Shared setup").slice(0, 80);
    const ok = await workspaceStore.createRemoteWorkspaceFlow({
      openworkHostUrl: hostUrl,
      openworkToken: token,
      directory: null,
      displayName: label,
      manageBusy: false,
      closeModal: false,
    });

    if (!ok) {
      throw new Error("Failed to create a worker from this share link.");
    }
  };

  const startWorkspaceFromTemplate = async (folder: string | null) => {
    const request = sharedTemplateStartRequest();
    if (!request || sharedTemplateStartBusy()) return false;

    setSharedTemplateStartBusy(true);

    try {
      const ok = await workspaceStore.createWorkspaceFlow(request.defaultPreset, folder);
      if (!ok) return false;

      const imported = await importSharedBundleIntoActiveWorker(
        request.request,
        {
          localRoot: workspaceStore.selectedWorkspaceRoot().trim(),
        },
        request.bundle,
      );

      if (!imported) return false;

      setSharedTemplateStartRequest(null);
      setError(null);
      return true;
    } finally {
      setSharedTemplateStartBusy(false);
    }
  };

  const importSharedSkillIntoWorkspace = async (workspaceId: string) => {
    if (sharedSkillDestinationBusyId()) return;
    const destination = sharedSkillDestinationRequest();
    if (!destination) return;

    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!isSharedBundleImportWorkspace(workspace)) {
      setError("This worker cannot accept shared skills yet.");
      return;
    }

    setView("dashboard");
    setTab("scheduled");
    setError(null);
    setSharedSkillDestinationBusyId(workspaceId);

    try {
      const ok = await workspaceStore.activateWorkspace(workspaceId);
      if (!ok) return;

      const imported = await importSharedBundleIntoActiveWorker(
        destination.request,
        resolveSharedBundleImportTargetForWorkspace(workspace),
        destination.bundle,
      );
      if (!imported) return;

      showSharedSkillSuccessToast({
        title: "Skill added",
        description: `Added '${destination.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForToasts(workspace)}.`,
      });
      setSharedSkillDestinationRequest(null);
      setSharedBundleCreateWorkerRequest(null);
      setSharedBundleNoticeShown(false);
    } finally {
      setSharedSkillDestinationBusyId(null);
    }
  };

  const processSharedBundleInvite = async (request: SharedBundleDeepLink) => {
    const bundle = await fetchSharedBundle(request.bundleUrl, openworkServerClient());

    if (bundle.type === "skill") {
      setView("dashboard");
      setTab("scheduled");
      setError(null);
      setSharedSkillDestinationRequest({ request, bundle });
      return { mode: "choice" as const, bundle };
    }

    if (bundle.type === "skills-set") {
      setView("dashboard");
      setTab("skills");
      setError(null);
      setSharedBundleImportChoice({ request, bundle });
      return { mode: "choice" as const, bundle };
    }

    if (bundle.type === "workspace-profile" && request.intent === "new_worker" && isTauriRuntime()) {
      setView("dashboard");
      setTab("scheduled");
      setError(null);
      setSharedBundleCreateWorkerRequest(null);
      setSharedBundleImportChoice(null);
      setSharedTemplateStartRequest({
        request,
        bundle,
        defaultPreset: defaultPresetFromTemplateBundle(bundle),
      });
      return { mode: "start_with_template_modal" as const, bundle };
    }

    if (request.intent === "import_current") {
      const client = openworkServerClient();
      const connected = openworkServerStatus() === "connected";
      const target = resolveActiveSharedBundleImportTarget();
      const hasTargetHint = Boolean(target.workspaceId?.trim() || target.localRoot?.trim() || target.directoryHint?.trim());
      if (!client || !connected || !hasTargetHint) {
        if (!sharedBundleNoticeShown()) {
          setSharedBundleNoticeShown(true);
          setError("Share link detected. Connect to a writable OpenWork worker to import this bundle.");
        }
        return { mode: "blocked_import_current" as const, bundle };
      }
    } else {
      const target = resolveSharedBundleWorkerTarget();
      if (!target.hostUrl.trim() || !target.token.trim()) {
        if (!sharedBundleNoticeShown()) {
          setSharedBundleNoticeShown(true);
          setError("Share link detected. Configure an OpenWork host and token to create a new worker.");
        }
        return { mode: "blocked_new_worker" as const, bundle };
      }
    }

    if (request.intent === "new_worker") {
      await createWorkerForSharedBundle(request, bundle);
    }

    await importSharedBundlePayload(bundle, resolveActiveSharedBundleImportTarget());
    setError(null);
    return { mode: "imported" as const, bundle };
  };

  createEffect(() => {
    const request = pendingSharedBundleInvite();
    if (!request || booting()) {
      return;
    }

    if (untrack(sharedBundleImportBusy)) {
      return;
    }

    let cancelled = false;
    setSharedBundleImportBusy(true);

    void (async () => {
      try {
        await processSharedBundleInvite(request);
        if (cancelled) return;
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : safeStringify(error);
          setError(addOpencodeCacheHint(message));
        }
      } finally {
        if (!cancelled) {
          const nextPendingInvite = pendingSharedBundleInvite();
          const shouldClearPendingInvite = nextPendingInvite === request;
          setSharedBundleImportBusy(false);
          if (shouldClearPendingInvite) {
            setPendingSharedBundleInvite(null);
            setSharedBundleNoticeShown(false);
          } else if (nextPendingInvite) {
            setPendingSharedBundleInvite({ ...nextPendingInvite });
          }
        }
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!developerMode()) {
      setDevtoolsWorkspaceId(null);
      return;
    }
    if (!documentVisible()) return;

    const client = devtoolsOpenworkClient();
    if (!client) {
      setDevtoolsWorkspaceId(null);
      return;
    }
    let active = true;

    const run = async () => {
      try {
        const response = await client.listWorkspaces();
        if (!active) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const activeMatch = response.activeId ? items.find((item) => item.id === response.activeId) : null;
        setDevtoolsWorkspaceId(activeMatch?.id ?? items[0]?.id ?? null);
      } catch {
        if (active) setDevtoolsWorkspaceId(null);
      }
    };

    run();
    const interval = window.setInterval(run, 20_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!developerMode()) {
      setOpenworkAuditEntries([]);
      setOpenworkAuditStatus("idle");
      setOpenworkAuditError(null);
      return;
    }
    if (!documentVisible()) return;

    const client = devtoolsOpenworkClient();
    const workspaceId = devtoolsWorkspaceId();
    if (!client || !workspaceId) {
      setOpenworkAuditEntries([]);
      setOpenworkAuditStatus("idle");
      setOpenworkAuditError(null);
      return;
    }

    let active = true;
    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      setOpenworkAuditStatus("loading");
      setOpenworkAuditError(null);
      try {
        const result = await client.listAudit(workspaceId, 50);
        if (!active) return;
        setOpenworkAuditEntries(Array.isArray(result.items) ? result.items : []);
        setOpenworkAuditStatus("idle");
      } catch (error) {
        if (!active) return;
        setOpenworkAuditEntries([]);
        setOpenworkAuditStatus("error");
        setOpenworkAuditError(error instanceof Error ? error.message : "Failed to load audit log.");
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 15_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    const active = workspaceStore.selectedWorkspaceDisplay();
    if (active.workspaceType !== "remote" || active.remoteType !== "openwork") {
      return;
    }
    const hostUrl = active.openworkHostUrl?.trim() ?? "";
    if (!hostUrl) return;
    const token = active.openworkToken?.trim() ?? "";
    const settings = openworkServerSettings();
    if (settings.urlOverride?.trim() === hostUrl && (!token || settings.token?.trim() === token)) {
      return;
    }
    updateOpenworkServerSettings({
      ...settings,
      urlOverride: hostUrl,
      token: token || settings.token,
    });
  });

  const openworkServerReady = createMemo(() => openworkServerStatus() === "connected");
  const openworkServerWorkspaceReady = createMemo(() => Boolean(runtimeWorkspaceId()));
  const resolvedOpenworkCapabilities = createMemo(() => openworkServerCapabilities());
  const openworkServerCanWriteSkills = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.skills?.write ?? false),
  );
  const openworkServerCanWritePlugins = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.plugins?.write ?? false),
  );
  const openworkServerCanReadConfig = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.config?.read ?? false),
  );
  const openworkServerCanWriteConfig = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.config?.write ?? false),
  );
  const devtoolsCapabilities = createMemo(() => openworkServerCapabilities());

  function updateOpenworkServerSettings(next: OpenworkServerSettings) {
    const stored = writeOpenworkServerSettings(next);
    setOpenworkServerSettings(stored);
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (shareRemoteAccessBusy()) return;
    const previous = openworkServerSettings();
    const next: OpenworkServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    setShareRemoteAccessBusy(true);
    setShareRemoteAccessError(null);
    updateOpenworkServerSettings(next);

    try {
      if (isTauriRuntime() && workspaceStore.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await restartLocalServer();
        if (!restarted) {
          throw new Error("Failed to restart the local worker with the updated sharing setting.");
        }
        await reconnectOpenworkServer();
      }
    } catch (error) {
      updateOpenworkServerSettings(previous);
      setShareRemoteAccessError(
        error instanceof Error
          ? error.message
          : "Failed to update remote access.",
      );
      return;
    } finally {
      setShareRemoteAccessBusy(false);
    }
  };

  const resetOpenworkServerSettings = () => {
    clearOpenworkServerSettings();
    setOpenworkServerSettings({});
  };

  const [editRemoteWorkspaceOpen, setEditRemoteWorkspaceOpen] = createSignal(false);
  const [editRemoteWorkspaceId, setEditRemoteWorkspaceId] = createSignal<string | null>(null);
  const [editRemoteWorkspaceError, setEditRemoteWorkspaceError] = createSignal<string | null>(null);
  const [deepLinkRemoteWorkspaceDefaults, setDeepLinkRemoteWorkspaceDefaults] = createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingRemoteConnectDeepLink, setPendingRemoteConnectDeepLink] = createSignal<RemoteWorkspaceDefaults | null>(null);
  const [autoConnectRemoteWorkspaceOverlayOpen, setAutoConnectRemoteWorkspaceOverlayOpen] = createSignal(false);
  const [pendingDenAuthDeepLink, setPendingDenAuthDeepLink] = createSignal<DenAuthDeepLink | null>(null);
  const [processingDenAuthDeepLink, setProcessingDenAuthDeepLink] = createSignal(false);
  const [pendingSharedBundleInvite, setPendingSharedBundleInvite] = createSignal<SharedBundleDeepLink | null>(null);
  const [sharedTemplateStartRequest, setSharedTemplateStartRequest] =
    createSignal<SharedTemplateStartRequest | null>(null);
  const [sharedTemplateStartBusy, setSharedTemplateStartBusy] = createSignal(false);
  const [sharedBundleCreateWorkerRequest, setSharedBundleCreateWorkerRequest] =
    createSignal<SharedBundleCreateWorkerRequest | null>(null);
  const [sharedSkillDestinationRequest, setSharedSkillDestinationRequest] =
    createSignal<SharedSkillDestinationRequest | null>(null);
  const [sharedSkillDestinationBusyId, setSharedSkillDestinationBusyId] = createSignal<string | null>(null);
  const [sharedBundleImportChoice, setSharedBundleImportChoice] = createSignal<SharedBundleImportChoice | null>(null);
  const [sharedBundleImportBusy, setSharedBundleImportBusy] = createSignal(false);
  const [sharedBundleImportError, setSharedBundleImportError] = createSignal<string | null>(null);
  const [sharedBundleNoticeShown, setSharedBundleNoticeShown] = createSignal(false);
  const [sharedSkillSuccessToast, setSharedSkillSuccessToast] = createSignal<SharedSkillSuccessToast | null>(null);
  const recentClaimedDeepLinks = new Map<string, number>();
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = createSignal(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = createSignal<string | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = createSignal("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = createSignal(false);
  let sharedSkillSuccessToastTimer: number | null = null;

  const clearSharedSkillSuccessToast = () => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
      sharedSkillSuccessToastTimer = null;
    }
    setSharedSkillSuccessToast(null);
  };

  const showSharedSkillSuccessToast = (toast: SharedSkillSuccessToast) => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
    }
    setSharedSkillSuccessToast(toast);
    sharedSkillSuccessToastTimer = window.setTimeout(() => {
      sharedSkillSuccessToastTimer = null;
      setSharedSkillSuccessToast(null);
    }, 4200);
  };

  onCleanup(() => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
    }
  });

  const createWorkspaceDefaultPreset = createMemo<WorkspacePreset>(() =>
    sharedBundleCreateWorkerRequest()?.defaultPreset ?? "starter"
  );
  const sharedTemplateStartItems = createMemo(() => {
    const request = sharedTemplateStartRequest();
    return request ? describeSharedBundleImport(request.bundle).items : [];
  });

  const sharedSkillDestinationWorkspaces = createMemo(() => {
    const activeId = workspaceStore.selectedWorkspaceId();
    return workspaceStore
      .workspaces()
      .filter((workspace) => isSharedBundleImportWorkspace(workspace))
      .slice()
      .sort((a, b) => {
        if (a.id === activeId && b.id !== activeId) return -1;
        if (b.id === activeId && a.id !== activeId) return 1;
        const aLabel =
          a.displayName?.trim() ||
          a.openworkWorkspaceName?.trim() ||
          a.name?.trim() ||
          a.directory?.trim() ||
          a.path?.trim() ||
          a.baseUrl?.trim() ||
          "";
        const bLabel =
          b.displayName?.trim() ||
          b.openworkWorkspaceName?.trim() ||
          b.name?.trim() ||
          b.directory?.trim() ||
          b.path?.trim() ||
          b.baseUrl?.trim() ||
          "";
        return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
      });
  });

  const describeWorkspaceForToasts = (workspace: WorkspaceDisplay | WorkspaceInfo | null) =>
    workspace?.displayName?.trim() ||
    workspace?.openworkWorkspaceName?.trim() ||
    workspace?.name?.trim() ||
    workspace?.directory?.trim() ||
    workspace?.path?.trim() ||
    workspace?.baseUrl?.trim() ||
    "the selected worker";

  const queueRemoteConnectDeepLink = (rawUrl: string): boolean => {
    const parsed = parseRemoteConnectDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingRemoteConnectDeepLink(parsed);
    return true;
  };

  const completeRemoteConnectDeepLink = async (pending: RemoteWorkspaceDefaults) => {
    const input = {
      openworkHostUrl: pending.openworkHostUrl,
      openworkToken: pending.openworkToken,
      directory: pending.directory,
      displayName: pending.displayName,
    };

    if (!pending.autoConnect) {
      setDeepLinkRemoteWorkspaceDefaults(input);
      workspaceStore.setCreateRemoteWorkspaceOpen(true);
      return;
    }

    setError(null);
    setAutoConnectRemoteWorkspaceOverlayOpen(true);
    try {
      const ok = await workspaceStore.createRemoteWorkspaceFlow(input);
      if (ok) {
        setDeepLinkRemoteWorkspaceDefaults(null);
        return;
      }

      setDeepLinkRemoteWorkspaceDefaults(input);
      workspaceStore.setCreateRemoteWorkspaceOpen(true);
    } finally {
      setAutoConnectRemoteWorkspaceOverlayOpen(false);
    }
  };

  const queueDenAuthDeepLink = (rawUrl: string): boolean => {
    const parsed = parseDenAuthDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingDenAuthDeepLink(parsed);
    return true;
  };

  const queueSharedBundleDeepLink = (rawUrl: string): boolean => {
    const parsed = parseSharedBundleDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingSharedBundleInvite(parsed);
    setSharedSkillDestinationRequest(null);
    setSharedSkillDestinationBusyId(null);
    setSharedBundleImportChoice(null);
    setSharedBundleCreateWorkerRequest(null);
    setSharedBundleImportError(null);
    setSharedBundleNoticeShown(false);
    return true;
  };

  const stripHandledBrowserDeepLink = (rawUrl: string) => {
    if (typeof window === "undefined" || isTauriRuntime()) {
      return;
    }

    if (window.location.href !== rawUrl) {
      return;
    }

    const remoteStripped = stripRemoteConnectQuery(rawUrl) ?? rawUrl;
    const bundleStripped = stripSharedBundleQuery(remoteStripped) ?? remoteStripped;
    if (bundleStripped !== rawUrl) {
      window.history.replaceState({}, "", bundleStripped);
    }
  };

  const consumeDeepLinks = (urls: readonly string[] | null | undefined) => {
    if (!Array.isArray(urls)) {
      return;
    }

    const normalized = urls.map((url) => url.trim()).filter(Boolean);
    if (normalized.length === 0) {
      return;
    }

    const now = Date.now();
    for (const [url, seenAt] of recentClaimedDeepLinks) {
      if (now - seenAt > 1500) {
        recentClaimedDeepLinks.delete(url);
      }
    }

    for (const url of normalized) {
      const seenAt = recentClaimedDeepLinks.get(url) ?? 0;
      if (now - seenAt < 1500) {
        continue;
      }

      const matchedDen = queueDenAuthDeepLink(url);
      const matchedRemote = !matchedDen && queueRemoteConnectDeepLink(url);
      const matchedBundle = !matchedDen && !matchedRemote && queueSharedBundleDeepLink(url);
      const claimed = matchedDen || matchedRemote || matchedBundle;
      if (!claimed) {
        continue;
      }

      recentClaimedDeepLinks.set(url, now);
      stripHandledBrowserDeepLink(url);
      break;
    }
  };

  const openDebugDeepLink = async (rawUrl: string): Promise<{ ok: boolean; message: string }> => {
    const parsed = parseDebugDeepLinkInput(rawUrl);
    if (!parsed) {
      return { ok: false, message: "That link is not a recognized OpenWork deep link or share URL." };
    }

    setError(null);
    setView("dashboard");
    if (parsed.kind === "bundle") {
      setPendingSharedBundleInvite(null);
      setSharedBundleNoticeShown(false);
      setSharedSkillDestinationRequest(null);
      setSharedSkillDestinationBusyId(null);
      setSharedBundleImportError(null);
      setSharedBundleImportChoice(null);
      setSharedTemplateStartRequest(null);
      setSharedBundleCreateWorkerRequest(null);

      try {
        setSharedBundleImportBusy(true);
        const result = await processSharedBundleInvite(parsed.link);
        switch (result.mode) {
          case "choice":
            return { ok: true, message: "Opened the share import chooser." };
          case "start_with_template_modal":
            return { ok: true, message: "Opened the template start flow." };
          case "blocked_import_current":
          case "blocked_new_worker":
            return { ok: false, message: error() || "The share link needs more worker setup before it can open." };
          case "imported":
            return { ok: true, message: "Imported the shared bundle into the current worker." };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : safeStringify(error);
        const friendly = addOpencodeCacheHint(message);
        setError(friendly);
        return { ok: false, message: friendly };
      } finally {
        setSharedBundleImportBusy(false);
      }
    }
    if (parsed.kind === "auth") {
      setPendingDenAuthDeepLink(parsed.link);
      return { ok: true, message: "Queued the Cloud auth deep link for OpenWork." };
    }

    setPendingRemoteConnectDeepLink(parsed.kind === "remote" ? parsed.link : null);
    setTab("scheduled");
    return { ok: true, message: "Queued remote worker link. OpenWork should move into the connect flow." };
  };

  const closeSharedBundleImportChoice = () => {
    if (sharedBundleImportBusy()) return;
    setSharedBundleImportChoice(null);
    setSharedBundleImportError(null);
  };

  const openCloudTemplate = async (input: {
    templateId: string;
    name: string;
    templateData: unknown;
    organizationName?: string | null;
  }) => {
    const bundle = parseSharedBundle(input.templateData);
    setError(null);
    setView("dashboard");
    setTab("settings");
    setSharedSkillDestinationBusyId(null);
    setSharedBundleImportError(null);
    setSharedTemplateStartRequest(null);
    setSharedBundleCreateWorkerRequest(null);

    if (bundle.type === "skill") {
      setSharedBundleImportChoice(null);
      setSharedSkillDestinationRequest({
        request: {
          bundleUrl: "",
          intent: "import_current",
          source: "cloud-template",
          label: input.name,
        },
        bundle,
      });
      return;
    }

    setSharedSkillDestinationRequest(null);
    setSharedBundleImportChoice({
      request: {
        bundleUrl: "",
        intent: "import_current",
        source: "cloud-template",
        label: input.name,
      },
      bundle,
    });
  };

  const sharedBundleImportCopy = createMemo(() => {
    const choice = sharedBundleImportChoice();
    if (!choice) return null;
    return describeSharedBundleImport(choice.bundle);
  });

  const sharedBundleWorkerOptions = createMemo(() => {
    const selectedWorkspaceId = workspaceStore.selectedWorkspaceId().trim();
    const items = workspaceStore.workspaces().map((workspace) => {
        let disabledReason: string | null = null;
        if (!resolveSharedBundleImportTargetForWorkspace(workspace)) {
          disabledReason =
            workspace.workspaceType === "remote" && workspace.remoteType !== "openwork"
            ? "Only OpenWork-connected workers support direct shared bundle imports."
            : "This worker is missing the info OpenWork needs to import the bundle.";
        }

      const label =
        workspace.displayName?.trim() ||
        workspace.openworkWorkspaceName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        "Worker";
      const badge =
        workspace.workspaceType === "remote"
          ? workspace.sandboxBackend === "docker" ||
            Boolean(workspace.sandboxRunId?.trim()) ||
            Boolean(workspace.sandboxContainerName?.trim())
            ? "Sandbox"
            : "Remote"
          : "Local";
      const detail =
        workspace.workspaceType === "local"
          ? workspace.path?.trim() || "Local worker"
          : workspace.directory?.trim() || workspace.baseUrl?.trim() || workspace.openworkHostUrl?.trim() || "Remote worker";

      return {
        id: workspace.id,
        label,
        detail,
        badge,
        current: workspace.id === selectedWorkspaceId,
        disabledReason,
      };
    });

    return items.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  });

  const openSharedBundleCreateWorkerFlow = async () => {
    const choice = sharedBundleImportChoice();
    if (!choice || sharedBundleImportBusy()) return;

    setSharedBundleImportError(null);
    setError(null);

    if (isTauriRuntime()) {
      setView("dashboard");
      setTab("scheduled");
      setSharedBundleCreateWorkerRequest({
        request: choice.request,
        bundle: choice.bundle,
        defaultPreset:
          choice.bundle.type === "workspace-profile"
            ? defaultPresetFromTemplateBundle(choice.bundle)
            : "starter",
      });
      setSharedBundleImportChoice(null);
      workspaceStore.setCreateWorkspaceOpen(true);
      return;
    }

    setSharedBundleImportBusy(true);
    try {
      await createWorkerForSharedBundle(choice.request, choice.bundle);
      await importSharedBundlePayload(choice.bundle, resolveActiveSharedBundleImportTarget());
      setSharedBundleImportChoice(null);
      setError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      setSharedBundleImportError(friendly);
      setError(friendly);
    } finally {
      setSharedBundleImportBusy(false);
    }
  };

  const importSharedBundleIntoExistingWorkspace = async (workspaceId: string) => {
    const choice = sharedBundleImportChoice();
    if (!choice || sharedBundleImportBusy()) return;

    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace) {
      setSharedBundleImportError("The selected worker is no longer available.");
      return;
    }

    const target = resolveSharedBundleImportTargetForWorkspace(workspace);
    if (!target) {
      setSharedBundleImportError("This worker cannot accept shared bundle imports yet.");
      return;
    }

    setSharedBundleImportBusy(true);
    setSharedBundleImportError(null);
    setError(null);

    try {
      setView("dashboard");
      setTab(choice.bundle.type === "workspace-profile" ? "scheduled" : "skills");
      const ok = await workspaceStore.activateWorkspace(workspace.id);
      if (!ok) {
        throw new Error(error() || `Failed to switch to ${workspace.displayName?.trim() || workspace.name || "the selected worker"}.`);
      }
      await importSharedBundlePayload(choice.bundle, target);
      setSharedBundleImportChoice(null);
      setError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      setSharedBundleImportError(friendly);
      setError(friendly);
    } finally {
      setSharedBundleImportBusy(false);
    }
  };

  createEffect(() => {
    const pending = pendingDenAuthDeepLink();
    if (!pending || booting() || processingDenAuthDeepLink()) {
      return;
    }

    setProcessingDenAuthDeepLink(true);
    setPendingDenAuthDeepLink(null);
    setView("dashboard");
    setSettingsTab("den");
    goToDashboard("settings");

    void createDenClient({ baseUrl: pending.denBaseUrl })
      .exchangeDesktopHandoff(pending.grant)
      .then((result) => {
        if (!result.token) {
          throw new Error("Desktop sign-in completed, but OpenWork Cloud did not return a session token.");
        }

        writeDenSettings({
          baseUrl: pending.denBaseUrl,
          authToken: result.token,
          activeOrgId: null,
          activeOrgSlug: null,
          activeOrgName: null,
        });

        window.dispatchEvent(
          new CustomEvent("openwork-den-session-updated", {
            detail: {
              status: "success",
              email: result.user?.email ?? null,
            },
          }),
        );
      })
      .catch((error) => {
        window.dispatchEvent(
          new CustomEvent("openwork-den-session-updated", {
            detail: {
              status: "error",
              message: error instanceof Error ? error.message : "Failed to complete OpenWork Cloud sign-in.",
            },
          }),
        );
      })
      .finally(() => {
        setProcessingDenAuthDeepLink(false);
      });
  });

  createEffect(() => {
    const pending = pendingRemoteConnectDeepLink();
    if (!pending || booting()) {
      return;
    }

    if (pending.autoConnect) {
      setView("session");
    } else {
      setView("dashboard");
      setTab("scheduled");
    }
    setPendingRemoteConnectDeepLink(null);
    void completeRemoteConnectDeepLink(pending);
  });

  createEffect(() => {
    if (workspaceStore.createRemoteWorkspaceOpen()) {
      return;
    }
    if (!deepLinkRemoteWorkspaceDefaults()) {
      return;
    }
    setDeepLinkRemoteWorkspaceDefaults(null);
  });

  const editRemoteWorkspaceDefaults = createMemo(() => {
    const workspaceId = editRemoteWorkspaceId();
    if (!workspaceId) return null;
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "remote") return null;
    return {
      openworkHostUrl: workspace.openworkHostUrl ?? workspace.baseUrl ?? "",
      openworkToken: workspace.openworkToken ?? openworkServerSettings().token ?? "",
      directory: workspace.directory ?? "",
      displayName: workspace.displayName ?? "",
    };
  });

  const openRenameWorkspace = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceName(
      workspace.displayName?.trim() ||
        workspace.openworkWorkspaceName?.trim() ||
        workspace.name?.trim() ||
        ""
    );
    setRenameWorkspaceOpen(true);
  };

  const closeRenameWorkspace = () => {
    if (renameWorkspaceBusy()) return;
    setRenameWorkspaceOpen(false);
    setRenameWorkspaceId(null);
    setRenameWorkspaceName("");
  };

  const saveRenameWorkspace = async () => {
    const workspaceId = renameWorkspaceId();
    if (!workspaceId) return;
    const nextName = renameWorkspaceName().trim();
    if (!nextName) return;
    if (renameWorkspaceBusy()) return;

    setRenameWorkspaceBusy(true);
    setError(null);
    try {
      const ok = await workspaceStore.updateWorkspaceDisplayName(workspaceId, nextName);
      if (!ok) return;
      setRenameWorkspaceOpen(false);
      setRenameWorkspaceId(null);
      setRenameWorkspaceName("");
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
    } finally {
      setRenameWorkspaceBusy(false);
    }
  };

  const testOpenworkServerConnection = async (next: OpenworkServerSettings) => {
    const derived = normalizeOpenworkServerUrl(next.urlOverride ?? "");
    if (!derived) {
      setOpenworkServerStatus("disconnected");
      setOpenworkServerCapabilities(null);
      setOpenworkServerCheckedAt(Date.now());
      return false;
    }
    const result = await checkOpenworkServer(derived, next.token, openworkServerAuth().hostToken);
    setOpenworkServerStatus(result.status);
    setOpenworkServerCapabilities(result.capabilities);
    setOpenworkServerCheckedAt(Date.now());
    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isTauriRuntime()) {
      const active = workspaceStore.selectedWorkspaceDisplay();
      const shouldAttach = !client() || active.workspaceType !== "remote" || active.remoteType !== "openwork";
      if (shouldAttach) {
        await workspaceStore
          .createRemoteWorkspaceFlow({
            openworkHostUrl: derived,
            openworkToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectOpenworkServer = async () => {
    if (openworkReconnectBusy()) return false;
    setOpenworkReconnectBusy(true);
    try {
      let hostInfo = openworkServerHostInfo();
      if (isTauriRuntime()) {
        try {
          hostInfo = await openworkServerInfo();
          setOpenworkServerHostInfo(hostInfo);
        } catch {
          hostInfo = null;
          setOpenworkServerHostInfo(null);
        }
      }

      // Repair stale local token state by syncing settings token from the live host.
      if (hostInfo?.clientToken?.trim() && startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const settings = openworkServerSettings();
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateOpenworkServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = openworkServerBaseUrl().trim();
      const auth = openworkServerAuth();
      if (!url) {
        setOpenworkServerStatus("disconnected");
        setOpenworkServerCapabilities(null);
        setOpenworkServerCheckedAt(Date.now());
        return false;
      }

      const result = await checkOpenworkServer(url, auth.token, auth.hostToken);
      setOpenworkServerStatus(result.status);
      setOpenworkServerCapabilities(result.capabilities);
      setOpenworkServerCheckedAt(Date.now());
      return result.status === "connected" || result.status === "limited";
    } finally {
      setOpenworkReconnectBusy(false);
    }
  };

  async function ensureLocalOpenworkServerClient(): Promise<OpenworkServerClient | null> {
    let hostInfo = openworkServerHostInfo();
    if (hostInfo?.baseUrl?.trim() && hostInfo.clientToken?.trim()) {
      const existing = createOpenworkServerClient({
        baseUrl: hostInfo.baseUrl.trim(),
        token: hostInfo.clientToken.trim(),
        hostToken: hostInfo.hostToken?.trim() || undefined,
      });
      try {
        await existing.health();
        if (startupPreference() !== "server") {
          await reconnectOpenworkServer();
        }
        return existing;
      } catch {
        // restart below
      }
    }

    if (!isTauriRuntime()) {
      return null;
    }

    try {
      hostInfo = await openworkServerRestart({
        remoteAccessEnabled: openworkServerSettings().remoteAccessEnabled === true,
      });
      setOpenworkServerHostInfo(hostInfo);
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) {
      return null;
    }

    if (startupPreference() !== "server") {
      await reconnectOpenworkServer();
    }

    return createOpenworkServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const restartLocalServer = async () => {
    const activeWorkspace = workspaceStore.selectedWorkspaceDisplay();
    const activeLocalPath =
      activeWorkspace.workspaceType === "local" ? workspaceStore.selectedWorkspacePath().trim() : "";
    const runningProjectDir = workspaceStore.engine()?.projectDir?.trim() ?? "";
    const workspacePath = activeLocalPath || runningProjectDir;

    if (!workspacePath) {
      setError("Pick a local worker folder before restarting the local server.");
      return false;
    }

    return workspaceStore.startHost({ workspacePath, navigate: false });
  };

  const openWorkspaceConnectionSettings = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (workspace?.workspaceType === "remote" && workspace.remoteType === "openwork") {
      setEditRemoteWorkspaceId(workspace.id);
      setEditRemoteWorkspaceError(null);
      setEditRemoteWorkspaceOpen(true);
      return;
    }
    if (workspace?.workspaceType === "remote") {
      setEditRemoteWorkspaceId(workspace.id);
      setEditRemoteWorkspaceError(null);
      setEditRemoteWorkspaceOpen(true);
      return;
    }
    setTab("config");
    setView("dashboard");
  };

  const canReloadLocalEngine = () =>
    isTauriRuntime() && workspaceStore.selectedWorkspaceDisplay().workspaceType === "local";

  const canReloadWorkspace = createMemo(() => {
    if (canReloadLocalEngine()) return true;
    if (workspaceStore.selectedWorkspaceDisplay().workspaceType !== "remote") return false;
    return openworkServerStatus() === "connected" && Boolean(openworkServerClient() && runtimeWorkspaceId());
  });

  const reloadWorkspaceEngineFromUi = async () => {
    if (canReloadLocalEngine()) {
      return workspaceStore.reloadWorkspaceEngine();
    }

    if (workspaceStore.selectedWorkspaceDisplay().workspaceType !== "remote") {
      return false;
    }

    const client = openworkServerClient();
    const workspaceId = runtimeWorkspaceId();
    if (!client || !workspaceId || openworkServerStatus() !== "connected") {
      setError("Connect to this worker before applying runtime changes.");
      return false;
    }

    try {
      await client.reloadEngine(workspaceId);
      await workspaceStore.activateWorkspace(workspaceStore.selectedWorkspaceId());
      await refreshMcpServers();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply runtime changes.";
      setError(message);
      return false;
    }
  };

  const systemState = createSystemState({
    client,
    sessions,
    sessionStatusById,
    refreshPlugins,
    refreshSkills,
    refreshMcpServers,
    reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
    canReloadWorkspaceEngine: () => canReloadWorkspace(),
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
    notion: {
      status: notionStatus,
      setStatus: setNotionStatus,
      statusDetail: notionStatusDetail,
      setStatusDetail: setNotionStatusDetail,
      skillInstalled: notionSkillInstalled,
      setTryPromptVisible: setTryNotionPromptVisible,
    },
  });

  const {
    reloadPending,
    reloadCopy,
    reloadTrigger,
    reloadBusy,
    reloadError,
    reloadWorkspaceEngine,
    clearReloadRequired,
    cacheRepairBusy,
    cacheRepairResult,
    repairOpencodeCache,
    dockerCleanupBusy,
    dockerCleanupResult,
    cleanupOpenworkDockerContainers,
    updateAutoCheck,
    setUpdateAutoCheck,
    updateAutoDownload,
    setUpdateAutoDownload,
    updateStatus,
    setUpdateStatus,
    pendingUpdate,
    setPendingUpdate,
    updateEnv,
    setUpdateEnv,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
    resetModalOpen,
    setResetModalOpen,
    resetModalMode,
    setResetModalMode,
    resetModalText,
    setResetModalText,
    resetModalBusy,
    openResetModal,
    confirmReset,
    anyActiveRuns,
  } = systemState;

  markReloadRequiredHandler = systemState.markReloadRequired;

  const UPDATE_AUTO_CHECK_EVERY_MS = 12 * 60 * 60_000;
  const UPDATE_AUTO_CHECK_POLL_MS = 60_000;

  const resetAppConfigDefaults = async () => {
    try {
      if (typeof window !== "undefined") {
        try {
          const sessionOverridePrefix = `${SESSION_MODEL_PREF_KEY}.`;
          const keysToRemove: string[] = [];
          for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (!key) continue;
            if (key.startsWith(sessionOverridePrefix)) {
              keysToRemove.push(key);
            }
          }
          for (const key of keysToRemove) {
            window.localStorage.removeItem(key);
          }
        } catch {
          // ignore
        }
      }

      setThemeMode("system");
      setEngineSource(isTauriRuntime() ? "sidecar" : "path");
      setEngineCustomBinPath("");
      setEngineRuntime("openwork-orchestrator");
      setDefaultModel(DEFAULT_MODEL);
      setLegacyDefaultModel(DEFAULT_MODEL);
      setDefaultModelExplicit(false);
      setShowThinking(false);
      setHideTitlebar(false);
      setAutoCompactContext(false);
      setModelVariant(null);
      setUpdateAutoCheck(true);
      setUpdateAutoDownload(false);
      setUpdateStatus({ state: "idle", lastCheckedAt: null });
      setDeveloperMode(false);

      clearStartupPreference();
      setStartupPreference(null);
      setRememberStartupChoice(false);

      clearOpenworkServerSettings();
      setOpenworkServerSettings(readOpenworkServerSettings());

      setNotionStatus("disconnected");
      setNotionStatusDetail(null);
      setNotionError(null);
      setNotionSkillInstalled(false);
      setTryNotionPromptVisible(false);

      return { ok: true, message: "Reset app config defaults. Restart OpenWork if any stale settings remain." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset app config defaults.";
      return { ok: false, message };
    }
  };

  const getUpdateLastCheckedAt = (state: ReturnType<typeof updateStatus>) => {
    if (state.state === "checking") return null;
    return state.lastCheckedAt ?? null;
  };

  const shouldAutoCheckForUpdates = () => {
    const state = updateStatus();
    const lastCheckedAt = getUpdateLastCheckedAt(state);
    if (!lastCheckedAt) return true;
    return Date.now() - lastCheckedAt >= UPDATE_AUTO_CHECK_EVERY_MS;
  };

  const workspaceAutoReloadAvailable = createMemo(() =>
    false,
  );

  const workspaceAutoReloadEnabled = createMemo(() => {
    if (!workspaceAutoReloadAvailable()) return false;
    const cfg = workspaceStore.workspaceConfig();
    return Boolean(cfg?.reload?.auto);
  });

  const workspaceAutoReloadResumeEnabled = createMemo(() => {
    if (!workspaceAutoReloadAvailable()) return false;
    const cfg = workspaceStore.workspaceConfig();
    return Boolean(cfg?.reload?.resume);
  });

  const setWorkspaceAutoReloadEnabled = async (next: boolean) => {
    if (!workspaceAutoReloadAvailable()) return;
    const cfg = workspaceStore.workspaceConfig();
    const resume = Boolean(cfg?.reload?.resume);
    await workspaceStore.persistReloadSettings({ auto: next, resume: next ? resume : false });
  };

  const setWorkspaceAutoReloadResumeEnabled = async (next: boolean) => {
    if (!workspaceAutoReloadAvailable()) return;
    const cfg = workspaceStore.workspaceConfig();
    const auto = Boolean(cfg?.reload?.auto);
    await workspaceStore.persistReloadSettings({ auto, resume: auto ? next : false });
  };

  const reloadWorkspaceEngineAndResume = async () => {
    await reloadWorkspaceEngine();
  };

  const isActiveSessionStatus = (status: string | null | undefined) =>
    status === "running" || status === "retry";

  const reloadRequired = (...sources: ReloadTrigger["type"][]) => {
    if (!reloadPending()) return false;
    const triggerType = reloadTrigger()?.type;
    if (!triggerType) return false;
    if (!sources.length) return true;
    return sources.includes(triggerType);
  };

  const markOpencodeConfigReloadRequired = () => {
    markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
  };

  const activeReloadBlockingSessions = createMemo(() => {
    const statuses = sessionStatusById();
    return sessions()
      .filter((session) => isActiveSessionStatus(statuses[session.id]))
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || session.slug?.trim() || session.id,
      }));
  });

  const forceStopActiveSessionsAndReload = async () => {
    const activeSessions = activeReloadBlockingSessions();
    for (const session of activeSessions) {
      try {
        await abortSession(session.id);
      } catch {
        // ignore and continue stopping the rest before reload
      }
    }
    await reloadWorkspaceEngineAndResume();
  };

  onMount(() => {
    // OpenCode hot reload drives freshness now; OpenWork no longer listens for
    // legacy reload-required events.
  });

  const {
    engine,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    projectDir: workspaceProjectDir,
    newAuthorizedDir,
    refreshEngineDoctor,
    stopHost,
    setEngineInstallLogs,
  } = workspaceStore;

  // Scheduler helpers - must be defined after workspaceStore
  const resolveOpenworkScheduler = () => {
    const client = openworkServerClient();
    const workspaceId = runtimeWorkspaceId();
    if (openworkServerStatus() !== "connected" || !client || !workspaceId) return null;
    return { client, workspaceId };
  };

  const scheduledJobsSource = createMemo<"local" | "remote">(() => {
    return resolveOpenworkScheduler() ? "remote" : "local";
  });

  const scheduledJobsSourceReady = createMemo(() => {
    if (scheduledJobsSource() !== "remote") return true;
    const client = openworkServerClient();
    const workspaceId = runtimeWorkspaceId();
    return openworkServerStatus() === "connected" && Boolean(client && workspaceId);
  });

  const schedulerPluginInstalled = createMemo(() => isPluginInstalledByName("opencode-scheduler"));

  const scheduledJobsContextKey = createMemo(() => {
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    const root = normalizeDirectoryPath(workspaceStore.selectedWorkspaceRoot().trim());
    return `${scheduledJobsSource()}:${workspaceId}:${root}`;
  });

  const scheduledJobsPollingAvailable = createMemo(() => {
    if (scheduledJobsSource() === "remote") return scheduledJobsSourceReady();
    return isTauriRuntime() && !isWindowsPlatform() && schedulerPluginInstalled();
  });

  const refreshScheduledJobs = async (
    options?: { force?: boolean },
  ): Promise<"success" | "error" | "unavailable" | "skipped"> => {
    void options;
    if (scheduledJobsBusy()) return "skipped";

    const requestContextKey = scheduledJobsContextKey();

    if (scheduledJobsSource() === "remote") {
      const scheduler = resolveOpenworkScheduler();
      if (!scheduler) {
        if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
        const status =
          openworkServerStatus() === "disconnected"
            ? "OpenWork server unavailable. Connect to sync scheduled tasks."
            : openworkServerStatus() === "limited"
              ? "OpenWork server needs a token to load scheduled tasks."
              : "OpenWork server not ready.";
        setScheduledJobsStatus(status);
        return "unavailable";
      }

      setScheduledJobsBusy(true);
      setScheduledJobsStatus(null);

      try {
        const response = await scheduler.client.listScheduledJobs(scheduler.workspaceId);
        if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
        const jobs = Array.isArray(response.items) ? response.items : [];
        setScheduledJobs(jobs);
        setScheduledJobsUpdatedAt(Date.now());
        return "success";
      } catch (error) {
        if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
        const message = error instanceof Error ? error.message : String(error);
        setScheduledJobsStatus(message || "Failed to load scheduled tasks.");
        return "error";
      } finally {
        setScheduledJobsBusy(false);
      }
    }

    if (!isTauriRuntime()) {
      if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
      setScheduledJobsStatus(null);
      return "unavailable";
    }

    if (isWindowsPlatform()) {
      if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
      setScheduledJobsStatus(null);
      return "unavailable";
    }

    if (!schedulerPluginInstalled()) {
      if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
      setScheduledJobsStatus(null);
      return "unavailable";
    }

    setScheduledJobsBusy(true);
    setScheduledJobsStatus(null);

    try {
      const root = workspaceStore.selectedWorkspaceRoot().trim();
      const jobs = await schedulerListJobs(root || undefined);
      if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
      setScheduledJobs(jobs);
      setScheduledJobsUpdatedAt(Date.now());
      return "success";
    } catch (error) {
      if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
      const message = error instanceof Error ? error.message : String(error);
      setScheduledJobsStatus(message || "Failed to load scheduled tasks.");
      return "error";
    } finally {
      setScheduledJobsBusy(false);
    }
  };

  createEffect(() => {
    scheduledJobsContextKey();
    setScheduledJobs([]);
    setScheduledJobsStatus(null);
    setScheduledJobsUpdatedAt(null);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (currentView() !== "dashboard") return;
    if (tab() !== "scheduled") return;
    if (!documentVisible()) return;

    const pollingAvailable = scheduledJobsPollingAvailable();
    const startedAt = Date.now();
    let active = true;
    let failureCount = 0;
    let timeoutId: number | undefined;

    const clearTimer = () => {
      if (timeoutId == null) return;
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    };

    const nextDelayMs = () => {
      const baseDelay = Date.now() - startedAt < 60_000 ? 5_000 : 15_000;
      if (failureCount <= 0) return baseDelay;
      return Math.min(baseDelay * 2 ** failureCount, 60_000);
    };

    const scheduleNext = () => {
      clearTimer();
      if (!active || !pollingAvailable) return;
      timeoutId = window.setTimeout(() => {
        void run("poll");
      }, nextDelayMs());
    };

    const run = async (_reason: "initial" | "focus" | "poll") => {
      if (!active) return;
      const result = await refreshScheduledJobs();
      if (!active) return;

      if (result === "error") {
        failureCount += 1;
      } else if (result === "success" || result === "unavailable") {
        failureCount = 0;
      }

      scheduleNext();
    };

    const handleFocus = () => {
      clearTimer();
      void run("focus");
    };

    void run("initial");
    window.addEventListener("focus", handleFocus);

    onCleanup(() => {
      active = false;
      clearTimer();
      window.removeEventListener("focus", handleFocus);
    });
  });

  const deleteScheduledJob = async (name: string) => {
    if (scheduledJobsSource() === "remote") {
      const scheduler = resolveOpenworkScheduler();
      if (!scheduler) {
        throw new Error("OpenWork server unavailable. Connect to sync scheduled tasks.");
      }
      const response = await scheduler.client.deleteScheduledJob(scheduler.workspaceId, name);
      setScheduledJobs((current) => current.filter((entry) => entry.slug !== response.job.slug));
      return;
    }

    if (!isTauriRuntime()) {
      throw new Error("Scheduled tasks require the desktop app.");
    }
    if (isWindowsPlatform()) {
      throw new Error("Scheduler is not supported on Windows yet.");
    }
  const root = workspaceStore.selectedWorkspaceRoot().trim();
  const job = await schedulerDeleteJob(name, root || undefined);
  setScheduledJobs((current) => current.filter((entry) => entry.slug !== job.slug));
  return;
};

  createEffect(() => {
    if (!isTauriRuntime()) return;
    workspaceStore.selectedWorkspaceId();
    workspaceProjectDir();
    void refreshMcpServers();
  });

  const activeAuthorizedDirs = createMemo(() => workspaceStore.authorizedDirs());
  const selectedWorkspaceDisplay = createMemo(() => workspaceStore.selectedWorkspaceDisplay());
  const resolvedActiveWorkspaceConfig = createMemo(
    () => activeWorkspaceServerConfig() ?? workspaceStore.workspaceConfig(),
  );
  const refreshActiveWorkspaceServerConfig = async (
    workspaceIdOverride?: string | null,
  ): Promise<WorkspaceOpenworkConfig | null> => {
    const client = openworkServerClient();
    const workspaceId = (workspaceIdOverride ?? runtimeWorkspaceId() ?? "").trim();
    if (!client || !workspaceId) return null;

    const workspace = selectedWorkspaceDisplay();
    const config = await client.getConfig(workspaceId);
    const normalized = normalizeWorkspaceOpenworkConfig(
      config.openwork,
      workspace.preset,
    );
    const next = normalized.blueprint
      ? normalized
      : {
          ...normalized,
          blueprint: buildDefaultWorkspaceBlueprint(
            normalized.workspace?.preset ?? workspace.preset ?? "starter",
          ),
        };
    setActiveWorkspaceServerConfig(next);
    return next;
  };
  const activePermissionMemo = createMemo(() => activePermission());
  const migrationRepairUnavailableReason = createMemo<string | null>(() => {
    if (workspaceStore.canRepairOpencodeMigration()) return null;
    if (!isTauriRuntime()) {
      return t("app.migration.desktop_required", currentLocale());
    }

    if (selectedWorkspaceDisplay().workspaceType !== "local") {
      return t("app.migration.local_only", currentLocale());
    }

    if (!workspaceStore.selectedWorkspacePath().trim()) {
      return t("app.migration.workspace_required", currentLocale());
    }

    return t("app.migration.local_only", currentLocale());
  });

  const [expandedStepIds, setExpandedStepIds] = createSignal<Set<string>>(
    new Set()
  );
  const [expandedSidebarSections, setExpandedSidebarSections] = createSignal({
    progress: true,
    artifacts: true,
    context: false,
    plugins: false,
    mcp: false,
    skills: true,
    authorizedFolders: false,
  });
  const [autoConnectAttempted, setAutoConnectAttempted] = createSignal(false);

  createEffect(() => {
    const workspace = selectedWorkspaceDisplay();
    const openworkClient = openworkServerClient();
    const workspaceId = runtimeWorkspaceId();
    const capabilities = resolvedOpenworkCapabilities();
    const canReadConfig =
      openworkServerStatus() === "connected" &&
      Boolean(openworkClient && workspaceId && capabilities?.config?.read);

    if (!canReadConfig || !openworkClient || !workspaceId) {
      setActiveWorkspaceServerConfig(null);
      return;
    }

    let cancelled = false;

    const loadWorkspaceConfig = async () => {
      try {
        const config = await openworkClient.getConfig(workspaceId);
        if (cancelled) return;

        const normalized = normalizeWorkspaceOpenworkConfig(
          config.openwork,
          workspace.preset,
        );

        if (!normalized.blueprint) {
          setActiveWorkspaceServerConfig({
            ...normalized,
            blueprint: buildDefaultWorkspaceBlueprint(
              normalized.workspace?.preset ?? workspace.preset ?? "starter",
            ),
          });
          return;
        }

        setActiveWorkspaceServerConfig(normalized);
      } catch {
        if (!cancelled) {
          setActiveWorkspaceServerConfig(null);
        }
      }
    };

    void loadWorkspaceConfig();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const [blueprintSessionMaterializeBusyByWorkspaceId, setBlueprintSessionMaterializeBusyByWorkspaceId] =
    createSignal<Record<string, boolean>>({});
  const [blueprintSessionMaterializeAttemptedByWorkspaceId, setBlueprintSessionMaterializeAttemptedByWorkspaceId] =
    createSignal<Record<string, boolean>>({});

  createEffect(() => {
    const workspaceId = (runtimeWorkspaceId() ?? "").trim();
    const client = openworkServerClient();
    const connected = openworkServerStatus() === "connected";
    const root = workspaceStore.selectedWorkspaceRoot().trim();
    const config = resolvedActiveWorkspaceConfig();
    const templates = blueprintSessions(config);
    const materialized = blueprintMaterializedSessions(config);
    const currentSessions = sessions();
    const normalizedRoot = normalizeDirectoryPath(root);
    const hasWorkspaceSessions = currentSessions.some((session) => {
      const directory = typeof session.directory === "string" ? session.directory : "";
      return normalizeDirectoryPath(directory) === normalizedRoot;
    });

    if (!workspaceId || !client || !connected) return;
    if (!root) return;
    if (!sessionsLoaded()) return;
    if (creatingSession()) return;
    if (selectedSessionId()) return;
    if (!templates.length) return;
    if (materialized.length > 0) return;
    if (hasWorkspaceSessions) return;
    if (blueprintSessionMaterializeBusyByWorkspaceId()[workspaceId]) return;
    if (blueprintSessionMaterializeAttemptedByWorkspaceId()[workspaceId]) return;

    setBlueprintSessionMaterializeBusyByWorkspaceId((current) => ({
      ...current,
      [workspaceId]: true,
    }));

    void (async () => {
      try {
        const result = await client.materializeBlueprintSessions(workspaceId);
        const templateMessages = new Map(
          templates.map((template) => [template.id?.trim(), (template.messages ?? []).filter((entry) => entry?.text?.trim())] as const),
        );
        if (result.created.length > 0) {
          setBlueprintSeedMessagesBySessionId((current) => {
            const next = { ...current };
            result.created.forEach((entry) => {
              const messages = templateMessages.get(entry.templateId?.trim());
              if (messages && messages.length > 0) {
                next[entry.sessionId] = messages;
              }
            });
            return next;
          });
        }
        setBlueprintSessionMaterializeAttemptedByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: true,
        }));
        await refreshActiveWorkspaceServerConfig(workspaceId);
        await loadSessionsWithReady(root || undefined);
        if (result.openSessionId) {
          setView("session");
          await selectSession(result.openSessionId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      } finally {
        setBlueprintSessionMaterializeBusyByWorkspaceId((current) => {
          const next = { ...current };
          delete next[workspaceId];
          return next;
        });
      }
    })();
  });

  const [appVersion, setAppVersion] = createSignal<string | null>(null);
  const [launchUpdateCheckTriggered, setLaunchUpdateCheckTriggered] = createSignal(false);


  const busySeconds = createMemo(() => {
    const start = busyStartedAt();
    if (!start) return 0;
    return Math.max(0, Math.round((Date.now() - start) / 1000));
  });

  const newTaskDisabled = createMemo(() => {
    if (!client()) {
      return true;
    }

    const label = busyLabel();
    // Allow creating a new session even while a run is in progress.
    if (busy() && label === "status.running") return false;

    // Otherwise, block during engine / connection transitions.
    if (
      busy() &&
      (label === "status.connecting" ||
        label === "status.starting_engine" ||
        label === "status.disconnecting")
    ) {
      return true;
    }

    return busy();
  });

  createEffect(() => {
    if (isTauriRuntime()) return;
    if (autoConnectAttempted()) return;
    if (client()) return;
    if (openworkServerStatus() !== "connected") return;

    const settings = openworkServerSettings();
    if (!settings.urlOverride || !settings.token) return;

    setAutoConnectAttempted(true);
    void workspaceStore.onConnectClient();
  });

  const selectedSessionModel = createMemo<ModelRef>(() => {
    const id = selectedSessionId();
    if (!id) return pendingSessionModel() ?? defaultModel();

    const override = sessionModelOverrideById()[id];
    if (override) return override;

    const known = sessionModelById()[id];
    if (known) return known;

    const fromMessages = lastUserModelFromMessages(messages());
    if (fromMessages) return fromMessages;

    return defaultModel();
  });

  const selectedSessionAgent = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return null;
    return sessionAgentById()[id] ?? null;
  });

  const selectedSessionModelLabel = createMemo(() =>
    formatModelLabel(selectedSessionModel(), providers())
  );

  const findProviderModel = (ref: ModelRef) => {
    const provider = providers().find((entry) => entry.id === ref.providerID);
    return provider?.models?.[ref.modelID] ?? null;
  };

  const sanitizeModelVariantForRef = (ref: ModelRef, value: string | null) => {
    const modelInfo = findProviderModel(ref);
    if (!modelInfo) return normalizeModelBehaviorValue(value);
    return sanitizeModelBehaviorValue(ref.providerID, modelInfo, value);
  };

  const getModelBehaviorCopy = (ref: ModelRef, value: string | null) => {
    const modelInfo = findProviderModel(ref);
    if (!modelInfo) {
      return {
        title: "Model behavior",
        label: formatGenericBehaviorLabel(value),
        description: "Choose the model first to see provider-specific behavior controls.",
        options: [],
      };
    }
    return getModelBehaviorSummary(ref.providerID, modelInfo, value);
  };

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel()
  );

  const isHeroModel = (id: string) => {
    const check = id.toLowerCase();
    if (check.includes("gpt-5")) return true;
    if (check.includes("opus-4")) return true;
    if (check.includes("claude-3-7-sonnet")) return true;
    if (check.includes("claude-3-5-sonnet")) return true;
    if (check.includes("gpt-4o") && !check.includes("mini") && !check.includes("audio")) return true;
    if (check.includes("o3-mini")) return true;
    if (check.includes("o1") && !check.includes("mini")) return true;
    if (check.includes("deepseek-r1")) return true;
    return false;
  };

  const modelOptions = createMemo<ModelOption[]>(() => {
    const allProviders = providers();
    const defaults = providerDefaults();
    const currentDefault = defaultModel();

    if (!allProviders.length) {
      const behavior = getModelBehaviorCopy(DEFAULT_MODEL, getVariantFor(DEFAULT_MODEL));
      return [
        {
          providerID: DEFAULT_MODEL.providerID,
          modelID: DEFAULT_MODEL.modelID,
          title: DEFAULT_MODEL.modelID,
          description: DEFAULT_MODEL.providerID,
          footer: t("settings.model_fallback", currentLocale()),
          behaviorTitle: behavior.title,
          behaviorLabel: behavior.label,
          behaviorDescription: behavior.description,
          behaviorValue: normalizeModelBehaviorValue(getVariantFor(DEFAULT_MODEL)),
          behaviorOptions: behavior.options,
          isFree: true,
          isConnected: false,
        },
      ];
    }

    const sortedProviders = allProviders.slice().sort(compareProviders);

    const next: ModelOption[] = [];

    for (const provider of sortedProviders) {
      const defaultModelID = defaults[provider.id];
      const isConnected = providerConnectedIds().includes(provider.id);
      const models = Object.values(provider.models ?? {}).filter(
        (m) => m.status !== "deprecated"
      );

      models.sort((a, b) => {
        const aFree = a.cost?.input === 0 && a.cost?.output === 0;
        const bFree = b.cost?.input === 0 && b.cost?.output === 0;
        if (aFree !== bFree) return aFree ? -1 : 1;
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
      });

      for (const model of models) {
        const isFree = model.cost?.input === 0 && model.cost?.output === 0;
        const isDefault =
          provider.id === currentDefault.providerID && model.id === currentDefault.modelID;
        const ref = { providerID: provider.id, modelID: model.id };
        const behavior = getModelBehaviorSummary(provider.id, model, getVariantFor(ref));
        const behaviorValue = sanitizeModelBehaviorValue(provider.id, model, getVariantFor(ref));
        const footerBits: string[] = [];
        if (defaultModelID === model.id || isDefault) {
          footerBits.push(t("settings.model_default", currentLocale()));
        }
        if (model.reasoning) footerBits.push(t("settings.model_reasoning", currentLocale()));

        next.push({
          providerID: provider.id,
          modelID: model.id,
          title: model.name ?? model.id,
          description: provider.name,
          footer: footerBits.length
            ? footerBits.slice(0, 2).join(" · ")
            : undefined,
          behaviorTitle: behavior.title,
          behaviorLabel: behavior.label,
          behaviorDescription: behavior.description,
          behaviorValue,
          behaviorOptions: behavior.options,
          disabled: !isConnected,
          isFree,
          isConnected,
          isRecommended: isHeroModel(model.id),
        });
      }
    }

    next.sort((a, b) => {
      if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      const providerRankDiff =
        providerPriorityRank(a.providerID) - providerPriorityRank(b.providerID);
      if (providerRankDiff !== 0) return providerRankDiff;
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
        opt.behaviorTitle,
        opt.behaviorLabel,
        opt.behaviorDescription,
        `${opt.providerID}/${opt.modelID}`,
        opt.isConnected ? "connected" : "disconnected",
        opt.isFree ? "free" : "paid",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  function closeModelPicker(options?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      options?.restorePromptFocus ??
      modelPickerReturnFocusTarget() === "composer";
    setModelPickerOpen(false);
    setModelPickerReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      focusSessionPromptSoon();
    }
  }

  function openSessionModelPicker(options?: {
    returnFocusTarget?: PromptFocusReturnTarget;
  }) {
    setModelPickerTarget("session");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget(options?.returnFocusTarget ?? "composer");
    setModelPickerOpen(true);
  }

  function openDefaultModelPicker() {
    setModelPickerTarget("default");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget("none");
    setModelPickerOpen(true);
  }

  function applyModelSelection(next: ModelRef) {
    const restorePromptFocus = modelPickerTarget() === "session";

    if (modelPickerTarget() === "default") {
      setDefaultModelExplicit(true);
      setDefaultModel(next);
      closeModelPicker({ restorePromptFocus: false });
      return;
    }

    const id = selectedSessionId();
    if (!id) {
      setPendingSessionModel(next);
      setDefaultModelExplicit(true);
      setDefaultModel(next);
      closeModelPicker({ restorePromptFocus });
      return;
    }

    setSessionModelOverrideById((current) => ({ ...current, [id]: next }));
    setDefaultModelExplicit(true);
    setDefaultModel(next);
    closeModelPicker({ restorePromptFocus });
  }

  function openSettingsFromModelPicker() {
    setTab("settings");
    setView("dashboard");
  }

  async function connectNotion() {
    if (workspaceStore.selectedWorkspaceDisplay().workspaceType !== "local") {
      setNotionError("Notion connections are only available for local workspaces.");
      return;
    }

    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) {
      setNotionError("Pick a workspace folder first.");
      return;
    }

    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.mcp?.write;

    if (!canUseOpenworkServer && !isTauriRuntime()) {
      setNotionError("Notion connections require the desktop app.");
      return;
    }

    if (notionBusy()) return;

    setNotionBusy(true);
    setNotionError(null);
    setNotionStatus("connecting");
    setNotionStatusDetail(t("mcp.connecting", currentLocale()));
    setNotionSkillInstalled(false);

    try {
      if (canUseOpenworkServer) {
        await openworkClient.addMcp(openworkWorkspaceId, {
          name: "notion",
          config: {
            type: "remote",
            url: "https://mcp.notion.com/mcp",
            enabled: true,
          },
        });
      } else {
        const config = await readOpencodeConfig("project", projectDir);
        const raw = config.content ?? "";
        const nextConfig = raw.trim()
          ? (parse(raw) as Record<string, unknown>)
          : { $schema: "https://opencode.ai/config.json" };

        const mcp = typeof nextConfig.mcp === "object" && nextConfig.mcp
          ? { ...(nextConfig.mcp as Record<string, unknown>) }
          : {};
        mcp.notion = {
          type: "remote",
          url: "https://mcp.notion.com/mcp",
          enabled: true,
        };

        nextConfig.mcp = mcp;
        const formatted = JSON.stringify(nextConfig, null, 2);

        const result = await writeOpencodeConfig("project", projectDir, `${formatted}\n`);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
      }

      markReloadRequired("mcp", { type: "mcp", name: "notion", action: "added" });

      await refreshMcpServers();
      setNotionStatusDetail(t("mcp.connecting", currentLocale()));
      try {
        window.localStorage.setItem("openwork.notionStatus", "connecting");
        window.localStorage.setItem("openwork.notionStatusDetail", t("mcp.connecting", currentLocale()));
        window.localStorage.setItem("openwork.notionSkillInstalled", "0");
      } catch {
        // ignore
      }
    } catch (e) {
      setNotionStatus("error");
      setNotionError(e instanceof Error ? e.message : "Failed to connect Notion.");
    } finally {
      setNotionBusy(false);
    }
  }

  async function refreshMcpServers() {
    const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
      const configured = new Set(entries.map((entry) => entry.name));
      return Object.fromEntries(Object.entries(status).filter(([name]) => configured.has(name))) as McpStatusMap;
    };

    const projectDir = workspaceProjectDir().trim();
    const isRemoteWorkspace = workspaceStore.selectedWorkspaceDisplay().workspaceType === "remote";
    const isLocalWorkspace = !isRemoteWorkspace;
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.mcp?.read;

    if (isRemoteWorkspace) {
      if (!canUseOpenworkServer) {
        setMcpStatus("OpenWork server unavailable. MCP config is read-only.");
        setMcpServers([]);
        setMcpStatuses({});
        return;
      }

      try {
        setMcpStatus(null);
        const response = await openworkClient.listMcp(openworkWorkspaceId);
        const next = response.items.map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
        }));
        setMcpServers(next);
        setMcpLastUpdatedAt(Date.now());

        const activeClient = client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
          } catch {
            setMcpStatuses({});
          }
        } else {
          setMcpStatuses({});
        }

        if (!next.length) {
          setMcpStatus("No MCP servers configured yet.");
        }
      } catch (e) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
      }
      return;
    }

    if (isLocalWorkspace && canUseOpenworkServer) {
      try {
        setMcpStatus(null);
        const response = await openworkClient.listMcp(openworkWorkspaceId);
        const next = response.items.map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
        }));
        setMcpServers(next);
        setMcpLastUpdatedAt(Date.now());

        const activeClient = client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
          } catch {
            setMcpStatuses({});
          }
        } else {
          setMcpStatuses({});
        }

        if (!next.length) {
          setMcpStatus("No MCP servers configured yet.");
        }
      } catch (e) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setMcpStatus("MCP configuration is only available for local workspaces.");
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }

    if (!projectDir) {
      setMcpStatus("Pick a workspace folder to load MCP servers.");
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }

    try {
      setMcpStatus(null);
      const config = await readOpencodeConfig("project", projectDir);
      if (!config.exists || !config.content) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus("No opencode.json found yet. Create one by connecting an MCP.");
        return;
      }

      const next = parseMcpServersFromContent(config.content);
      setMcpServers(next);
      setMcpLastUpdatedAt(Date.now());

      const activeClient = client();
      if (activeClient) {
        try {
          const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
          setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
        } catch {
          setMcpStatuses({});
        }
      }

      if (!next.length) {
        setMcpStatus("No MCP servers configured yet.");
      }
    } catch (e) {
      setMcpServers([]);
      setMcpStatuses({});
      setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
    }
  }

  const readMcpConfigFile = async (scope: "project" | "global") => {
    const projectDir = workspaceProjectDir().trim();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      resolvedOpenworkCapabilities()?.config?.read;

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      return openworkClient.readOpencodeConfigFile(openworkWorkspaceId, scope);
    }
    if (!isTauriRuntime()) {
      return null;
    }
    return readOpencodeConfig(scope, projectDir);
  };

  async function connectMcp(entry: (typeof MCP_QUICK_CONNECT)[number]) {
    const startedAt = perfNow();
    const isRemoteWorkspace =
      workspaceStore.selectedWorkspaceDisplay().workspaceType === "remote" ||
      (!isTauriRuntime() && openworkServerStatus() === "connected");
    const projectDir = workspaceProjectDir().trim();
    const entryType = entry.type ?? "remote";

    recordPerfLog(developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const openworkClient = openworkServerClient();
    let openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    if (!openworkWorkspaceId && openworkClient && openworkServerStatus() === "connected") {
      try {
        const response = await openworkClient.listWorkspaces();
        const match = response.items?.[0];
        if (match?.id) {
          openworkWorkspaceId = match.id;
          setRuntimeWorkspaceId(match.id);
        }
      } catch {
        // ignore
      }
    }
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.mcp?.write;

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setMcpStatus("OpenWork server unavailable. MCP config is read-only.");
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "openwork-server-unavailable",
      });
      return;
    }

    if (!canUseOpenworkServer && !isTauriRuntime()) {
      setMcpStatus(t("mcp.desktop_required", currentLocale()));
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return;
    }

    if (!isRemoteWorkspace && !projectDir) {
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return;
    }

    let activeClient = client();
    if (!activeClient) {
      const openworkBaseUrl = openworkServerBaseUrl().trim();
      const auth = openworkServerAuth();
      if (openworkBaseUrl && auth.token) {
        const opencodeUrl = `${openworkBaseUrl.replace(/\/+$/, "")}/opencode`;
        activeClient = createClient(opencodeUrl, undefined, { token: auth.token, mode: "openwork" });
        setClient(activeClient);
      }
    }
    if (!activeClient) {
      setMcpStatus(t("mcp.connect_server_first", currentLocale()));
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return;
    }

    let resolvedProjectDir = projectDir;
    if (!resolvedProjectDir) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = normalizeDirectoryQueryPath(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          workspaceStore.setProjectDir(discovered);
        }
      } catch {
        // ignore
      }
    }
    if (!resolvedProjectDir) {
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return;
    }

    const slug = entry.id ?? entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const action = mcpServers().some((server) => server.name === slug) ? "updated" : "added";

    try {
      setMcpStatus(null);
      setMcpConnectingName(entry.name);

      let mcpEnvironment: Record<string, string> | undefined;

      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };

      if (entryType === "remote") {
        if (!entry.url) {
          throw new Error("Missing MCP URL.");
        }
        mcpEntryConfig["url"] = entry.url;
        if (entry.oauth) {
          mcpEntryConfig["oauth"] = {};
        }
      }

      if (entryType === "local") {
        if (!entry.command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = entry.command;

        if (slug === CHROME_DEVTOOLS_MCP_ID && usesChromeDevtoolsAutoConnect(entry.command) && isTauriRuntime()) {
          try {
            const hostHome = (await homeDir()).replace(/[\\/]+$/, "");
            if (hostHome) {
              mcpEnvironment = { HOME: hostHome };
              mcpEntryConfig["environment"] = mcpEnvironment;
            }
          } catch {
            // ignore and let the MCP use the default worker environment
          }
        }
      }

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.addMcp(openworkWorkspaceId, {
          name: slug,
          config: mcpEntryConfig,
        });
      } else {
        const configFile = await readOpencodeConfig("project", resolvedProjectDir);

        let existingConfig: Record<string, unknown> = {};
        if (configFile.exists && configFile.content?.trim()) {
          try {
            existingConfig = parse(configFile.content) ?? {};
          } catch (parseErr) {
            recordPerfLog(developerMode(), "mcp.connect", "config-parse-failed", {
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            existingConfig = {};
          }
        }

        if (!existingConfig["$schema"]) {
          existingConfig["$schema"] = "https://opencode.ai/config.json";
        }

        const mcpSection = (existingConfig["mcp"] as Record<string, unknown>) ?? {};
        existingConfig["mcp"] = mcpSection;
        mcpSection[slug] = mcpEntryConfig;

        const writeResult = await writeOpencodeConfig(
          "project",
          resolvedProjectDir,
          `${JSON.stringify(existingConfig, null, 2)}\n`
        );
        if (!writeResult.ok) {
          throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
        }
      }

      const mcpAddConfig =
        entryType === "remote"
          ? {
            type: "remote" as const,
            url: entry.url!,
            enabled: true,
            ...(entry.oauth ? { oauth: {} } : {}),
          }
          : {
            type: "local" as const,
            command: entry.command!,
            enabled: true,
            ...(mcpEnvironment ? { environment: mcpEnvironment } : {}),
          };

      const status = unwrap(
        await activeClient.mcp.add({
          directory: resolvedProjectDir,
          name: slug,
          config: mcpAddConfig,
        }),
      );

      setMcpStatuses(status as McpStatusMap);
      markReloadRequired("mcp", { type: "mcp", name: slug, action });
      await refreshMcpServers();

      if (entry.oauth) {
        setMcpAuthEntry(entry);
        setMcpAuthNeedsReload(true);
        setMcpAuthModalOpen(true);
      } else {
        setMcpStatus(t("mcp.connected", currentLocale()));
      }

      await refreshMcpServers();
      finishPerf(developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : t("mcp.connect_failed", currentLocale()));
      finishPerf(developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
    } finally {
      setMcpConnectingName(null);
    }
  }

  function authorizeMcp(entry: McpServerEntry) {
    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      setMcpStatus(t("mcp.login_unavailable", currentLocale()));
      return;
    }

    const matchingQuickConnect = MCP_QUICK_CONNECT.find((candidate) => {
      const candidateSlug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return candidateSlug === entry.name || candidate.name === entry.name;
    });

    setMcpAuthEntry(
      matchingQuickConnect ?? {
        name: entry.name,
        description: "",
        type: "remote",
        url: entry.config.url,
        oauth: true,
      },
    );
    setMcpAuthNeedsReload(false);
    setMcpAuthModalOpen(true);
  }

  async function logoutMcpAuth(name: string) {
    const isRemoteWorkspace =
      workspaceStore.selectedWorkspaceDisplay().workspaceType === "remote" ||
      (!isTauriRuntime() && openworkServerStatus() === "connected");
    const projectDir = workspaceProjectDir().trim();

    const openworkClient = openworkServerClient();
    let openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    if (!openworkWorkspaceId && openworkClient && openworkServerStatus() === "connected") {
      try {
        const response = await openworkClient.listWorkspaces();
        const match = response.items?.[0];
        if (match?.id) {
          openworkWorkspaceId = match.id;
          setRuntimeWorkspaceId(match.id);
        }
      } catch {
        // ignore
      }
    }
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.mcp?.write;

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setMcpStatus("OpenWork server unavailable. MCP auth is read-only.");
      return;
    }

    if (!canUseOpenworkServer && !isTauriRuntime()) {
      setMcpStatus(t("mcp.desktop_required", currentLocale()));
      return;
    }

    let activeClient = client();
    if (!activeClient) {
      const openworkBaseUrl = openworkServerBaseUrl().trim();
      const auth = openworkServerAuth();
      if (openworkBaseUrl && auth.token) {
        const opencodeUrl = `${openworkBaseUrl.replace(/\/+$/, "")}/opencode`;
        activeClient = createClient(opencodeUrl, undefined, { token: auth.token, mode: "openwork" });
        setClient(activeClient);
      }
    }
    if (!activeClient) {
      setMcpStatus(t("mcp.connect_server_first", currentLocale()));
      return;
    }

    let resolvedProjectDir = projectDir;
    if (!resolvedProjectDir) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = normalizeDirectoryQueryPath(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          workspaceStore.setProjectDir(discovered);
        }
      } catch {
        // ignore
      }
    }
    if (!resolvedProjectDir) {
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
      return;
    }

    const safeName = validateMcpServerName(name);
    setMcpStatus(null);

    try {
      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.logoutMcpAuth(openworkWorkspaceId, safeName);
      } else {
        try {
          await activeClient.mcp.disconnect({ directory: resolvedProjectDir, name: safeName });
        } catch {
          // ignore
        }
        await activeClient.mcp.auth.remove({ directory: resolvedProjectDir, name: safeName });
      }

      try {
        const status = unwrap(await activeClient.mcp.status({ directory: resolvedProjectDir }));
        setMcpStatuses(status as McpStatusMap);
      } catch {
        // ignore
      }

      await refreshMcpServers();
      setMcpStatus(t("mcp.logout_success", currentLocale()).replace("{server}", safeName));
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : t("mcp.logout_failed", currentLocale()));
    }
  }

  async function removeMcp(name: string) {
    try {
      setMcpStatus(null);

      const openworkClient = openworkServerClient();
      const openworkWorkspaceId = runtimeWorkspaceId();
      const canUseOpenworkServer =
        openworkServerStatus() === "connected" &&
        openworkClient &&
        openworkWorkspaceId &&
        resolvedOpenworkCapabilities()?.mcp?.write;

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.removeMcp(openworkWorkspaceId, name);
      } else {
        const projectDir = workspaceProjectDir().trim();
        if (!projectDir) {
          setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
          return;
        }
        await removeMcpFromConfig(projectDir, name);
      }

      markReloadRequired("mcp", { type: "mcp", name, action: "removed" });
      await refreshMcpServers();
      if (selectedMcp() === name) {
        setSelectedMcp(null);
      }
      setMcpStatus(null);
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : t("mcp.remove_failed", currentLocale()));
    }
  }

  async function createSessionAndOpen() {
    const ready = await ensureSelectedWorkspaceRuntime();
    if (!ready) {
      return;
    }

    const c = client();
    if (!c) {
      return;
    }

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const runId = (() => {
      const key = "__openwork_create_session_run__";
      const w = window as typeof window & { [key]?: number };
      w[key] = (w[key] ?? 0) + 1;
      return w[key];
    })();

    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsed = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.create", event, {
        runId,
        elapsedMs: elapsed,
        ...(payload ?? {}),
      });
    };

    mark("start", {
      baseUrl: baseUrl(),
      workspace: workspaceStore.selectedWorkspaceRoot().trim() || null,
    });

    // Abort any in-flight refresh operations to free up connection resources
    abortRefreshes();

    // Small delay to allow pending requests to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    setBusy(true);
    setBusyLabel("status.creating_task");
    setBusyStartedAt(Date.now());
    setError(null);
    setCreatingSession(true);

    const withTimeout = async <T,>(
      promise: Promise<T>,
      ms: number,
      label: string
    ) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          ms
        );
      });
      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    };

    try {
      // Quick health check to detect stale connection
      mark("health:start");
      try {
        await withTimeout(c.global.health(), 3_000, "health");
        mark("health:ok");
      } catch (healthErr) {
        mark("health:error", {
          error: healthErr instanceof Error ? healthErr.message : safeStringify(healthErr),
        });
        throw new Error(t("app.connection_lost", currentLocale()));
      }

      let rawResult: Awaited<ReturnType<typeof c.session.create>>;
      try {
        const directory = toSessionTransportDirectory(workspaceStore.selectedWorkspaceRoot().trim()) || undefined;
        logWorkspaceScopeSnapshot("session:create:scope", {
          transportDirectory: directory ?? null,
          transportScope: describeDirectoryScope(directory ?? null),
        });
        mark("session:create:start");
        rawResult = await c.session.create({
          directory,
        });
        mark("session:create:ok");
      } catch (createErr) {
        mark("session:create:error", {
          error: createErr instanceof Error ? createErr.message : safeStringify(createErr),
        });
        throw createErr;
      }

      const session = unwrap(rawResult);
      const pendingModel = pendingSessionModel();
      // Immediately select and show the new session before background list refresh.
      setBusyLabel("status.loading_session");
      mark("session:select:start", { sessionID: session.id });
      await selectSession(session.id);
      mark("session:select:ok", { sessionID: session.id });

      if (pendingModel) {
        setSessionModelOverrideById((current) => ({
          ...current,
          [session.id]: pendingModel,
        }));
        setPendingSessionModel(null);
      }

      // Inject the new session into the reactive sessions() store so
      // the createEffect bridge (sessions → sidebar) will always include it,
      // even if the background loadSessionsWithReady hasn't returned yet.
      const currentStoreSessions = sessions();
      if (!currentStoreSessions.some((s) => s.id === session.id)) {
        setSessions([session, ...currentStoreSessions]);
      }

      const newItem: SidebarSessionItem = {
        id: session.id,
        title: session.title,
        slug: session.slug,
        parentID: session.parentID,
        time: session.time,
        directory: session.directory,
      };
      const wsId = workspaceStore.selectedWorkspaceId().trim();
      if (wsId) {
        const currentSessions = sidebarSessionsByWorkspaceId()[wsId] || [];
        setSidebarSessionsByWorkspaceId((prev) => ({
          ...prev,
          [wsId]: [newItem, ...currentSessions],
        }));
        setSidebarSessionStatusByWorkspaceId((prev) => ({
          ...prev,
          [wsId]: "ready",
        }));
      }

      // setSessionViewLockUntil(Date.now() + 1200);
      goToSession(session.id);

      // The new session is already in the sessions() store (injected above)
      // and in the sidebar signal. SSE session.created events will handle
      // any further syncing. Calling loadSessionsWithReady() here would
      // race with the store injection — the server may not have indexed the
      // session yet, so reconcile() would wipe it from the store, causing
      // the sidebar to flash and the route guard to bounce back.
      finishPerf(perfEnabled, "session.create", "done", startedAt, {
        runId,
        sessionID: session.id,
      });
      return session.id;
    } catch (e) {
      finishPerf(perfEnabled, "session.create", "error", startedAt, {
        runId,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message = e instanceof Error ? e.message : t("app.unknown_error", currentLocale());
      setError(addOpencodeCacheHint(message));
      return undefined;
    } finally {
      setCreatingSession(false);
      setBusy(false);
    }
  }


  onMount(async () => {
    const startupPref = readStartupPreference();
    if (startupPref) {
      setRememberStartupChoice(true);
      setStartupPreference(startupPref);
    }

    const unsubscribeTheme = subscribeToSystemTheme((isDark) => {
      if (themeMode() !== "system") return;
      applyThemeMode(isDark ? "dark" : "light");
    });

    onCleanup(() => {
      unsubscribeTheme();
    });

    createEffect(() => {
      const next = themeMode();
      persistThemeMode(next);
      applyThemeMode(next);
    });

    if (typeof window !== "undefined") {
      try {
        // In Tauri/desktop mode, do NOT restore the cached baseUrl from localStorage.
        // OpenCode is assigned a random port on every restart, so the stored URL is
        // always stale after a relaunch. The correct baseUrl is provided by engine_info().
        // Web mode still needs the cached value since it connects to a fixed server URL.
        if (!isTauriRuntime()) {
          const storedBaseUrl = window.localStorage.getItem("openwork.baseUrl");
          if (storedBaseUrl) {
            setBaseUrl(storedBaseUrl);
          }
        }

        const storedClientDir = window.localStorage.getItem(
          "openwork.clientDirectory"
        );
        if (storedClientDir) {
          setClientDirectory(storedClientDir);
        }

        const storedEngineSource = window.localStorage.getItem(
          "openwork.engineSource"
        );
        const storedEngineCustomBinPath = window.localStorage.getItem(
          "openwork.engineCustomBinPath"
        );
        if (storedEngineCustomBinPath) {
          setEngineCustomBinPath(storedEngineCustomBinPath);
        }
        if (
          storedEngineSource === "path" ||
          storedEngineSource === "sidecar" ||
          storedEngineSource === "custom"
        ) {
          if (storedEngineSource === "custom" && !(storedEngineCustomBinPath ?? "").trim()) {
            setEngineSource(isTauriRuntime() ? "sidecar" : "path");
          } else {
            setEngineSource(storedEngineSource);
          }
        }

        const storedEngineRuntime = window.localStorage.getItem(
          "openwork.engineRuntime"
        );
        if (storedEngineRuntime === "direct" || storedEngineRuntime === "openwork-orchestrator") {
          setEngineRuntime(storedEngineRuntime);
        }

        const storedOpencodeEnableExa = window.localStorage.getItem(
          "openwork.opencodeEnableExa"
        );
        if (storedOpencodeEnableExa === "0" || storedOpencodeEnableExa === "1") {
          setOpencodeEnableExa(storedOpencodeEnableExa === "1");
        }

        const storedDefaultModel = window.localStorage.getItem(MODEL_PREF_KEY);
        const parsedDefaultModel = parseModelRef(storedDefaultModel);
        if (parsedDefaultModel) {
          setDefaultModel(parsedDefaultModel);
          setLegacyDefaultModel(parsedDefaultModel);
        } else {
          setDefaultModel(DEFAULT_MODEL);
          setLegacyDefaultModel(DEFAULT_MODEL);
          try {
            window.localStorage.setItem(
              MODEL_PREF_KEY,
              formatModelRef(DEFAULT_MODEL)
            );
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

        const storedHideTitlebar = window.localStorage.getItem(HIDE_TITLEBAR_PREF_KEY);
        if (storedHideTitlebar != null) {
          try {
            const parsed = JSON.parse(storedHideTitlebar);
            if (typeof parsed === "boolean") {
              setHideTitlebar(parsed);
            }
          } catch {
            // ignore
          }
        }

        const storedVariant = window.localStorage.getItem(VARIANT_PREF_KEY);
        if (storedVariant && storedVariant.trim()) {
          try {
            const parsed = JSON.parse(storedVariant);
            if (typeof parsed === "object" && parsed !== null) {
              setModelVariantMap(parsed);
            } else {
              setModelVariantMap({ [`${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`]: normalizeModelBehaviorValue(storedVariant)! });
            }
          } catch {
            setModelVariantMap({ [`${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`]: normalizeModelBehaviorValue(storedVariant)! });
          }
        }

        const storedUpdateAutoCheck = window.localStorage.getItem(
          "openwork.updateAutoCheck"
        );
        if (storedUpdateAutoCheck === "0" || storedUpdateAutoCheck === "1") {
          setUpdateAutoCheck(storedUpdateAutoCheck === "1");
        }

        const storedUpdateAutoDownload = window.localStorage.getItem(
          "openwork.updateAutoDownload"
        );
        if (storedUpdateAutoDownload === "0" || storedUpdateAutoDownload === "1") {
          const enabled = storedUpdateAutoDownload === "1";
          setUpdateAutoDownload(enabled);
          if (enabled) {
            setUpdateAutoCheck(true);
          }
        }

        const storedUpdateCheckedAt = window.localStorage.getItem(
          "openwork.updateLastCheckedAt"
        );
        if (storedUpdateCheckedAt) {
          const parsed = Number(storedUpdateCheckedAt);
          if (Number.isFinite(parsed) && parsed > 0) {
            setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
          }
        }

        const storedNotionStatus = window.localStorage.getItem("openwork.notionStatus");
        if (
          storedNotionStatus === "disconnected" ||
          storedNotionStatus === "connected" ||
          storedNotionStatus === "connecting" ||
          storedNotionStatus === "error"
        ) {
          setNotionStatus(storedNotionStatus);
        }

        const storedNotionDetail = window.localStorage.getItem("openwork.notionStatusDetail");
        if (storedNotionDetail) {
          setNotionStatusDetail(storedNotionDetail);
        } else if (storedNotionStatus === "connecting") {
          setNotionStatusDetail(t("mcp.connecting", currentLocale()));
        }

        await refreshMcpServers();

        const storedNotionSkillInstalled = window.localStorage.getItem("openwork.notionSkillInstalled");
        if (storedNotionSkillInstalled === "1") {
          setNotionSkillInstalled(true);
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

      try {
        setUpdateEnv(await updaterEnvironment());
      } catch {
        // ignore
      }

      if (!launchUpdateCheckTriggered()) {
        setLaunchUpdateCheckTriggered(true);
        checkForUpdates({ quiet: true }).catch(() => undefined);
      }
    }

    if (typeof window !== "undefined") {
      const handleDeepLinkEvent = (event: Event) => {
        const detail = (event as CustomEvent<DeepLinkBridgeDetail>).detail;
        consumeDeepLinks(detail?.urls ?? []);
      };

      consumeDeepLinks(drainPendingDeepLinks(window));
      window.addEventListener(deepLinkBridgeEvent, handleDeepLinkEvent as EventListener);
      onCleanup(() => {
        window.removeEventListener(deepLinkBridgeEvent, handleDeepLinkEvent as EventListener);
      });
    }

    void workspaceStore.bootstrapOnboarding().finally(() => setBooting(false));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.selectedWorkspaceId();
    if (!workspaceId) return;

    setSessionModelOverridesReady(false);
    const raw = window.localStorage.getItem(sessionModelOverridesKey(workspaceId));
    setSessionModelOverrideById(parseSessionModelOverrides(raw));
    setSessionModelOverridesReady(true);
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) return;
    void refreshMcpServers();
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessionModelOverridesReady()) return;
    const workspaceId = workspaceStore.selectedWorkspaceId();
    if (!workspaceId) return;

    const payload = serializeSessionModelOverrides(sessionModelOverrideById());
    try {
      if (payload) {
        window.localStorage.setItem(sessionModelOverridesKey(workspaceId), payload);
      } else {
        window.localStorage.removeItem(sessionModelOverridesKey(workspaceId));
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const canReadConfig = openworkServerCanReadConfig();

    if (!openworkClient || !openworkWorkspaceId || !canReadConfig) {
      setAuthorizedFolders([]);
      setAuthorizedFolderDraft("");
      setAuthorizedFolderHiddenEntries({});
      setAuthorizedFoldersLoading(false);
      setAuthorizedFoldersStatus(null);
      setAuthorizedFoldersError(null);
      return;
    }

    let cancelled = false;
    setAuthorizedFolderDraft("");
    setAuthorizedFoldersLoading(true);
    setAuthorizedFoldersError(null);
    setAuthorizedFoldersStatus(null);

    const loadAuthorizedFolders = async () => {
      try {
        const config = await openworkClient.getConfig(openworkWorkspaceId);
        if (cancelled) return;
        const next = readAuthorizedFoldersFromConfig(ensureRecord(config.opencode));
        setAuthorizedFolders(next.folders);
        setAuthorizedFolderHiddenEntries(next.hiddenEntries);
        setAuthorizedFoldersStatus(
          buildAuthorizedFoldersStatus(Object.keys(next.hiddenEntries).length),
        );
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setAuthorizedFolders([]);
        setAuthorizedFolderHiddenEntries({});
        setAuthorizedFoldersError(message);
      } finally {
        if (!cancelled) {
          setAuthorizedFoldersLoading(false);
        }
      }
    };

    void loadAuthorizedFolders();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const persistAuthorizedFolders = async (nextFolders: string[]) => {
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    if (!openworkClient || !openworkWorkspaceId || !openworkServerCanWriteConfig()) {
      setAuthorizedFoldersError(
        "A writable OpenWork server workspace is required to update authorized folders.",
      );
      return false;
    }

    setAuthorizedFoldersSaving(true);
    setAuthorizedFoldersError(null);
    setAuthorizedFoldersStatus("Saving authorized folders...");

    try {
      const currentConfig = await openworkClient.getConfig(openworkWorkspaceId);
      const currentAuthorizedFolders = readAuthorizedFoldersFromConfig(
        ensureRecord(currentConfig.opencode),
      );
      const nextExternalDirectory = mergeAuthorizedFoldersIntoExternalDirectory(
        nextFolders,
        currentAuthorizedFolders.hiddenEntries,
      );

      await openworkClient.patchConfig(openworkWorkspaceId, {
        opencode: {
          permission: {
            external_directory: nextExternalDirectory,
          },
        },
      });
      setAuthorizedFolders(nextFolders);
      setAuthorizedFolderHiddenEntries(currentAuthorizedFolders.hiddenEntries);
      setAuthorizedFoldersStatus(
        buildAuthorizedFoldersStatus(
          Object.keys(currentAuthorizedFolders.hiddenEntries).length,
          "Authorized folders updated.",
        ),
      );
      markOpencodeConfigReloadRequired();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setAuthorizedFoldersError(message);
      setAuthorizedFoldersStatus(null);
      return false;
    } finally {
      setAuthorizedFoldersSaving(false);
    }
  };

  const addAuthorizedFolder = async () => {
    const normalized = normalizeAuthorizedFolderPath(authorizedFolderDraft());
    const workspaceRoot = normalizeAuthorizedFolderPath(workspaceStore.selectedWorkspaceRoot().trim());
    if (!normalized) return;
    if (workspaceRoot && normalized === workspaceRoot) {
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersStatus("Workspace root is already available.");
      setAuthorizedFoldersError(null);
      return;
    }
    if (authorizedFolders().includes(normalized)) {
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersStatus("Folder is already authorized.");
      setAuthorizedFoldersError(null);
      return;
    }

    const ok = await persistAuthorizedFolders([...authorizedFolders(), normalized]);
    if (ok) {
      setAuthorizedFolderDraft("");
    }
  };

  const removeAuthorizedFolder = async (folder: string) => {
    const nextFolders = authorizedFolders().filter((entry) => entry !== folder);
    await persistAuthorizedFolders(nextFolders);
  };

  const pickAuthorizedFolder = async () => {
    if (!isTauriRuntime()) return;
    try {
      const selection = await pickDirectory({ title: t("onboarding.authorize_folder", currentLocale()) });
      const folder = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      const normalized = normalizeAuthorizedFolderPath(folder);
      const workspaceRoot = normalizeAuthorizedFolderPath(workspaceStore.selectedWorkspaceRoot().trim());
      if (!normalized) return;
      setAuthorizedFolderDraft(normalized);
      if (workspaceRoot && normalized === workspaceRoot) {
        setAuthorizedFolderDraft("");
        setAuthorizedFoldersStatus("Workspace root is already available.");
        setAuthorizedFoldersError(null);
        return;
      }
      if (authorizedFolders().includes(normalized)) {
        setAuthorizedFoldersStatus("Folder is already authorized.");
        setAuthorizedFoldersError(null);
        return;
      }
      const ok = await persistAuthorizedFolders([...authorizedFolders(), normalized]);
      if (ok) {
        setAuthorizedFolderDraft("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setAuthorizedFoldersError(message);
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.selectedWorkspaceId();
    if (!workspaceId) return;

    setWorkspaceDefaultModelReady(false);
    const workspaceType = workspaceStore.selectedWorkspaceDisplay().workspaceType;
    const workspaceRoot = workspaceStore.selectedWorkspacePath().trim();
    const activeClient = client();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

    let cancelled = false;

    const applyDefault = async () => {
      let configDefault: ModelRef | null = null;
      let configFileContent: string | null = null;

      if (workspaceType === "local" && workspaceRoot) {
        if (canUseOpenworkServer) {
          try {
            const config = await openworkClient.getConfig(openworkWorkspaceId);
            const model = typeof config.opencode?.model === "string" ? config.opencode.model : null;
            configDefault = parseModelRef(model);
          } catch {
            // ignore
          }
        } else if (isTauriRuntime()) {
          try {
            const configFile = await readOpencodeConfig("project", workspaceRoot);
            configFileContent = configFile.content;
            configDefault = parseDefaultModelFromConfig(configFile.content);
          } catch {
            // ignore
          }
        }
      } else if (activeClient) {
        try {
          const config = unwrap(
            await activeClient.config.get({ directory: workspaceRoot || undefined })
          );
          if (typeof config.model === "string") {
            configDefault = parseModelRef(config.model);
          }
        } catch {
          // ignore
        }
      }

      setDefaultModelExplicit(Boolean(configDefault));
      const nextDefault = configDefault ?? legacyDefaultModel();
      const currentDefault = untrack(defaultModel);
      if (nextDefault && !modelEquals(currentDefault, nextDefault)) {
        setDefaultModel(nextDefault);
      }

      if (workspaceType === "local" && workspaceRoot) {
        setLastKnownConfigSnapshot(getConfigSnapshot(configFileContent));
      }

      if (!cancelled) {
        setWorkspaceDefaultModelReady(true);
      }
    };

    void applyDefault();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!workspaceDefaultModelReady()) return;
    if (!isTauriRuntime()) return;
    if (!defaultModelExplicit()) return;

    const workspace = workspaceStore.selectedWorkspaceDisplay();
    if (workspace.workspaceType !== "local") return;

    const root = workspaceStore.selectedWorkspacePath().trim();
    if (!root) return;
    const nextModel = defaultModel();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;
    let cancelled = false;

    const writeConfig = async () => {
      try {
        if (canUseOpenworkServer) {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          const currentModel = typeof config.opencode?.model === "string" ? parseModelRef(config.opencode.model) : null;
          if (currentModel && modelEquals(currentModel, nextModel)) return;

          await openworkClient.patchConfig(openworkWorkspaceId, {
            opencode: { model: formatModelRef(nextModel) },
          });
          markOpencodeConfigReloadRequired();
          return;
        }

        const configFile = await readOpencodeConfig("project", root);
        const existingModel = parseDefaultModelFromConfig(configFile.content);
        if (existingModel && modelEquals(existingModel, nextModel)) return;

        const content = formatConfigWithDefaultModel(configFile.content, nextModel);
        const result = await writeOpencodeConfig("project", root, content);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
        setLastKnownConfigSnapshot(getConfigSnapshot(content));
        markOpencodeConfigReloadRequired();
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      }
    };

    void writeConfig();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const workspaceId = workspaceStore.selectedWorkspaceId();
    if (!workspaceId) {
      setAutoCompactContext(true);
      setAutoCompactContextApplied(true);
      setAutoCompactContextDirty(false);
      setAutoCompactContextReady(false);
      setAutoCompactContextSaving(false);
      return;
    }

    const workspace = workspaceStore.selectedWorkspaceDisplay();
    const root = workspaceStore.selectedWorkspacePath().trim();
    const activeClient = client();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

    let cancelled = false;
    setAutoCompactContextReady(false);
    setAutoCompactContextDirty(false);

    const loadAutoCompactContext = async () => {
      let nextValue = true;

      if (canUseOpenworkServer) {
        try {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          nextValue = readAutoCompactContextFromRecord(config.opencode) ?? true;
        } catch {
          // ignore
        }
      } else if (workspace.workspaceType === "local" && root && isTauriRuntime()) {
        try {
          const configFile = await readOpencodeConfig("project", root);
          nextValue = parseAutoCompactContextFromConfig(configFile.content) ?? true;
        } catch {
          // ignore
        }
      } else if (activeClient) {
        try {
          const config = unwrap(await activeClient.config.get({ directory: root || undefined }));
          nextValue = readAutoCompactContextFromRecord(config) ?? true;
        } catch {
          // ignore
        }
      }

      if (cancelled) return;
      setAutoCompactContext(nextValue);
      setAutoCompactContextApplied(nextValue);
      setAutoCompactContextReady(true);
    };

    void loadAutoCompactContext();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!autoCompactContextReady()) return;
    if (!autoCompactContextDirty()) return;

    const nextValue = autoCompactContext();
    const appliedValue = autoCompactContextApplied();
    const workspace = workspaceStore.selectedWorkspaceDisplay();
    const root = workspaceStore.selectedWorkspacePath().trim();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;

    let cancelled = false;
    setAutoCompactContextSaving(true);

    const persistAutoCompactContext = async () => {
      try {
        if (canUseOpenworkServer) {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          const currentValue = readAutoCompactContextFromRecord(config.opencode) ?? true;
          if (currentValue !== nextValue) {
            await openworkClient.patchConfig(openworkWorkspaceId, {
              opencode: {
                compaction: {
                  auto: nextValue,
                },
              },
            });
            markOpencodeConfigReloadRequired();
          }
          if (cancelled) return;
          setAutoCompactContextApplied(nextValue);
          setAutoCompactContextDirty(false);
          return;
        }

        if (workspace.workspaceType !== "local" || !root || !isTauriRuntime()) {
          throw new Error(
            "Auto context compaction can only be changed for a local workspace or a writable OpenWork server workspace.",
          );
        }

        const configFile = await readOpencodeConfig("project", root);
        const currentValue = parseAutoCompactContextFromConfig(configFile.content) ?? true;
        if (currentValue !== nextValue) {
          const content = formatConfigWithAutoCompactContext(configFile.content, nextValue);
          const result = await writeOpencodeConfig("project", root, content);
          if (!result.ok) {
            throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
          }
          setLastKnownConfigSnapshot(getConfigSnapshot(content));
          markOpencodeConfigReloadRequired();
        }

        if (cancelled) return;
        setAutoCompactContextApplied(nextValue);
        setAutoCompactContextDirty(false);
      } catch (error) {
        if (cancelled) return;
        setAutoCompactContext(appliedValue);
        setAutoCompactContextDirty(false);
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      } finally {
        setAutoCompactContextSaving(false);
      }
    };

    void persistAutoCompactContext();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (onboardingStep() !== "local") return;
    void workspaceStore.refreshEngineDoctor();
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
      window.localStorage.setItem(
        "openwork.clientDirectory",
        clientDirectory()
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    // Legacy key: keep for backwards compatibility.
    try {
      window.localStorage.setItem("openwork.projectDir", workspaceProjectDir());
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
    try {
      const value = engineCustomBinPath().trim();
      if (value) {
        window.localStorage.setItem("openwork.engineCustomBinPath", value);
      } else {
        window.localStorage.removeItem("openwork.engineCustomBinPath");
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.engineRuntime", engineRuntime());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.opencodeEnableExa",
        opencodeEnableExa() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        MODEL_PREF_KEY,
        formatModelRef(defaultModel())
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.updateAutoCheck",
        updateAutoCheck() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.updateAutoDownload",
        updateAutoDownload() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        THINKING_PREF_KEY,
        JSON.stringify(showThinking())
      );
    } catch {
      // ignore
    }
  });

  // Persist and apply hideTitlebar setting
  createEffect(() => {
    if (typeof window === "undefined") return;
    const hide = hideTitlebar();
    try {
      window.localStorage.setItem(HIDE_TITLEBAR_PREF_KEY, JSON.stringify(hide));
    } catch {
      // ignore
    }
    // Apply to window decorations (only in Tauri desktop environment)
    if (isTauriRuntime()) {
      setWindowDecorations(!hide).catch(() => {
        // ignore errors (e.g., window not ready)
      });
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const map = modelVariantMap();
      if (Object.keys(map).length > 0) {
        window.localStorage.setItem(VARIANT_PREF_KEY, JSON.stringify(map));
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
        window.localStorage.setItem(
          "openwork.updateLastCheckedAt",
          String(state.lastCheckedAt)
        );
      } catch {
        // ignore
      }
    }
  });

  createEffect(() => {
    if (booting()) return;
    if (!isTauriRuntime()) return;
    if (launchUpdateCheckTriggered()) return;

    const state = updateStatus();
    if (state.state === "checking" || state.state === "downloading") return;

    setLaunchUpdateCheckTriggered(true);
    checkForUpdates({ quiet: true }).catch(() => undefined);
  });

  createEffect(() => {
    if (booting()) return;
    if (typeof window === "undefined") return;
    if (!isTauriRuntime()) return;
    if (!launchUpdateCheckTriggered()) return;
    if (!updateAutoCheck()) return;

    const maybeRunAutoUpdateCheck = () => {
      if (!updateAutoCheck()) return;
      const state = updateStatus();
      if (state.state === "checking" || state.state === "downloading") return;
      if (!shouldAutoCheckForUpdates()) return;
      checkForUpdates({ quiet: true }).catch(() => undefined);
    };

    const interval = window.setInterval(maybeRunAutoUpdateCheck, UPDATE_AUTO_CHECK_POLL_MS);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!updateAutoDownload()) return;

    const state = updateStatus();
    if (state.state !== "available") return;
    if (!pendingUpdate()) return;

    downloadUpdate().catch(() => undefined);
  });

  const headerConnectedVersion = createMemo(() => {
    const fallbackVersion = connectedVersion()?.trim() ?? "";
    if (!developerMode()) {
      return fallbackVersion || null;
    }

    const openworkVersion =
      appVersion()?.trim() ||
      openworkServerDiagnostics()?.version?.trim() ||
      "";
    if (!openworkVersion) {
      return fallbackVersion || null;
    }

    const normalizedVersion = openworkVersion.startsWith("v")
      ? openworkVersion
      : `v${openworkVersion}`;
    return `OpenWork ${normalizedVersion}`;
  });

  const headerStatus = createMemo(() => {
    if (!client() || !headerConnectedVersion()) return t("status.disconnected", currentLocale());
    const bits = [`${t("status.connected", currentLocale())} · ${headerConnectedVersion()}`];
    if (sseConnected()) bits.push(t("status.live", currentLocale()));
    return bits.join(" · ");
  });

  const busyHint = createMemo(() => {
    if (!busy() || !busyLabel()) return null;
    const seconds = busySeconds();
    const label = t(busyLabel()!, currentLocale());
    return seconds > 0 ? `${label} · ${seconds}s` : label;
  });

  const workspaceSwitchWorkspace = createMemo(() => {
    const switchingId = workspaceStore.connectingWorkspaceId();
    if (switchingId) {
      return workspaceStore.workspaces().find((ws) => ws.id === switchingId) ?? selectedWorkspaceDisplay();
    }
    return selectedWorkspaceDisplay();
  });

  // Avoid flashing the full-screen switch overlay for fast workspace switches.
  // Only show it if a switch is still in progress after a short delay.
  const [workspaceSwitchDelayElapsed, setWorkspaceSwitchDelayElapsed] = createSignal(false);
  createEffect(() => {
    if (typeof window === "undefined") return;
    const switchingId = workspaceStore.connectingWorkspaceId();
    if (!switchingId) {
      setWorkspaceSwitchDelayElapsed(false);
      return;
    }

    setWorkspaceSwitchDelayElapsed(false);
    const timer = window.setTimeout(() => setWorkspaceSwitchDelayElapsed(true), 250);
    onCleanup(() => window.clearTimeout(timer));
  });

  const workspaceSwitchOpen = createMemo(() => {
    if (booting()) return true;
    if (workspaceStore.connectingWorkspaceId()) return workspaceSwitchDelayElapsed();
    if (!busy() || !busyLabel()) return false;
    const label = busyLabel();
    return (
      label === "status.starting_engine" ||
      label === "status.restarting_engine"
    );
  });

  const workspaceSwitchStatusKey = createMemo(() => {
    const label = busyLabel();
    if (label === "status.connecting") return "workspace.switching_status_connecting";
    if (label === "status.starting_engine" || label === "status.restarting_engine") {
      return "workspace.switching_status_preparing";
    }
    if (label === "status.loading_session") return "workspace.switching_status_loading";
    if (workspaceStore.connectingWorkspaceId()) return "workspace.switching_status_loading";
    if (booting()) return "workspace.switching_status_preparing";
    return "workspace.switching_status_preparing";
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

  const onboardingProps = () => ({
    startupPreference: startupPreference(),
    onboardingStep: onboardingStep(),
    rememberStartupChoice: rememberStartupChoice(),
    busy: busy(),
    clientDirectory: clientDirectory(),
    openworkHostUrl: openworkServerSettings().urlOverride ?? "",
    openworkToken: openworkServerSettings().token ?? "",
    newAuthorizedDir: newAuthorizedDir(),
    authorizedDirs: workspaceStore.authorizedDirs(),
    selectedWorkspacePath: workspaceStore.selectedWorkspacePath(),
    workspaces: workspaceStore.workspaces(),
    localHostLabel: localHostLabel(),
    engineRunning: Boolean(engine()?.running),
    developerMode: developerMode(),
    engineBaseUrl: engine()?.baseUrl ?? null,
    engineDoctorFound: engineDoctorResult()?.found ?? null,
    engineDoctorSupportsServe: engineDoctorResult()?.supportsServe ?? null,
    engineDoctorVersion: engineDoctorResult()?.version ?? null,
    engineDoctorResolvedPath: engineDoctorResult()?.resolvedPath ?? null,
    engineDoctorNotes: engineDoctorResult()?.notes ?? [],
    engineDoctorServeHelpStdout: engineDoctorResult()?.serveHelpStdout ?? null,
    engineDoctorServeHelpStderr: engineDoctorResult()?.serveHelpStderr ?? null,
    engineDoctorCheckedAt: engineDoctorCheckedAt(),
    engineInstallLogs: engineInstallLogs(),
    error: error(),
    canRepairMigration: workspaceStore.canRepairOpencodeMigration(),
    migrationRepairUnavailableReason: migrationRepairUnavailableReason(),
    migrationRepairBusy: workspaceStore.migrationRepairBusy(),
    migrationRepairResult: workspaceStore.migrationRepairResult(),
    isWindows: isWindowsPlatform(),
    onClientDirectoryChange: setClientDirectory,
    onOpenworkHostUrlChange: (value: string) =>
      updateOpenworkServerSettings({
        ...openworkServerSettings(),
        urlOverride: value,
      }),
    onOpenworkTokenChange: (value: string) =>
      updateOpenworkServerSettings({
        ...openworkServerSettings(),
        token: value,
      }),
    onSelectStartup: workspaceStore.onSelectStartup,
    onRememberStartupToggle: workspaceStore.onRememberStartupToggle,
    onStartHost: workspaceStore.onStartHost,
    onRepairMigration: workspaceStore.onRepairOpencodeMigration,
    onCreateWorkspace: workspaceStore.createWorkspaceFlow,
    onPickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
    onImportWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
    onAttachHost: workspaceStore.onAttachHost,
    onConnectClient: workspaceStore.onConnectClient,
    onBackToWelcome: workspaceStore.onBackToWelcome,
    onSetAuthorizedDir: workspaceStore.setNewAuthorizedDir,
    onAddAuthorizedDir: workspaceStore.addAuthorizedDir,
    onAddAuthorizedDirFromPicker: () =>
      workspaceStore.addAuthorizedDirFromPicker({ persistToWorkspace: true }),
    onRemoveAuthorizedDir: workspaceStore.removeAuthorizedDirAtIndex,
    onRefreshEngineDoctor: async () => {
      workspaceStore.setEngineInstallLogs(null);
      await workspaceStore.refreshEngineDoctor();
    },
    onInstallEngine: workspaceStore.onInstallEngine,
    onShowSearchNotes: () => {
      const notes =
        workspaceStore.engineDoctorResult()?.notes?.join("\n") ?? "";
      workspaceStore.setEngineInstallLogs(notes || null);
    },
    onOpenSettings: () => {
      setTab("settings");
      setView("dashboard");
    },
    onOpenAdvancedSettings: () => {
      setTab("config");
      setView("dashboard");
    },
    themeMode: themeMode(),
    setThemeMode,
  });

  const dashboardProps = () => {
    const workspaceType = selectedWorkspaceDisplay().workspaceType;
    const isRemoteWorkspace = workspaceType === "remote";
    const providerAuthWorkerType: "local" | "remote" = isRemoteWorkspace ? "remote" : "local";
    const openworkStatus = openworkServerStatus();
    const canUseDesktopTools = isTauriRuntime() && !isRemoteWorkspace;
    const canInstallSkillCreator = isRemoteWorkspace
      ? openworkServerCanWriteSkills()
      : isTauriRuntime();
    const canEditPlugins = isRemoteWorkspace
      ? openworkServerCanWritePlugins()
      : isTauriRuntime();
    const canUseGlobalPluginScope = !isRemoteWorkspace && isTauriRuntime();
    const skillsAccessHint = isRemoteWorkspace
      ? openworkStatus === "disconnected"
        ? "OpenWork server unavailable. Add the server URL/token in Advanced to manage skills."
        : openworkStatus === "limited"
          ? "OpenWork server needs a host token to install/update skills. Add it in Advanced and reconnect."
          : openworkServerCanWriteSkills()
            ? null
            : "OpenWork server is read-only for skills. Add a host token in Advanced to enable installs."
      : null;
    const pluginsAccessHint = isRemoteWorkspace
      ? openworkStatus === "disconnected"
        ? "OpenWork server unavailable. Plugins are read-only."
        : openworkStatus === "limited"
          ? "OpenWork server needs a token to edit plugins."
          : openworkServerCanWritePlugins()
            ? null
            : "OpenWork server is read-only for plugins."
      : null;

    return {
      tab: tab(),
      setTab,
      settingsTab: settingsTab(),
      setSettingsTab,
      providers: providers(),
      providerConnectedIds: providerConnectedIds(),
      providerAuthBusy: providerAuthBusy(),
      providerAuthModalOpen: providerAuthModalOpen(),
      providerAuthError: providerAuthError(),
      providerAuthMethods: providerAuthMethods(),
      providerAuthPreferredProviderId: providerAuthPreferredProviderId(),
      providerAuthWorkerType,
      openProviderAuthModal,
      disconnectProvider,
      closeProviderAuthModal,
      startProviderAuth,
      completeProviderAuthOAuth,
      refreshProviders,
      submitProviderApiKey,
      view: currentView(),
      setView,
      toggleSettings: () => toggleSettingsView("general"),
      startupPreference: startupPreference(),
      baseUrl: baseUrl(),
      clientConnected: Boolean(client()),
      busy: busy(),
      busyHint: busyHint(),
      busyLabel: busyLabel(),
      newTaskDisabled: newTaskDisabled(),
      headerStatus: headerStatus(),
      error: error(),
      openworkServerStatus: openworkStatus,
      openworkServerUrl: openworkServerUrl(),
      openworkServerClient: openworkServerClient(),
      openworkReconnectBusy: openworkReconnectBusy(),
      reconnectOpenworkServer,
      openworkServerSettings: openworkServerSettings(),
      openworkServerHostInfo: openworkServerHostInfo(),
      shareRemoteAccessBusy: shareRemoteAccessBusy(),
      shareRemoteAccessError: shareRemoteAccessError(),
      saveShareRemoteAccess,
      openworkServerCapabilities: devtoolsCapabilities(),
      openworkServerDiagnostics: openworkServerDiagnostics(),
      runtimeWorkspaceId: runtimeWorkspaceId(),
      activeWorkspaceType: workspaceStore.selectedWorkspaceDisplay().workspaceType,
      openworkAuditEntries: openworkAuditEntries(),
      openworkAuditStatus: openworkAuditStatus(),
      openworkAuditError: openworkAuditError(),
      opencodeConnectStatus: opencodeConnectStatus(),
      engineInfo: workspaceStore.engine(),
      orchestratorStatus: orchestratorStatusState(),
      opencodeRouterInfo: opencodeRouterInfoState(),
      engineDoctorVersion: workspaceStore.engineDoctorResult()?.version ?? null,
      updateOpenworkServerSettings,
      resetOpenworkServerSettings,
      testOpenworkServerConnection,
      canReloadWorkspace: canReloadWorkspace(),
      reloadWorkspaceEngine: reloadWorkspaceEngineAndResume,
      reloadBusy: reloadBusy(),
      reloadError: reloadError(),
      workspaceAutoReloadAvailable: workspaceAutoReloadAvailable(),
      workspaceAutoReloadEnabled: workspaceAutoReloadEnabled(),
      setWorkspaceAutoReloadEnabled,
      workspaceAutoReloadResumeEnabled: workspaceAutoReloadResumeEnabled(),
      setWorkspaceAutoReloadResumeEnabled,
      selectedWorkspaceDisplay: selectedWorkspaceDisplay(),
      workspaces: workspaceStore.workspaces(),
      selectedWorkspaceId: workspaceStore.selectedWorkspaceId(),
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
      workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
      selectWorkspace: workspaceStore.selectWorkspace,
      ensureWorkspaceActivated: workspaceStore.ensureWorkspaceActivated,
      testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
      recoverWorkspace: workspaceStore.recoverWorkspace,
      openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
      getStartedWorkspace: workspaceStore.quickStartWorkspaceFlow,
      pickFolderWorkspace: workspaceStore.createWorkspaceFromPickedFolder,
      openCreateRemoteWorkspace: () => workspaceStore.setCreateRemoteWorkspaceOpen(true),
      connectRemoteWorkspace: workspaceStore.createRemoteWorkspaceFlow,
      openCloudTemplate,
      importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
      importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
      exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
      exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
      createWorkspaceOpen: workspaceStore.createWorkspaceOpen(),
      setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
      createWorkspaceFlow: workspaceStore.createWorkspaceFlow,
      pickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
      workspaceSessionGroups: sidebarWorkspaceGroups(),
      selectedSessionId: activeSessionId(),
      openRenameWorkspace,
      editWorkspaceConnection: openWorkspaceConnectionSettings,
      forgetWorkspace: workspaceStore.forgetWorkspace,
      stopSandbox: workspaceStore.stopSandbox,
      scheduledJobs: scheduledJobs(),
      scheduledJobsSource: scheduledJobsSource(),
      scheduledJobsSourceReady: scheduledJobsSourceReady(),
      schedulerPluginInstalled: schedulerPluginInstalled(),
      scheduledJobsStatus: scheduledJobsStatus(),
      scheduledJobsBusy: scheduledJobsBusy(),
      scheduledJobsUpdatedAt: scheduledJobsUpdatedAt(),
      refreshScheduledJobs: (options?: { force?: boolean }) =>
        refreshScheduledJobs(options).catch(() => undefined),
      deleteScheduledJob,
      selectedWorkspaceRoot: workspaceStore.selectedWorkspaceRoot().trim(),
      isRemoteWorkspace: workspaceStore.selectedWorkspaceDisplay().workspaceType === "remote",
      refreshSkills: (options?: { force?: boolean }) => refreshSkills(options).catch(() => undefined),
      refreshHubSkills: (options?: { force?: boolean }) => refreshHubSkills(options).catch(() => undefined),
      refreshPlugins: (scopeOverride?: PluginScope) =>
        refreshPlugins(scopeOverride).catch(() => undefined),
      skills: skills(),
      skillsStatus: skillsStatus(),
      hubSkills: hubSkills(),
      hubSkillsStatus: hubSkillsStatus(),
      hubRepo: hubRepo(),
      hubRepos: hubRepos(),
      skillsAccessHint,
      canInstallSkillCreator,
      canUseDesktopTools,
      importLocalSkill,
      installSkillCreator,
      installHubSkill,
      setHubRepo,
      addHubRepo,
      removeHubRepo,
      revealSkillsFolder,
      uninstallSkill,
      readSkill,
      saveSkill,
      pluginsAccessHint,
      canEditPlugins,
      canUseGlobalPluginScope,
      pluginScope: pluginScope(),
      setPluginScope,
      pluginConfigPath: pluginConfigPath() ?? pluginConfig()?.path ?? null,
      pluginList: pluginList(),
      pluginInput: pluginInput(),
      setPluginInput,
      pluginStatus: pluginStatus(),
      activePluginGuide: activePluginGuide(),
      setActivePluginGuide,
      isPluginInstalled: isPluginInstalledByName,
      suggestedPlugins: SUGGESTED_PLUGINS,
      addPlugin,
      removePlugin,
      createSessionAndOpen,
      setPrompt,
      selectSession: selectSession,
      defaultModelLabel: formatModelLabel(defaultModel(), providers()),
      defaultModelRef: formatModelRef(defaultModel()),
      openDefaultModelPicker,
      showThinking: showThinking(),
      toggleShowThinking: () => setShowThinking((v) => !v),
      autoCompactContext: autoCompactContext(),
      toggleAutoCompactContext,
      autoCompactContextBusy: autoCompactContextSaving(),
      hideTitlebar: hideTitlebar(),
      toggleHideTitlebar: () => setHideTitlebar((v) => !v),
      modelVariantLabel: getModelBehaviorCopy(defaultModel(), getVariantFor(defaultModel())).label,
      editModelVariant: openDefaultModelPicker,
      updateAutoCheck: updateAutoCheck(),
      toggleUpdateAutoCheck: () => setUpdateAutoCheck((v) => !v),
      updateAutoDownload: updateAutoDownload(),
      toggleUpdateAutoDownload: () =>
        setUpdateAutoDownload((v) => {
          const next = !v;
          if (next) {
            setUpdateAutoCheck(true);
          }
          return next;
        }),
      updateStatus: updateStatus(),
      updateEnv: updateEnv(),
      appVersion: appVersion(),
      checkForUpdates: () => checkForUpdates(),
      downloadUpdate: () => downloadUpdate(),
      installUpdateAndRestart,
      anyActiveRuns: anyActiveRuns(),
      engineSource: engineSource(),
      setEngineSource,
      engineCustomBinPath: engineCustomBinPath(),
      setEngineCustomBinPath,
      engineRuntime: engineRuntime(),
      setEngineRuntime,
      opencodeEnableExa: opencodeEnableExa(),
      toggleOpencodeEnableExa: () => setOpencodeEnableExa((v) => !v),
      isWindows: isWindowsPlatform(),
      toggleDeveloperMode: () => setDeveloperMode((v) => !v),
      developerMode: developerMode(),
      stopHost,
      restartLocalServer,
      openResetModal,
      resetModalBusy: resetModalBusy(),
      onResetStartupPreference: () => {
        clearStartupPreference();
        setStartupPreference(null);
        setRememberStartupChoice(false);
      },
      themeMode: themeMode(),
      setThemeMode,
      pendingPermissions: pendingPermissions(),
      events: events(),
      workspaceDebugEvents: workspaceStore.workspaceDebugEvents(),
      sandboxCreateProgress: workspaceStore.sandboxCreateProgress(),
      sandboxCreateProgressLast: workspaceStore.lastSandboxCreateProgress(),
      clearWorkspaceDebugEvents: workspaceStore.clearWorkspaceDebugEvents,
      safeStringify,
      repairOpencodeMigration: workspaceStore.repairOpencodeMigration,
      migrationRepairBusy: workspaceStore.migrationRepairBusy(),
      migrationRepairResult: workspaceStore.migrationRepairResult(),
      migrationRepairAvailable: workspaceStore.canRepairOpencodeMigration(),
      migrationRepairUnavailableReason: migrationRepairUnavailableReason(),
      repairOpencodeCache,
      cacheRepairBusy: cacheRepairBusy(),
      cacheRepairResult: cacheRepairResult(),
      cleanupOpenworkDockerContainers,
      dockerCleanupBusy: dockerCleanupBusy(),
      dockerCleanupResult: dockerCleanupResult(),
      authorizedFolders: authorizedFolders(),
      authorizedFolderDraft: authorizedFolderDraft(),
      setAuthorizedFolderDraft,
      authorizedFoldersLoading: authorizedFoldersLoading(),
      authorizedFoldersSaving: authorizedFoldersSaving(),
      authorizedFoldersError: authorizedFoldersError(),
      authorizedFoldersStatus: authorizedFoldersStatus(),
      authorizedFoldersAvailable: openworkServerCanReadConfig(),
      authorizedFoldersEditable: openworkServerCanWriteConfig(),
      authorizedFoldersHint: !openworkServerReady()
        ? "OpenWork server is disconnected."
        : !openworkServerWorkspaceReady()
          ? "No active server workspace is selected."
          : !openworkServerCanReadConfig()
            ? "OpenWork server config access is unavailable for this workspace."
            : !openworkServerCanWriteConfig()
              ? "OpenWork server is connected read-only for workspace config."
              : null,
      addAuthorizedFolder,
      pickAuthorizedFolder,
      removeAuthorizedFolder,
      resetAppConfigDefaults,
      notionStatus: notionStatus(),
      notionStatusDetail: notionStatusDetail(),
      notionError: notionError(),
      notionBusy: notionBusy(),
      connectNotion,
      openDebugDeepLink,
      mcpServers: mcpServers(),
      mcpStatus: mcpStatus(),
      mcpLastUpdatedAt: mcpLastUpdatedAt(),
      mcpStatuses: mcpStatuses(),
      mcpConnectingName: mcpConnectingName(),
      selectedMcp: selectedMcp(),
      setSelectedMcp,
      readConfigFile: readMcpConfigFile,
      quickConnect: MCP_QUICK_CONNECT,
      connectMcp,
      authorizeMcp,
      logoutMcpAuth,
      removeMcp,
      refreshMcpServers,
      language: currentLocale(),
      setLanguage: setLocale,
    };
  };

  const searchWorkspaceFiles = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const activeClient = client();
    if (!activeClient) return [];
    try {
      const directory = workspaceProjectDir().trim();
      const result = unwrap(
        await activeClient.find.files({
          query: trimmed,
          dirs: "true",
          limit: 50,
          directory: directory || undefined,
        }),
      );
      return result;
    } catch {
      return [];
    }
  };

  const sessionProps = () => ({
    providerAuthWorkerType: (selectedWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local") as
      | "remote"
      | "local",
    selectedSessionId: activeSessionId(),
    setView,
    tab: tab(),
    settingsTab: settingsTab(),
    setTab,
    setSettingsTab,
    toggleSettings: () => toggleSettingsView("general"),
    selectedWorkspaceDisplay: selectedWorkspaceDisplay(),
    selectedWorkspaceRoot: workspaceStore.selectedWorkspaceRoot().trim(),
    activeWorkspaceConfig: resolvedActiveWorkspaceConfig(),
    workspaces: workspaceStore.workspaces(),
    selectedWorkspaceId: workspaceStore.selectedWorkspaceId(),
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
    selectWorkspace: workspaceStore.selectWorkspace,
    ensureWorkspaceActivated: workspaceStore.ensureWorkspaceActivated,
    testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
    recoverWorkspace: workspaceStore.recoverWorkspace,
    editWorkspaceConnection: openWorkspaceConnectionSettings,
    forgetWorkspace: workspaceStore.forgetWorkspace,
    openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
    getStartedWorkspace: workspaceStore.quickStartWorkspaceFlow,
    pickFolderWorkspace: workspaceStore.createWorkspaceFromPickedFolder,
    openCreateRemoteWorkspace: () => workspaceStore.setCreateRemoteWorkspaceOpen(true),
    importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
    exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
    exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
    clientConnected: Boolean(client()),
    openworkServerStatus: openworkServerStatus(),
    openworkServerClient: openworkServerClient(),
    openworkServerDiagnostics: openworkServerDiagnostics(),
    openworkServerSettings: openworkServerSettings(),
    openworkServerHostInfo: openworkServerHostInfo(),
    shareRemoteAccessBusy: shareRemoteAccessBusy(),
    shareRemoteAccessError: shareRemoteAccessError(),
    saveShareRemoteAccess,
    runtimeWorkspaceId: runtimeWorkspaceId(),
    engineInfo: workspaceStore.engine(),
    engineDoctorVersion: workspaceStore.engineDoctorResult()?.version ?? null,
    orchestratorStatus: orchestratorStatusState(),
    opencodeRouterInfo: opencodeRouterInfoState(),
    appVersion: appVersion(),
    stopHost,
    headerStatus: headerStatus(),
    busyHint: busyHint(),
    updateStatus: updateStatus(),
    updateEnv: updateEnv(),
    anyActiveRuns: anyActiveRuns(),
    installUpdateAndRestart,
    selectedSessionModelLabel: selectedSessionModelLabel(),
    selectedProviderID: selectedSessionModel().providerID,
    openSessionModelPicker: openSessionModelPicker,
    modelVariantLabel: getModelBehaviorCopy(selectedSessionModel(), getVariantFor(selectedSessionModel())).label,
    modelVariant: getVariantFor(selectedSessionModel()),
    modelBehaviorOptions: getModelBehaviorCopy(selectedSessionModel(), getVariantFor(selectedSessionModel())).options,
    setModelVariant: (value: string | null) => updateModelVariant(selectedSessionModel(), value),
    activePlugins: sidebarPluginList(),
    activePluginStatus: sidebarPluginStatus(),
    mcpServers: mcpServers(),
    mcpStatuses: mcpStatuses(),
    mcpStatus: mcpStatus(),
    skills: skills(),
    skillsStatus: skillsStatus(),
    createSessionAndOpen: createSessionAndOpen,
    sendPromptAsync: sendPrompt,
    abortSession: abortSession,
    sessionRevertMessageId: selectedSession()?.revert?.messageID ?? null,
    undoLastUserMessage: undoLastUserMessage,
    redoLastUserMessage: redoLastUserMessage,
    compactSession: compactCurrentSession,
    lastPromptSent: lastPromptSent(),
    retryLastPrompt: retryLastPrompt,
    newTaskDisabled: newTaskDisabled(),
    workspaceSessionGroups: sidebarWorkspaceGroups(),
    openRenameWorkspace,
    selectSession: selectSession,
    messages: visibleMessages(),
    getSessionById: sessionById,
    getMessagesBySessionId: messagesBySessionId,
    ensureSessionLoaded,
    sessionLoadingById,
    todos: activeTodos(),
    busyLabel: busyLabel(),
    developerMode: developerMode(),
    showThinking: showThinking(),
    sessionCompactionState: selectedSessionCompactionState(),
    groupMessageParts,
    summarizeStep,
    expandedStepIds: expandedStepIds(),
    setExpandedStepIds: setExpandedStepIds,
    expandedSidebarSections: expandedSidebarSections(),
    setExpandedSidebarSections: setExpandedSidebarSections,
    workingFiles: activeWorkingFiles(),
    authorizedDirs: activeAuthorizedDirs(),
    busy: busy(),
    prompt: prompt(),
    setPrompt: setPrompt,
    activePermission: activePermissionMemo(),
    permissionReplyBusy: permissionReplyBusy(),
    respondPermission: respondPermission,
    respondPermissionAndRemember: respondPermissionAndRemember,
    activeQuestion: activeQuestion(),
    questionReplyBusy: questionReplyBusy(),
    respondQuestion: respondQuestion,
    safeStringify: safeStringify,
    showTryNotionPrompt: tryNotionPromptVisible() && notionIsActive(),
    startProviderAuth: startProviderAuth,
    completeProviderAuthOAuth: completeProviderAuthOAuth,
    refreshProviders: refreshProviders,
    submitProviderApiKey: submitProviderApiKey,
    openProviderAuthModal: openProviderAuthModal,
    closeProviderAuthModal: closeProviderAuthModal,
    providerAuthModalOpen: providerAuthModalOpen(),
    providerAuthBusy: providerAuthBusy(),
    providerAuthError: providerAuthError(),
    providerAuthMethods: providerAuthMethods(),
    providerAuthPreferredProviderId: providerAuthPreferredProviderId(),
    providers: providers(),
    providerConnectedIds: providerConnectedIds(),
    listAgents: listAgents,
    listCommands: listCommands,
    selectedSessionAgent: selectedSessionAgent(),
    setSessionAgent: setSessionAgent,
    saveSession: saveSessionExport,
    sessionStatusById: activeSessionStatusById(),
    hasEarlierMessages: selectedSessionHasEarlierMessages(),
    loadingEarlierMessages: selectedSessionLoadingEarlierMessages(),
    loadEarlierMessages,
    searchFiles: searchWorkspaceFiles,
    deleteSession: deleteSessionById,
    onTryNotionPrompt: () => {
      setPrompt("setup my crm");
      setTryNotionPromptVisible(false);
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("openwork.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
    },
    sessionStatus: selectedSessionStatus(),
    renameSession: renameSessionTitle,
    error: error(),
  });

  const dashboardTabs = new Set<DashboardTab>([
    "scheduled",
    "skills",
    "plugins",
    "mcp",
    "identities",
    "config",
    "settings",
  ]);

  const resolveDashboardTab = (value?: string | null) => {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (dashboardTabs.has(normalized as DashboardTab)) {
      return normalized as DashboardTab;
    }
    return "scheduled";
  };

  const initialRoute = () => {
    if (typeof window === "undefined") return "/session";
    return "/session";
  };

  createEffect(() => {
    const rawPath = location.pathname.trim();
    const path = rawPath.toLowerCase();

    if (path === "" || path === "/") {
      navigate(initialRoute(), { replace: true });
      return;
    }

    if (path.startsWith("/dashboard")) {
      const [, , tabSegment] = path.split("/");
      const resolvedTab = resolveDashboardTab(tabSegment);

      if (resolvedTab !== tab()) {
        setTabState(resolvedTab);
      }
      if (!tabSegment || tabSegment !== resolvedTab) {
        goToDashboard(resolvedTab, { replace: true });
      }
      return;
    }

    if (path.startsWith("/session")) {
      const [, , sessionSegment] = rawPath.split("/");
      const id = (sessionSegment ?? "").trim();

      if (!id) {
        if (selectedSessionId()) {
          setSelectedSessionId(null);
          setMessages([]);
          setTodos([]);
        }
        return;
      }

      // If the URL points at a session that no longer exists (e.g. after deletion),
      // route back to /session so the app can fall back safely.
      if (
        sessionsLoaded() &&
        shouldRedirectMissingSessionAfterScopedLoad({
          loadedScopeRoot: loadedSessionScopeRoot(),
          workspaceRoot: workspaceStore.selectedWorkspaceRoot().trim(),
          hasMatchingSession: sessions().some((session) => session.id === id),
        })
      ) {
        if (selectedSessionId() === id) {
          setSelectedSessionId(null);
        }
        navigate("/session", { replace: true });
        return;
      }

      if (selectedSessionId() !== id) {
        void selectSession(id);
      }
      return;
    }

    if (path.startsWith("/proto-v1-ux")) {
      if (isTauriRuntime()) {
        navigate("/dashboard/scheduled", { replace: true });
      }
      return;
    }

    if (path.startsWith("/proto")) {
      if (isTauriRuntime()) {
        navigate("/dashboard/scheduled", { replace: true });
        return;
      }

      const [, , protoSegment] = rawPath.split("/");
      if (!protoSegment) {
        navigate("/proto/workspaces", { replace: true });
      }
      return;
    }

    if (path.startsWith("/onboarding")) {
      navigate("/session", { replace: true });
      return;
    }

    const fallback = activeSessionId();
    if (fallback) {
      goToSession(fallback, { replace: true });
      return;
    }
    navigate("/session", { replace: true });
  });

  return (
    <>
      <Switch>
        <Match when={currentView() === "proto"}>
          <Switch>
            <Match when={isProtoV1Ux()}>
              <ProtoV1UxView />
            </Match>
            <Match when={true}>
              <ProtoWorkspacesView />
            </Match>
          </Switch>
        </Match>
        <Match when={currentView() === "onboarding"}>
          <OnboardingView {...onboardingProps()} />
        </Match>
        <Match when={currentView() === "session"}>
          <SessionView {...sessionProps()} />
        </Match>
        <Match when={true}>
          <DashboardView {...dashboardProps()} />
        </Match>
      </Switch>

      <WorkspaceSwitchOverlay
        open={workspaceSwitchOpen()}
        workspace={workspaceSwitchWorkspace()}
        statusKey={workspaceSwitchStatusKey()}
      />

      <ModelPickerModal
        open={modelPickerOpen()}
        options={modelOptions()}
        filteredOptions={filteredModelOptions()}
        query={modelPickerQuery()}
        setQuery={setModelPickerQuery}
        target={modelPickerTarget()}
        current={modelPickerCurrent()}
        onSelect={applyModelSelection}
        onBehaviorChange={(model, value) => {
          updateModelVariant(model, sanitizeModelVariantForRef(model, value));
        }}
        onOpenSettings={openSettingsFromModelPicker}
        onClose={closeModelPicker}
      />

      <ResetModal
        open={resetModalOpen()}
        mode={resetModalMode()}
        text={resetModalText()}
        busy={resetModalBusy()}
        canReset={
          !resetModalBusy() &&
          !anyActiveRuns() &&
          resetModalText().trim().toUpperCase() === "RESET"
        }
        hasActiveRuns={anyActiveRuns()}
        language={currentLocale()}
        onClose={() => setResetModalOpen(false)}
        onConfirm={confirmReset}
        onTextChange={setResetModalText}
      />

      <McpAuthModal
        open={mcpAuthModalOpen()}
        client={client()}
        entry={mcpAuthEntry()}
        projectDir={workspaceProjectDir()}
        language={currentLocale()}
        reloadRequired={mcpAuthNeedsReload()}
        reloadBlocked={activeReloadBlockingSessions().length > 0}
        activeSessions={activeReloadBlockingSessions()}
        isRemoteWorkspace={selectedWorkspaceDisplay().workspaceType === "remote"}
        onForceStopSession={(sessionID) => abortSession(sessionID)}
        onClose={() => {
          setMcpAuthModalOpen(false);
          setMcpAuthEntry(null);
          setMcpAuthNeedsReload(false);
        }}
        onComplete={async () => {
          setMcpAuthModalOpen(false);
          setMcpAuthEntry(null);
          setMcpAuthNeedsReload(false);
          await refreshMcpServers();
        }}
        onReloadEngine={() => reloadWorkspaceEngineAndResume()}
      />

      <SharedBundleImportModal
        open={Boolean(sharedBundleImportChoice())}
        title={sharedBundleImportCopy()?.title ?? "Import shared bundle"}
        description={sharedBundleImportCopy()?.description ?? "Choose how to import this shared bundle."}
        items={sharedBundleImportCopy()?.items ?? []}
        workers={sharedBundleWorkerOptions()}
        busy={sharedBundleImportBusy()}
        error={sharedBundleImportError()}
        onClose={closeSharedBundleImportChoice}
        onCreateNewWorker={() => {
          void openSharedBundleCreateWorkerFlow();
        }}
        onSelectWorker={(workspaceId) => {
          void importSharedBundleIntoExistingWorkspace(workspaceId);
        }}
      />

      <StartWithTemplateModal
        open={Boolean(sharedTemplateStartRequest())}
        templateName={sharedTemplateStartRequest()?.bundle.name?.trim() || "this template"}
        description={sharedTemplateStartRequest()?.bundle.description ?? ""}
        items={sharedTemplateStartItems()}
        busy={sharedTemplateStartBusy()}
        onClose={() => {
          if (sharedTemplateStartBusy()) return;
          setSharedTemplateStartRequest(null);
        }}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        onConfirm={(folder) => {
          void startWorkspaceFromTemplate(folder);
        }}
      />

      <CreateWorkspaceModal
        open={workspaceStore.createWorkspaceOpen()}
        onClose={() => {
          workspaceStore.setCreateWorkspaceOpen(false);
          workspaceStore.clearSandboxCreateProgress?.();
          setSharedBundleCreateWorkerRequest(null);
        }}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        defaultPreset={createWorkspaceDefaultPreset()}
        onConfirm={async (preset, folder) => {
          const request = sharedBundleCreateWorkerRequest();
          const ok = await workspaceStore.createWorkspaceFlow(preset, folder);
          if (!ok || !request) return;
          const imported = await importSharedBundleIntoActiveWorker(request.request, {
            localRoot: workspaceStore.selectedWorkspaceRoot().trim(),
          }, request.bundle);
          setSharedBundleCreateWorkerRequest(null);
          if (imported) {
            if (request.bundle.type === "skill") {
              showSharedSkillSuccessToast({
                title: "Skill added",
                description: `Added '${request.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForToasts(workspaceStore.selectedWorkspaceDisplay())}.`,
              });
            }
            setSharedSkillDestinationRequest(null);
          }
        }}
        onConfirmWorker={
          isTauriRuntime()
            ? async (preset, folder) => {
                const request = sharedBundleCreateWorkerRequest();
                const ok = await workspaceStore.createSandboxFlow(
                  preset,
                  folder,
                  request
                    ? {
                        onReady: async () => {
                          const active = workspaceStore.selectedWorkspaceDisplay();
                          await importSharedBundleIntoActiveWorker(request.request, {
                            workspaceId:
                              active.openworkWorkspaceId?.trim() ||
                              parseOpenworkWorkspaceIdFromUrl(active.openworkHostUrl ?? "") ||
                              parseOpenworkWorkspaceIdFromUrl(active.baseUrl ?? "") ||
                              null,
                            directoryHint: active.directory?.trim() || active.path?.trim() || null,
                          }, request.bundle);
                          if (request.bundle.type === "skill") {
                            showSharedSkillSuccessToast({
                              title: "Skill added",
                              description: `Added '${request.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForToasts(active)}.`,
                            });
                          }
                        },
                      }
                    : undefined,
                );
                if (!ok) return;
                setSharedBundleCreateWorkerRequest(null);
                if (request) {
                  setSharedSkillDestinationRequest(null);
                }
              }
            : undefined
        }
        workerDisabled={(() => {
          if (!isTauriRuntime()) return true;
          if (workspaceStore.sandboxDoctorBusy?.()) return true;
          const doctor = workspaceStore.sandboxDoctorResult?.();
          if (!doctor) return false;
          return !doctor?.ready;
        })()}
        workerDisabledReason={(() => {
          if (!isTauriRuntime()) return t("app.error.tauri_required", currentLocale());
          if (workspaceStore.sandboxDoctorBusy?.()) {
            return t("dashboard.sandbox_checking_docker", currentLocale());
          }
          const doctor = workspaceStore.sandboxDoctorResult?.();
          if (!doctor || doctor.ready) return null;
          const message = doctor?.error?.trim();
          return message || t("dashboard.sandbox_get_ready_desc", currentLocale());
        })()}
        workerCtaLabel={t("dashboard.sandbox_get_ready_action", currentLocale())}
        workerCtaDescription={t("dashboard.sandbox_get_ready_desc", currentLocale())}
        onWorkerCta={async () => {
          const url = "https://www.docker.com/products/docker-desktop/";
          if (isTauriRuntime()) {
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            await openUrl(url);
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }}
        workerRetryLabel={t("common.retry", currentLocale())}
        workerDebugLines={(() => {
          const doctor = workspaceStore.sandboxDoctorResult?.();
          const lines: string[] = [];
          if (!doctor?.debug) return lines;
          const selected = doctor.debug.selectedBin?.trim();
          if (selected) lines.push(`selected: ${selected}`);
          if (doctor.debug.candidates?.length) {
            lines.push(`candidates: ${doctor.debug.candidates.join(", ")}`);
          }
          if (doctor.debug.versionCommand) {
            const cmd = doctor.debug.versionCommand;
            lines.push(`docker --version exit=${cmd.status}`);
            if (cmd.stderr?.trim()) lines.push(`docker --version stderr: ${cmd.stderr.trim()}`);
          }
          if (doctor.debug.infoCommand) {
            const cmd = doctor.debug.infoCommand;
            lines.push(`docker info exit=${cmd.status}`);
            if (cmd.stderr?.trim()) lines.push(`docker info stderr: ${cmd.stderr.trim()}`);
          }
          return lines;
        })()}
        onWorkerRetry={() => {
          void workspaceStore.refreshSandboxDoctor?.();
        }}
        workerSubmitting={workspaceStore.sandboxPreflightBusy?.() ?? false}
        submitting={(() => {
          const phase = workspaceStore.sandboxCreatePhase?.() ?? "idle";
          if (phase === "provisioning" || phase === "finalizing") return true;
          return busy() && busyLabel() === "status.creating_workspace";
        })()}
        submittingProgress={workspaceStore.sandboxCreateProgress?.() ?? null}
      />

      <SharedSkillDestinationModal
        open={
          Boolean(sharedSkillDestinationRequest()) &&
          !workspaceStore.createWorkspaceOpen() &&
          !workspaceStore.createRemoteWorkspaceOpen()
        }
        skill={(() => {
          const request = sharedSkillDestinationRequest();
          if (!request) return null;
          return {
            name: request.bundle.name,
            description: request.bundle.description ?? null,
            trigger: request.bundle.trigger ?? null,
          };
        })()}
        workspaces={sharedSkillDestinationWorkspaces()}
        selectedWorkspaceId={workspaceStore.selectedWorkspaceId()}
        busyWorkspaceId={sharedSkillDestinationBusyId()}
        onClose={() => {
          if (sharedSkillDestinationBusyId()) return;
          setSharedSkillDestinationRequest(null);
        }}
        onSubmitWorkspace={importSharedSkillIntoWorkspace}
        onCreateWorker={
          isTauriRuntime()
            ? () => {
                const request = sharedSkillDestinationRequest();
                if (!request) return;
                setError(null);
                setSharedBundleCreateWorkerRequest({
                  request: request.request,
                  bundle: request.bundle,
                  defaultPreset: "starter",
                });
                workspaceStore.setCreateWorkspaceOpen(true);
              }
            : undefined
        }
        onConnectRemote={() => {
          setError(null);
          workspaceStore.setCreateRemoteWorkspaceOpen(true);
        }}
      />

      <CreateRemoteWorkspaceModal
        open={workspaceStore.createRemoteWorkspaceOpen()}
        onClose={() => {
          workspaceStore.setCreateRemoteWorkspaceOpen(false);
          setDeepLinkRemoteWorkspaceDefaults(null);
        }}
        onConfirm={(input) => workspaceStore.createRemoteWorkspaceFlow(input)}
        initialValues={deepLinkRemoteWorkspaceDefaults() ?? undefined}
        submitting={
          busy() &&
          (busyLabel() === "status.creating_workspace" || busyLabel() === "status.connecting")
        }
      />

      <Show when={autoConnectRemoteWorkspaceOverlayOpen()}>
        <div class="fixed inset-0 z-[60] flex items-center justify-center bg-gray-1/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            role="status"
            aria-live="polite"
            class="w-full max-w-lg overflow-hidden rounded-2xl border border-gray-6 bg-gray-2 shadow-2xl"
          >
            <div class="border-b border-gray-6 bg-gray-1 px-6 py-5">
              <div class="inline-flex items-center rounded-full border border-gray-6 bg-gray-2 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-gray-10">
                OpenWork Cloud
              </div>
              <h3 class="mt-4 text-lg font-semibold text-gray-12">Adding your worker</h3>
              <p class="mt-1 text-sm text-gray-10">
                Connecting your OpenWork worker now. This usually takes a moment.
              </p>
            </div>
            <div class="flex items-center gap-4 px-6 py-6">
              <div class="flex h-12 w-12 items-center justify-center rounded-2xl border border-gray-6 bg-gray-1/50">
                <div class="h-5 w-5 rounded-full border-2 border-gray-7 border-t-gray-12 animate-spin" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium text-gray-12">Preparing your session</div>
                <div class="mt-1 text-xs leading-relaxed text-gray-10">
                  We are adding the remote worker in the background so you can land directly in the chat view.
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <div class="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(24rem,calc(100vw-1.5rem))] max-w-full flex-col gap-3 sm:right-6 sm:top-6">
        <div class="pointer-events-auto">
          <ReloadWorkspaceToast
            open={reloadRequired("config", "mcp", "plugin", "skill", "agent", "command")}
            title={reloadCopy().title}
            description={reloadCopy().body}
            trigger={reloadTrigger()}
            error={reloadError()}
            reloadLabel={activeReloadBlockingSessions().length > 0 ? "Reload & Stop Tasks" : "Reload now"}
            dismissLabel="Later"
            busy={reloadBusy()}
            canReload={canReloadWorkspace()}
            hasActiveRuns={activeReloadBlockingSessions().length > 0}
            onReload={() => {
              void (activeReloadBlockingSessions().length > 0
                ? forceStopActiveSessionsAndReload()
                : reloadWorkspaceEngineAndResume());
            }}
            onDismiss={clearReloadRequired}
          />
        </div>

        <div class="pointer-events-auto">
          <StatusToast
            open={Boolean(sharedSkillSuccessToast())}
            tone="success"
            title={sharedSkillSuccessToast()?.title ?? "Skill added"}
            description={sharedSkillSuccessToast()?.description ?? null}
            dismissLabel="Dismiss"
            onDismiss={clearSharedSkillSuccessToast}
          />
        </div>

      </div>

      <RenameWorkspaceModal
        open={renameWorkspaceOpen()}
        title={renameWorkspaceName()}
        busy={renameWorkspaceBusy()}
        canSave={renameWorkspaceName().trim().length > 0 && !renameWorkspaceBusy()}
        onClose={closeRenameWorkspace}
        onSave={saveRenameWorkspace}
        onTitleChange={setRenameWorkspaceName}
      />

      <CreateRemoteWorkspaceModal
        open={editRemoteWorkspaceOpen()}
        onClose={() => {
          setEditRemoteWorkspaceOpen(false);
          setEditRemoteWorkspaceId(null);
          setEditRemoteWorkspaceError(null);
        }}
        onConfirm={(input) => {
          const workspaceId = editRemoteWorkspaceId();
          if (!workspaceId) return;
          setEditRemoteWorkspaceError(null);
          void (async () => {
            try {
              const ok = await workspaceStore.updateRemoteWorkspaceFlow(workspaceId, input);
              if (ok) {
                setEditRemoteWorkspaceOpen(false);
                setEditRemoteWorkspaceId(null);
                setEditRemoteWorkspaceError(null);
              } else {
                setEditRemoteWorkspaceError(error() || "Connection failed. Check the URL and token.");
                setError(null);
              }
            } catch (e) {
              const message = e instanceof Error ? e.message : "Connection failed";
              setEditRemoteWorkspaceError(message);
              setError(null);
            }
          })();
        }}
        initialValues={editRemoteWorkspaceDefaults() ?? undefined}
        submitting={busy() && busyLabel() === "status.connecting"}
        error={editRemoteWorkspaceError()}
        title={t("dashboard.edit_remote_workspace_title", currentLocale())}
        subtitle={t("dashboard.edit_remote_workspace_subtitle", currentLocale())}
        confirmLabel={t("dashboard.edit_remote_workspace_confirm", currentLocale())}
      />
    </>
  );
}
