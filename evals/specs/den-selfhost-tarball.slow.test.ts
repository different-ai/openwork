import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { closeSync, openSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { denFetch, signIn } from "@openwork/behaviors";
import type { DenRef, DenSession } from "@openwork/behaviors";
import { expect } from "vitest";
import { ephemeralDatabaseName, localMysqlIsRunning, needs, test } from "@openwork/testkit";
import type { ChildProcess } from "node:child_process";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const requirements = { optIn: ["OPENWORK_EVAL_APP_SPECS"] };
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1";
const mysqlOpen = await localMysqlIsRunning();
const title = !appSpecsEnabled
  ? "den self-host tarball skipped — needs: set OPENWORK_EVAL_APP_SPECS=1"
  : !localPlacement
    ? "den self-host tarball skipped — needs: unset OPENWORK_EVAL_DAYTONA"
    : !mysqlOpen
      ? "den self-host tarball skipped — needs: run pnpm dev:den:mysql"
      : "one native Den tarball installs, starts, and upgrades without losing its admin";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface RunningService {
  label: string;
  child: ChildProcess;
  logPath: string;
}

function command(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs ?? 120_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${executable} ${args.join(" ")} failed: ${error.message}\n${stderr.slice(-4_000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string") throw new Error(`Missing string field ${key}`);
  return value[key];
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function spawnService(label: string, launcher: string, subcommand: "start-api" | "start-web", logPath: string): RunningService {
  const logFd = openSync(logPath, "a");
  const child = spawn(launcher, [subcommand], {
    cwd: path.dirname(launcher),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  if (!child.pid) throw new Error(`Could not start ${label}`);
  return { label, child, logPath };
}

async function stopService(service: RunningService): Promise<void> {
  const pid = service.child.pid;
  if (!pid || service.child.exitCode !== null) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") throw error;
    return;
  }
  const deadline = Date.now() + 10_000;
  while (service.child.exitCode === null && Date.now() < deadline) await delay(100);
  if (service.child.exitCode === null) process.kill(-pid, "SIGKILL");
}

async function stopServices(services: RunningService[]): Promise<void> {
  await Promise.all(services.splice(0).map(stopService));
}

async function waitForHttp(url: string, service: RunningService): Promise<Response> {
  const deadline = Date.now() + 120_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null) {
      throw new Error(`${service.label} exited with ${service.child.exitCode}:\n${(await readFile(service.logPath, "utf8")).slice(-4_000)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${last}\n${(await readFile(service.logPath, "utf8")).slice(-4_000)}`);
}

async function startServices(prefix: string, logDir: string, ref: DenRef): Promise<RunningService[]> {
  const launcher = path.join(prefix, "current", "bin", "openwork-den");
  const api = spawnService("Den API", launcher, "start-api", path.join(logDir, `api-${Date.now()}.log`));
  await waitForHttp(`${ref.apiUrl}/health`, api);
  const web = spawnService("Den Web", launcher, "start-web", path.join(logDir, `web-${Date.now()}.log`));
  await waitForHttp(`${ref.webUrl}/api/ready`, web);
  return [api, web];
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function denEnv(databaseUrl: string, apiPort: number, webPort: number, allowPublicSignup: boolean): string {
  const origins = [
    `http://localhost:${apiPort}`,
    `http://127.0.0.1:${apiPort}`,
    `http://localhost:${webPort}`,
    `http://127.0.0.1:${webPort}`,
  ].join(",");
  return [
    "NODE_ENV=production",
    "OPENWORK_DEV_MODE=1",
    "DB_MODE=mysql",
    `DATABASE_URL=${databaseUrl}`,
    "DEN_DB_ENCRYPTION_KEY=selfhost-eval-database-encryption-key-1234567890",
    "BETTER_AUTH_SECRET=selfhost-eval-better-auth-secret-1234567890",
    `BETTER_AUTH_URL=http://localhost:${webPort}`,
    "DEN_ORG_MODE=single_org",
    "DEN_SINGLE_ORG_NAME=OpenWork-Selfhost-Eval",
    "DEN_SINGLE_ORG_SLUG=default",
    "DEN_SINGLE_ORG_OWNER_EMAILS=admin@selfhost.test",
    `DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP=${allowPublicSignup}`,
    "DEN_REQUIRE_EMAIL_VERIFICATION=false",
    "DEN_PASSWORD_BREACH_SCREENING_ENABLED=false",
    "DEN_BOOTSTRAP_ADMIN_EMAILS=admin@selfhost.test",
    `DEN_API_PUBLIC_URL=http://127.0.0.1:${apiPort}`,
    `DEN_API_BASE=http://127.0.0.1:${apiPort}`,
    `DEN_AUTH_ORIGIN=http://localhost:${webPort}`,
    `DEN_AUTH_FALLBACK_BASE=http://127.0.0.1:${apiPort}`,
    `DEN_BETTER_AUTH_TRUSTED_ORIGINS=${origins}`,
    `CORS_ORIGINS=${origins}`,
    "PROVISIONER_MODE=stub",
    `DEN_API_PORT=${apiPort}`,
    `DEN_WEB_PORT=${webPort}`,
    "DEN_BIND_HOST=127.0.0.1",
    "DEN_WEB_HOST=127.0.0.1",
    "",
  ].join("\n");
}

async function migrationTableExists(prefix: string, databaseUrl: string): Promise<boolean> {
  const script = [
    "const { realpathSync } = require('node:fs');",
    "const { createRequire } = require('node:module');",
    "const requireFromDb = createRequire(realpathSync('node_modules/@openwork-ee/den-db/package.json'));",
    "const mysql = requireFromDb('mysql2/promise');",
    "void (async () => {",
    "const connection = await mysql.createConnection(process.argv[1]);",
    "const [rows] = await connection.query(\"SHOW TABLES LIKE '__drizzle_migrations'\");",
    "await connection.end();",
    "console.log(rows.length);",
    "})();",
  ].join("");
  const result = await command(path.join(prefix, "current", "bin", "node"), ["-e", script, databaseUrl], {
    cwd: path.join(prefix, "current", "services", "den-api"),
  });
  return result.stdout.trim() === "1";
}

async function installBundle(bundleDir: string, prefix: string, configDir: string, systemdDir: string): Promise<void> {
  await command(path.join(bundleDir, "install.sh"), [
    "--prefix", prefix,
    "--config-dir", configDir,
    "--systemd-dir", systemdDir,
    "--no-systemd",
    "--no-user",
  ], { cwd: bundleDir });
}

test.skipIf(!appSpecsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs(requirements);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "openwork-den-selfhost-spec-"));
  const services: RunningService[] = [];
  const database = await place.db(ephemeralDatabaseName("den_selfhost"));
  try {
    const outDir = path.join(temporaryRoot, "out");
    const extractDir = path.join(temporaryRoot, "extract");
    const prefix = path.join(temporaryRoot, "opt", "openwork-den");
    const configDir = path.join(temporaryRoot, "etc", "openwork-den");
    const systemdDir = path.join(temporaryRoot, "systemd");
    const logDir = path.join(temporaryRoot, "logs");
    await mkdir(extractDir, { recursive: true });
    await mkdir(logDir, { recursive: true });

    const desktopPackage = JSON.parse(await readFile(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8"));
    const version = stringField(desktopPackage, "version");
    const platform = process.platform;
    const arch = process.arch;
    await command(process.execPath, [
      "scripts/den/build-selfhost-bundle.mjs",
      "--node-source", "host",
      "--platform", platform,
      "--arch", arch,
      "--version", version,
      "--out", outDir,
    ], { timeoutMs: 600_000 });

    const archiveName = `openwork-den-${platform}-${arch}-${version}.tar.gz`;
    const archivePath = path.join(outDir, archiveName);
    const listing = (await command("tar", ["-tzf", archivePath])).stdout.split(/\r?\n/).filter(Boolean);
    const top = `openwork-den-${version}`;
    const requiredEntries = [
      `${top}/bin/node`,
      `${top}/bin/openwork-den`,
      `${top}/services/den-api/dist/main.js`,
      `${top}/services/den-web/.next/BUILD_ID`,
      `${top}/install.sh`,
    ];
    const frameTwoPassed = requiredEntries.every((entry) => listing.includes(entry));
    evidence.fact(
      "One platform tarball contains Den API, Den Web, and a bundled Node runtime",
      `${archiveName}; ${requiredEntries.join(", ")}`,
      frameTwoPassed,
    );
    expect(frameTwoPassed).toBe(true);

    await command("tar", ["-xzf", archivePath, "-C", extractDir]);
    const bundleDir = path.join(extractDir, top);
    const nodeMode = (await stat(path.join(bundleDir, "bin", "node"))).mode;
    expect(nodeMode & 0o111).not.toBe(0);
    const installSource = await readFile(path.join(bundleDir, "install.sh"), "utf8");
    const launcherSource = await readFile(path.join(bundleDir, "bin", "openwork-den"), "utf8");
    const frameOnePassed = mysqlOpen && !installSource.includes("docker") && !launcherSource.includes("docker");
    evidence.fact(
      "The native install has no Docker dependency and uses a reachable network MySQL database",
      `MySQL reachable at 127.0.0.1:3306; install and launch scripts contain no Docker invocation`,
      frameOnePassed,
    );
    expect(frameOnePassed).toBe(true);

    await installBundle(bundleDir, prefix, configDir, systemdDir);
    const envExample = await readFile(path.join(configDir, "den.env"), "utf8");
    const apiUnit = await readFile(path.join(systemdDir, "openwork-den-api.service"), "utf8");
    const webUnit = await readFile(path.join(systemdDir, "openwork-den-web.service"), "utf8");
    const targetUnit = await readFile(path.join(systemdDir, "openwork-den.target"), "utf8");
    const frameThreePassed = envExample.includes("DEN_ORG_MODE=single_org")
      && installSource.includes("useradd --system")
      && apiUnit.includes(`EnvironmentFile=${configDir}/den.env`)
      && apiUnit.includes(`ExecStartPre=${prefix}/current/bin/openwork-den migrate`)
      && apiUnit.includes("User=openwork-den")
      && webUnit.includes("Wants=network-online.target openwork-den-api.service")
      && targetUnit.includes("Wants=openwork-den-api.service openwork-den-web.service");
    evidence.fact(
      "install.sh creates the service account contract, config template, two services, and target",
      `Installed den.env and three units under the isolated prefix; units run as openwork-den`,
      frameThreePassed,
    );
    expect(frameThreePassed).toBe(true);

    const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
    const ref = { apiUrl: `http://127.0.0.1:${apiPort}`, webUrl: `http://localhost:${webPort}` };
    const envPath = path.join(configDir, "den.env");
    await writeFile(envPath, denEnv(database.url, apiPort, webPort, true), { mode: 0o600 });
    await command(path.join(prefix, "current", "bin", "openwork-den"), ["migrate"], {
      timeoutMs: 180_000,
    });
    const migrationTableReady = await migrationTableExists(prefix, database.url);
    const frameFourPassed = migrationTableReady;
    evidence.fact(
      "openwork-den migrate prepares MySQL with the same Den DB bootstrap used by cloud",
      `Migration exited 0 and __drizzle_migrations exists in ${database.name}`,
      frameFourPassed,
    );
    expect(frameFourPassed).toBe(true);

    services.push(...await startServices(prefix, logDir, ref));
    const adminCredentials = { email: "admin@selfhost.test", password: "OpenWorkSelfhost123!" };
    const signUp = await denFetch(ref, "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ ...adminCredentials, name: "Selfhost Admin" }),
    });
    expect(signUp.response.ok, signUp.text).toBe(true);
    let admin = await signIn(ref, adminCredentials);
    const adminOverview = await denFetch(admin, "/v1/admin/overview", { headers: auth(admin) });
    const orgsResult = await denFetch(admin, "/v1/me/orgs", { headers: auth(admin) });
    const orgs = isRecord(orgsResult.body) && Array.isArray(orgsResult.body.orgs) ? orgsResult.body.orgs : [];
    expect(adminOverview.response.ok, adminOverview.text).toBe(true);
    expect(orgsResult.response.ok, orgsResult.text).toBe(true);
    expect(orgs).toHaveLength(1);
    expect(isRecord(orgs[0]) ? orgs[0].slug : null).toBe("default");

    await stopServices(services);
    await writeFile(envPath, denEnv(database.url, apiPort, webPort, false), { mode: 0o600 });
    services.push(...await startServices(prefix, logDir, ref));
    admin = await signIn(ref, adminCredentials);
    const rejectedSignup = await denFetch(ref, "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: "outsider@selfhost.test", name: "Outsider", password: "OpenWorkSelfhost123!" }),
    });
    const frameFivePassed = admin.email === adminCredentials.email && rejectedSignup.response.status === 403;
    evidence.fact(
      "Den API and Web start on configured ports with one private organization and its bootstrap admin",
      `API /health and Web /api/ready returned 2xx; admin endpoint returned 2xx; outsider signup returned ${rejectedSignup.response.status}`,
      frameFivePassed,
    );
    expect(frameFivePassed).toBe(true);

    const preservedBytes = await readFile(envPath);
    const preservedMtime = (await stat(envPath)).mtimeMs;
    await stopServices(services);

    const nextVersion = `${version}+1`;
    const upgradeStage = path.join(temporaryRoot, "upgrade-stage");
    const upgradeTop = `openwork-den-${nextVersion}`;
    const upgradeBundle = path.join(upgradeStage, upgradeTop);
    await mkdir(upgradeStage, { recursive: true });
    await cp(bundleDir, upgradeBundle, { recursive: true });
    await writeFile(path.join(upgradeBundle, "VERSION"), `${nextVersion}\n`, "utf8");
    const upgradeArchive = path.join(outDir, `openwork-den-${platform}-${arch}-${nextVersion}.tar.gz`);
    await command("tar", ["-czf", upgradeArchive, "-C", upgradeStage, upgradeTop]);
    const upgradeExtract = path.join(temporaryRoot, "upgrade-extract");
    await mkdir(upgradeExtract);
    await command("tar", ["-xzf", upgradeArchive, "-C", upgradeExtract]);
    await installBundle(path.join(upgradeExtract, upgradeTop), prefix, configDir, systemdDir);

    const currentLink = await readlink(path.join(prefix, "current"));
    const afterBytes = await readFile(envPath);
    const afterMtime = (await stat(envPath)).mtimeMs;
    await command(path.join(prefix, "current", "bin", "openwork-den"), ["migrate"], {
      timeoutMs: 180_000,
    });
    services.push(...await startServices(prefix, logDir, ref));
    const sameAdmin = await signIn(ref, adminCredentials);
    const wrongPassword = await denFetch(ref, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: adminCredentials.email, password: "definitely-wrong-password" }),
    });
    const migrationBeforeStart = apiUnit.indexOf("ExecStartPre=") < apiUnit.indexOf("ExecStart=");
    const frameSixPassed = currentLink === `versions/${nextVersion}`
      && preservedBytes.equals(afterBytes)
      && preservedMtime === afterMtime
      && sameAdmin.email === adminCredentials.email
      && !wrongPassword.response.ok
      && migrationBeforeStart;
    evidence.fact(
      "Upgrade flips current, preserves den.env, migrates before restart, and keeps the existing admin",
      `current -> versions/${nextVersion}; config bytes and mtime preserved; same admin signed in; wrong password returned ${wrongPassword.response.status}`,
      frameSixPassed,
    );
    expect(frameSixPassed).toBe(true);
  } finally {
    await stopServices(services);
    await database.drop().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 900_000);
