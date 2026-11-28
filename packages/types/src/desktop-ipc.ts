import type { ConnectLinkVerifyFailure, ConnectLinkVerifyResult } from "./connect-link.js";
import type { WorkspaceWire } from "./workspace.js";

export type OpencodeExecutionEnvEntry = {
  name: string;
  value: string;
  redacted: boolean;
};

export type OpencodeExecutionSnapshot = {
  command: string;
  args: string[];
  cwd: string;
  env: OpencodeExecutionEnvEntry[];
};

export type EngineInfo = {
  running: boolean;
  runtime: "direct";
  managedByServer: boolean;
  baseUrl: string | null;
  projectDir: string | null;
  hostname: string | null;
  port: number | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
  opencodeBinPath: string | null;
  opencodeBinSource: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
  execution: OpencodeExecutionSnapshot | null;
};

export type DesktopNotificationInput = {
  title: string;
  body?: string;
  href?: string;
  silent?: boolean;
};

export type DesktopNotificationResult =
  | { ok: true }
  | { ok: false; reason: string };

export type DesktopIntegrationIssue =
  | "appimage-path"
  | "desktop-entry"
  | "icon"
  | "protocol-handler"
  | "version";

export type DesktopIntegrationStatus = {
  supported: boolean;
  state: "unsupported" | "not_integrated" | "integrated" | "needs_repair" | "managed_externally";
  ownership: "none" | "openwork" | "external";
  appImagePath: string | null;
  desktopEntryPath: string | null;
  handlerDesktopId: string | null;
  issues: DesktopIntegrationIssue[];
};

export type DesktopIntegrationResult = {
  ok: boolean;
  status: DesktopIntegrationStatus;
  error?: string;
};

export type OpenworkServerInfo = {
  running: boolean;
  generation: number | null;
  host: string | null;
  port: number | null;
  baseUrl: string | null;
  clientToken: string | null;
  ownerToken: string | null;
  hostToken: string | null;
  managedOpencodeBinPath: string | null;
  managedOpencodeBinSource: string | null;
  logFilePath: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
};

export type EngineDoctorResult = {
  found: boolean;
  inPath: boolean;
  resolvedPath: string | null;
  resolvedSource: string | null;
  version: string | null;
  supportsServe: boolean;
  notes: string[];
  serveHelpStatus: number | null;
  serveHelpStdout: string | null;
  serveHelpStderr: string | null;
};

export type WorkspaceList = {
  selectedId?: string;
  watchedId?: string | null;
  activeId?: string | null;
  workspaces: WorkspaceWire[];
};

export type WorkspaceExportSummary = {
  outputPath: string;
  included: number;
  excluded: string[];
};

export type BrandIconApplyResult = { ok: boolean; reason?: string };
export type BrandIconState = { applied: boolean; sourceUrl: string | null; reason: string | null };
export type EvalRelaunchResult = { ok: true };

export type OpencodeCommandDraft = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
};

export type WorkspaceOpenworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

export type AppBuildInfo = {
  version: string;
  gitSha?: string | null;
  buildEpoch?: string | null;
  openworkDevMode?: boolean;
  os?: string | null;
  arch?: string | null;
};

/** This launch's startup milestones in epoch milliseconds; null until reached. */
export type DesktopStartupTimings = {
  processStartedAt: number;
  windowShownAt: number | null;
  engineSettledAt: number | null;
  engine: "ready" | "failed" | "skipped" | null;
};

export type DesktopDistributionInfo = {
  flavor: "public" | "enterprise";
  appName: string;
  appIdentifier: string;
  protocolScheme: string;
  requireSignin: boolean;
  requireActivation: boolean;
};

/** Org + first-skill identity shared by the handoff and prepared records. */
export type DesktopBootstrapOrgSkill = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  skillId: string;
  skillTitle: string;
};

export type DesktopBootstrapConfig = {
  baseUrl: string;
  apiBaseUrl?: string | null;
  requireSignin: boolean;
  requireActivation?: boolean;
  brandAppName?: string | null;
  brandLogoUrl?: string | null;
  brandIconUrl?: string | null;
  writtenAt?: string | null;
  fromFile?: boolean;
  claimLinks?: Array<{
    id: string;
    role: string;
    token?: string;
    url: string;
    expiresAt: string;
  }> | null;
  handoff?: (DesktopBootstrapOrgSkill & {
    grant: string;
    denBaseUrl: string;
    createdAt: string;
  }) | null;
  prepared?: (DesktopBootstrapOrgSkill & {
    skillsDir: string;
    skillPath: string;
    preparedAt: string;
  }) | null;
  enterpriseActivation?: {
    activatedAt: string;
    denBaseUrl: string;
  } | null;
};

export type OpenworkDockerCleanupResult = {
  candidates: string[];
  removed: string[];
  errors: string[];
};

export type ExecResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
};

export type LocalSkillCard = {
  name: string;
  path: string;
  description?: string;
  trigger?: string;
};

export type LocalSkillContent = {
  path: string;
  content: string;
};

export type OpencodeConfigFile = {
  path: string;
  exists: boolean;
  content: string | null;
};

export type UpdaterEnvironment = {
  supported: boolean;
  reason: string | null;
  executablePath: string | null;
  appBundlePath: string | null;
};

export type CacheResetResult = {
  removed: string[];
  missing: string[];
  errors: string[];
};

export type NukeManifestPreview = {
  deletePaths: string[];
  bootstrapPath: string;
  preserveBootstrapPath: string | null;
  partitions: string[];
};

export type NukeOptions = {
  preserveBootstrap: boolean;
};

export type NukeReceiptError = {
  path: string;
  message: string;
  code?: string;
};

export type NukeReceipt = {
  deleted: string[];
  pendingRetry: string[];
  errors: NukeReceiptError[];
  preservedBootstrap: boolean;
  relaunchMode: "cleanup_worker" | "direct";
  workerScheduled: boolean;
};

export type DesktopFetchInit = {
  cancellable?: boolean;
  transferId?: string;
  redirect?: "error";
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  agentContextDiagnostics?: {
    deadlineAtMs: number;
  };
};

export type DesktopFetchResult = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
};

/**
 * Outcome of opening a workspace file from chat. The host resolves the file on disk and
 * only launches it when it is a real file inside the real workspace root; a file that
 * resolves elsewhere is shown in its folder instead of being handed to an application.
 */
export type DesktopWorkspaceFileOpenResult =
  | { ok: true; action: "opened" | "revealed" | "unavailable" }
  | { ok: false; error: string };

export type DesktopBinaryDownloadResult = {
  status: number;
  statusText: string;
  headers: [string, string][];
  path: string | null;
  bytes: number;
  body?: string;
};

export type WorkspaceCreateInput = {
  folderPath: string;
  name?: string | null;
  preset?: string | null;
};

export type UiControlBridgeInfo = {
  baseUrl?: string;
  token?: string;
};

export type ComputerPermission = "accessibility" | "screenRecording";

/** The agent needs computer use this chat does not have yet: setup, or the person's allowance. */
export type ComputerRequest = {
  id: string;
  reason: "setup" | "script" | "files" | "credential";
  computer: string;
  placement: "local" | "remote";
  detail?: string;
  appId?: string;
  purpose?: string;
  standing?: boolean;
  script?: { app: "applescript" | "jxa" | "blender"; code: string };
  files?: { app: string; names: string[]; site?: string; canRemember?: boolean; save?: boolean };
  credential?: { site?: string; use?: PrivateValueUse; app?: string; appId?: string; secret?: { label: string; kind: BrowserSecretKind; field: string }; fills?: PrivateValueFill[]; paste?: false; keep?: false };
};

/**
 * One field the built-in browser fills with a value the agent never sees: the field's input type, and where the
 * value comes from. `command` is the program and arguments that print it. `ask` is the name under which the person
 * pastes it into the card; `kept` says one pasted earlier is kept for this chat. A command that reads a key from
 * its environment names the variable in `needs`; that key is its own row after the fields, with the variable in
 * `unlock`, the command it is for in `program`, and the name under which the person pastes it in `ask`.
 */
export type PrivateValueUse =
  | { kind: "run"; command: string[] }
  | { kind: "request"; method: string; url: string; origin: string; seal?: PrivateValueSeal[] };

/** A value a request's JSON answer keeps for the chat instead of showing: its name, the path it is taken from, and the one https origin it may later be sent to. */
export type PrivateValueSeal = { name: string; from: string; for: string };

export type PrivateValueFill =
  | { field: string; command: string[]; needs?: string; ask?: undefined; kept?: undefined; unlock?: undefined; program?: undefined }
  | { field: string; ask: string; kept?: true; command?: undefined; needs?: undefined; unlock?: undefined; program?: undefined }
  | { unlock: string; program: string; ask: string; kept?: true; field?: undefined; command?: undefined; needs?: undefined };

/** One of the person's own switches for private values, in Settings under Computer use. */
export type PrivateValueSwitch = "commands" | "paste" | "keep";

/**
 * What Settings shows about private values. No value is in it. `organization` says what the person's
 * organization set and they cannot change: `blocked`, `limited` to some websites or commands, or `ask` every time.
 */
export type PrivateValueSettings = {
  enabled: boolean;
  switches: Record<PrivateValueSwitch, boolean>;
  organization: { fills: "blocked" | "limited" | "ask" | null; commands: "blocked" | "limited" | null; paste: "blocked" | null };
  always: Array<{ id: string; sessionId: string; site: string; field: string; command?: string; kept?: true; blocked: boolean }>;
  kept: Array<{ id: string; sessionId: string; site?: string; program?: string; label: string }>;
  recent: Array<{ at: number; sessionId: string; site: string; field: string; source: "command" | "paste" | "kept"; program?: string; result: string }>;
};

/** What a saved browser secret is: a password, a one-time code, or an API key or token. */
export type BrowserSecretKind = "password" | "code" | "token";

/** A chat's saved browser secret as the app shows it. The value never leaves the main process. */
export type BrowserSecretSummary = { secretRef: string; label: string; kind: BrowserSecretKind; origins: string[] };

/** One chat's computer use state, as the broker reports it. */
export type ComputerSnapshot = {
  revision: number;
  enabled: boolean;
  entry: { name: string; ours: boolean };
  request: ComputerRequest | null;
  targetId: string;
  targets: { id: string; label: string; placement: "local" | "remote" }[];
  placement: "local" | "remote";
  readiness: "ready" | "setup-required" | "unsupported" | "unavailable";
  permissions?: { accessibility: boolean; screenRecording: boolean };
  detail: string;
  busyElsewhere: boolean;
  session: {
    state: string;
    purpose: string;
    appName?: string;
    windowTitle?: string;
    phase?: string;
    expiresAt?: string;
    reason?: string;
  } | null;
  cleanupPending?: boolean;
  timing?: { steps: number; computerMs: number; modelMs: number; last?: { name: string; computerMs: number; modelMs?: number } };
};

/** One of a chat's subagents on its computer, for the chat's crew view (`parallelComputerUse`). */
export type ComputerCrewMember = {
  sessionId: string;
  name: string;
  color: string;
  app: string | null;
  state: "working" | "waiting" | "paused" | "done";
  intent: string | null;
  frame?: { mimeType: "image/png"; data: string; width: number; height: number };
};

/** Settings: the computer every chat uses and whether it is set up. */
export type ComputerStatus = Pick<ComputerSnapshot, "enabled" | "entry" | "targetId" | "targets" | "placement" | "readiness" | "permissions" | "detail">;

/**
 * The computers this desktop offers and how they are doing, for the organization's
 * devices list (`remoteDevices`). Names and readiness only.
 */
export type ComputerDevicesSnapshot = {
  enabled: boolean;
  remoteEnabled: boolean;
  selectedId: string | null;
  permissions: { accessibility: boolean; screenRecording: boolean } | null;
  computers: Array<{
    id: string;
    label: string;
    placement: "local" | "remote";
    readiness: "ready" | "setup-required" | "unsupported" | "unavailable" | null;
    detail: string | null;
    provider: "freestyle" | "daytona" | null;
    externalId: string | null;
  }>;
};

/** How this desktop names itself to the organization's devices list. */
export type DesktopDeviceIdentity = {
  installId: string | null;
  machineKey: string | null;
  label: string;
  platform: string;
  appVersion: string;
  osVersion: string | null;
  arch: string | null;
};

/** The live watch view: recent redacted frames and dispatched input, never actionable. */
export type ComputerPresentation = {
  id: string;
  phase: "working" | "paused" | "closed";
  appName?: string;
  windowTitle?: string;
  task?: string;
  mode?: string;
  status?: string;
  canContinue?: boolean;
  frame?: { sequence: number; capturedAt: number; width: number; height: number; mimeType: "image/png"; data: string };
  inputs: { sequence: number; at: number; action: string; phase: string; x?: number; y?: number }[];
};

export type DesktopCommandMap = {
  __startNativeDictation: { args: [requestId: string]; result: { ok: true } | { ok: false; reason: "unavailable" | "not_focused" | "failed" } };
  __cancelNativeDictationStart: { args: [requestId: string]; result: boolean };
  __speechDictationMode: { args: []; result: "local" | "online" | null };
  __startSpeechDictation: { args: [requestId: string, language: string]; result: { ok: true } | { ok: false; reason: "unavailable" | "not_focused" | "failed" } };
  __stopSpeechDictation: { args: [requestId: string]; result: boolean };
  __abortSpeechDictation: { args: [requestId: string]; result: boolean };
  workspaceBootstrap: { args: []; result: WorkspaceList };
  workspaceSetSelected: { args: [workspaceId: string]; result: WorkspaceList };
  workspaceSetRuntimeActive: { args: [workspaceId: string | null]; result: WorkspaceList };
  workspaceCreate: { args: [input: WorkspaceCreateInput]; result: WorkspaceList };
  workspaceForget: { args: [workspaceId: string]; result: WorkspaceList };
  workspaceOpenworkRead: {
    args: [input: { workspacePath: string }];
    result: WorkspaceOpenworkConfig;
  };
  workspaceOpenworkWrite: {
    args: [input: { workspacePath: string; config: WorkspaceOpenworkConfig }];
    result: unknown;
  };

  engineStart: { args: [projectDir: string, options?: Record<string, unknown>]; result: EngineInfo };
  runtimeBootstrap: { args: []; result: unknown };
  runtimeStatus: { args: []; result: unknown };
  engineStop: { args: []; result: EngineInfo };
  engineRestart: { args: [options?: Record<string, unknown>]; result: EngineInfo };
  engineInfo: { args: []; result: EngineInfo };

  appBuildInfo: { args: []; result: AppBuildInfo };
  startupTimings: { args: []; result: DesktopStartupTimings };
  desktopNotificationShow: {
    args: [input: DesktopNotificationInput];
    result: DesktopNotificationResult;
  };
  desktopSentrySetSession: {
    args: [input: { userId: string; orgId: string }];
    result: { enabled: boolean };
  };
  desktopSentryClearSession: { args: []; result: { enabled: boolean } };
  desktopSetKeepAwake: { args: [active: boolean]; result: { active: boolean } };
  desktopIntegrationStatus: { args: []; result: DesktopIntegrationStatus };
  desktopIntegrationInstall: {
    args: [options?: { useExternalLauncher?: boolean }];
    result: DesktopIntegrationResult;
  };
  desktopIntegrationRemove: { args: []; result: DesktopIntegrationResult };
  getUiControlBridgeInfo: { args: []; result: UiControlBridgeInfo | null };
  getOpenworkUiMcpCommand: { args: []; result: string[] };
  getOpenworkUiMcpEnvironment: { args: []; result: Record<string, string> };

  computerSnapshot: { args: [sessionId: string]; result: ComputerSnapshot };
  computerCrew: { args: [sessionId: string, thumbnails: boolean]; result: ComputerCrewMember[] };
  computerStatus: { args: []; result: ComputerStatus };
  computerDevices: { args: []; result: ComputerDevicesSnapshot };
  desktopDeviceIdentity: { args: []; result: DesktopDeviceIdentity };
  computerPresentation: { args: [sessionId: string, visible: boolean]; result: ComputerPresentation | null };
  computerFollow: { args: [sessionId: string, watching: boolean]; result: void };
  computerInteract: {
    args: [input: { sessionId: string; id: string; action: "takeover" | "resume" }];
    result: void;
  };
  computerSetup: { args: [permission: ComputerPermission]; result: { setupId: string } };
  computerDismissSetup: { args: [setupId?: string]; result: void };
  computerChoose: { args: [targetId: string]; result: ComputerStatus };
  computerHalt: { args: [sessionId: string]; result: ComputerSnapshot };
  computerAnswerRequest: { args: [input: { sessionId: string; answer: "dismiss" | "allow" | "always" | "remember"; id?: string; values?: Array<string | null>; keep?: boolean[] }]; result: ComputerSnapshot };
  computerOpenSavedFile: { args: [input: { sessionId: string; path: string; reveal?: boolean }]; result: DesktopWorkspaceFileOpenResult };
  computerChatFiles: { args: [input: { sessionId: string }]; result: { files: Array<{ path: string; bytes: number; modifiedAt: number }> } };
  computerChatImage: { args: [input: { sessionId: string; path: string }]; result: { data: Uint8Array<ArrayBuffer>; contentType: string } | null };
  computerListFileGrants: { args: []; result: { enabled: boolean; grants: Array<{ id: string; origin: string; folder: string; blocked?: boolean }> } };
  computerRemoveFileGrant: { args: [id: string]; result: { ok: boolean } };
  computerListPrivateValues: { args: []; result: PrivateValueSettings };
  computerSetPrivateValueSwitch: { args: [name: PrivateValueSwitch, enabled: boolean]; result: { ok: boolean } };
  computerRemovePrivateValue: { args: [kind: "always" | "kept", id: string]; result: { ok: boolean } };
  computerSetRemoteEnabled: { args: [enabled: boolean]; result: boolean };
  computerRecordableOverlay: { args: []; result: boolean };
  computerSetRecordableOverlay: { args: [enabled: boolean]; result: boolean };
  computerSetBackgroundEnabled: { args: [enabled: boolean]; result: boolean };
  computerResetPermission: { args: [permission: ComputerPermission]; result: { setupId: string } };
  computerEndTurn: { args: [sessionId: string]; result: boolean };

  browserSecretsSetEnabled: { args: [enabled: boolean]; result: boolean };
  browserSecretsList: { args: [sessionId: string]; result: BrowserSecretSummary[] };
  browserSecretsAdd: {
    args: [input: { sessionId: string; label: string; kind: BrowserSecretKind; origins: string[]; value: string }];
    result: { ok: true; secret: BrowserSecretSummary } | { ok: false; error: string };
  };
  browserSecretsRemove: { args: [input: { sessionId: string; secretRef: string }]; result: boolean };

  getDesktopBootstrapConfig: { args: []; result: DesktopBootstrapConfig };
  debugDesktopBootstrapConfig: { args: []; result: unknown };
  clearDesktopBootstrapConfig: { args: []; result: unknown };
  setDesktopBootstrapConfig: {
    args: [config: Partial<DesktopBootstrapConfig>];
    result: DesktopBootstrapConfig;
  };

  connectLinkVerify: { args: [rawUrl: string]; result: ConnectLinkVerifyResult };
  connectLinkAccept: {
    args: [rawUrl: string];
    result: { ok: true; config: DesktopBootstrapConfig } | ConnectLinkVerifyFailure;
  };
  nukeOpenworkAndOpencodeConfigPreview: { args: [options?: NukeOptions]; result: NukeManifestPreview };
  nukeOpenworkAndOpencodeConfigAndExit: { args: [options?: NukeOptions]; result: NukeReceipt };

  openworkServerInfo: { args: []; result: OpenworkServerInfo };
  automationRunnerConfigure: {
    args: [configuration: { baseUrl: string; token: string; runnerId: string } | null];
    result: { connected: boolean };
  };
  openworkServerRestart: {
    args: [options?: Record<string, unknown>];
    result: OpenworkServerInfo;
  };

  pickDirectory: {
    args: [options?: { title?: string; defaultPath?: string; multiple?: boolean }];
    result: string | string[] | null;
  };
  pickFile: {
    args: [
      options?: {
        title?: string;
        defaultPath?: string;
        multiple?: boolean;
        filters?: { name: string; extensions: string[] }[];
      },
    ];
    result: string | string[] | null;
  };

  importSkill: {
    args: [projectDir: string, sourceDir: string, options?: { overwrite?: boolean }];
    result: ExecResult;
  };
  installSkillTemplate: {
    args: [projectDir: string, name: string, content: string, options?: { overwrite?: boolean }];
    result: ExecResult;
  };
  listLocalSkills: { args: [projectDir: string]; result: LocalSkillCard[] };
  readLocalSkill: { args: [projectDir: string, skillName: string]; result: LocalSkillContent };
  writeLocalSkill: {
    args: [projectDir: string, skillName: string, content: string];
    result: ExecResult;
  };
  uninstallSkill: { args: [projectDir: string, skillName: string]; result: ExecResult };

  updaterEnvironment: { args: []; result: UpdaterEnvironment };
  readOpencodeConfig: { args: [scope: string, projectDir?: string]; result: OpencodeConfigFile };
  writeOpencodeConfig: {
    args: [scope: string, projectDir: string, content: string];
    result: ExecResult;
  };
  resetOpenworkState: { args: [mode?: "onboarding" | "all"]; result: unknown };
  opencodeMcpAuth: { args: [action: string, name: string]; result: ExecResult };

  __showContextMenu: { args: [request: NativeContextMenuRequest]; result: string | null };
  __cancelContextMenu: { args: [requestId: string]; result: boolean };
  __resolveChatFilePath: { args: [target: string]; result: string | null };
  __openPath: { args: [target: string]; result: unknown };
  __openWorkspaceFile: { args: [workspaceRoot: string, target: string, options?: { reveal?: boolean }]; result: DesktopWorkspaceFileOpenResult };
  __revealItemInDir: { args: [target: string]; result: unknown };
  __applyBrandAppName: { args: [appName: string | null]; result: { ok: true; appName: string } };
  __applyBrandIcon: { args: [url: string | null]; result: BrandIconApplyResult };
  __getBrandIconState: { args: []; result: BrandIconState };
  __evalRelaunch: { args: []; result: EvalRelaunchResult };
  __getApplicationsForFile: { args: [target: string]; result: { name: string; appPath: string; icon: string | null }[] };
  __openWithApp: { args: [target: string, appPath: string, workspaceRoot: string]; result: unknown };
  __fetch: { args: [url: string, init?: DesktopFetchInit]; result: DesktopFetchResult };
  __cancelTransfer: { args: [transferId: string]; result: boolean };
  __homeDir: { args: []; result: string };
  __joinPath: { args: [...segments: string[]]; result: string };
  __setZoomFactor: { args: [factor: number]; result: boolean };
  __setNativeTheme: { args: [theme: string]; result: unknown };
  __setApplicationMenuVisible: { args: [visible: boolean]; result: unknown };
};

/** Data-only context menu contract; callbacks and privileged Electron roles never cross IPC. */
export type NativeContextMenuItem = { type: "separator" } | {
  type: "item";
  id: string;
  label: string;
  enabled?: boolean;
  submenu?: NativeContextMenuItem[];
};

export type NativeContextMenuRequest = {
  requestId?: string;
  items: NativeContextMenuItem[];
  point: { x: number; y: number };
  includeEditing?: boolean;
};

export type DesktopCommandName = keyof DesktopCommandMap;

export type DesktopCommandArgs<C extends DesktopCommandName> = DesktopCommandMap[C]["args"];

export type DesktopCommandResult<C extends DesktopCommandName> = DesktopCommandMap[C]["result"];

type DesktopCommandHandler<Event, C extends DesktopCommandName> = (
  event: Event,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any[]
) => Promise<DesktopCommandResult<C>>;

export type DesktopCommandHandlers<Event = unknown> = {
  [C in Exclude<DesktopCommandName, "__evalRelaunch">]: DesktopCommandHandler<Event, C>;
} & {
  __evalRelaunch?: DesktopCommandHandler<Event, "__evalRelaunch">;
};

/** Renderer-side bridge: one async function per command. */
export type DesktopCommandInvokers = {
  [C in DesktopCommandName]: (...args: DesktopCommandArgs<C>) => Promise<DesktopCommandResult<C>>;
};
