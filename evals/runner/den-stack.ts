/**
 * Den-stack harness for the eval runner (`pnpm evals --stack den`).
 *
 * Brings up everything the cloud eval flows need, idempotently:
 *   1. MySQL (docker compose, reuses the dev:den compose project + volume)
 *   2. Schema push when the persistent database is behind the current checkout
 *   3. den-api behind a local proxy on :8790: bare /* plus den-web
 *      /api/den/* topology (only when not already healthy)
 *   4. Demo-org seed (only when the demo owner cannot sign in)
 *   5. Desktop bootstrap pointed at the local Den + dev Electron with CDP
 *      (only when no CDP endpoint is reachable)
 *   6. A demo-owner session token, exported as OPENWORK_EVAL_DEN_API_URL /
 *      OPENWORK_EVAL_DEN_TOKEN so env-gated flows run without manual setup.
 *
 * `pnpm evals --stack-down` stops what the harness started.
 */
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(RUNNER_DIR, "..", "..");
const STATE_DIR = join(RUNNER_DIR, "..", "results", ".den-stack");
const EVAL_ELECTRON_USERDATA = process.env.OPENWORK_EVAL_ELECTRON_USERDATA?.trim()
  || join(STATE_DIR, "electron-user-data");

const DEN_API_PORT = Number(process.env.OPENWORK_EVAL_DEN_PORT ?? 8790);
const DEN_API_INTERNAL_PORT = DEN_API_PORT + 1;
const DEN_API_URL = `http://127.0.0.1:${DEN_API_PORT}`;
const DEN_API_INTERNAL_URL = `http://127.0.0.1:${DEN_API_INTERNAL_PORT}`;
const DEN_BASE_URL = `http://localhost:${DEN_API_PORT}`;
const DEMO_EMAIL = process.env.DEN_DEMO_OWNER_EMAIL ?? "alex@acme.test";
const DEMO_PASSWORD = process.env.DEN_DEMO_OWNER_PASSWORD ?? "OpenWorkDemo123!";
const MYSQL_CONTAINER = "openwork-web-local-mysql";
const MYSQL_STATE_DIR = join(STATE_DIR, "mysql");
const MYSQL_SOCKET = join(MYSQL_STATE_DIR, "mysql.sock");
const COMPOSE_ARGS = ["compose", "-p", "openwork-den-local", "-f", "packaging/docker/docker-compose.web-local.yml"];
const DEFAULT_MOCK_IDP_ISSUER = "http://127.0.0.1:19190";
const MOCK_IDP_ISSUER = (process.env.OPENWORK_EVAL_MOCK_IDP_ISSUER?.trim() || DEFAULT_MOCK_IDP_ISSUER).replace(/\/+$/, "");
const DEN_WEB_ORIGIN = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "http://localhost:3005").replace(/\/+$/, "");
const DEN_WEB_PORT = new URL(DEN_WEB_ORIGIN).port || "3005";

function envCsv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

const DEN_TRUSTED_ORIGINS = [
  DEN_BASE_URL,
  DEN_WEB_ORIGIN,
  `http://localhost:${DEN_WEB_PORT}`,
  `http://127.0.0.1:${DEN_WEB_PORT}`,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  MOCK_IDP_ISSUER,
  ...envCsv("OPENWORK_EVAL_DEN_EXTRA_TRUSTED_ORIGINS"),
].filter((origin, index, origins) => origins.indexOf(origin) === index).join(",");

// Override with OPENWORK_EVAL_DATABASE_URL to isolate a run from the shared
// dev database (e.g. a dedicated schema on the same MySQL container).
const DEN_DATABASE_URL = process.env.OPENWORK_EVAL_DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_den";
const DEN_DATABASE_NAME = new URL(DEN_DATABASE_URL).pathname.replace(/^\//, "") || "openwork_den";
if (!/^[A-Za-z0-9_]+$/.test(DEN_DATABASE_NAME)) {
  throw new Error(`Unsupported Den database name: ${DEN_DATABASE_NAME}`);
}

type DenOrgMode = "single_org" | "multi_org";

interface DenEvalEnvironmentOptions {
  orgMode?: DenOrgMode;
}

export function denEvalEnvironment(options: DenEvalEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    OPENWORK_DEV_MODE: "1",
    DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true",
    PORT: String(DEN_API_INTERNAL_PORT),
    DATABASE_URL: DEN_DATABASE_URL,
    DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
    BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
    BETTER_AUTH_URL: DEN_WEB_ORIGIN,
    DEN_API_PUBLIC_URL: DEN_API_URL,
    DEN_BETTER_AUTH_TRUSTED_ORIGINS: DEN_TRUSTED_ORIGINS,
    CORS_ORIGINS: DEN_TRUSTED_ORIGINS,
    PROVISIONER_MODE: "stub",
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "sk_test_openwork_eval",
    STRIPE_INFERENCE_PRICE_ID: process.env.STRIPE_INFERENCE_PRICE_ID ?? "price_openwork_models_eval",
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_openwork_eval",
    INFERENCE_PROXY_BASE_URL: process.env.INFERENCE_PROXY_BASE_URL ?? "http://127.0.0.1:8791",
  };
  if (options.orgMode) env.DEN_ORG_MODE = options.orgMode;
  return env;
}

const DEN_ENV = denEvalEnvironment();

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function isDenOrgMode(value: unknown): value is DenOrgMode {
  return value === "single_org" || value === "multi_org";
}

function devUserDataHome(): string {
  return EVAL_ELECTRON_USERDATA;
}

function devBootstrapPath(): string {
  return join(devUserDataHome(), "openwork-dev-data", "home", ".config", "openwork", "desktop-bootstrap.json");
}

async function httpOk(url: string, timeoutMs = 2_500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function runtimeOrgMode(timeoutMs = 2_500): Promise<DenOrgMode | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${DEN_WEB_ORIGIN}/api/runtime-config`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return isRecord(payload) && isDenOrgMode(payload.orgMode) ? payload.orgMode : null;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidIsAlive(pid)) return true;
    await sleep(250);
  }
  return !pidIsAlive(pid);
}

async function stopRecordedProcess(name: string, label: string, log: (message: string) => void): Promise<void> {
  const pidText = await readPidState(name);
  if (!pidText) return;
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return;
  let signaled = false;
  try {
    process.kill(-pid, "SIGINT");
    signaled = true;
  } catch {
    // Group may not exist, or this may be Windows.
  }
  try {
    process.kill(pid, "SIGINT");
    signaled = true;
  } catch {
    // Already gone.
  }
  if (signaled) log(`Stopped ${label} for orgMode restart (pid ${pid})`);
  if (await waitForPidGone(pid, 5_000)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group may already be gone.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await waitForPidGone(pid, 1_000);
}

async function hasCdpPageTarget(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    const response = await fetch(`${baseUrl}/json/list`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const targets: unknown = await response.json();
    return Array.isArray(targets)
      && targets.some((target) => isRecord(target) && target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
  } catch {
    return false;
  }
}

async function signInDemoOwner(): Promise<string | null> {
  try {
    const response = await fetch(`${DEN_API_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: DEN_BASE_URL },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return isRecord(payload) && typeof payload.token === "string" && payload.token ? payload.token : null;
  } catch {
    return null;
  }
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolveRun({
        stdout,
        stderr,
      });
    });
  });
}

interface SpawnDetachedOptions {
  logName: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

function spawnDetached(command: string, args: string[], { logName, env, cwd }: SpawnDetachedOptions): number {
  // Redirect stdio to a log file — inheriting it would keep the parent's
  // pipes open forever and hang any shell pipeline wrapping the runner.
  const logFd = openSync(join(STATE_DIR, `${logName}.log`), "a");
  const child = spawn(command, args, {
    cwd: cwd ?? REPO_ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not spawn ${command}.`);
  return child.pid;
}

async function writePidState(name: string, value: unknown): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, name), String(value));
}

async function readPidState(name: string): Promise<string | null> {
  try {
    return (await readFile(join(STATE_DIR, name), "utf8")).trim();
  } catch {
    return null;
  }
}

async function resolveExecutable(names: string[]): Promise<string | null> {
  for (const name of names) {
    try {
      const { stdout } = await run("which", [name]);
      const executable = stdout.trim();
      if (executable) return executable;
    } catch {
      // Try the next compatible binary name.
    }
  }
  return null;
}

function mysqlConnectionArgs(includeDatabase = true): string[] {
  const url = new URL(DEN_DATABASE_URL);
  const args = [
    "--protocol=tcp",
    "-h",
    url.hostname,
    "-P",
    url.port || "3306",
    `-u${decodeURIComponent(url.username || "root")}`,
  ];
  const password = decodeURIComponent(url.password);
  if (password) args.push(`-p${password}`);
  if (includeDatabase) args.push(DEN_DATABASE_NAME);
  return args;
}

async function nativeMysqlQuery(sql: string, includeDatabase = true): Promise<string> {
  const client = await resolveExecutable(["mariadb", "mysql"]);
  if (!client) throw new Error("Neither mariadb nor mysql client is available.");
  const { stdout } = await run(client, [
    ...mysqlConnectionArgs(includeDatabase),
    "-N",
    "-e",
    sql,
  ]);
  return stdout.trim();
}

async function nativeMysqlHealthy(): Promise<boolean> {
  try {
    await nativeMysqlQuery("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export function nativeMysqlServerArgs(
  runAsRoot = process.getuid?.() === 0,
): string[] {
  const args = [
    `--datadir=${MYSQL_STATE_DIR}`,
    `--socket=${MYSQL_SOCKET}`,
    "--port=3306",
    "--bind-address=127.0.0.1",
    "--skip-networking=0",
    `--pid-file=${join(MYSQL_STATE_DIR, "mysql.pid")}`,
    `--log-error=${join(MYSQL_STATE_DIR, "mysql.error.log")}`,
  ];
  if (runAsRoot) args.push("--user=root");
  return args;
}

export function nativeMysqlSocketArgs(
  authenticated: boolean,
): string[] {
  const url = new URL(DEN_DATABASE_URL);
  const args = [
    "--protocol=socket",
    `--socket=${MYSQL_SOCKET}`,
    `-u${decodeURIComponent(url.username || "root")}`,
  ];
  const password = decodeURIComponent(url.password);
  if (authenticated && password) args.push(`-p${password}`);
  return args;
}

async function ensureNativeMysql(log: (message: string) => void): Promise<void> {
  if (await nativeMysqlHealthy()) {
    await writePidState("mysql.backend", "native");
    log("Native MySQL already healthy");
    return;
  }

  const server = await resolveExecutable(["mariadbd", "mysqld"]);
  const installer = await resolveExecutable(["mariadb-install-db", "mysql_install_db"]);
  const socketClient = await resolveExecutable(["mariadb", "mysql"]);
  if (!server || !installer || !socketClient) {
    throw new Error(
      "Docker is unavailable and the native MySQL server/client toolchain is incomplete.",
    );
  }

  await mkdir(MYSQL_STATE_DIR, { recursive: true });
  try {
    await access(join(MYSQL_STATE_DIR, "mysql"));
  } catch {
    log("Initializing native MariaDB data directory...");
    await run(installer, [
      `--datadir=${MYSQL_STATE_DIR}`,
      "--auth-root-authentication-method=normal",
      "--skip-test-db",
    ]);
  }

  log("Starting native MariaDB...");
  const pid = spawnDetached(
    server,
    nativeMysqlServerArgs(),
    { logName: "mysql", env: {} },
  );
  await writePidState("mysql.pid", pid);
  await writePidState("mysql.backend", "native");

  let socketArgs: string[] | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    for (const authenticated of [false, true]) {
      const candidateArgs = nativeMysqlSocketArgs(authenticated);
      try {
        await run(socketClient, [
          ...candidateArgs,
          "-N",
          "-e",
          "SELECT 1",
        ]);
        socketArgs = candidateArgs;
        break;
      } catch {
        // A fresh data directory accepts passwordless root while a resumed
        // directory requires the password configured below.
      }
    }
    if (socketArgs) break;
    await sleep(500);
  }
  if (!socketArgs) {
    throw new Error("Native MariaDB did not become ready within 30s.");
  }

  await run(socketClient, [
    ...socketArgs,
    "-e",
    [
      "ALTER USER 'root'@'localhost' IDENTIFIED BY 'password'",
      "CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY 'password'",
      "GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION",
      `CREATE DATABASE IF NOT EXISTS \`${DEN_DATABASE_NAME}\``,
      "FLUSH PRIVILEGES",
    ].join("; "),
  ]);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await nativeMysqlHealthy()) {
      log("Native MariaDB healthy");
      return;
    }
    await sleep(500);
  }
  throw new Error("Native MariaDB did not accept Den database connections within 15s.");
}

async function ensureMysql(log: (message: string) => void): Promise<void> {
  if (process.env.OPENWORK_EVAL_DATABASE_URL) {
    if (!(await nativeMysqlHealthy())) {
      throw new Error("OPENWORK_EVAL_DATABASE_URL is configured but not reachable.");
    }
    await writePidState("mysql.backend", "external");
    log("External MySQL already healthy");
    return;
  }

  const docker = await resolveExecutable(["docker"]);
  if (!docker) {
    await ensureNativeMysql(log);
    return;
  }

  try {
    const { stdout } = await run(docker, ["inspect", "-f", "{{.State.Health.Status}}", MYSQL_CONTAINER]);
    if (stdout.trim() === "healthy") {
      await writePidState("mysql.backend", "docker");
      log("MySQL already healthy");
      return;
    }
  } catch {
    // Not running — start it below.
  }
  log("Starting MySQL (docker compose)...");
  await run(docker, [...COMPOSE_ARGS, "up", "-d", "--wait", "mysql"]);
  await writePidState("mysql.backend", "docker");
  await writePidState("mysql.started", "1");
  log("MySQL healthy");
}

async function mysqlQuery(sql: string): Promise<string> {
  const backend = await readPidState("mysql.backend");
  if (backend === "native" || backend === "external") {
    return nativeMysqlQuery(sql);
  }
  const docker = await resolveExecutable(["docker"]);
  if (!docker) throw new Error("The selected Docker MySQL backend is unavailable.");
  const { stdout } = await run(docker, [
    "exec", MYSQL_CONTAINER,
    "mysql", "-uroot", "-ppassword", DEN_DATABASE_NAME, "-N", "-e", sql,
  ]);
  return stdout.trim();
}

async function ensureSchema(log: (message: string) => void): Promise<void> {
  try {
    const schema = await mysqlQuery("SHOW TABLES LIKE 'organization'; SHOW TABLES LIKE 'desktop_connect_grant'; SHOW TABLES LIKE 'scim_group'; SHOW COLUMNS FROM scim_provider LIKE 'group_mapping_mode';");
    if (
      schema.includes("organization")
      && schema.includes("desktop_connect_grant")
      && schema.includes("scim_group")
      && schema.includes("group_mapping_mode")
    ) {
      log("Schema present");
      return;
    }
  } catch {
    // Database may not exist yet — push will create what it needs.
  }
  log("Synchronizing schema with the current checkout...");
  const denDbDir = join(REPO_ROOT, "ee", "packages", "den-db");
  await run("pnpm", ["--filter", "@openwork-ee/den-db", "build"]);
  await run("node", ["--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "push", "--config", "drizzle.config.ts"], {
    cwd: denDbDir,
    env: { ...process.env, DATABASE_URL: DEN_ENV.DATABASE_URL, DEN_DB_ENCRYPTION_KEY: DEN_ENV.DEN_DB_ENCRYPTION_KEY },
  });
  log("Schema pushed");
}

async function ensureDenApi(log: (message: string) => void, orgMode?: DenOrgMode): Promise<void> {
  const publicHealthOk = await httpOk(`${DEN_API_URL}/health`);
  const denWebPathHealthOk = await httpOk(`${DEN_API_URL}/api/den/health`);
  if (publicHealthOk && denWebPathHealthOk) {
    log("den stack already healthy (with /api/den path)");
    return;
  }
  if (publicHealthOk) {
    throw new Error(
      `A den-api is already healthy on :${DEN_API_PORT}, but it does not serve /api/den. ` +
      "The desktop app cannot use a bare den-api there; rerun with OPENWORK_EVAL_DEN_PORT=<free port>.",
    );
  }

  log(`Starting den-api on internal :${DEN_API_INTERNAL_PORT} (proxied on :${DEN_API_PORT})...`);
  const pid = spawnDetached("pnpm", ["exec", "tsx", "src/main.ts"], {
    logName: "den-api",
    cwd: join(REPO_ROOT, "ee", "apps", "den-api"),
    env: denEvalEnvironment({ orgMode }),
  });
  await writePidState("den-api.pid", pid);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await httpOk(`${DEN_API_INTERNAL_URL}/health`)) {
      log("den-api healthy");
      break;
    }
    await sleep(2_000);
  }
  if (!(await httpOk(`${DEN_API_INTERNAL_URL}/health`))) {
    throw new Error(`den-api did not become healthy on internal :${DEN_API_INTERNAL_PORT} within 60s.`);
  }

  if (await httpOk(`${DEN_API_URL}/api/den/health`)) {
    log("den proxy healthy");
    return;
  }

  log(`Starting den proxy on :${DEN_API_PORT} -> :${DEN_API_INTERNAL_PORT}...`);
  const proxyPid = spawnDetached(process.execPath, [join(RUNNER_DIR, "den-proxy.ts")], {
    logName: "den-proxy",
    env: {
      DEN_PROXY_LISTEN_PORT: String(DEN_API_PORT),
      DEN_PROXY_UPSTREAM_PORT: String(DEN_API_INTERNAL_PORT),
      OPENWORK_EVAL_DEN_PROXY_CONTROL: "1",
    },
  });
  await writePidState("den-proxy.pid", proxyPid);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await httpOk(`${DEN_API_URL}/api/den/health`)) {
      log("den proxy healthy");
      return;
    }
    await sleep(1_000);
  }
  throw new Error("den proxy did not expose /api/den/health within 30s.");
}

export async function clearDenWebBuildCache(
  denWebRoot = join(REPO_ROOT, "ee", "apps", "den-web"),
): Promise<void> {
  await rm(join(denWebRoot, ".next"), { recursive: true, force: true });
}

export async function ensureDenOrgMode(orgMode: DenOrgMode | undefined, log: (message: string) => void): Promise<void> {
  if (!orgMode) return;
  const actual = await runtimeOrgMode();
  if (actual === orgMode) {
    log(`Den orgMode already ${orgMode}`);
    return;
  }
  if (!actual && !(await httpOk(`${DEN_API_URL}/health`)) && !(await httpOk(`${DEN_WEB_ORIGIN}/api/den/health`))) {
    return;
  }
  const detail = actual ? `reports ${actual}` : "could not be verified from runtime-config";
  log(`Den orgMode ${detail}; restarting den-api and den-web for ${orgMode}.`);
  await stopRecordedProcess("den-api.pid", "den-api", log);
  await stopRecordedProcess("den-web.pid", "den-web", log);
  await freePorts([DEN_API_PORT, DEN_API_INTERNAL_PORT, Number(DEN_WEB_PORT)].filter((port) => Number.isInteger(port) && port > 0), log, "Den orgMode restart");
  await clearDenWebBuildCache();
}

async function ensureDenWeb(log: (message: string) => void, orgMode?: DenOrgMode): Promise<void> {
  if (await httpOk(`${DEN_WEB_ORIGIN}/api/den/health`)) {
    log(`den-web already healthy at ${DEN_WEB_ORIGIN}`);
    return;
  }

  const webUrl = new URL(DEN_WEB_ORIGIN);
  const denWebPort = webUrl.port || "3005";
  // Reusable Daytona images may retain a generated Next.js route manifest
  // from an older checkout. Dependencies remain cached, but generated app
  // output must match the exact candidate being proved.
  await clearDenWebBuildCache();
  log(`Starting den-web on :${denWebPort}...`);
  const pid = spawnDetached("pnpm", ["dev:den:web"], {
    logName: "den-web",
    env: {
      DEN_API_BASE: DEN_API_URL,
      DEN_AUTH_ORIGIN: DEN_WEB_ORIGIN,
      DEN_AUTH_FALLBACK_BASE: DEN_API_URL,
      DEN_WEB_PORT: denWebPort,
      ...(orgMode ? { DEN_ORG_MODE: orgMode } : {}),
    },
  });
  await writePidState("den-web.pid", pid);
  // A clean Daytona checkout can spend more than 90 seconds compiling the
  // first den-web route even after the process has started successfully.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (await httpOk(`${DEN_WEB_ORIGIN}/api/den/health`)) {
      log("den-web healthy");
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`den-web did not become healthy at ${DEN_WEB_ORIGIN} within 180s.`);
}

export function denSeedNodeArgs(): string[] {
  return [
    "--conditions=development",
    "--import",
    "tsx",
    "scripts/seed-demo-org.ts",
  ];
}

async function ensureSeed(log: (message: string) => void): Promise<void> {
  if (await signInDemoOwner()) {
    log(`Demo org present (${DEMO_EMAIL})`);
    return;
  }
  log("Seeding demo org (Acme Robotics)...");
  await run(process.execPath, denSeedNodeArgs(), {
    cwd: join(REPO_ROOT, "ee", "apps", "den-api"),
    env: { ...process.env, ...DEN_ENV },
  });
  if (!(await signInDemoOwner())) {
    throw new Error("Seed completed but the demo owner still cannot sign in.");
  }
  log("Demo org seeded");
}

async function freePorts(ports: number[], log: (message: string) => void, reason: string): Promise<void> {
  for (const port of ports) {
    try {
      const { stdout } = await run("lsof", ["-nP", "-ti", `tcp:${port}`]);
      const pids = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL");
          log(`Cleared process ${pid} holding :${port} (${reason})`);
        } catch {
          // Already gone.
        }
      }
    } catch {
      // Port free — nothing to do.
    }
  }
  await sleep(1_500);
}

async function freeStaleAppPorts(log: (message: string) => void): Promise<void> {
  // If no app page target is serving but the dev ports are held, a previous
  // run left a half-dead app behind (e.g. Electron without its renderer).
  // Clear them so the fresh spawn does not lose the bind race.
  await freePorts([9823, 5173], log, "stale app cleanup");
}

async function ensureApp(log: (message: string) => void, cdpCandidates: string[]): Promise<void> {
  for (const candidate of cdpCandidates) {
    if (await hasCdpPageTarget(candidate)) {
      log(`App CDP already reachable at ${candidate} — make sure it targets the local Den (reload after bootstrap changes).`);
      return;
    }
  }

  await freeStaleAppPorts(log);

  const bootstrapPath = devBootstrapPath();
  await mkdir(dirname(bootstrapPath), { recursive: true });
  await writeFile(
    bootstrapPath,
    `${JSON.stringify({ baseUrl: DEN_BASE_URL, apiBaseUrl: DEN_BASE_URL, requireSignin: false }, null, 2)}\n`,
  );
  await writePidState("bootstrap.path", bootstrapPath);
  log(`Wrote desktop bootstrap -> ${DEN_BASE_URL}`);

  log("Starting dev Electron (pnpm dev)...");
  const pid = spawnDetached("pnpm", ["dev"], {
    logName: "app",
    env: { OPENWORK_ELECTRON_USERDATA: EVAL_ELECTRON_USERDATA },
  });
  await writePidState("app.pid", pid);
  for (let attempt = 0; attempt < 45; attempt += 1) {
    for (const candidate of cdpCandidates) {
      if (await hasCdpPageTarget(candidate)) {
        log(`App CDP up at ${candidate}`);
        // Give the renderer a moment to finish booting providers.
        await sleep(8_000);
        return;
      }
    }
    await sleep(4_000);
  }
  throw new Error("Dev Electron CDP page target did not come up within 3 minutes.");
}

export interface EnsureDenStackOptions {
  log(message: string): void;
  cdpCandidates: string[];
  skipApp?: boolean;
  orgMode?: DenOrgMode;
}

export async function ensureDenStack({ log, cdpCandidates, skipApp = false, orgMode }: EnsureDenStackOptions): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await ensureMysql(log);
  await ensureSchema(log);
  await ensureDenOrgMode(orgMode, log);
  await ensureDenApi(log, orgMode);
  await ensureDenWeb(log, orgMode);
  await ensureSeed(log);
  if (skipApp) {
    log("Skipping dev Electron startup — selected eval flow is app-less");
  } else {
    await ensureApp(log, cdpCandidates);
  }

  const token = await signInDemoOwner();
  if (!token) throw new Error("Could not obtain a demo-owner session token.");

  process.env.OPENWORK_EVAL_DEN_API_URL = DEN_API_URL;
  process.env.OPENWORK_EVAL_DEN_WEB_URL = DEN_WEB_ORIGIN;
  process.env.OPENWORK_EVAL_DEN_TOKEN = token;
  log(`Den stack ready — flows get OPENWORK_EVAL_DEN_API_URL=${DEN_API_URL}, OPENWORK_EVAL_DEN_WEB_URL=${DEN_WEB_ORIGIN}, and a fresh ${DEMO_EMAIL} token.`);
}

export interface DenStackDownOptions {
  log(message: string): void;
}

export async function denStackDown({ log }: DenStackDownOptions): Promise<void> {
  const proxyPid = await readPidState("den-proxy.pid");
  if (proxyPid) {
    try { process.kill(Number(proxyPid)); log(`Stopped den-proxy (pid ${proxyPid})`); } catch { /* already gone */ }
  }
  const apiPid = await readPidState("den-api.pid");
  if (apiPid) {
    try { process.kill(Number(apiPid)); log(`Stopped den-api (pid ${apiPid})`); } catch { /* already gone */ }
  }
  const webPid = await readPidState("den-web.pid");
  if (webPid) {
    try { process.kill(-Number(webPid)); } catch { /* group gone */ }
    try { process.kill(Number(webPid)); log(`Stopped den-web (pid ${webPid})`); } catch { /* already gone */ }
  }
  const appPid = await readPidState("app.pid");
  if (appPid) {
    try { process.kill(-Number(appPid)); } catch { /* group gone */ }
    try { process.kill(Number(appPid)); log(`Stopped dev app (pid ${appPid})`); } catch { /* already gone */ }
  }
  const bootstrapPath = await readPidState("bootstrap.path");
  if (bootstrapPath) {
    await rm(bootstrapPath, { force: true });
    log("Removed dev desktop bootstrap override");
  }
  const mysqlBackend = await readPidState("mysql.backend");
  const mysqlPid = await readPidState("mysql.pid");
  if (mysqlBackend === "native" && mysqlPid) {
    try {
      process.kill(Number(mysqlPid));
      log(`Stopped native MariaDB (pid ${mysqlPid})`);
    } catch {
      // Already gone.
    }
  } else if (mysqlBackend === "docker") {
    const docker = await resolveExecutable(["docker"]);
    if (docker) {
      try {
        await run(docker, [...COMPOSE_ARGS, "down"]);
        log("MySQL compose project stopped (volume kept)");
      } catch {
        log("Docker compose down skipped (docker unavailable?)");
      }
    }
  }
  await rm(STATE_DIR, { recursive: true, force: true });
}
