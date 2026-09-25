export const supportedTargets = ["local/host"];

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const lifetimeMs = 120 * 60_000;
const ownerEmail = "gateway-owner@openwork.test";
const inheritedKeys = new Set([
  "PATH", "HOME", "TMPDIR", "SHELL", "LANG", "TERM", "PNPM_HOME",
  "OPENWORK_WORLD_STAGE", "OPENWORK_WORLD_PLACE", "OPENWORK_WORLD_RECIPE_HASH",
  "OPENWORK_WORLD_INVOCATION_HASH", "OPENWORK_WORLD_EVENTS", "OPENWORK_WORLD_LEDGER",
]);

export function preflight(): void {
  if (process.env.OPENWORK_WORLD_SNAPSHOT_DIR && resolve(process.env.OPENWORK_WORLD_SNAPSHOT_DIR) !== join(root, "evals/results/.worlds/scripts")) {
    throw new Error("gateway-local requires worktree-local world receipts.");
  }
  if (process.env.OPENWORK_WORLD_PLACE && process.env.OPENWORK_WORLD_PLACE !== "local") {
    throw new Error("gateway-local requires --place local.");
  }
  for (const key of [
    "OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_MYSQL_URL",
    "OPENWORK_EVAL_DAYTONA", "OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_DEV_SHARED_STATE",
    "OPENWORK_DEN_DB_ENV_PATH", "DATABASE_ENV_FILE",
    "DOCKER_HOST", "DOCKER_CONTEXT", "GATEWAY_EGRESS_ALLOWED_ORIGINS", "OPENROUTER_UPSTREAM_URL",
  ]) {
    if (process.env[key]?.trim()) throw new Error(`Unset ${key}; this world never attaches shared services or overrides upstreams.`);
  }
  const directories = new Set([
    root, join(root, "ee/apps/den-api"), join(root, "ee/apps/den-web"),
    join(root, "ee/apps/gateway"), join(root, "ee/packages/den-db"),
    join(root, "apps/app"), join(root, "apps/desktop"), join(root, "apps/server"),
  ]);
  let ancestor = join(root, "ee");
  for (let depth = 0; depth <= 6; depth += 1) {
    directories.add(ancestor);
    ancestor = dirname(ancestor);
  }
  for (const directory of directories) {
    for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
      if (existsSync(join(directory, name))) {
        throw new Error(`Refusing dotenv file ${join(directory, name)}; use a credential-free worktree.`);
      }
    }
  }
}

async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(500);
  }
  throw new Error(`${label} did not become ready; inspect this world's owner-only logs.`);
}

export async function main(): Promise<void> {
  preflight();
  if (process.argv.includes("--check")) {
    console.log("gateway-local preflight passed; no resources started.");
    return;
  }
  if (process.argv.slice(2).length > 0) throw new Error("gateway-local accepts only --check; lifetime is 120 minutes.");
  process.umask(0o077);
  for (const key of Object.keys(process.env)) {
    if (!inheritedKeys.has(key)) delete process.env[key];
  }
  const dockerEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  const docker = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const result = await exec("docker", args, { env: { ...dockerEnv, ...extraEnv }, timeout: 180_000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  };
  const endpoint = await docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!endpoint.startsWith("unix://")) throw new Error("gateway-local requires a local Unix-socket Docker daemon.");
  await using stack = new AsyncDisposableStack();
  const privateRoot = await mkdtemp(join(tmpdir(), "openwork-gateway-local-"));
  stack.defer(() => rm(privateRoot, { recursive: true, force: true }));
  const pnpmHome = process.env.PNPM_HOME ?? join(process.env.HOME ?? "", "Library/pnpm");
  const home = join(privateRoot, "home");
  await mkdir(home);
  Object.assign(process.env, {
    HOME: home, PNPM_HOME: pnpmHome, NODE_ENV: "development", OPENWORK_DEV_MODE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    OPENWORK_DEN_DB_ENV_PATH: join(privateRoot, "no-env"),
    OPENWORK_EVAL_SURFACES_DIR: join(privateRoot, "surfaces"),
  });
  const { progress, trackResource } = await import("../packages/world/src/index.ts");
  const { allocateFreePort } = await import("../evals/packages/cdp/src/index.ts");
  const { server } = await import("../evals/packages/env/src/den.ts");
  const { resolvePlace } = await import("../evals/packages/env/src/place.ts");
  const { app } = await import("../evals/packages/env/src/desktop-app.ts");
  const { hold } = await import("../packages/world/src/hold.ts");
  await trackResource({ kind: "tmpdir", id: privateRoot, label: "gateway-local-private-state" });
  const steps = progress();
  const infra = steps.step("gateway-local-infra", "Owned MySQL and Redis");
  const nonce = randomBytes(8).toString("hex");
  const password = randomBytes(32).toString("hex");
  const encryptionKey = randomBytes(32).toString("hex");
  const authSecret = randomBytes(32).toString("hex");
  const startContainer = async (name: string, args: string[], env: Record<string, string> = {}) => {
    const id = await docker(["create", "--name", name, ...args], env);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker returned an invalid owned container ID.");
    stack.defer(async () => { await docker(["rm", "--force", "--volumes", id]); });
    await trackResource({ kind: "docker", id, label: name });
    await docker(["start", id]);
    return id;
  };
  const mysql = await startContainer(`openwork-gateway-mysql-${nonce}`, [
    "--publish", "127.0.0.1::3306", "--tmpfs", "/var/lib/mysql",
    "--env", "MYSQL_ROOT_PASSWORD", "mysql:8.4@sha256:c592c15aaf4a1961e15d82eb31ea5987dda862d1c4b1e93424438c0e91dc1f8d",
  ], { MYSQL_ROOT_PASSWORD: password });
  const redis = await startContainer(`openwork-gateway-redis-${nonce}`, [
    "--publish", "127.0.0.1::6379", "--tmpfs", "/data", "redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf",
    "redis-server", "--save", "", "--appendonly", "no",
  ]);
  const mappedPort = async (id: string, port: number) => {
    const address = await docker(["port", id, `${port}/tcp`]);
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Container is not bound exclusively to loopback.");
    return address;
  };
  const mysqlAddress = await mappedPort(mysql, 3306);
  const redisAddress = await mappedPort(redis, 6379);
  await waitUntil("MySQL", async () => {
    try {
      await docker(["exec", "--env", "MYSQL_PWD", mysql, "mysql", "--user=root", "--execute=SELECT 1"], { MYSQL_PWD: password });
      return true;
    } catch { return false; }
  });
  await waitUntil("Redis", async () => (await docker(["exec", redis, "redis-cli", "ping"]).catch(() => "")) === "PONG");
  process.env.OPENWORK_EVAL_MYSQL_URL = `mysql://root:${password}@${mysqlAddress}`;
  process.env.DATABASE_REDIS_URL = `redis://${redisAddress}`;
  await infra.ok();
  const place = resolvePlace();
  const port = await allocateFreePort();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const commonEnv = {
    NODE_ENV: "development", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
    DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false",
    DEN_REQUIRE_EMAIL_VERIFICATION: "false", DEN_BOOTSTRAP_ADMIN_EMAILS: ownerEmail,
    GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
    DEN_DB_ENCRYPTION_KEY: encryptionKey, BETTER_AUTH_SECRET: authSecret,
    GATEWAY_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
    PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    SENTRY_LOG_LEVEL: "off", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "",
    DEN_DIAGNOSTICS_ORIGIN: gatewayUrl, DEN_DIAGNOSTICS_BEARER_TOKEN: "",
    DEN_AUTOMATIONS_ENABLED: "false", DEN_AUTOMATIONS_RUNTIME_ENABLED: "false",
  };
  const den = stack.use(await server({ place, provision: false, web: true, env: commonEnv }));
  if (!den.database || !new URL(den.database.url).pathname.startsWith("/openwork_eval_")) {
    throw new Error("Expected an owned disposable Den database.");
  }
  const gatewayStep = steps.step("gateway-local", "Gateway (real public provider egress)");
  const log = await open(join(privateRoot, "gateway.log"), "a", 0o600);
  const gateway = spawn(process.execPath, [
    "--conditions=development", "--import", "tsx", "--input-type=module", "--eval",
    'import "./src/instrumentation.ts"; import { serve } from "@hono/node-server"; import app from "./src/app.ts"; serve({fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.GATEWAY_PORT)});',
  ], {
    cwd: join(root, "ee/apps/gateway"), detached: true, stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, ...commonEnv, DATABASE_URL: den.database.url, GATEWAY_PORT: String(port), CORS_ORIGINS: den.ref.webUrl },
  });
  await log.close();
  let spawnFailed = false;
  gateway.on("error", () => { spawnFailed = true; });
  stack.defer(async () => {
    if (!gateway.pid || gateway.exitCode !== null || gateway.signalCode !== null) return;
    gateway.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { gateway.kill("SIGKILL"); resolve(); }, 5000);
      gateway.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  });
  if (gateway.pid) await trackResource({ kind: "process", id: String(gateway.pid), label: "gateway", match: './src/app.ts' });
  const httpReady = async (url: string) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((response) => response.ok).catch(() => false);
  await waitUntil("Gateway", async () => {
    if (spawnFailed || gateway.exitCode !== null) throw new Error("Gateway exited; inspect its owner-only log.");
    return httpReady(`${gatewayUrl}/ready`);
  });
  await gatewayStep.ok(gatewayUrl);
  delete process.env.OPENWORK_EVAL_MYSQL_URL;
  delete process.env.DATABASE_REDIS_URL;
  const desktop = stack.use(await app({
    den, place, signIn: false, workspacePath: join(privateRoot, "workspace"),
    env: { SENTRY_DSN: "", OPENWORK_DESKTOP_SENTRY_DSN: "", VITE_DISABLE_OPENWORK_MODELS: "1" },
  }));
  for (const url of [`${den.ref.apiUrl}/health`, `${den.ref.webUrl}/api/ready`, `${den.ref.webUrl}/`, `${gatewayUrl}/ready`]) {
    await waitUntil("Final HTTP verification", () => httpReady(url));
  }
  const expires = new Date(Date.now() + lifetimeMs).toISOString();
  const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), lifetimeMs);
  try {
    await hold({ name: "gateway-local", outputs: {
      denWeb: den.ref.webUrl, denApi: den.ref.apiUrl, gatewayUrl,
      signup: `${den.ref.webUrl}/`, ownerEmail,
      gatewayProviders: `${den.ref.webUrl}/dashboard/ai-gateway?tab=ai-providers`,
      desktop: "Isolated OpenWork Eval testkit-fresh window; sign in to the local Den manually",
      desktopState: desktop.readiness?.state ?? "workspace created", expires,
      status: "HTTP readiness and isolated Electron workspace verified; no account, provider key, policy, or inference request seeded",
      stop: `pnpm world down gateway-local${process.env.OPENWORK_WORLD_STAGE ? ` --stage ${process.env.OPENWORK_WORLD_STAGE}` : ""}`,
    } });
  } finally { clearTimeout(timer); }
}

if (import.meta.main) await main();
