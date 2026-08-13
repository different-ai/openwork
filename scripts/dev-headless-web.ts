import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  buildDetachedRespawnArgs,
  normalizeDenTarget,
  buildHeadlessCorsOrigins,
  buildHeadlessRuntimeManifest,
  buildHeadlessServerLaunch,
  buildOpenworkServerArgs,
  isHeadlessStackCommand,
  mergeHeadlessServerConfig,
  resolveHeadlessRuntimeManifestPath,
  resolveHeadlessServerConfigPath,
  resolveHeadlessTokens,
  type HeadlessRuntimeManifest,
} from "./dev-headless-web-lib";

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");

const DEFAULT_WEB_PORT = "5178";
const DEFAULT_SERVER_PORT = "8778";
const DEFAULT_DEN_TARGET = "https://app.openworklabs.com";

const ensureTmp = async () => {
  await mkdir(tmpDir, { recursive: true });
};

const isPortFree = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });

const getFreePort = (host: string) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve free port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const resolvePort = async (value: string | undefined, host: string) => {
  if (value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      const free = await isPortFree(parsed, host);
      if (free) return parsed;
    }
  }
  return await getFreePort(host);
};

const logLine = (message: string) => {
  process.stdout.write(`${message}\n`);
};

const readBool = (value: string | undefined) => {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const silent = process.argv.includes("--silent");
const replaceRequested =
  process.argv.includes("--replace") ||
  readBool(process.env.OPENWORK_DEV_HEADLESS_WEB_REPLACE);

const denProxyEnabled =
  process.env.OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY == null
    ? true
    : readBool(process.env.OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY);

// Detached: each child leads its own process group, so signals aimed at the
// launcher (e.g. a terminal session getting reaped) cannot take the stack down.
const spawnLogged = (
  command: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv,
) => {
  const logFd = openSync(logPath, "w");
  return spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const probeOk = async (url: string) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

const processCommand = (pid: number): string | null => {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
    return output || null;
  } catch {
    return null;
  }
};

const killStackPid = async (pid: number | null | undefined) => {
  if (!pid || pid <= 0) return;
  const command = processCommand(pid);
  if (!command || !isHeadlessStackCommand(command)) return;
  const signalGroupThenPid = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  };
  signalGroupThenPid("SIGTERM");
  await sleep(500);
  if (processCommand(pid)) {
    signalGroupThenPid("SIGKILL");
  }
};

const readExistingManifest = async (
  manifestPath: string,
): Promise<HeadlessRuntimeManifest | null> => {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "webUrl" in parsed &&
      "healthUrl" in parsed
    ) {
      return parsed as HeadlessRuntimeManifest;
    }
    return null;
  } catch {
    return null;
  }
};

const probeStack = async (manifest: HeadlessRuntimeManifest) =>
  (await probeOk(manifest.healthUrl)) && (await probeOk(manifest.webUrl));

await ensureTmp();

const runtimeManifestPath = resolveHeadlessRuntimeManifestPath(cwd);
const existingManifest = await readExistingManifest(runtimeManifestPath);
const existingHealthy = existingManifest
  ? await probeStack(existingManifest)
  : false;

if (existingManifest && existingHealthy && !replaceRequested) {
  logLine("[dev:headless-web] Already running; reusing the healthy instance");
  logLine(`[dev:headless-web] Web URL: ${existingManifest.webUrl}`);
  logLine(`[dev:headless-web] OpenWork server: ${existingManifest.openworkUrl}`);
  logLine(
    `[dev:headless-web] Agent runtime: ${path.relative(cwd, runtimeManifestPath)}`,
  );
  logLine("[dev:headless-web] Pass --replace to restart it");
  process.exit(0);
}

// --detach: re-spawn this script in its own process group so the stack does
// not depend on the invoking terminal surviving, then wait for health.
const detachRequested = process.argv.includes("--detach");
const isDetachedChild = readBool(process.env.OPENWORK_DEV_HEADLESS_WEB_DETACHED);
if (detachRequested && !isDetachedChild) {
  const launcherLogPath = path.join(tmpDir, "dev-headless-web.launcher.log");
  const launcherLogFd = openSync(launcherLogPath, "w");
  const detachedChild = spawn(
    process.execPath,
    [
      path.join(cwd, "scripts", "dev-headless-web.ts"),
      ...buildDetachedRespawnArgs(process.argv.slice(2)),
    ],
    {
      cwd,
      env: { ...process.env, OPENWORK_DEV_HEADLESS_WEB_DETACHED: "1" },
      stdio: ["ignore", launcherLogFd, launcherLogFd],
      detached: true,
    },
  );
  detachedChild.unref();
  logLine(
    `[dev:headless-web] Detached launcher started (pid ${detachedChild.pid}); log: ${path.relative(cwd, launcherLogPath)}`,
  );
  const previousStartedAt = existingManifest?.startedAt ?? null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const manifest = await readExistingManifest(runtimeManifestPath);
    if (
      manifest &&
      manifest.startedAt !== previousStartedAt &&
      (await probeStack(manifest))
    ) {
      logLine(`[dev:headless-web] Web URL: ${manifest.webUrl}`);
      logLine(`[dev:headless-web] OpenWork server: ${manifest.openworkUrl}`);
      if (manifest.denApiUrl) {
        logLine(
          `[dev:headless-web] Den (same-origin): ${manifest.denApiUrl} -> ${manifest.denTarget}`,
        );
      }
      logLine(
        `[dev:headless-web] Agent runtime: ${path.relative(cwd, runtimeManifestPath)}`,
      );
      process.exit(0);
    }
    await sleep(500);
  }
  logLine(
    `[dev:headless-web] Still starting; watch ${path.relative(cwd, launcherLogPath)} and tmp/dev-headless-web.json`,
  );
  process.exit(0);
}

if (existingManifest) {
  if (existingHealthy) {
    logLine("[dev:headless-web] --replace: stopping the running instance");
  } else {
    logLine("[dev:headless-web] Cleaning up stale instance from the last run");
  }
  await killStackPid(existingManifest.pids?.web);
  await killStackPid(existingManifest.pids?.openworkServer);
  await killStackPid(existingManifest.pids?.launcher ?? existingManifest.pid);
}

const remoteAccessEnabled = readBool(process.env.OPENWORK_REMOTE_ACCESS);
const host = remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
const viteHost = process.env.VITE_HOST ?? process.env.HOST ?? host;
const publicHost = process.env.OPENWORK_PUBLIC_HOST ?? null;
const clientHost = publicHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
const workspace = path.resolve(process.env.OPENWORK_WORKSPACE ?? cwd);
const openworkPort = await resolvePort(
  process.env.OPENWORK_PORT ?? DEFAULT_SERVER_PORT,
  "127.0.0.1",
);
const webPort = await resolvePort(
  process.env.OPENWORK_WEB_PORT ?? DEFAULT_WEB_PORT,
  "127.0.0.1",
);
// `--replace` starts a new process, so leaked credentials from the previous
// run must not stay valid. Crash-restart (stale pid cleanup) still reuses
// tokens so open tabs survive. `--keep-tokens` opts into reuse across replace.
const keepTokensRequested = process.argv.includes("--keep-tokens");
const rotateTokensRequested =
  process.argv.includes("--rotate-tokens") ||
  (replaceRequested && !keepTokensRequested);
const { token: openworkToken, hostToken: openworkHostToken } =
  resolveHeadlessTokens({
    envToken: process.env.OPENWORK_TOKEN,
    envHostToken: process.env.OPENWORK_HOST_TOKEN,
    previous: rotateTokensRequested ? null : existingManifest,
    generate: randomUUID,
  });
const serverConfigPath = resolveHeadlessServerConfigPath(
  cwd,
  process.env.OPENWORK_DEV_HEADLESS_WEB_CONFIG,
);
const webLogPath = path.join(tmpDir, "dev-web.log");
const headlessLogPath = path.join(tmpDir, "dev-headless.log");

// Merge (never rewrite) the isolated config: the server persists registered
// workspaces and expanded authorizedRoots into it at runtime.
const existingServerConfigRaw = await readFile(serverConfigPath, "utf8").catch(
  () => null,
);
await writeFile(
  serverConfigPath,
  `${JSON.stringify(mergeHeadlessServerConfig(existingServerConfigRaw, workspace), null, 2)}\n`,
  "utf8",
);

const openworkUrl = `http://${clientHost}:${openworkPort}`;
const webUrl = `http://${clientHost}:${webPort}`;

// Den wiring: Vite serves /api/den same-origin (proxied to the target) and
// the app pins its Den API calls there via VITE_DEN_API_BASE_URL, so the
// browser never issues cross-origin Den calls. Sign-in still opens the Den
// web app itself. Deliberately NOT gateway-marker mode: that runtime assumes
// a provisioned cloud instance and disables local workspace creation.
const denTarget = denProxyEnabled
  ? normalizeDenTarget(process.env.OPENWORK_DEV_DEN_PROXY_TARGET)
  : null;
const denApiUrl = denTarget ? `${webUrl}/api/den` : null;

const viteEnv = {
  ...process.env,
  HOST: viteHost,
  PORT: String(webPort),
  VITE_OPENWORK_URL: process.env.VITE_OPENWORK_URL ?? openworkUrl,
  VITE_OPENWORK_PORT: process.env.VITE_OPENWORK_PORT ?? String(openworkPort),
  VITE_OPENWORK_TOKEN: process.env.VITE_OPENWORK_TOKEN ?? openworkToken,
  // Never put the host token in VITE_*: Vite inlines those into the browser
  // bundle. The owner bearer is enough for the web UI; host-token routes
  // (env secrets, den-session) stay on the server process.
  VITE_OPENWORK_FORCE_ENV_SETTINGS: "1",
  VITE_OPENWORK_DEPLOYMENT: process.env.VITE_OPENWORK_DEPLOYMENT ?? "web",
  ...(denTarget && denApiUrl
    ? {
        OPENWORK_DEV_HEADLESS_DEN_TARGET: denTarget,
        // Den API calls go same-origin through the Vite proxy.
        VITE_DEN_API_BASE_URL: process.env.VITE_DEN_API_BASE_URL ?? denApiUrl,
        // For custom control planes, point the sign-in page at the target's
        // own web UI; the hosted default already resolves inside the app.
        ...(denTarget !== DEFAULT_DEN_TARGET
          ? { VITE_DEN_BASE_URL: process.env.VITE_DEN_BASE_URL ?? denTarget }
          : {}),
      }
    : {}),
};

const headlessEnv = {
  ...process.env,
  OPENWORK_WORKSPACE: workspace,
  OPENWORK_HOST: host,
  OPENWORK_REMOTE_ACCESS: remoteAccessEnabled ? "1" : "0",
  OPENWORK_PORT: String(openworkPort),
  OPENWORK_TOKEN: openworkToken,
  OPENWORK_HOST_TOKEN: openworkHostToken,
  OPENWORK_SERVER_CONFIG: serverConfigPath,
  OPENWORK_MANAGE_OPENCODE: "1",
  OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN ?? "opencode",
};

const children: ChildProcess[] = [];

const webProcess = spawnLogged(
  "pnpm",
  [
    "--filter",
    "@openwork/app",
    "exec",
    "vite",
    "--host",
    viteHost,
    "--port",
    String(webPort),
    "--strictPort",
  ],
  webLogPath,
  viteEnv,
);
children.push(webProcess);

const headlessServerLaunch = buildHeadlessServerLaunch(
  cwd,
  buildOpenworkServerArgs({
    host,
    port: openworkPort,
    configPath: serverConfigPath,
    corsOrigins: buildHeadlessCorsOrigins({ webUrl, webPort }),
  }),
);
const headlessProcess = spawnLogged(
  headlessServerLaunch.command,
  headlessServerLaunch.args,
  headlessLogPath,
  headlessEnv,
);
children.push(headlessProcess);

const runtimeManifest = buildHeadlessRuntimeManifest({
  webUrl,
  openworkUrl,
  workspace,
  token: openworkToken,
  hostToken: openworkHostToken,
  serverConfigPath,
  runtimeManifestPath,
  webLogPath,
  headlessLogPath,
  denTarget,
  webPid: webProcess.pid ?? null,
  openworkServerPid: headlessProcess.pid ?? null,
});
// The manifest carries the server bearer and host tokens, so keep it
// owner-only. `mode` applies on creation only; chmod covers the rewrite of a
// manifest an earlier run left with a permissive umask.
await writeFile(
  runtimeManifestPath,
  `${JSON.stringify(runtimeManifest, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
await chmod(runtimeManifestPath, 0o600);

logLine("[dev:headless-web] Starting isolated local-server session");
logLine(`[dev:headless-web] Workspace: ${workspace}`);
logLine(`[dev:headless-web] OpenWork server: ${openworkUrl}`);
logLine(`[dev:headless-web] Web URL: ${webUrl}`);
logLine(
  `[dev:headless-web] Server config: ${path.relative(cwd, serverConfigPath)} (not ~/.config/openwork/server.json)`,
);
logLine(
  `[dev:headless-web] Agent runtime: ${path.relative(cwd, runtimeManifestPath)}`,
);
if (denApiUrl && denTarget) {
  logLine(`[dev:headless-web] Den (same-origin): ${denApiUrl} -> ${denTarget}`);
  logLine(
    "[dev:headless-web] Cloud sign-in: Account -> sign in opens the Den web flow in this browser",
  );
} else {
  logLine("[dev:headless-web] Den disabled (OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY=0)");
}
logLine(
  `[dev:headless-web] Web logs: ${path.relative(cwd, webLogPath)}`,
);
logLine(
  `[dev:headless-web] Headless logs: ${path.relative(cwd, headlessLogPath)}`,
);
logLine("[dev:headless-web] Re-running this command reuses the healthy instance; --replace restarts it");

const killChild = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.exitCode !== null || child.killed) return;
  const pid = child.pid;
  if (pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // fall through to direct kill
    }
  }
  child.kill(signal);
};

let shuttingDown = false;

const shutdown = async (
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const reason =
    code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
  logLine(`[dev:headless-web] ${label} exited (${reason})`);
  for (const child of children) {
    killChild(child, "SIGTERM");
  }
  process.exit(code ?? 1);
};

const stopAll = (signal: NodeJS.Signals) => {
  for (const child of children) {
    killChild(child, signal);
  }
};

process.on("SIGINT", () => {
  stopAll("SIGINT");
});
process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});

webProcess.on("exit", (code, signal) => {
  void shutdown("web", code, signal);
});
headlessProcess.on("exit", (code, signal) => {
  void shutdown("openwork-server", code, signal);
});
