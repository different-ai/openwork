import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ApprovalMode, ApprovalConfig, ServerConfig, WorkspaceConfig } from "./types.js";
import { buildWorkspaceInfos } from "./workspaces.js";
import { parseList, readJsonFile, shortId } from "./utils.js";

interface CliArgs {
  configPath?: string;
  host?: string;
  port?: number;
  token?: string;
  hostToken?: string;
  approvalMode?: ApprovalMode;
  approvalTimeoutMs?: number;
  workspaces: string[];
  corsOrigins?: string[];
  readOnly?: boolean;
  help?: boolean;
}

interface FileConfig {
  host?: string;
  port?: number;
  token?: string;
  hostToken?: string;
  approval?: Partial<ApprovalConfig>;
  workspaces?: WorkspaceConfig[];
  corsOrigins?: string[];
  authorizedRoots?: string[];
  readOnly?: boolean;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30000;

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { workspaces: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === "--help" || value === "-h") {
      args.help = true;
      continue;
    }
    if (value === "--config") {
      args.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--host") {
      args.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--port") {
      const port = Number(argv[index + 1]);
      if (!Number.isNaN(port)) args.port = port;
      index += 1;
      continue;
    }
    if (value === "--token") {
      args.token = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--host-token") {
      args.hostToken = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--approval") {
      const mode = argv[index + 1] as ApprovalMode | undefined;
      if (mode === "manual" || mode === "auto") args.approvalMode = mode;
      index += 1;
      continue;
    }
    if (value === "--approval-timeout") {
      const timeout = Number(argv[index + 1]);
      if (!Number.isNaN(timeout)) args.approvalTimeoutMs = timeout;
      index += 1;
      continue;
    }
    if (value === "--workspace") {
      const path = argv[index + 1];
      if (path) args.workspaces.push(path);
      index += 1;
      continue;
    }
    if (value === "--cors") {
      args.corsOrigins = parseList(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--read-only") {
      args.readOnly = true;
      continue;
    }
  }
  return args;
}

export function printHelp(): void {
  const message = [
    "openwork-server",
    "",
    "Options:",
    "  --config <path>          Path to server.json",
    "  --host <host>            Hostname (default 127.0.0.1)",
    "  --port <port>            Port (default 8787)",
    "  --token <token>          Client bearer token",
    "  --host-token <token>     Host approval token",
    "  --approval <mode>        manual | auto",
    "  --approval-timeout <ms>  Approval timeout",
    "  --workspace <path>       Workspace root (repeatable)",
    "  --cors <origins>          Comma-separated origins or *",
    "  --read-only              Disable writes",
  ].join("\n");
  console.log(message);
}

async function loadFileConfig(configPath: string): Promise<FileConfig> {
  const parsed = await readJsonFile<FileConfig>(configPath);
  return parsed ?? {};
}

export async function resolveServerConfig(cli: CliArgs): Promise<ServerConfig> {
  const envConfigPath = process.env.OPENWORK_SERVER_CONFIG;
  const configPath = cli.configPath ?? envConfigPath ?? resolve(homedir(), ".config", "openwork", "server.json");
  const fileConfig = await loadFileConfig(configPath);
  const configDir = dirname(configPath);

  const envWorkspaces = parseList(process.env.OPENWORK_WORKSPACES);
  const workspaceConfigs: WorkspaceConfig[] =
    cli.workspaces.length > 0
      ? cli.workspaces.map((path) => ({ path }))
      : envWorkspaces.length > 0
        ? envWorkspaces.map((path) => ({ path }))
        : fileConfig.workspaces ?? [];

  const workspaces = buildWorkspaceInfos(workspaceConfigs, configDir);

  const tokenFromEnv = process.env.OPENWORK_TOKEN;
  const hostTokenFromEnv = process.env.OPENWORK_HOST_TOKEN;

  const token = cli.token ?? tokenFromEnv ?? fileConfig.token ?? shortId();
  const hostToken = cli.hostToken ?? hostTokenFromEnv ?? fileConfig.hostToken ?? shortId();

  const tokenSource: ServerConfig["tokenSource"] = cli.token
    ? "cli"
    : tokenFromEnv
      ? "env"
      : fileConfig.token
        ? "file"
        : "generated";

  const hostTokenSource: ServerConfig["hostTokenSource"] = cli.hostToken
    ? "cli"
    : hostTokenFromEnv
      ? "env"
      : fileConfig.hostToken
        ? "file"
        : "generated";

  const approvalMode =
    cli.approvalMode ??
    (process.env.OPENWORK_APPROVAL_MODE as ApprovalMode | undefined) ??
    fileConfig.approval?.mode ??
    "manual";

  const approvalTimeoutMs =
    cli.approvalTimeoutMs ??
    (process.env.OPENWORK_APPROVAL_TIMEOUT_MS ? Number(process.env.OPENWORK_APPROVAL_TIMEOUT_MS) : undefined) ??
    fileConfig.approval?.timeoutMs ??
    DEFAULT_TIMEOUT_MS;

  const approval: ApprovalConfig = {
    mode: approvalMode === "auto" ? "auto" : "manual",
    timeoutMs: Number.isNaN(approvalTimeoutMs) ? DEFAULT_TIMEOUT_MS : approvalTimeoutMs,
  };

  const envCorsOrigins = process.env.OPENWORK_CORS_ORIGINS;
  const parsedEnvCors = envCorsOrigins ? parseList(envCorsOrigins) : null;
  const corsOrigins = cli.corsOrigins ?? parsedEnvCors ?? fileConfig.corsOrigins ?? ["*"];

  const envReadOnly = process.env.OPENWORK_READONLY;
  const parsedReadOnly = envReadOnly
    ? ["true", "1", "yes"].includes(envReadOnly.toLowerCase())
    : undefined;
  const readOnly = cli.readOnly ?? parsedReadOnly ?? fileConfig.readOnly ?? false;

  const authorizedRoots =
    fileConfig.authorizedRoots?.length
      ? fileConfig.authorizedRoots.map((root) => resolve(configDir, root))
      : workspaces.map((workspace) => workspace.path);

  const host = cli.host ?? process.env.OPENWORK_HOST ?? fileConfig.host ?? DEFAULT_HOST;
  const port = cli.port ?? (process.env.OPENWORK_PORT ? Number(process.env.OPENWORK_PORT) : undefined) ?? fileConfig.port ?? DEFAULT_PORT;

  return {
    host,
    port: Number.isNaN(port) ? DEFAULT_PORT : port,
    token,
    hostToken,
    approval,
    corsOrigins,
    workspaces,
    authorizedRoots,
    readOnly,
    startedAt: Date.now(),
    tokenSource,
    hostTokenSource,
  };
}
