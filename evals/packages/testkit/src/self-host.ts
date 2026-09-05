import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePorts } from "@openwork/cdp";
import { SkipError, ephemeralDatabaseName, localMysqlIsRunning, localRedisIsRunning, trustedOrigins } from "@openwork/env";
import { freePort, killLocalPid } from "@openwork/hosts";
import type { ChildProcess } from "node:child_process";
import type { DenRef } from "@openwork/behaviors";
import type { DbHandle, Place } from "@openwork/env";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const DATABASE_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890";
const BETTER_AUTH_SECRET = "local-testkit-secret-not-for-production-use!!";
const START_TIMEOUT_MS = 120_000;

export interface SelfHostServerOptions {
  place: Place;
  name: string;
  slug: string;
  ownerEmails: string[];
  allowPublicSignup?: boolean;
}

export interface SelfHostDen {
  ref: DenRef;
  database: string;
}

interface SpawnedService {
  child: ChildProcess;
  pid: number;
  port: number;
  label: string;
  logPath: string;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanUrl(value: string): string {
  let out = value.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

// mirrored from server.ts (keep in sync)
function spawnService(
  label: string,
  script: "dev:den:api" | "dev:den:web",
  port: number,
  env: NodeJS.ProcessEnv,
  logPath: string,
): SpawnedService {
  const logFd = openSync(logPath, "a");
  const prepared = process.env.OPENWORK_EVAL_DEN_RUNTIME_PREPARED === "1";
  const args = prepared
    ? label === "den-api"
      ? ["--filter", "@openwork-ee/den-api", "exec", "tsx", "src/main.ts"]
      : ["--filter", "@openwork-ee/den-web", "exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)]
    : [script];
  const child = spawn("pnpm", args, {
    cwd: REPO_ROOT,
    env: prepared && label === "den-api" ? { ...env, PORT: String(port) } : env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error(`Could not start ${label}.`);
  return { child, pid: child.pid, port, label, logPath };
}

// mirrored from server.ts (keep in sync)
async function logTail(path: string): Promise<string> {
  return readFile(path, "utf8")
    .then((text) => text.split(/\r?\n/).slice(-40).join("\n"))
    .catch((error: unknown) => `log unavailable: ${messageText(error)}`);
}

// mirrored from server.ts (keep in sync)
async function waitForHttp(url: string, service: SpawnedService, accept: (response: Response) => boolean): Promise<Response> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last = "not attempted";
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null) {
      throw new Error(`${service.label} exited with ${service.child.exitCode}. Last log lines:\n${await logTail(service.logPath)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (accept(response)) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${service.label} at ${url}: ${last}. Last log lines:\n${await logTail(service.logPath)}`);
}

// mirrored from server.ts (keep in sync)
async function waitForAuthProbe(ref: DenRef, service: SpawnedService): Promise<void> {
  const url = `${cleanUrl(ref.apiUrl)}/api/auth/sign-in/email`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ref.webUrl },
        body: JSON.stringify({ email: `probe-${Date.now()}@openwork.test`, password: "not-a-real-password" }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status !== 403 && response.status < 500) return;
      last = `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`;
    } catch (error) {
      last = messageText(error);
    }
    await delay(500);
  }
  throw new Error(`Den auth behavioral probe failed at ${url}; expected a non-403 response. Last: ${last}. Log:\n${await logTail(service.logPath)}`);
}

// mirrored from server.ts (keep in sync)
async function runDbPush(databaseUrl: string): Promise<void> {
  try {
    const commands = process.env.OPENWORK_EVAL_DEN_RUNTIME_PREPARED === "1"
      ? [
          ["--filter", "@openwork-ee/den-db", "exec", "node", "--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "push", "--config", "drizzle.config.ts"],
          ["--filter", "@openwork-ee/den-db", "exec", "node", "--import", "tsx", "scripts/ensure-schema-repairs.ts"],
        ]
      : [["--filter", "@openwork-ee/den-db", "db:push"]];
    for (const args of commands) {
      await execFileAsync("pnpm", args, {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DEN_DB_ENCRYPTION_KEY: DATABASE_ENCRYPTION_KEY,
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 180_000,
      });
    }
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && typeof Reflect.get(error, "stderr") === "string"
      ? Reflect.get(error, "stderr")
      : "";
    throw new Error(`Ephemeral Den database push failed: ${messageText(error)}${stderr ? `\n${stderr}` : ""}`);
  }
}

// mirrored from server.ts (keep in sync)
async function stopServices(services: SpawnedService[]): Promise<void> {
  for (const service of services) {
    await killLocalPid(service.pid, { log: (line) => console.error(`[openwork/testkit] ${line}`) })
      .catch((error: unknown) => console.error(`[openwork/testkit] ${service.label} cleanup failed: ${messageText(error)}`));
    await freePort(service.port)
      .catch((error: unknown) => console.error(`[openwork/testkit] ${service.label} port cleanup failed: ${messageText(error)}`));
  }
}

export async function selfHostServer(options: SelfHostServerOptions): Promise<SelfHostDen & AsyncDisposable> {
  if (options.place.kind === "daytona") {
    throw new SkipError("selfHostServer requires local placement; unset OPENWORK_EVAL_DAYTONA");
  }
  if (!await localMysqlIsRunning()) {
    throw new Error("Local Den requires MySQL on 127.0.0.1:3306. Run: pnpm dev:den:mysql");
  }
  if (!await localRedisIsRunning()) {
    throw new Error("Local Den requires Redis on 127.0.0.1:6379. Run: redis-server --port 6379 --daemonize yes --save '' --appendonly no");
  }

  const services: SpawnedService[] = [];
  let database: DbHandle | undefined;
  try {
    database = await options.place.db(ephemeralDatabaseName("openwork_selfhost_eval"));
    await runDbPush(database.url);
    const [apiPort, webPort] = await allocateFreePorts(2);
    if (apiPort === undefined || webPort === undefined) throw new Error("Could not allocate Den API/Web ports.");

    const origins = trustedOrigins(apiPort, webPort).join(",");
    const ref: DenRef = {
      apiUrl: `http://127.0.0.1:${apiPort}`,
      webUrl: `http://127.0.0.1:${webPort}`,
    };
    const logsDir = join(REPO_ROOT, "evals", "results", ".testkit", database.name);
    await mkdir(logsDir, { recursive: true });
    const commonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: database.url,
      DEN_DB_ENCRYPTION_KEY: DATABASE_ENCRYPTION_KEY,
      BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: `http://localhost:${webPort}`,
      DEN_BASE_URL: `http://localhost:${webPort}`,
      DEN_API_PUBLIC_URL: ref.apiUrl,
      DEN_API_PORT: String(apiPort),
      DEN_WEB_PORT: String(webPort),
      DEN_BETTER_AUTH_TRUSTED_ORIGINS: origins,
      CORS_ORIGINS: origins,
      DEN_ORG_MODE: "single_org",
      DEN_SINGLE_ORG_NAME: options.name,
      DEN_SINGLE_ORG_SLUG: options.slug,
      DEN_SINGLE_ORG_OWNER_EMAILS: options.ownerEmails.join(","),
      DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: String(options.allowPublicSignup ?? false),
      DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      DEN_PASSWORD_BREACH_SCREENING_ENABLED: "false",
      OPENWORK_DEV_MODE: "1",
      PROVISIONER_MODE: "stub",
    };

    const api = spawnService("den-api", "dev:den:api", apiPort, {
      ...commonEnv,
      DEN_BIND_HOST: "127.0.0.1",
    }, join(logsDir, "api.log"));
    services.push(api);
    const web = spawnService("den-web", "dev:den:web", webPort, {
      DEN_WEB_HOST: "127.0.0.1",
      ...commonEnv,
      DEN_API_BASE: `http://127.0.0.1:${apiPort}`,
      DEN_BASE_URL: `http://localhost:${webPort}`,
      DEN_AUTH_ORIGIN: `http://localhost:${webPort}`,
      DEN_AUTH_FALLBACK_BASE: `http://127.0.0.1:${apiPort}`,
    }, join(logsDir, "web.log"));
    services.push(web);

    await waitForHttp(`${ref.apiUrl}/health`, api, (response) => response.ok);
    await waitForHttp(`${ref.webUrl}/api/ready`, web, (response) => response.ok);
    await waitForAuthProbe(ref, api);

    let disposed = false;
    return {
      ref,
      database: database.name,
      async [Symbol.asyncDispose](): Promise<void> {
        if (disposed) return;
        disposed = true;
        await stopServices(services);
        await database?.drop().catch((error: unknown) => {
          console.error(`[openwork/testkit] ephemeral database cleanup failed: ${messageText(error)}`);
        });
      },
    };
  } catch (error) {
    await stopServices(services);
    await database?.drop().catch(() => undefined);
    throw error;
  }
}
