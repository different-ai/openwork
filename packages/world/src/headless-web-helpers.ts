import path from "node:path";

export type HeadlessServerConfigDocument = Record<string, unknown> & {
  authorizedRoots: string[];
  workspaces: Array<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export type HeadlessRuntimePids = {
  launcher: number;
  web: number | null;
  openworkServer: number | null;
};

export type HeadlessRuntimeManifest = {
  mode: "local-server";
  webUrl: string;
  openworkUrl: string;
  healthUrl: string;
  workspace: string;
  token: string;
  hostToken: string;
  serverConfigPath: string;
  runtimeManifestPath: string;
  webLogPath: string;
  headlessLogPath: string;
  denTarget: string | null;
  denApiUrl: string | null;
  notes: string;
  startedAt: string;
  pid: number;
  pids: HeadlessRuntimePids;
  supervisorPid?: number | null;
  world?: { name: string; state: HeadlessWebState; launchId?: string };
};

export type HeadlessWebState = "isolated" | "installed-production";

/** Args forwarded by the legacy detached launcher. */
export function buildDetachedRespawnArgs(argv: string[]): string[] {
  return argv.filter((arg) => arg !== "--detach");
}

export function normalizeDenTarget(value: string | undefined): string {
  const raw = (value ?? "https://app.openworklabs.com").trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withProtocol).origin;
}

export function isHeadlessStackCommand(command: string): boolean {
  return command.includes("dev-headless-web")
    || command.includes("openwork-server")
    || command.includes("apps/server/src/cli.ts")
    || command.includes("packages/world")
    || command.includes("vite");
}

export function buildHeadlessServerLaunch(
  cwd: string,
  serverArgs: string[],
): { command: string; args: string[] } {
  return {
    command: "bun",
    args: [
      "--conditions=development",
      path.join(cwd, "apps/server/src/cli.ts"),
      ...serverArgs,
    ],
  };
}

export function resolveHeadlessServerConfigPath(
  cwd: string,
  override?: string | null,
): string {
  const trimmed = override?.trim();
  if (trimmed) return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  return path.join(cwd, "tmp", "headless-server.json");
}

export function resolveHeadlessRuntimeManifestPath(cwd: string): string {
  return path.join(cwd, "tmp", "dev-headless-web.json");
}

export function mergeHeadlessServerConfig(
  existingRaw: string | null,
  workspace: string,
): HeadlessServerConfigDocument {
  const workspaceRoot = path.resolve(workspace);
  let existing: Record<string, unknown> = {};
  if (existingRaw) {
    try {
      const parsed: unknown = JSON.parse(existingRaw);
      if (isRecord(parsed)) existing = parsed;
    } catch {
      // Corrupt config: fall back to a minimal isolated document.
    }
  }
  const existingRoots = Array.isArray(existing.authorizedRoots)
    ? existing.authorizedRoots.filter((root): root is string => typeof root === "string")
    : [];
  const authorizedRoots = existingRoots.some((root) => path.resolve(root) === workspaceRoot)
    ? existingRoots
    : [...existingRoots, workspaceRoot];
  const existingWorkspaces = Array.isArray(existing.workspaces)
    ? existing.workspaces.filter(isRecord)
    : [];
  const hasWorkspace = existingWorkspaces.some(
    (entry) => typeof entry.path === "string" && path.resolve(entry.path) === workspaceRoot,
  );
  return {
    ...existing,
    authorizedRoots,
    workspaces: hasWorkspace
      ? existingWorkspaces
      : [...existingWorkspaces, { path: workspaceRoot }],
  };
}

export function resolveHeadlessTokens(input: {
  envToken: string | undefined;
  envHostToken: string | undefined;
  previous: Pick<HeadlessRuntimeManifest, "token" | "hostToken"> | null;
  generate: () => string;
}): { token: string; hostToken: string } {
  const token = input.envToken?.trim() || input.previous?.token?.trim() || input.generate();
  const hostToken = input.envHostToken?.trim() || input.previous?.hostToken?.trim() || input.generate();
  return { token, hostToken };
}

export function buildHeadlessCorsOrigins(input: {
  webUrl: string;
  webPort: number;
}): string[] {
  return Array.from(new Set([
    new URL(input.webUrl).origin,
    `http://127.0.0.1:${input.webPort}`,
    `http://localhost:${input.webPort}`,
  ]));
}

export function buildOpenworkServerArgs(input: {
  host: string;
  port: number;
  configPath: string;
  corsOrigins: string[];
}): string[] {
  return [
    "--config",
    input.configPath,
    "--host",
    input.host,
    "--port",
    String(input.port),
    "--approval",
    "auto",
    "--cors",
    input.corsOrigins.join(","),
    "--verbose",
  ];
}

export function buildHeadlessRuntimeManifest(input: {
  webUrl: string;
  openworkUrl: string;
  workspace: string;
  token: string;
  hostToken: string;
  serverConfigPath: string;
  runtimeManifestPath: string;
  webLogPath: string;
  headlessLogPath: string;
  denTarget?: string | null;
  pid?: number;
  webPid?: number | null;
  openworkServerPid?: number | null;
  startedAt?: string;
  supervisorPid?: number | null;
  world?: { name: string; state: HeadlessWebState; launchId?: string };
}): HeadlessRuntimeManifest {
  const denTarget = input.denTarget ?? null;
  const launcherPid = input.pid ?? process.pid;
  return {
    mode: "local-server",
    webUrl: input.webUrl,
    openworkUrl: input.openworkUrl,
    healthUrl: `${stripTrailingSlashes(input.openworkUrl)}/health`,
    workspace: path.resolve(input.workspace),
    token: input.token,
    hostToken: input.hostToken,
    serverConfigPath: input.serverConfigPath,
    runtimeManifestPath: input.runtimeManifestPath,
    webLogPath: input.webLogPath,
    headlessLogPath: input.headlessLogPath,
    denTarget,
    denApiUrl: denTarget ? `${stripTrailingSlashes(input.webUrl)}/api/den` : null,
    notes: "Local openwork-server session. Workspace auth uses token/hostToken; the server config and state selection are owned by the selected world. Den/Cloud API calls go same-origin through denApiUrl (Vite proxies them to denTarget; the app is pinned there via VITE_DEN_API_BASE_URL).",
    startedAt: input.startedAt ?? new Date().toISOString(),
    pid: launcherPid,
    pids: {
      launcher: launcherPid,
      web: input.webPid ?? null,
      openworkServer: input.openworkServerPid ?? null,
    },
    ...(input.supervisorPid === undefined ? {} : { supervisorPid: input.supervisorPid }),
    ...(input.world ? { world: input.world } : {}),
  };
}
