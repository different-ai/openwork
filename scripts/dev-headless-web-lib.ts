import path from "node:path";

export type HeadlessServerConfigDocument = Record<string, unknown> & {
  authorizedRoots: string[];
  workspaces: Array<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
};

/** Args forwarded to the detached re-spawn of the launcher itself. */
export function buildDetachedRespawnArgs(argv: string[]): string[] {
  return argv.filter((arg) => arg !== "--detach");
}

/** Normalizes a Den control-plane target to a bare origin. */
export function normalizeDenTarget(value: string | undefined): string {
  const raw = (value ?? "https://app.openworklabs.com").trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withProtocol).origin;
}

/**
 * Matches only processes this launcher may have spawned, so stale-manifest
 * cleanup can never kill an unrelated process that reused a pid.
 */
export function isHeadlessStackCommand(command: string): boolean {
  return (
    command.includes("dev-headless-web") ||
    command.includes("openwork-server") ||
    command.includes("apps/server/src/cli.ts") ||
    command.includes("vite")
  );
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
  if (trimmed) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  }
  return path.join(cwd, "tmp", "headless-server.json");
}

export function resolveHeadlessRuntimeManifestPath(cwd: string): string {
  return path.join(cwd, "tmp", "dev-headless-web.json");
}

/**
 * Merges the launcher's requirements into the existing isolated server config
 * instead of rewriting it. The server persists runtime state into this file
 * (workspaces registered through the UI, expanded authorizedRoots), so a
 * relaunch that clobbered it would orphan every workspace the user added —
 * their browser tabs would land on "Workspace or session not found".
 */
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
      // Corrupt config: fall back to the minimal document below.
    }
  }
  const existingRoots = Array.isArray(existing.authorizedRoots)
    ? existing.authorizedRoots.filter(
        (root): root is string => typeof root === "string",
      )
    : [];
  const authorizedRoots = existingRoots.some(
    (root) => path.resolve(root) === workspaceRoot,
  )
    ? existingRoots
    : [...existingRoots, workspaceRoot];
  const existingWorkspaces = Array.isArray(existing.workspaces)
    ? existing.workspaces.filter(isRecord)
    : [];
  const hasWorkspace = existingWorkspaces.some(
    (entry) =>
      typeof entry.path === "string" && path.resolve(entry.path) === workspaceRoot,
  );
  return {
    ...existing,
    authorizedRoots,
    workspaces: hasWorkspace
      ? existingWorkspaces
      : [...existingWorkspaces, { path: workspaceRoot }],
  };
}

/**
 * Tokens survive crash-restarts: reuse the previous manifest's credentials
 * unless the caller pins them via env. `--replace` passes `previous: null`
 * so leaked credentials die with the old process; `--keep-tokens` opts back
 * into reuse for a controlled handoff.
 */
export function resolveHeadlessTokens(input: {
  envToken: string | undefined;
  envHostToken: string | undefined;
  previous: Pick<HeadlessRuntimeManifest, "token" | "hostToken"> | null;
  generate: () => string;
}): { token: string; hostToken: string } {
  const token =
    input.envToken?.trim() || input.previous?.token?.trim() || input.generate();
  const hostToken =
    input.envHostToken?.trim() ||
    input.previous?.hostToken?.trim() ||
    input.generate();
  return { token, hostToken };
}

/**
 * Origins allowed to call the local server from a browser. The only browser
 * client is the Vite app, so listing its origins keeps `--cors *` — which lets
 * any site the developer visits reach the token-authenticated local API — out
 * of the dev stack. `localhost` and `127.0.0.1` are distinct origins to a
 * browser, and either can be typed into the address bar.
 */
export function buildHeadlessCorsOrigins(input: {
  webUrl: string;
  webPort: number;
}): string[] {
  const origins = new Set<string>([
    new URL(input.webUrl).origin,
    `http://127.0.0.1:${input.webPort}`,
    `http://localhost:${input.webPort}`,
  ]);
  return Array.from(origins);
}

// No --workspace flag: a CLI workspace makes the server ignore the config
// file's persisted `workspaces` list at boot, which would drop workspaces the
// user added through the UI. The merged config carries the workspace instead.
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
}): HeadlessRuntimeManifest {
  const denTarget = input.denTarget ?? null;
  const launcherPid = input.pid ?? process.pid;
  return {
    mode: "local-server",
    webUrl: input.webUrl,
    openworkUrl: input.openworkUrl,
    healthUrl: `${input.openworkUrl.replace(/\/+$/, "")}/health`,
    workspace: path.resolve(input.workspace),
    token: input.token,
    hostToken: input.hostToken,
    serverConfigPath: input.serverConfigPath,
    runtimeManifestPath: input.runtimeManifestPath,
    webLogPath: input.webLogPath,
    headlessLogPath: input.headlessLogPath,
    denTarget,
    denApiUrl: denTarget ? `${input.webUrl.replace(/\/+$/, "")}/api/den` : null,
    notes:
      "Local openwork-server session. Workspace auth uses token/hostToken; both are stable across relaunches, and the server config is merged (never rewritten) so registered workspaces survive --replace. Den/Cloud API calls go same-origin through denApiUrl (Vite proxies them to denTarget; the app is pinned there via VITE_DEN_API_BASE_URL), so no CORS and no stale localStorage base URLs. Sign-in opens the Den web flow in the browser.",
    startedAt: input.startedAt ?? new Date().toISOString(),
    pid: launcherPid,
    pids: {
      launcher: launcherPid,
      web: input.webPid ?? null,
      openworkServer: input.openworkServerPid ?? null,
    },
  };
}
