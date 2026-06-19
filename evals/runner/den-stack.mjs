/**
 * Den-stack harness for the eval runner (`pnpm evals --stack den`).
 *
 * Brings up everything the cloud eval flows need, idempotently:
 *   1. MySQL (docker compose, reuses the dev:den compose project + volume)
 *   2. Schema push (only when the database is empty)
 *   3. den-api on :8790 (only when not already healthy)
 *   4. Demo-org seed (only when the demo owner cannot sign in)
 *   5. Desktop bootstrap pointed at the local Den + dev Electron with CDP
 *      (only when no CDP endpoint is reachable)
 *   6. A demo-owner session token, exported as OPENWORK_EVAL_DEN_API_URL /
 *      OPENWORK_EVAL_DEN_TOKEN so env-gated flows run without manual setup.
 *
 * `pnpm evals --stack-down` stops what the harness started.
 */
import { spawn, execFile } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(RUNNER_DIR, "..", "..");
const STATE_DIR = join(RUNNER_DIR, "..", "results", ".den-stack");

const DEN_API_PORT = Number(process.env.OPENWORK_EVAL_DEN_PORT ?? 8790);
const DEN_API_URL = `http://127.0.0.1:${DEN_API_PORT}`;
const DEN_BASE_URL = `http://localhost:${DEN_API_PORT}`;
const DEMO_EMAIL = process.env.DEN_DEMO_OWNER_EMAIL ?? "alex@acme.test";
const DEMO_PASSWORD = process.env.DEN_DEMO_OWNER_PASSWORD ?? "OpenWorkDemo123!";
const MYSQL_CONTAINER = "openwork-web-local-mysql";
const COMPOSE_ARGS = ["compose", "-p", "openwork-den-local", "-f", "packaging/docker/docker-compose.web-local.yml"];

const DEN_ENV = {
  OPENWORK_DEV_MODE: "1",
  PORT: String(DEN_API_PORT),
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: DEN_BASE_URL,
  DEN_BETTER_AUTH_TRUSTED_ORIGINS: `${DEN_BASE_URL},http://localhost:5173,http://127.0.0.1:5173`,
  CORS_ORIGINS: `${DEN_BASE_URL},http://localhost:5173,http://127.0.0.1:5173`,
  PROVISIONER_MODE: "stub",
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function devUserDataHome() {
  // Matches Electron's appData layout for the dev app identifier.
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "com.differentai.openwork.dev");
  }
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "com.differentai.openwork.dev");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "com.differentai.openwork.dev");
}

function devBootstrapPath() {
  return join(devUserDataHome(), "openwork-dev-data", "home", ".config", "openwork", "desktop-bootstrap.json");
}

async function httpOk(url, timeoutMs = 2_500) {
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

async function signInDemoOwner() {
  try {
    const response = await fetch(`${DEN_API_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: DEN_BASE_URL },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return typeof payload.token === "string" && payload.token ? payload.token : null;
  } catch {
    return null;
  }
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, ...options });
}

function spawnDetached(command, args, { logName, env, cwd }) {
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
  return child.pid;
}

async function writePidState(name, value) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, name), String(value));
}

async function readPidState(name) {
  try {
    return (await readFile(join(STATE_DIR, name), "utf8")).trim();
  } catch {
    return null;
  }
}

async function ensureMysql(log) {
  try {
    const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Health.Status}}", MYSQL_CONTAINER]);
    if (stdout.trim() === "healthy") {
      log("MySQL already healthy");
      return;
    }
  } catch {
    // Not running — start it below.
  }
  log("Starting MySQL (docker compose)...");
  await run("docker", [...COMPOSE_ARGS, "up", "-d", "--wait", "mysql"]);
  await writePidState("mysql.started", "1");
  log("MySQL healthy");
}

async function mysqlQuery(sql) {
  const { stdout } = await run("docker", [
    "exec", MYSQL_CONTAINER,
    "mysql", "-uroot", "-ppassword", "openwork_den", "-N", "-e", sql,
  ]);
  return stdout.trim();
}

async function ensureSchema(log) {
  try {
    const tables = await mysqlQuery("SHOW TABLES LIKE 'organization';");
    if (tables.includes("organization")) {
      log("Schema present");
      return;
    }
  } catch {
    // Database may not exist yet — push will create what it needs.
  }
  log("Pushing schema (first run takes a minute)...");
  const denDbDir = join(REPO_ROOT, "ee", "packages", "den-db");
  await run("pnpm", ["--filter", "@openwork-ee/den-db", "build"]);
  await run("node", ["--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "push", "--config", "drizzle.config.ts"], {
    cwd: denDbDir,
    env: { ...process.env, DATABASE_URL: DEN_ENV.DATABASE_URL, DEN_DB_ENCRYPTION_KEY: DEN_ENV.DEN_DB_ENCRYPTION_KEY },
  });
  log("Schema pushed");
}

async function ensureDenApi(log) {
  if (await httpOk(`${DEN_API_URL}/health`)) {
    log(`den-api already healthy on :${DEN_API_PORT}`);
    return;
  }
  log(`Starting den-api on :${DEN_API_PORT}...`);
  const pid = spawnDetached("npx", ["tsx", "src/server.ts"], {
    logName: "den-api",
    cwd: join(REPO_ROOT, "ee", "apps", "den-api"),
    env: DEN_ENV,
  });
  await writePidState("den-api.pid", pid);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await httpOk(`${DEN_API_URL}/health`)) {
      log("den-api healthy");
      return;
    }
    await sleep(2_000);
  }
  throw new Error("den-api did not become healthy within 60s.");
}

async function ensureSeed(log) {
  if (await signInDemoOwner()) {
    log(`Demo org present (${DEMO_EMAIL})`);
    return;
  }
  log("Seeding demo org (Acme Robotics)...");
  await run("npx", ["tsx", "scripts/seed-demo-org.ts"], {
    cwd: join(REPO_ROOT, "ee", "apps", "den-api"),
    env: { ...process.env, ...DEN_ENV },
  });
  if (!(await signInDemoOwner())) {
    throw new Error("Seed completed but the demo owner still cannot sign in.");
  }
  log("Demo org seeded");
}

async function freeStaleAppPorts(log) {
  // If CDP is not serving but the dev ports are held, a previous run left a
  // half-dead app behind (e.g. Electron without its devtools listener).
  // Clear them so the fresh spawn does not lose the bind race.
  for (const port of [9823, 5173]) {
    try {
      const { stdout } = await execFileAsync("lsof", ["-nP", "-ti", `tcp:${port}`]);
      const pids = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL");
          log(`Cleared stale process ${pid} holding :${port}`);
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

async function ensureApp(log, cdpCandidates) {
  for (const candidate of cdpCandidates) {
    if (await httpOk(`${candidate}/json/list`)) {
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
  const pid = spawnDetached("pnpm", ["dev"], { logName: "app", env: {} });
  await writePidState("app.pid", pid);
  for (let attempt = 0; attempt < 45; attempt += 1) {
    for (const candidate of cdpCandidates) {
      if (await httpOk(`${candidate}/json/list`)) {
        log(`App CDP up at ${candidate}`);
        // Give the renderer a moment to finish booting providers.
        await sleep(8_000);
        return;
      }
    }
    await sleep(4_000);
  }
  throw new Error("Dev Electron CDP did not come up within 3 minutes.");
}

export async function ensureDenStack({ log, cdpCandidates }) {
  await mkdir(STATE_DIR, { recursive: true });
  await ensureMysql(log);
  await ensureSchema(log);
  await ensureDenApi(log);
  await ensureSeed(log);
  await ensureApp(log, cdpCandidates);

  const token = await signInDemoOwner();
  if (!token) throw new Error("Could not obtain a demo-owner session token.");

  process.env.OPENWORK_EVAL_DEN_API_URL = DEN_API_URL;
  process.env.OPENWORK_EVAL_DEN_TOKEN = token;
  log(`Den stack ready — flows get OPENWORK_EVAL_DEN_API_URL=${DEN_API_URL} and a fresh ${DEMO_EMAIL} token.`);
}

export async function denStackDown({ log }) {
  const apiPid = await readPidState("den-api.pid");
  if (apiPid) {
    try { process.kill(Number(apiPid)); log(`Stopped den-api (pid ${apiPid})`); } catch { /* already gone */ }
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
  try {
    await run("docker", [...COMPOSE_ARGS, "down"]);
    log("MySQL compose project stopped (volume kept)");
  } catch {
    log("Docker compose down skipped (docker unavailable?)");
  }
  await rm(STATE_DIR, { recursive: true, force: true });
}
