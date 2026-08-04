import { execFile, spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePorts } from "@openwork/cdp";
import {
  deleteSandboxes,
  freePort,
  killLocalPid,
  provisionDenSandbox,
  startMockOnSandbox,
} from "@openwork/hosts";
import { denFetch, ensureMemberSession, freshSession, signIn } from "@openwork/behaviors";
import { createConnection } from "mysql2/promise";
import type { ChildProcess } from "node:child_process";
import type { DenRef, DenSession } from "@openwork/behaviors";
import type { DbHandle, Place } from "./place.ts";
import { ephemeralDatabaseName, localMysqlIsRunning } from "./place.ts";
import type { BootedMock, MockBoot, MockHandle } from "./mock.ts";
import { SkipError } from "./needs.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const DATABASE_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890";
const BETTER_AUTH_SECRET = "local-testkit-secret-not-for-production-use!!";
const START_TIMEOUT_MS = 120_000;

export interface PersonShape {
  email?: string;
  name?: string;
  password?: string;
}

export interface OrgShape {
  name?: string;
  admin?: PersonShape;
  members?: Record<string, PersonShape>;
}

export interface ServerOptions {
  place: Place;
  mocks?: Record<string, MockBoot>;
  org?: OrgShape;
  reuse?: DenRef;
  reuseMembers?: Record<string, PersonShape>;
}

export interface Den extends AsyncDisposable {
  ref: DenRef;
  admin: DenSession;
  members: Record<string, DenSession>;
  mocks: Record<string, MockHandle>;
  database?: DbHandle;
  ports?: { api: number; web: number };
}

interface SpawnedService {
  child: ChildProcess;
  pid: number;
  port: number;
  label: string;
  logPath: string;
}

interface ProvisionedOrganization {
  admin: DenSession;
  members: Record<string, DenSession>;
  createdOrg: boolean;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanUrl(value: string): string {
  let out = value.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function personDefaults(key: string, person: PersonShape | undefined, runId: string): Required<PersonShape> {
  return {
    email: person?.email?.trim() || `${key}+${runId}@openwork.test`,
    name: person?.name?.trim() || key.replace(/(^|[-_ ])\w/g, (part) => part.toUpperCase()),
    password: person?.password || "OpenWorkEval123!",
  };
}

function defaultLocalOrg(runId: string): OrgShape {
  return {
    name: `OpenWork Eval ${runId}`,
    admin: personDefaults("admin", undefined, runId),
    members: { jordan: personDefaults("jordan", { name: "Jordan Eval" }, runId) },
  };
}

function defaultReuseAdmin(): Required<PersonShape> {
  return {
    email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
    name: "Alex Eval",
    password: process.env.OPENWORK_EVAL_DEMO_PASSWORD || "OpenWorkDemo123!",
  };
}

export function trustedOrigins(apiPort: number, webPort: number): string[] {
  return [
    `http://localhost:${apiPort}`,
    `http://127.0.0.1:${apiPort}`,
    `http://localhost:${webPort}`,
    `http://127.0.0.1:${webPort}`,
  ];
}

function spawnService(
  label: string,
  script: "dev:den:api" | "dev:den:web",
  port: number,
  env: NodeJS.ProcessEnv,
  logPath: string,
): SpawnedService {
  const logFd = openSync(logPath, "a");
  const child = spawn("pnpm", [script], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error(`Could not start ${label}.`);
  return { child, pid: child.pid, port, label, logPath };
}

async function logTail(path: string): Promise<string> {
  return readFile(path, "utf8")
    .then((text) => text.split(/\r?\n/).slice(-40).join("\n"))
    .catch((error: unknown) => `log unavailable: ${messageText(error)}`);
}

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

async function runDbPush(databaseUrl: string): Promise<void> {
  try {
    await execFileAsync("pnpm", ["--filter", "@openwork-ee/den-db", "db:push"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DEN_DB_ENCRYPTION_KEY: DATABASE_ENCRYPTION_KEY,
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && typeof Reflect.get(error, "stderr") === "string"
      ? Reflect.get(error, "stderr")
      : "";
    throw new Error(`Ephemeral Den database push failed: ${messageText(error)}${stderr ? `\n${stderr}` : ""}`);
  }
}

async function markVerified(databaseUrl: string, email: string): Promise<void> {
  const connection = await createConnection(databaseUrl);
  try {
    await connection.execute("UPDATE `user` SET email_verified = true WHERE email = ?", [email]);
  } finally {
    await connection.end();
  }
}

async function createOrSignInAccount(
  ref: DenRef,
  person: Required<PersonShape>,
  databaseUrl?: string,
): Promise<DenSession> {
  const signUp = await denFetch(ref, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: person.email, name: person.name, password: person.password }),
  });
  if (signUp.response.ok && databaseUrl) await markVerified(databaseUrl, person.email);
  try {
    return await signIn(ref, { email: person.email, password: person.password });
  } catch (error) {
    throw new Error(
      `Could not provision ${person.email}: sign-up HTTP ${signUp.response.status} ${signUp.text.slice(0, 300)}; ${messageText(error)}`,
    );
  }
}

async function createOrganization(admin: DenSession, name: string): Promise<void> {
  const created = await denFetch(admin, "/v1/org", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ name }),
  });
  if (!created.response.ok) {
    throw new Error(`Organization create failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
}

async function createMember(
  ref: DenRef,
  admin: DenSession,
  person: Required<PersonShape>,
  databaseUrl?: string,
): Promise<DenSession> {
  const invitation = await denFetch(ref, "/v1/invitations", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ email: person.email, role: "member" }),
  });
  const inviteToken = stringField(invitation.body, "inviteToken");
  if (!invitation.response.ok || !inviteToken) {
    throw new Error(`Invitation failed for ${person.email}: HTTP ${invitation.response.status} ${invitation.text.slice(0, 500)}`);
  }
  const member = await createOrSignInAccount(ref, person, databaseUrl);
  const accepted = await denFetch(ref, "/v1/orgs/invitations/accept", {
    method: "POST",
    headers: auth(member),
    body: JSON.stringify({ id: inviteToken }),
  });
  if (!accepted.response.ok || stringField(accepted.body, "error")) {
    throw new Error(`Invitation accept failed for ${person.email}: HTTP ${accepted.response.status} ${accepted.text.slice(0, 500)}`);
  }
  return member;
}

async function provisionOrganization(
  ref: DenRef,
  shape: OrgShape,
  runId: string,
  options: { databaseUrl?: string; createOrg: boolean; fallbackAdmin?: Required<PersonShape> },
): Promise<ProvisionedOrganization> {
  const adminPerson = shape.admin
    ? personDefaults("admin", shape.admin, runId)
    : options.fallbackAdmin ?? personDefaults("admin", undefined, runId);
  const admin = options.fallbackAdmin && !shape.admin
    ? await signIn(ref, { email: adminPerson.email, password: adminPerson.password })
    : await createOrSignInAccount(ref, adminPerson, options.databaseUrl);
  if (options.createOrg) await createOrganization(admin, shape.name?.trim() || `OpenWork Eval ${runId}`);
  const members: Record<string, DenSession> = {};
  for (const [key, memberShape] of Object.entries(shape.members ?? {})) {
    members[key] = await createMember(ref, admin, personDefaults(key, memberShape, runId), options.databaseUrl);
  }
  return { admin, members, createdOrg: options.createOrg };
}

async function provisionReusedMembers(
  ref: DenRef,
  admin: DenSession,
  shapes: Record<string, PersonShape>,
  runId: string,
): Promise<Record<string, DenSession>> {
  const members: Record<string, DenSession> = {};
  for (const [key, shape] of Object.entries(shapes)) {
    const person = personDefaults(key, shape, runId);
    members[key] = await ensureMemberSession(ref, admin, {
      email: person.email,
      password: person.password,
      name: person.name,
      markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
    });
  }
  return members;
}

async function bootLocalMocks(
  place: Place,
  definitions: Record<string, MockBoot>,
): Promise<{ handles: Record<string, MockHandle>; env: Record<string, string> }> {
  const handles: Record<string, MockHandle> = {};
  const env: Record<string, string> = {};
  try {
    for (const [name, definition] of Object.entries(definitions)) {
      const booted = await definition.boot(place);
      try {
        const publicUrl = await place.exposeMock(booted.handle);
        handles[name] = booted.handle;
        Object.assign(env, booted.env({
          name,
          url: cleanUrl(publicUrl.toString()),
          mcpUrl: `${cleanUrl(publicUrl.toString())}/mcp`,
        }));
      } catch (error) {
        await booted.handle.stop().catch(() => undefined);
        if (place.kind === "daytona") {
          throw new Error(`mock ${name} unreachable from remote den: set publicUrl`);
        }
        throw error;
      }
    }
    return { handles, env };
  } catch (error) {
    await stopMocks(handles);
    throw error;
  }
}

async function bootDaytonaMocks(
  sandbox: string,
  definitions: Record<string, MockBoot>,
): Promise<{ handles: Record<string, MockHandle>; env: Record<string, string> }> {
  const handles: Record<string, MockHandle> = {};
  const env: Record<string, string> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (!definition.daytonaPort || !definition.connect) {
      throw new Error(`mock ${name} cannot boot on Daytona: its MockBoot has no sandbox adapter`);
    }
    const remote = await startMockOnSandbox({ sandbox, port: definition.daytonaPort });
    const booted: BootedMock = await definition.connect(remote.url);
    handles[name] = booted.handle;
    Object.assign(env, booted.env({ name, url: cleanUrl(remote.url), mcpUrl: `${cleanUrl(remote.url)}/mcp` }));
  }
  return { handles, env };
}

async function stopMocks(handles: Record<string, MockHandle>): Promise<void> {
  for (const [name, handle] of Object.entries(handles)) {
    await handle.stop().catch((error: unknown) => {
      console.error(`[openwork/testkit] mock ${name} cleanup failed: ${messageText(error)}`);
    });
  }
}

async function stopServices(services: SpawnedService[]): Promise<void> {
  for (const service of services) {
    await killLocalPid(service.pid, { log: (line) => console.error(`[openwork/testkit] ${line}`) })
      .catch((error: unknown) => console.error(`[openwork/testkit] ${service.label} cleanup failed: ${messageText(error)}`));
    await freePort(service.port)
      .catch((error: unknown) => console.error(`[openwork/testkit] ${service.label} port cleanup failed: ${messageText(error)}`));
  }
}

async function deleteCreatedOrganization(admin: DenSession): Promise<void> {
  const active = await freshSession(admin);
  const deleted = await denFetch(active, "/v1/org", { method: "DELETE", headers: auth(active) });
  if (!deleted.response.ok) {
    throw new Error(`Organization cleanup returned HTTP ${deleted.response.status}: ${deleted.text.slice(0, 500)}`);
  }
}

function reusedRef(options: ServerOptions): DenRef | null {
  if (options.reuse) return { apiUrl: cleanUrl(options.reuse.apiUrl), webUrl: cleanUrl(options.reuse.webUrl) };
  const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
  if (!apiUrl) return null;
  const cleanApi = cleanUrl(apiUrl);
  const webUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()
    || cleanApi.replace("127.0.0.1", "localhost");
  return { apiUrl: cleanApi, webUrl: cleanUrl(webUrl) };
}

function daytonaAvailable(): boolean {
  const result = spawnSync("daytona", ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

export async function server(options: ServerOptions): Promise<Den> {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const reuse = reusedRef(options);
  if (reuse) {
    const bootedMocks = await bootLocalMocks(options.place, options.mocks ?? {});
    try {
      const organization = await provisionOrganization(
        reuse,
        options.org ?? {},
        runId,
        {
          createOrg: Boolean(options.org),
          fallbackAdmin: options.org?.admin ? undefined : defaultReuseAdmin(),
        },
      );
      const reusedMembers = await provisionReusedMembers(reuse, organization.admin, options.reuseMembers ?? {}, runId);
      let disposed = false;
      return {
        ref: reuse,
        admin: organization.admin,
        members: { ...organization.members, ...reusedMembers },
        mocks: bootedMocks.handles,
        async [Symbol.asyncDispose](): Promise<void> {
          if (disposed) return;
          disposed = true;
          if (organization.createdOrg) {
            await deleteCreatedOrganization(organization.admin).catch((error: unknown) => {
              console.error(`[openwork/testkit] reused Den org cleanup failed: ${messageText(error)}`);
            });
          }
          await stopMocks(bootedMocks.handles);
        },
      };
    } catch (error) {
      await stopMocks(bootedMocks.handles);
      throw error;
    }
  }

  if (options.place.kind === "daytona") {
    if (!daytonaAvailable()) {
      throw new SkipError("Daytona CLI is unavailable; install and authenticate daytona, then set OPENWORK_EVAL_DAYTONA=1");
    }
    const base = options.place.denBase();
    if (base.kind !== "daytona") throw new Error("Daytona place returned a local Den base.");
    const provisioned = await provisionDenSandbox({
      ref: base.ref,
      log: (line) => console.error(`[openwork/testkit] ${line}`),
    });
    let bootedMocks: { handles: Record<string, MockHandle>; env: Record<string, string> } = { handles: {}, env: {} };
    try {
      bootedMocks = await bootDaytonaMocks(provisioned.sandbox, options.mocks ?? {});
      const ref = { apiUrl: cleanUrl(provisioned.apiUrl), webUrl: cleanUrl(provisioned.webUrl) };
      const organization = await provisionOrganization(
        ref,
        options.org ?? {},
        runId,
        {
          createOrg: Boolean(options.org),
          fallbackAdmin: options.org?.admin ? undefined : defaultReuseAdmin(),
        },
      );
      let disposed = false;
      return {
        ref,
        admin: organization.admin,
        members: organization.members,
        mocks: bootedMocks.handles,
        async [Symbol.asyncDispose](): Promise<void> {
          if (disposed) return;
          disposed = true;
          if (organization.createdOrg) {
            await deleteCreatedOrganization(organization.admin).catch((error: unknown) => {
              console.error(`[openwork/testkit] Daytona Den org cleanup failed: ${messageText(error)}`);
            });
          }
          await stopMocks(bootedMocks.handles);
          if (provisioned.created) {
            await deleteSandboxes([provisioned.sandbox]).catch((error: unknown) => {
              console.error(`[openwork/testkit] Daytona Den cleanup failed: ${messageText(error)}`);
            });
          }
        },
      };
    } catch (error) {
      await stopMocks(bootedMocks.handles);
      if (provisioned.created) await deleteSandboxes([provisioned.sandbox]).catch(() => undefined);
      throw error;
    }
  }

  if (!await localMysqlIsRunning()) {
    throw new Error("Local Den requires MySQL on 127.0.0.1:3306. Run: pnpm dev:den:mysql");
  }

  const bootedMocks = await bootLocalMocks(options.place, options.mocks ?? {});
  const services: SpawnedService[] = [];
  let database: DbHandle | undefined;
  try {
    database = await options.place.db(ephemeralDatabaseName());
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
      ...bootedMocks.env,
      DATABASE_URL: database.url,
      DEN_DB_ENCRYPTION_KEY: DATABASE_ENCRYPTION_KEY,
      BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: `http://localhost:${webPort}`,
      DEN_API_PORT: String(apiPort),
      DEN_WEB_PORT: String(webPort),
      DEN_BETTER_AUTH_TRUSTED_ORIGINS: origins,
      CORS_ORIGINS: origins,
      DEN_ORG_MODE: "multi_org",
      DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      DEN_PASSWORD_BREACH_SCREENING_ENABLED: "false",
      OPENWORK_DEV_MODE: "1",
      PROVISIONER_MODE: "stub",
    };
    const api = spawnService("den-api", "dev:den:api", apiPort, { ...commonEnv, DEN_BIND_HOST: "127.0.0.1" }, join(logsDir, "api.log"));
    services.push(api);
    const web = spawnService("den-web", "dev:den:web", webPort, {
      DEN_WEB_HOST: "127.0.0.1",
      ...commonEnv,
      DEN_API_BASE: `http://127.0.0.1:${apiPort}`,
      DEN_AUTH_ORIGIN: `http://localhost:${webPort}`,
      DEN_AUTH_FALLBACK_BASE: `http://127.0.0.1:${apiPort}`,
    }, join(logsDir, "web.log"));
    services.push(web);
    await waitForHttp(`${ref.apiUrl}/health`, api, (response) => response.ok);
    await waitForHttp(`${ref.webUrl}/api/ready`, web, (response) => response.ok);
    await waitForAuthProbe(ref, api);
    const organization = await provisionOrganization(
      ref,
      options.org ?? defaultLocalOrg(runId),
      runId,
      { databaseUrl: database.url, createOrg: true },
    );
    let disposed = false;
    return {
      ref,
      admin: organization.admin,
      members: organization.members,
      mocks: bootedMocks.handles,
      database,
      ports: { api: apiPort, web: webPort },
      async [Symbol.asyncDispose](): Promise<void> {
        if (disposed) return;
        disposed = true;
        await deleteCreatedOrganization(organization.admin).catch((error: unknown) => {
          console.error(`[openwork/testkit] local Den org cleanup failed: ${messageText(error)}`);
        });
        await stopServices(services);
        await database?.drop().catch((error: unknown) => {
          console.error(`[openwork/testkit] ephemeral database cleanup failed: ${messageText(error)}`);
        });
        await stopMocks(bootedMocks.handles);
      },
    };
  } catch (error) {
    await stopServices(services);
    await database?.drop().catch(() => undefined);
    await stopMocks(bootedMocks.handles);
    throw error;
  }
}
