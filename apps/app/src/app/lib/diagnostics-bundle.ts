import { readDevLogs, type DevLogRecord } from "./dev-log";
import {
  appBuildInfo,
  engineInfo,
  openworkServerInfo,
  type AppBuildInfo,
  type EngineInfo,
  type OpencodeExecutionSnapshot,
  type OpenworkServerInfo,
} from "./desktop";
import { readPerfLogs, type PerfLogRecord } from "./perf-log";
import { sanitizeCloudMcpHealthDiagnostic } from "./diagnostic-sanitizer";
import {
  readOpenworkServerSettings,
  type OpenworkServerSettings,
  type OpenworkServerStatus,
} from "./openwork-server";
import { isDesktopRuntime } from "../utils";

export type DiagnosticsBundleContext = {
  anyActiveRuns?: boolean;
  canReloadWorkspace?: boolean;
  clientConnected?: boolean;
  developerMode?: boolean;
  hostConnectUrl?: string;
  hostConnectUrlUsesMdns?: boolean;
  hostInfo?: OpenworkServerInfo | null;
  openworkServerStatus?: OpenworkServerStatus;
  openworkServerUrl?: string;
  runtimeWorkspaceId?: string | null;
  cloudMcpHealth?: unknown;
};

export type DiagnosticsBundleInputs = {
  capturedAt: string;
  desktopRuntime: boolean;
  appInfo: AppBuildInfo | null;
  engineInfo: EngineInfo | null;
  openworkServerSettings: OpenworkServerSettings;
  hostInfo: OpenworkServerInfo | null;
  developerLogs: DevLogRecord[];
  perfLogs: PerfLogRecord[];
  context?: DiagnosticsBundleContext;
  cloudMcpHealth?: unknown;
};

type DiagnosticsExecution = {
  command: string;
  args: string[];
  cwd: string;
  env: Array<{
    name: string;
    value: string;
    redacted: boolean;
  }>;
};

function pickAppInfo(info: AppBuildInfo | null) {
  if (!info) return null;
  return {
    version: info.version,
    gitSha: info.gitSha ?? null,
    buildEpoch: info.buildEpoch ?? null,
    openworkDevMode: info.openworkDevMode ?? null,
  };
}

function pickExecution(execution: OpencodeExecutionSnapshot | null): DiagnosticsExecution | null {
  if (!execution) return null;
  return {
    command: execution.command,
    args: execution.args.map((arg) => arg),
    cwd: execution.cwd,
    env: execution.env.map((entry) => ({
      name: entry.name,
      value: entry.value,
      redacted: entry.redacted,
    })),
  };
}

function pickEngineInfo(info: EngineInfo | null) {
  if (!info) return null;
  return {
    running: info.running,
    runtime: info.runtime,
    managedByServer: info.managedByServer,
    baseUrl: info.baseUrl,
    projectDir: info.projectDir,
    hostname: info.hostname,
    port: info.port,
    pid: info.pid,
    opencodeBinPath: info.opencodeBinPath,
    opencodeBinSource: info.opencodeBinSource,
    lastStdout: info.lastStdout,
    lastStderr: info.lastStderr,
    execution: pickExecution(info.execution),
  };
}

function pickHostInfo(info: OpenworkServerInfo | null) {
  if (!info) return null;
  return {
    running: Boolean(info.running),
    remoteAccessEnabled: info.remoteAccessEnabled,
    baseUrl: info.baseUrl ?? null,
    connectUrl: info.connectUrl ?? null,
    mdnsUrl: info.mdnsUrl ?? null,
    lanUrl: info.lanUrl ?? null,
    lastStdout: info.lastStdout ?? null,
    lastStderr: info.lastStderr ?? null,
  };
}

function defaultHostConnectUrl(hostInfo: OpenworkServerInfo | null) {
  return hostInfo?.connectUrl ?? hostInfo?.mdnsUrl ?? hostInfo?.lanUrl ?? hostInfo?.baseUrl ?? "";
}

function addSecretValue(secrets: string[], value: string | null | undefined) {
  const secret = value?.trim() ?? "";
  if (secret.length < 4 || secrets.includes(secret)) return;
  secrets.push(secret);
}

function collectSecretValues(input: DiagnosticsBundleInputs) {
  const secrets: string[] = [];
  addSecretValue(secrets, input.openworkServerSettings.token);
  addSecretValue(secrets, input.openworkServerSettings.hostToken);
  addSecretValue(secrets, input.hostInfo?.clientToken);
  addSecretValue(secrets, input.hostInfo?.ownerToken);
  addSecretValue(secrets, input.hostInfo?.hostToken);
  addSecretValue(secrets, input.engineInfo?.opencodePassword);
  return secrets;
}

function scrubKnownSecretValues(value: string, secrets: string[]) {
  let output = value;
  for (const secret of secrets) {
    output = output.split(secret).join("[redacted]");
  }
  return output;
}

export function composeDiagnosticsBundleJson(input: DiagnosticsBundleInputs): string {
  const context = input.context;
  const urlOverride = input.openworkServerSettings.urlOverride?.trim() ?? "";
  const token = input.openworkServerSettings.token?.trim() ?? "";
  const hostConnectUrl = context?.hostConnectUrl ?? defaultHostConnectUrl(input.hostInfo);
  const hostConnectUrlUsesMdns = context?.hostConnectUrlUsesMdns ?? hostConnectUrl.includes(".local");
  const clientConnected = context?.clientConnected === true;
  const bundle = {
    capturedAt: input.capturedAt,
    app: pickAppInfo(input.appInfo),
    opencodeEngine: pickEngineInfo(input.engineInfo),
    runtime: {
      tauri: input.desktopRuntime,
      developerMode: context?.developerMode === true,
    },
    workspace: {
      runtimeWorkspaceId: context?.runtimeWorkspaceId ?? null,
      clientConnected,
      anyActiveRuns: context?.anyActiveRuns === true,
    },
    openworkServer: {
      status: context?.openworkServerStatus ?? (clientConnected ? "connected" : "disconnected"),
      url: context?.openworkServerUrl ?? "",
      settings: {
        urlOverride: urlOverride || null,
        tokenPresent: Boolean(token),
      },
      host: pickHostInfo(input.hostInfo),
    },
    cloudMcp: sanitizeCloudMcpHealthDiagnostic(input.cloudMcpHealth ?? context?.cloudMcpHealth ?? null),
    reload: {
      canReloadWorkspace: context?.canReloadWorkspace === true,
    },
    sharing: {
      hostConnectUrl: hostConnectUrl || null,
      hostConnectUrlUsesMdns,
    },
    performance: {
      retainedEntries: input.perfLogs.length,
      recent: input.perfLogs,
    },
    developerLogs: {
      retainedEntries: input.developerLogs.length,
      recent: input.developerLogs,
    },
  };
  return scrubKnownSecretValues(JSON.stringify(bundle, null, 2), collectSecretValues(input));
}

async function readAppInfo(desktopRuntime: boolean) {
  if (!desktopRuntime) return null;
  try {
    return await appBuildInfo();
  } catch {
    return null;
  }
}

async function readEngineInfo(desktopRuntime: boolean) {
  if (!desktopRuntime) return null;
  try {
    return await engineInfo();
  } catch {
    return null;
  }
}

async function readHostInfo(desktopRuntime: boolean) {
  if (!desktopRuntime) return null;
  try {
    return await openworkServerInfo();
  } catch {
    return null;
  }
}

export async function buildDiagnosticsBundleJson(context?: DiagnosticsBundleContext): Promise<string> {
  const desktopRuntime = isDesktopRuntime();
  const hasContextHostInfo = context !== undefined && "hostInfo" in context;
  const appInfo = await readAppInfo(desktopRuntime);
  const engine = await readEngineInfo(desktopRuntime);
  const fetchedHostInfo = hasContextHostInfo ? null : await readHostInfo(desktopRuntime);
  const hostInfo = hasContextHostInfo && context ? context.hostInfo ?? null : fetchedHostInfo;
  return composeDiagnosticsBundleJson({
    capturedAt: new Date().toISOString(),
    desktopRuntime,
    appInfo,
    engineInfo: engine,
    openworkServerSettings: readOpenworkServerSettings(),
    hostInfo,
    developerLogs: readDevLogs(80),
    perfLogs: readPerfLogs(80),
    context,
  });
}
