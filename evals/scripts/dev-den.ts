import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_ROOT = join(REPO_ROOT, "evals", "results", ".dev-den");
const MYSQL_CONTAINER = "openwork-web-local-mysql";
const DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890";
const BETTER_AUTH_SECRET = "local-dev-secret-not-for-production-use!!";
const USAGE = `Usage:
  pnpm --dir evals dev:den -- up [--port <port>] [--database <name>] [--seed]
  pnpm --dir evals dev:den -- down --port <port> [--drop-database]

The up command creates an isolated database, initializes it with
db:bootstrap, starts den-api in multi-org dev mode, waits for /health, and prints the
OPENWORK_EVAL_DEN_* exports. The generated trusted origins always include the
printed web URL; omitting it causes Better Auth 403 INVALID_ORIGIN responses.`;

interface DevDenState {
  apiUrl: string;
  database: string;
  databaseUrl: string;
  logPath: string;
  pid: number;
  port: number;
  webUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statePath(port: number): string {
  return join(STATE_ROOT, `${port}.json`);
}

function parseState(value: unknown): DevDenState | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.apiUrl !== "string"
    || typeof value.database !== "string"
    || typeof value.databaseUrl !== "string"
    || typeof value.logPath !== "string"
    || typeof value.pid !== "number"
    || typeof value.port !== "number"
    || typeof value.webUrl !== "string"
  ) return null;
  return {
    apiUrl: value.apiUrl,
    database: value.database,
    databaseUrl: value.databaseUrl,
    logPath: value.logPath,
    pid: value.pid,
    port: value.port,
    webUrl: value.webUrl,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = execFile(command, args, { cwd: REPO_ROOT, env }, (error) => {
      if (error) reject(error);
      else resolveRun();
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

async function pickPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local Den port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function validateDatabase(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Invalid database name: ${value}. Use only letters, numbers, and underscores.`);
  }
  return value;
}

async function ensurePortFree(port: number): Promise<void> {
  await new Promise<void>((resolveFree, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolveFree()));
  });
}

function denEnvironment(state: DevDenState): NodeJS.ProcessEnv {
  const trustedOrigins = `${state.apiUrl},${state.webUrl}`;
  return {
    ...process.env,
    OPENWORK_DEV_MODE: "1",
    PORT: String(state.port),
    DEN_API_PORT: String(state.port),
    DEN_API_PUBLIC_URL: state.apiUrl,
    DATABASE_URL: state.databaseUrl,
    DEN_DB_ENCRYPTION_KEY: DB_ENCRYPTION_KEY,
    BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: state.webUrl,
    DEN_BETTER_AUTH_TRUSTED_ORIGINS: trustedOrigins,
    CORS_ORIGINS: trustedOrigins,
    DEN_ORG_MODE: "multi_org",
    DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true",
    PROVISIONER_MODE: "stub",
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "sk_test_openwork_eval",
    STRIPE_INFERENCE_PRICE_ID: process.env.STRIPE_INFERENCE_PRICE_ID ?? "price_openwork_models_eval",
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_openwork_eval",
    INFERENCE_PROXY_BASE_URL: process.env.INFERENCE_PROXY_BASE_URL ?? "http://127.0.0.1:8791",
  };
}

async function waitForHealth(state: DevDenState): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180_000) {
    if (!processAlive(state.pid)) {
      throw new Error(`den-api exited before becoming healthy. See ${relative(REPO_ROOT, state.logPath)}.`);
    }
    const log = await readFile(state.logPath, "utf8").catch(() => "");
    if (log.includes('"message":"server listening"')) {
      try {
        const response = await fetch(`${state.apiUrl}/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return;
      } catch {
        // den-api logged that it is listening, but health is not ready yet.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`den-api did not become healthy within 180s. See ${relative(REPO_ROOT, state.logPath)}.`);
}

function printEnvironment(state: DevDenState): void {
  const trustedOrigins = `${state.apiUrl},${state.webUrl}`;
  console.log(`Health passed: ${state.apiUrl}/health`);
  console.log(`export OPENWORK_EVAL_DEN_API_URL="${state.apiUrl}"`);
  console.log(`export OPENWORK_EVAL_DEN_WEB_URL="${state.webUrl}"`);
  console.log(`# DEN_BETTER_AUTH_TRUSTED_ORIGINS="${trustedOrigins}"`);
  console.log("# The trusted origins include OPENWORK_EVAL_DEN_WEB_URL; otherwise sign-in fails with 403 INVALID_ORIGIN.");
  console.log(`Log: ${relative(REPO_ROOT, state.logPath)}`);
  console.log(`Tear down: pnpm --dir evals dev:den -- down --port ${state.port} --drop-database`);
}

async function createDatabase(database: string): Promise<void> {
  await run("pnpm", ["dev:den:mysql"]);
  await run("docker", [
    "exec",
    MYSQL_CONTAINER,
    "mysql",
    "-uroot",
    "-ppassword",
    "-e",
    `CREATE DATABASE IF NOT EXISTS \`${database}\``,
  ]);
}

async function applySchema(state: DevDenState): Promise<void> {
  // Uses db:bootstrap, the same entrypoint a real Den install runs, rather than
  // re-deriving DDL with db:push.
  //
  // push regenerates a prefix-length index as ``token`(191)`` — doubled
  // backticks — which MySQL rejects with a 1064 parse error, so an isolated Den
  // could never finish standing up. bootstrap instead initializes an empty
  // database from the build-time schema snapshot and records the committed
  // migrations as its baseline, so the eval Den is built the way a deployment
  // is. Plain db:migrate is not an option here: the ledger is baselined, so on
  // an empty database it has nothing to create the base tables from.
  console.log(`Bootstrapping ${state.database} from the current schema snapshot...`);
  await run("pnpm", ["--filter", "@openwork-ee/den-db", "db:bootstrap"], denEnvironment(state));
}

async function seedDemoOrg(state: DevDenState): Promise<void> {
  console.log("Seeding the demo organization...");
  await run("pnpm", ["--filter", "@openwork-ee/den-api", "seed:demo-org"], {
    ...denEnvironment(state),
    DEN_DEMO_SEED_FETCH_GITHUB: "0",
  });
}

async function up(portValue: string | undefined, databaseValue: string | undefined, seed: boolean): Promise<void> {
  const port = parsePort(portValue) ?? await pickPort();
  const database = validateDatabase(databaseValue ?? `openwork_den_eval_${process.pid}_${Date.now().toString(36)}`);
  await ensurePortFree(port);
  await mkdir(STATE_ROOT, { recursive: true });

  const apiUrl = `http://127.0.0.1:${port}`;
  const state: DevDenState = {
    apiUrl,
    database,
    databaseUrl: `mysql://root:password@127.0.0.1:3306/${database}`,
    logPath: join(STATE_ROOT, `${port}.log`),
    pid: 0,
    port,
    webUrl: `http://localhost:${port}`,
  };

  await createDatabase(database);
  await applySchema(state);
  await ensurePortFree(port);

  const logFd = openSync(state.logPath, "w");
  const child = spawn("pnpm", ["--filter", "@openwork-ee/den-api", "dev:local"], {
    cwd: REPO_ROOT,
    detached: true,
    env: denEnvironment(state),
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  if (!child.pid) throw new Error("Could not start den-api.");
  child.unref();
  state.pid = child.pid;
  await writeFile(statePath(port), `${JSON.stringify(state, null, 2)}\n`, "utf8");

  try {
    await waitForHealth(state);
    if (seed) await seedDemoOrg(state);
    printEnvironment(state);
  } catch (error) {
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      // Process already stopped.
    }
    throw error;
  }
}

async function readState(port: number): Promise<DevDenState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath(port), "utf8"));
  } catch {
    throw new Error(`No dev Den state found for port ${port}.`);
  }
  const state = parseState(parsed);
  if (!state) throw new Error(`Invalid dev Den state for port ${port}.`);
  return state;
}

async function stopProcess(state: DevDenState): Promise<void> {
  if (!processAlive(state.pid)) return;
  try {
    process.kill(-state.pid, "SIGTERM");
  } catch {
    process.kill(state.pid, "SIGTERM");
  }
  const startedAt = Date.now();
  while (processAlive(state.pid) && Date.now() - startedAt < 10_000) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  if (processAlive(state.pid)) {
    try {
      process.kill(-state.pid, "SIGKILL");
    } catch {
      process.kill(state.pid, "SIGKILL");
    }
  }
}

async function down(portValue: string | undefined, dropDatabase: boolean): Promise<void> {
  const port = parsePort(portValue);
  if (port === null) throw new Error(`--port is required for down.\n\n${USAGE}`);
  const state = await readState(port);
  await stopProcess(state);
  console.log(`Stopped den-api on port ${port}.`);
  if (dropDatabase) {
    await run("docker", [
      "exec",
      MYSQL_CONTAINER,
      "mysql",
      "-uroot",
      "-ppassword",
      "-e",
      `DROP DATABASE IF EXISTS \`${state.database}\``,
    ]);
    console.log(`Dropped database ${state.database}.`);
  }
  await rm(statePath(port), { force: true });
}

async function main(argv: string[]): Promise<void> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args,
    options: {
      port: { type: "string" },
      database: { type: "string" },
      seed: { type: "boolean" },
      "drop-database": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== "up" && command !== "down")) {
    throw new Error(USAGE);
  }
  if (command === "up") {
    await up(values.port, values.database, values.seed === true);
    return;
  }
  await down(values.port, values["drop-database"] === true);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
