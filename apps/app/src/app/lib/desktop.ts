import { nativeDeepLinkEvent } from "./deep-link-bridge";

export type * from "./desktop-types";
export type {
  EngineInfo,
  OpenworkServerInfo,
  EngineDoctorResult,
  WorkspaceInfo,
  WorkspaceList,
  WorkspaceExportSummary,
  OpencodeCommandDraft,
  WorkspaceOpenworkConfig,
  AppBuildInfo,
  BrandIconApplyResult,
  BrandIconState,
  DesktopBootstrapConfig,
  EvalRelaunchResult,
  OrchestratorDetachedHost,
  SandboxDoctorResult,
  OpenworkDockerCleanupResult,
  SandboxDebugProbeResult,
  ExecResult,
  LocalSkillCard,
  LocalSkillContent,
  OpencodeConfigFile,
  UpdaterEnvironment,
  CacheResetResult,
} from "./desktop-types";

import type {
  BrandIconApplyResult,
  BrandIconState,
  DesktopCommandArgs,
  DesktopCommandInvokers,
  DesktopCommandName,
  DesktopCommandResult,
  EvalRelaunchResult,
  WorkspaceList,
} from "./desktop-types";
import type { BrowserPanelTab } from "./desktop-types";

export type BrowserStatePayload = {
  activeTabId?: string | null;
  tabs?: BrowserPanelTab[];
};

export type BrowserProxyState = {
  proxy: { rules: string; authenticated: boolean } | null;
};

// ---------------------------------------------------------------------------
// Electron bridge surface
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __OPENWORK_ELECTRON__?: {
      invokeDesktop?: <C extends DesktopCommandName>(
        command: C,
        ...args: DesktopCommandArgs<C>
      ) => Promise<DesktopCommandResult<C>>;
      shell?: {
        openExternal?: (url: string) => Promise<{ ok: boolean; error?: string } | void>;
        relaunch?: () => Promise<void>;
      };
      system?: {
        getArchitectureInfo?: () => Promise<{
          appArch: string;
          appArchLabel: string;
          systemArch: string;
          systemArchLabel: string;
          mismatch: boolean;
          platform: "darwin" | "linux" | "windows";
          version: string;
          downloadUrl: string;
          releaseUrl: string;
        }>;
        getMicrophoneStatus?: () => Promise<{
          platform: string;
          status: string;
        }>;
        askMicrophoneAccess?: () => Promise<{
          platform: string;
          before?: string;
          after?: string;
          status?: string;
          granted: boolean;
        }>;
      };
      migration?: {
        readSnapshot?: () => Promise<unknown>;
        ackSnapshot?: () => Promise<{ ok: boolean; moved: boolean }>;
      };
      brandIcon?: {
        apply?: (url: string | null) => Promise<BrandIconApplyResult>;
        getState?: () => Promise<BrandIconState>;
      };
      dev?: {
        evalRelaunch?: () => Promise<EvalRelaunchResult>;
      };
      updater?: {
        getChannel?: () => Promise<{
          channel: "stable" | "alpha";
          feedUrl: string;
          currentVersion: string;
        }>;
        setChannel?: (channel: "stable" | "alpha") => Promise<{
          channel: "stable" | "alpha";
          feedUrl: string;
          currentVersion: string;
        }>;
        check?: (channel?: "stable" | "alpha", targetVersion?: string) => Promise<{
          available: boolean;
          currentVersion?: string;
          latestVersion?: string | null;
          releaseDate?: string | null;
          releaseNotes?: unknown;
          channel?: "stable" | "alpha";
          feedUrl?: string;
          reason?: string;
        }>;
        download?: () => Promise<{ ok: boolean; reason?: string }>;
        installAndRestart?: () => Promise<{ ok: boolean; reason?: string }>;
      };
      browser?: {
        show?: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
        hide?: () => Promise<void>;
        openUrl?: (url: string, provider?: "auto" | "builtin" | "external") => Promise<{
          provider: "builtin";
          browser_url: string;
          target_id: string;
          tab_id: string;
          url: string;
        }>;
        navigate?: (url: string) => Promise<void>;
        back?: () => Promise<void>;
        forward?: () => Promise<void>;
        reload?: () => Promise<void>;
        setBounds?: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
        getState?: () => Promise<BrowserStatePayload | null>;
        createTab?: (url?: string) => Promise<{ tabId: string }>;
        closeTab?: (tabId: string) => Promise<string | null>;
        closeAllTabs?: () => Promise<string[]>;
        selectTab?: (tabId: string) => Promise<string>;
        reorderTabs?: (tabIds: string[]) => Promise<BrowserPanelTab[]>;
        listTabs?: () => Promise<BrowserPanelTab[]>;
        setProxy?: (proxy?: string | null) => Promise<BrowserProxyState>;
        getProxy?: () => Promise<BrowserProxyState>;
        showTabContextMenu?: (tabId: string, point?: { x: number; y: number }) => Promise<void>;
        destroy?: () => Promise<void>;
        onStateChange?: (callback: (state: BrowserStatePayload) => void) => () => void;
        onPanelOpened?: (callback: () => void) => () => void;
        onPanelClosed?: (callback: () => void) => () => void;
      };
      terminal?: {
        create?: (options: { cwd: string; cols: number; rows: number }) => Promise<{ terminalId: string }>;
        write?: (terminalId: string, data: string) => Promise<void>;
        resize?: (terminalId: string, cols: number, rows: number) => Promise<void>;
        kill?: (terminalId: string) => Promise<void>;
        onData?: (callback: (payload: { terminalId: string; data: string }) => void) => () => void;
        onExit?: (callback: (payload: { terminalId: string; exitCode: number | null; signal?: number }) => void) => () => void;
      };
      meta?: {
        initialDeepLinks?: string[];
        platform?: "darwin" | "linux" | "windows";
        version?: string;
        disableWorkspaceRecovery?: boolean;
      };
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function invokeElectronHelper<C extends DesktopCommandName>(
  command: C,
  ...args: DesktopCommandArgs<C>
): Promise<DesktopCommandResult<C>> {
  const invokeDesktop = window.__OPENWORK_ELECTRON__?.invokeDesktop;
  if (!invokeDesktop) {
    throw new Error(`Electron desktop helper is unavailable: ${command}`);
  }
  return (await invokeDesktop(command, ...args)) as DesktopCommandResult<C>;
}

// Pure utility — resolves the selected workspace ID from a workspace list
// payload, handling legacy fields.
export function resolveWorkspaceListSelectedId(
  list: Pick<WorkspaceList, "selectedId" | "activeId"> | null | undefined,
): string {
  return list?.selectedId?.trim() || list?.activeId?.trim() || "";
}

// ---------------------------------------------------------------------------
// Desktop bridge (Electron IPC proxy)
// ---------------------------------------------------------------------------

// All bridge methods are implemented via invokeDesktop IPC. The Proxy
// automatically maps property access to `invokeDesktop(propertyName, ...args)`.
// Per-command signatures come from the shared DesktopCommandMap contract
// (packages/types/src/desktop-ipc.ts), so every destructured export below is
// precisely typed against what the Electron main process implements.

type DesktopBridge = DesktopCommandInvokers & {
  resolveWorkspaceListSelectedId: typeof resolveWorkspaceListSelectedId;
};

type DesktopBridgeFn = (...args: unknown[]) => Promise<unknown>;

const electronBridge: Record<string, DesktopBridgeFn> = {};

// The cast is inherent to the Proxy pattern: the target is an empty cache and
// members are fabricated on access. The contract typing above is what keeps
// it honest (command names + signatures are checked on both sides).
export const desktopBridge = new Proxy(electronBridge, {
  get(target, prop) {
    if (typeof prop !== "string") return undefined;

    // resolveWorkspaceListSelectedId is a pure function, not an IPC call
    if (prop === "resolveWorkspaceListSelectedId") {
      return resolveWorkspaceListSelectedId;
    }

    const cached = target[prop];
    if (cached) return cached;

    const fn = async (...args: unknown[]) => {
      const invokeDesktop = window.__OPENWORK_ELECTRON__?.invokeDesktop;
      if (!invokeDesktop) {
        throw new Error(`Electron desktop helper is unavailable: ${prop}`);
      }
      // The Proxy is the one dynamic point in the bridge: `prop` is whatever
      // property was accessed, already constrained by the DesktopBridge
      // surface this Proxy is exported as.
      return invokeDesktop(
        prop as DesktopCommandName,
        ...(args as DesktopCommandArgs<DesktopCommandName>),
      );
    };
    target[prop] = fn;
    return fn;
  },
}) as unknown as DesktopBridge;

// ---------------------------------------------------------------------------
// desktopFetch — proxies non-loopback requests through the Electron main
// process. Loopback hosts (the local opencode/openwork server) use the
// renderer's own fetch, which works against same-machine services. Cross-origin
// requests that need CORS headers the target does not send (e.g. the Den API on
// a different control plane) should instead use `desktopFetchViaMain` directly.
// ---------------------------------------------------------------------------

function isLoopbackUrl(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  try {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

type DesktopFetchMainOptions = {
  timeoutMs?: number;
  agentContextDiagnosticsDeadlineAtMs?: number;
};

async function desktopFetchThroughMain(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: DesktopFetchMainOptions = {},
): Promise<Response> {
  // Extract method/headers/body from either a Request object or the (input, init)
  // pair. The OpenCode SDK calls fetch(request) (no init), so reading these only
  // from `init` would silently drop the Authorization header and the POST body
  // — the remote would then reject every request with "Invalid bearer token".
  let url: string;
  let method: string | undefined;
  let headers: Record<string, string> | undefined;
  let body: string | undefined;

  if (typeof Request !== "undefined" && input instanceof Request) {
    url = input.url;
    method = init?.method ?? input.method;
    const headersSource = init?.headers ? new Headers(init.headers) : input.headers;
    headers = Object.fromEntries(headersSource.entries());
    if (typeof init?.body === "string") {
      body = init.body;
    } else if (input.body) {
      // Request body is a stream — buffer to text so it survives the IPC hop
      // to the Electron main process.
      body = await input.clone().text();
    }
  } else {
    url = typeof input === "string" ? input : input.toString();
    method = init?.method;
    headers = init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined;
    body = typeof init?.body === "string" ? init.body : undefined;
  }

  const diagnosticsDeadlineAtMs = options.agentContextDiagnosticsDeadlineAtMs;
  const result = await invokeElectronHelper("__fetch", url, {
    method,
    headers,
    body,
    timeoutMs: options.timeoutMs,
    agentContextDiagnostics: diagnosticsDeadlineAtMs === undefined
      ? undefined
      : { deadlineAtMs: diagnosticsDeadlineAtMs },
  });

  // Response constructor rejects bodies for null-body status codes, so we
  // must pass null instead of an empty string for those.
  const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
  const responseBody = NULL_BODY_STATUSES.has(result.status) ? null : result.body;

  return new Response(responseBody, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

export const desktopFetch: typeof globalThis.fetch = async (input, init) => {
  if (isLoopbackUrl(input)) {
    return globalThis.fetch(input, init);
  }
  return desktopFetchThroughMain(input, init);
};

export async function desktopFetchViaMain(input: RequestInfo | URL, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  return desktopFetchThroughMain(input, init, { timeoutMs });
}

export async function desktopFetchAgentContextDiagnostics(
  input: RequestInfo | URL,
  init: RequestInit,
  deadlineAtMs: number,
): Promise<Response> {
  if (isLoopbackUrl(input)) {
    return globalThis.fetch(input, init);
  }
  return desktopFetchThroughMain(input, init, {
    agentContextDiagnosticsDeadlineAtMs: deadlineAtMs,
  });
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export async function openDesktopUrl(url: string): Promise<void> {
  const openExternal = window.__OPENWORK_ELECTRON__?.shell?.openExternal;
  if (openExternal) {
    const result = await openExternal(url);
    if (result && result.ok === false) {
      throw new Error(result.error ?? "Failed to open browser");
    }
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export async function openDesktopPath(target: string): Promise<void> {
  const result = await invokeElectronHelper("__openPath", target);
  if (typeof result === "string" && result.trim()) {
    throw new Error(result);
  }
}

export async function revealDesktopItemInDir(target: string): Promise<void> {
  const result = await invokeElectronHelper("__revealItemInDir", target);
  if (typeof result === "string" && result.trim()) {
    throw new Error(result);
  }
}

export async function getDesktopFileIcon(target: string, size?: "small" | "normal" | "large"): Promise<string | null> {
  return invokeElectronHelper("__getFileIcon", target, size);
}

export async function applyBrandAppName(appName: string | null): Promise<string> {
  const result = await invokeElectronHelper("__applyBrandAppName", appName);
  return result.appName;
}

export async function applyBrandIcon(url: string | null): Promise<BrandIconApplyResult> {
  const apply = typeof window !== "undefined" ? window.__OPENWORK_ELECTRON__?.brandIcon?.apply : undefined;
  if (!apply) return { ok: false, reason: "bridge-unavailable" };
  return apply(url);
}

export async function getBrandIconState(): Promise<BrandIconState | null> {
  const getState = typeof window !== "undefined" ? window.__OPENWORK_ELECTRON__?.brandIcon?.getState : undefined;
  return getState ? getState() : null;
}

export async function evalRelaunchDesktopApp(): Promise<EvalRelaunchResult> {
  const relaunch = typeof window !== "undefined" ? window.__OPENWORK_ELECTRON__?.dev?.evalRelaunch : undefined;
  if (!relaunch) {
    throw new Error("Electron eval relaunch helper is unavailable.");
  }
  return relaunch();
}

export type DesktopApplication = {
  name: string;
  appPath: string;
  icon: string | null;
};

export async function getDesktopApplicationsForFile(target: string): Promise<DesktopApplication[]> {
  return invokeElectronHelper("__getApplicationsForFile", target);
}

export async function openDesktopWithApp(target: string, appPath: string): Promise<void> {
  const result = await invokeElectronHelper("__openWithApp", target, appPath);
  if (typeof result === "string" && result.trim()) {
    throw new Error(result);
  }
}

export async function relaunchDesktopApp(): Promise<void> {
  await window.__OPENWORK_ELECTRON__?.shell?.relaunch?.();
}

export async function getDesktopHomeDir(): Promise<string> {
  return invokeElectronHelper("__homeDir");
}

export async function joinDesktopPath(...parts: string[]): Promise<string> {
  return invokeElectronHelper("__joinPath", ...parts);
}

export async function setDesktopZoomFactor(value: number): Promise<boolean> {
  return invokeElectronHelper("__setZoomFactor", value);
}

export async function subscribeDesktopDeepLinks(
  handler: (urls: string[]) => void,
): Promise<() => void> {
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<string[]>;
    if (Array.isArray(customEvent.detail)) {
      handler(customEvent.detail);
    }
  };
  window.addEventListener(nativeDeepLinkEvent, listener as EventListener);
  const initialUrls = window.__OPENWORK_ELECTRON__?.meta?.initialDeepLinks;
  if (Array.isArray(initialUrls) && initialUrls.length > 0) {
    handler(initialUrls);
  }
  return () => {
    window.removeEventListener(nativeDeepLinkEvent, listener as EventListener);
  };
}

// ---------------------------------------------------------------------------
// Re-export bridge methods as named functions (preserves existing import API)
// ---------------------------------------------------------------------------

const {
  engineStart,
  workspaceBootstrap,
  workspaceSetSelected,
  workspaceSetRuntimeActive,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceUpdateRemote,
  workspaceUpdateDisplayName,
  workspaceForget,
  workspaceAddAuthorizedRoot,
  workspaceExportConfig,
  workspaceImportConfig,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  opencodeCommandList,
  opencodeCommandWrite,
  opencodeCommandDelete,
  engineStop,
  engineRestart,
  appBuildInfo,
  getDesktopBootstrapConfig,
  debugDesktopBootstrapConfig,
  clearDesktopBootstrapConfig,
  setDesktopBootstrapConfig,
  connectLinkVerify,
  connectLinkAccept,
  nukeOpenworkAndOpencodeConfigAndExit,
  orchestratorStartDetached,
  sandboxDoctor,
  sandboxStop,
  sandboxCleanupOpenworkContainers,
  sandboxDebugProbe,
  openworkServerInfo,
  openworkServerRestart,
  runtimeBootstrap,
  engineInfo,
  engineDoctor,
  pickDirectory,
  pickFile,
  saveFile,
  engineInstall,
  desktopNotificationShow,
  importSkill,
  installSkillTemplate,
  listLocalSkills,
  readLocalSkill,
  writeLocalSkill,
  uninstallSkill,
  updaterEnvironment,
  readOpencodeConfig,
  writeOpencodeConfig,
  resetOpenworkState,
  resetOpencodeCache,
  opencodeMcpAuth,
  setWindowDecorations,
} = desktopBridge;

export {
  engineStart,
  workspaceBootstrap,
  workspaceSetSelected,
  workspaceSetRuntimeActive,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceUpdateRemote,
  workspaceUpdateDisplayName,
  workspaceForget,
  workspaceAddAuthorizedRoot,
  workspaceExportConfig,
  workspaceImportConfig,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  opencodeCommandList,
  opencodeCommandWrite,
  opencodeCommandDelete,
  engineStop,
  engineRestart,
  appBuildInfo,
  getDesktopBootstrapConfig,
  debugDesktopBootstrapConfig,
  clearDesktopBootstrapConfig,
  setDesktopBootstrapConfig,
  connectLinkVerify,
  connectLinkAccept,
  nukeOpenworkAndOpencodeConfigAndExit,
  orchestratorStartDetached,
  sandboxDoctor,
  sandboxStop,
  sandboxCleanupOpenworkContainers,
  sandboxDebugProbe,
  openworkServerInfo,
  openworkServerRestart,
  runtimeBootstrap,
  engineInfo,
  engineDoctor,
  pickDirectory,
  pickFile,
  saveFile,
  engineInstall,
  desktopNotificationShow,
  importSkill,
  installSkillTemplate,
  listLocalSkills,
  readLocalSkill,
  writeLocalSkill,
  uninstallSkill,
  updaterEnvironment,
  readOpencodeConfig,
  writeOpencodeConfig,
  resetOpenworkState,
  resetOpencodeCache,
  opencodeMcpAuth,
  setWindowDecorations,
};
