import type { DesktopAgentPermissionRule } from "@openwork/types/den/desktop-policies";
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
  DesktopStartupTimings,
  DesktopDistributionInfo,
  BrandIconApplyResult,
  BrandIconState,
  DesktopBootstrapConfig,
  EvalRelaunchResult,
  OpenworkDockerCleanupResult,
  ExecResult,
  LocalSkillCard,
  LocalSkillContent,
  NukeManifestPreview,
  NukeOptions,
  NukeReceipt,
  NukeReceiptError,
  OpencodeConfigFile,
  UpdaterEnvironment,
  CacheResetResult,
} from "./desktop-types";

import type {
  BrandIconApplyResult,
  BrandIconState,
  DesktopBootstrapConfig,
  DesktopDistributionInfo,
  DesktopCommandArgs,
  DesktopCommandInvokers,
  DesktopCommandName,
  DesktopCommandResult,
  DesktopFetchInit,
  DesktopFetchResult,
  EvalRelaunchResult,
  NukeManifestPreview,
  NukeOptions,
  NukeReceipt,
  WorkspaceList,
} from "./desktop-types";
import type {
  AgentViewportKey,
  BrowserPanelOwnerPayload,
  BrowserPanelTab,
  BrowserStatePayload,
  OpenBrowserUrlResult,
} from "@openwork/browser-tabs";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { ComputerRequest } from "@openwork/types/desktop-ipc";
export type { BrowserStatePayload } from "@openwork/browser-tabs";

export type BrowserPresentationMode = "hidden" | "floating" | "side" | "fullscreen";

export type BrowserProxyState = {
  proxy: { rules: string; authenticated: boolean } | null;
};

export type RecoveryRelease = {
  id: string;
  version: string;
  marking: "current" | "previous" | null;
};

export type RecoveryActionResult = {
  ok: boolean;
  action?: "install" | "installer" | "eval";
  message?: string;
  reason?: string;
};

export type RemoteSessionAccessState = {
  mode: RemoteSessionAccessMode | null;
  ceiling: RemoteSessionAccessMode | null;
  effective: RemoteSessionAccessMode;
  supported: boolean;
  optIn: boolean;
  connected: boolean;
};

export type SpeechDictationEvent =
  | { id: string; type: "ready" | "end" }
  | { id: string; type: "result"; segments: string[] }
  | { id: string; type: "level"; level: number }
  | { id: string; type: "status"; status: "installing"; progress?: number }
  | { id: string; type: "error"; code: string };

declare global {
  interface Window {
    __openworkRecoveryControl?: {
      snapshot: () => Promise<unknown>;
      select: (id: string) => Promise<unknown>;
    };
    __OPENWORK_ELECTRON__?: {
      invokeDesktop?: <C extends DesktopCommandName>(
        command: C,
        ...args: DesktopCommandArgs<C>
      ) => Promise<DesktopCommandResult<C>>;
      sessionPins?: {
        read: () => { ok: true; pins: string[] | null } | { ok: false; error: string };
        update: (change: { previous: string[]; next: string[] }) => { ok: true; pins: string[] } | { ok: false; error: string };
      };
      computer?: {
        onRequest?: (callback: (payload: { sessionId: string; request: ComputerRequest | null }) => void) => () => void;
      };
      dictation?: {
        onEvent?: (callback: (payload: SpeechDictationEvent) => void) => () => void;
      };
      automationRunner?: {
        onRunLifecycle?: (callback: (event: unknown) => void) => () => void;
        onCredentialRejected?: (
          callback: (rejection?: { reason: "computer_disconnected" | "credential_rejected" }) => void,
        ) => () => void;
      };
      remoteSessionAccess?: {
        get?: () => Promise<RemoteSessionAccessState>;
        set?: (mode: RemoteSessionAccessMode) => Promise<RemoteSessionAccessState>;
      };
      fileSystem?: {
        getPathForFile?: (file: File) => string;
      };
      shell?: {
        openExternal?: (url: string) => Promise<{ ok: boolean; pending?: boolean; error?: string } | void>;
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
      nuke?: {
        preview?: (options?: NukeOptions) => Promise<NukeManifestPreview>;
        execute?: (options?: NukeOptions) => Promise<NukeReceipt>;
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
        check?: (channel?: "stable" | "alpha", targetVersion?: string, options?: { preserveStaged?: boolean }) => Promise<{
          available: boolean;
          currentVersion?: string;
          totalBytes?: number | null;
          stagedVersion?: string | null;
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
      recovery?: {
        recordHealthy?: () => Promise<unknown>;
        list?: (policy: {
          versions: string[];
          minimumVersion: string;
          allowedVersions?: string[];
        }) => Promise<{ ok: boolean; releases: RecoveryRelease[]; reason?: string }>;
        restorePrevious?: () => Promise<RecoveryActionResult>;
        use?: (id: string) => Promise<RecoveryActionResult>;
      };
      browser?: {
        openLink?: (url: string, sessionId: string | null) => void;
        chooseLinkDestination?: (id: string, destination: "openwork" | "external" | null) => Promise<boolean>;
        onLinkOpenRequest?: (callback: (request: { id: string; url: string } | null) => void) => () => void;
        show?: (bounds: { x: number; y: number; width: number; height: number }, sessionId?: string | null) => Promise<boolean | void>;
        hide?: (options?: { preserveShortcutFocus?: boolean }) => Promise<void>;
        openUrl?: (
          url: string,
          provider?: "auto" | "builtin",
          options?: { sessionId?: string | null },
        ) => Promise<OpenBrowserUrlResult>;
        setVisibleSession?: (sessionId: string | null) => Promise<string | null>;
        setPresentation?: (sessionId: string | null, mode: BrowserPresentationMode) => Promise<boolean>;
        focusWindow?: () => Promise<boolean>;
        claimDraftTabs?: (sessionId: string) => Promise<boolean>;
        navigate?: (url: string) => Promise<void>;
        back?: () => Promise<void>;
        forward?: () => Promise<void>;
        reload?: () => Promise<void>;
        setBounds?: (bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean | void>;
        getState?: () => Promise<BrowserStatePayload | null>;
        createTab?: (url?: string, sessionId?: string | null) => Promise<{ tabId: string }>;
        closeTab?: (tabId: string) => Promise<string | null>;
        suspendTab?: (tabId: string) => Promise<string | null>;
        restoreTab?: (tabId: string, sessionId: string | null) => Promise<OpenBrowserUrlResult>;
        releaseTab?: (tabId: string, sessionId: string | null) => Promise<{ tabId: string; released: true }>;
        closeAllTabs?: () => Promise<string[]>;
        closeSessionTabs?: (sessionId: string) => Promise<string[]>;
        selectTab?: (tabId: string) => Promise<string>;
        reorderTabs?: (tabIds: string[]) => Promise<BrowserPanelTab[]>;
        listTabs?: () => Promise<BrowserPanelTab[]>;
        setProxy?: (proxy?: string | null) => Promise<BrowserProxyState>;
        getProxy?: () => Promise<BrowserProxyState>;
        setControlEnabled?: (enabled: boolean) => Promise<boolean>;
        setTabPageSize?: (tabId: string, key: AgentViewportKey) => Promise<boolean>;
        startAgentTurn?: (sessionId: string) => Promise<boolean>;
        endAgentTurn?: (sessionId: string) => Promise<boolean>;
        setAgentPermissionRules?: (rules: DesktopAgentPermissionRule[] | null) => Promise<boolean>;
        showTabContextMenu?: (tabId: string, point?: { x: number; y: number }) => Promise<void>;
        destroy?: () => Promise<void>;
        onStateChange?: (callback: (state: BrowserStatePayload) => void) => () => void;
        onPanelOpened?: (callback: (payload?: BrowserPanelOwnerPayload) => void) => () => void;
        onPanelClosed?: (callback: (payload?: BrowserPanelOwnerPayload) => void) => () => void;
        onPresentationExit?: (callback: (payload: { sessionId: string | null; tabId: string }) => void) => () => void;
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
        desktopBootstrap?: DesktopBootstrapConfig | null;
        distribution?: DesktopDistributionInfo;
        initialDeepLinks?: string[];
        platform?: "darwin" | "linux" | "windows";
        arch?: string;
        isPackaged?: boolean;
        version?: string;
        evalFatalBootstrapFailure?: string | null;
      };
    };
  }
}

export async function closeSessionBrowserTabs(sessionId: string): Promise<void> {
  if (typeof window === "undefined" || !sessionId.trim()) return;
  try {
    await window.__OPENWORK_ELECTRON__?.browser?.closeSessionTabs?.(sessionId);
  } catch {
  }
}

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

export function resolveWorkspaceListSelectedId(
  list: Pick<WorkspaceList, "selectedId" | "activeId"> | null | undefined,
): string {
  return list?.selectedId?.trim() || list?.activeId?.trim() || "";
}

type DesktopBridge = DesktopCommandInvokers & {
  resolveWorkspaceListSelectedId: typeof resolveWorkspaceListSelectedId;
};

type DesktopBridgeFn = (...args: unknown[]) => Promise<unknown>;

const electronBridge: Record<string, DesktopBridgeFn> = {};

export const desktopBridge = new Proxy(electronBridge, {
  get(target, prop) {
    if (typeof prop !== "string") return undefined;

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
      return invokeDesktop(
        prop as DesktopCommandName,
        ...(args as DesktopCommandArgs<DesktopCommandName>),
      );
    };
    target[prop] = fn;
    return fn;
  },
}) as unknown as DesktopBridge;

function isLoopbackUrl(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  try {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function isPermissionReplyRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") return false;
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  try {
    return /\/permission\/[A-Za-z0-9_-]+\/reply$/.test(new URL(raw).pathname);
  } catch {
    return false;
  }
}

function desktopTransferId(): string {
  return crypto.randomUUID();
}

async function runCancellableDesktopTransfer<T>(
  transferId: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  const cancel = () => {
    void invokeElectronHelper("__cancelTransfer", transferId).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await operation();
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export type DesktopFetchRequestInit = RequestInit & {
  cancellable?: boolean;
};

type DesktopFetchMainOptions = {
  timeoutMs?: number;
  agentContextDiagnosticsDeadlineAtMs?: number;
};

async function desktopFetchThroughMain(
  input: RequestInfo | URL,
  init?: DesktopFetchRequestInit,
  options: DesktopFetchMainOptions = {},
): Promise<Response> {
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
      body = await input.clone().text();
    }
  } else {
    url = typeof input === "string" ? input : input.toString();
    method = init?.method;
    headers = init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined;
    body = typeof init?.body === "string" ? init.body : undefined;
  }

  const diagnosticsDeadlineAtMs = options.agentContextDiagnosticsDeadlineAtMs;
  const requestMethod = (method ?? "GET").toUpperCase();
  const cancellable = ["GET", "PATCH"].includes(requestMethod)
    || (requestMethod === "POST" && /\/session\/[^/]+\/abort$/.test(new URL(url).pathname))
    || isPermissionReplyRequest(url, { method: requestMethod })
    || init?.cancellable === true;
  const signal = cancellable && diagnosticsDeadlineAtMs === undefined
    ? init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal
    : undefined;
  const transferId = signal ? desktopTransferId() : undefined;
  const fetchInit: DesktopFetchInit = {
    ...((init?.redirect ?? (input instanceof Request ? input.redirect : undefined)) === "error"
      ? { redirect: "error" satisfies RequestRedirect }
      : {}),
    cancellable,
    transferId,
    method,
    headers,
    body,
    timeoutMs: options.timeoutMs,
    agentContextDiagnostics: diagnosticsDeadlineAtMs === undefined
      ? undefined
      : { deadlineAtMs: diagnosticsDeadlineAtMs },
  };
  const fetchResponse = () => invokeElectronHelper("__fetch", url, fetchInit);
  let result: DesktopFetchResult;
  try {
    result = transferId && signal
      ? await runCancellableDesktopTransfer(transferId, signal, fetchResponse)
      : await fetchResponse();
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }

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

export async function desktopFetchViaMain(input: RequestInfo | URL, init?: DesktopFetchRequestInit, timeoutMs?: number): Promise<Response> {
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

export function assertDesktopWebUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Only valid web links can be opened externally.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`External URL protocol "${parsed.protocol}" is not allowed.`);
  }
  return parsed.toString();
}

export type DesktopUrlOpenStatus = "opened" | "opening";

export async function openDesktopUrlWithStatus(url: string): Promise<DesktopUrlOpenStatus> {
  const safeUrl = assertDesktopWebUrl(url);
  const openExternal = window.__OPENWORK_ELECTRON__?.shell?.openExternal;
  if (openExternal) {
    const result = await openExternal(safeUrl);
    if (result && result.ok === false) {
      if (result.pending) return "opening";
      throw new Error(result.error ?? "Failed to open browser");
    }
    return "opened";
  }
  if (typeof window !== "undefined") {
    window.open(safeUrl, "_blank", "noopener,noreferrer");
  }
  return "opened";
}

export async function openDesktopUrl(url: string): Promise<void> {
  await openDesktopUrlWithStatus(url);
}

export async function resolveDesktopChatFilePath(target: string): Promise<string | null> {
  if (typeof window === "undefined" || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return null;
  try {
    return await invokeElectronHelper("__resolveChatFilePath", target);
  } catch {
    return null;
  }
}

export async function openDesktopPath(target: string): Promise<void> {
  const result = await invokeElectronHelper("__openPath", target);
  if (typeof result === "string" && result.trim()) {
    throw new Error(result);
  }
}

export async function openDesktopWorkspaceFile(workspaceRoot: string, target: string, options?: { reveal?: boolean }): Promise<"opened" | "revealed" | "unavailable"> {
  const result = await invokeElectronHelper("__openWorkspaceFile", workspaceRoot, target, options);
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new Error("Could not open this file.");
  }
  if (!result.ok) throw new Error(result.error || "Could not open this file.");
  return result.action;
}

export async function revealDesktopItemInDir(target: string): Promise<void> {
  const result = await invokeElectronHelper("__revealItemInDir", target);
  if (typeof result === "string" && result.trim()) {
    throw new Error(result);
  }
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

export async function openDesktopWithApp(target: string, appPath: string, workspaceRoot: string): Promise<void> {
  const result = await invokeElectronHelper("__openWithApp", target, appPath, workspaceRoot);
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

let cachedHomeDir: Promise<string | null> | null = null;

export function getCachedDesktopHomeDir(): Promise<string | null> {
  if (typeof window === "undefined" || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return Promise.resolve(null);
  cachedHomeDir ??= getDesktopHomeDir()
    .then((home) => (typeof home === "string" && home.trim() ? home : null))
    .catch(() => {
      cachedHomeDir = null;
      return null;
    });
  return cachedHomeDir;
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

export function readInitialDesktopBootstrapConfig(): DesktopBootstrapConfig | null | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__OPENWORK_ELECTRON__?.meta?.desktopBootstrap;
}

export function readDesktopDistributionInfo(): DesktopDistributionInfo {
  const distribution = typeof window === "undefined"
    ? undefined
    : window.__OPENWORK_ELECTRON__?.meta?.distribution;
  return distribution ?? {
    flavor: "public",
    appName: "OpenWork",
    appIdentifier: "com.differentai.openwork",
    protocolScheme: "openwork",
    requireSignin: false,
    requireActivation: false,
  };
}

const {
  engineStart,
  workspaceBootstrap,
  workspaceSetSelected,
  workspaceSetRuntimeActive,
  workspaceCreate,
  workspaceForget,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  engineStop,
  engineRestart,
  appBuildInfo,
  startupTimings,
  getDesktopBootstrapConfig,
  debugDesktopBootstrapConfig,
  clearDesktopBootstrapConfig,
  setDesktopBootstrapConfig,
  connectLinkVerify,
  connectLinkAccept,
  nukeOpenworkAndOpencodeConfigPreview,
  nukeOpenworkAndOpencodeConfigAndExit,
  openworkServerInfo,
  openworkServerRestart,
  runtimeBootstrap,
  runtimeStatus,
  engineInfo,
  pickDirectory,
  pickFile,
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
  opencodeMcpAuth,
} = desktopBridge;

export {
  engineStart,
  workspaceBootstrap,
  workspaceSetSelected,
  workspaceSetRuntimeActive,
  workspaceCreate,
  workspaceForget,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  engineStop,
  engineRestart,
  appBuildInfo,
  startupTimings,
  getDesktopBootstrapConfig,
  debugDesktopBootstrapConfig,
  clearDesktopBootstrapConfig,
  setDesktopBootstrapConfig,
  connectLinkVerify,
  connectLinkAccept,
  nukeOpenworkAndOpencodeConfigPreview,
  nukeOpenworkAndOpencodeConfigAndExit,
  openworkServerInfo,
  openworkServerRestart,
  runtimeBootstrap,
  runtimeStatus,
  engineInfo,
  pickDirectory,
  pickFile,
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
  opencodeMcpAuth,
};
