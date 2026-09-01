import { execFile, spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePorts } from "@openwork/cdp";
import {
  defaultDaytonaExec,
  deleteSandboxes,
  execInSandbox,
  freePort,
  killLocalPid,
  provisionDenSandbox,
  startMockOnSandbox,
} from "@openwork/hosts";
import { denFetch, ensureMemberSession, freshSession, signIn } from "@openwork/behaviors";
import { trackResource } from "@openwork/world";
import { createConnection } from "mysql2/promise";
import type { ChildProcess } from "node:child_process";
import type { DenRef, DenSession } from "@openwork/behaviors";
import type { DbHandle, Place } from "./place.ts";
import { ephemeralDatabaseName, localMysqlIsRunning, localRedisIsRunning } from "./place.ts";
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
  /** Set to false for an infra-only Den boot that creates no default organization or accounts. */
  provision?: boolean;
  web?: boolean;
  env?: Record<string, string | undefined>;
  reuse?: { apiUrl: string; webUrl?: string };
  reuseMembers?: Record<string, PersonShape>;
  ports?: { api: number; web: number };
  seedProfile?: "demo-org";
  /**
   * Extra origins Den should trust, on top of its own API and web hosts. A
   * loopback identity provider needs this: Den refuses to register an SSO
   * provider whose endpoints are not publicly routable unless the origin is
   * trusted, so a test that stands one up has to name it here.
   */
  trustedOrigins?: readonly string[];
}

export interface Den extends AsyncDisposable {
  ref: DenRef;
  placement?: { kind: "local" } | { kind: "daytona"; sandboxId: string };
  admin: DenSession;
  members: Record<string, DenSession>;
  mocks: Record<string, MockHandle>;
  database?: DbHandle;
  ports?: { api: number; web: number };
  /**
   * Raw den-api HTTP log text (JSON lines carrying http_route/timestamp).
   * Daytona lane: reads /tmp/den-api.log inside the server sandbox; local
   * lane: reads the spawned den-api service log. Attached Dens
   * (OPENWORK_EVAL_DEN_API_URL / reuse) throw — their den-api log lives with
   * whoever runs that server. Parsing belongs to the caller.
   */
  apiLog(): Promise<string>;
}

export interface DenOrgHandle extends AsyncDisposable {
  id: string;
  name: string;
  admin: DenSession;
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
  createdOrgId: string | null;
}

interface PlatformAdminGrant {
  id: string;
  owner: DenSession;
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

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const field = Reflect.get(value, key);
  return typeof field === "object" && field !== null && !Array.isArray(field) ? field : null;
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

export function personDefaults(key: string, person: PersonShape | undefined, runId: string): Required<PersonShape> {
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

export function defaultReuseAdmin(): Required<PersonShape> {
  return {
    email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
    name: "Alex Eval",
    password: process.env.OPENWORK_EVAL_DEMO_PASSWORD || "OpenWorkDemo123!",
  };
}

async function grantPreparedPlatformAdmin(ref: DenRef, email: string): Promise<PlatformAdminGrant | null> {
  const ownerPerson = defaultReuseAdmin();
  if (ownerPerson.email.toLowerCase() === email.toLowerCase()) return null;
  const owner = await signIn(ref, { email: ownerPerson.email, password: ownerPerson.password });
  const result = await denFetch(owner, "/v1/admin/admins", {
    method: "POST",
    headers: auth(owner),
    body: JSON.stringify({ email, note: "Temporary prepared eval admin" }),
  });
  if (result.response.status === 409) return null;
  const id = stringField(recordField(result.body, "admin"), "id");
  if (!result.response.ok || !id) {
    throw new Error(`Prepared Daytona admin grant failed for ${email}: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { id, owner };
}

async function revokePreparedPlatformAdmin(grant: PlatformAdminGrant): Promise<void> {
  const result = await denFetch(grant.owner, `/v1/admin/admins/${encodeURIComponent(grant.id)}`, {
    method: "DELETE",
    headers: auth(grant.owner),
  });
  if (!result.response.ok && result.response.status !== 404) {
    throw new Error(`Prepared Daytona admin cleanup returned HTTP ${result.response.status}: ${result.text.slice(0, 500)}`);
  }
}

function emptySession(ref: DenRef): DenSession {
  return { ...ref, token: "", email: "", password: "" };
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

async function logTail(path: string): Promise<string> {
  return readFile(path, "utf8")
    .then((text) => text.split(/\r?\n/).slice(-40).join("\n"))
    .catch((error: unknown) => `log unavailable: ${messageText(error)}`);
}

async function waitForHttp(url: string, service: SpawnedService, accept: (response: Response) => boolean, init?: RequestInit): Promise<Response> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last = "not attempted";
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null) {
      throw new Error(`${service.label} exited with ${service.child.exitCode}. Last log lines:\n${await logTail(service.logPath)}`);
    }
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
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

function validateFixedPort(label: "api" | "web", port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`Fixed Den ${label} port must be an integer from 1024 to 65535, got ${port}.`);
  }
}

function childOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null) return "";
  const value = Reflect.get(error, key);
  return typeof value === "string" ? value : "";
}

async function runDemoOrgSeed(databaseUrl: string, webPort: number, logPath: string): Promise<void> {
  try {
    const result = await execFileAsync(
      "pnpm",
      ["--filter", "@openwork-ee/den-api", "seed:demo-org", "--", "--reset"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DEN_DB_ENCRYPTION_KEY: DATABASE_ENCRYPTION_KEY,
          BETTER_AUTH_SECRET,
          BETTER_AUTH_URL: `http://localhost:${webPort}`,
          DEN_DEMO_SEED_FETCH_GITHUB: "0",
          // Single-org mode (the unset default) refuses email signup, which the
          // seed's owner bootstrap needs; the demo world is a multi-org Den.
          DEN_ORG_MODE: "multi_org",
          OPENWORK_DEV_MODE: "1",
        },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60_000,
      },
    );
    await writeFile(logPath, result.stdout, "utf8");
  } catch (error) {
    const stdout = childOutput(error, "stdout");
    await writeFile(logPath, stdout, "utf8").catch(() => undefined);
    const stderr = childOutput(error, "stderr");
    throw new Error(`Demo organization seed failed: ${messageText(error)}${stderr ? `\n${stderr}` : ""}`);
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

async function createOrganization(admin: DenSession, name: string): Promise<string> {
  const created = await denFetch(admin, "/v1/org", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ name }),
  });
  const organizationId = stringField(recordField(created.body, "organization"), "id");
  if (!created.response.ok || !organizationId) {
    throw new Error(`Organization create failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  return organizationId;
}

export async function createAdmin(den: Den, person: PersonShape): Promise<DenSession> {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const admin = await createOrSignInAccount(
    den.ref,
    personDefaults("admin", person, runId),
    den.database?.url,
  );
  den.admin = admin;
  return admin;
}

export async function createOrg(den: Den, name: string): Promise<DenOrgHandle> {
  if (!den.admin.token.trim()) {
    throw new Error("createOrg requires an authenticated den.admin; call createAdmin after server({ provision: false }).");
  }
  const admin = den.admin;
  const id = await createOrganization(admin, name);
  let disposed = false;
  return {
    id,
    name,
    admin,
    async [Symbol.asyncDispose](): Promise<void> {
      if (disposed) return;
      disposed = true;
      await deleteCreatedOrganization(admin, id);
    },
  };
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

export async function inviteMember(den: Den, key: string, person?: PersonShape): Promise<DenSession> {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const member = await createMember(den.ref, den.admin, personDefaults(key, person, runId), den.database?.url);
  den.members[key] = member;
  return member;
}

export async function queryDenDatabase(databaseUrl: string, statement: string, values: readonly unknown[] = []): Promise<unknown[]> {
  const connection = await createConnection(databaseUrl);
  try {
    const [rows] = await connection.execute(statement, [...values]);
    return Array.isArray(rows) ? rows : [];
  } finally {
    await connection.end();
  }
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
  const createdOrgId = options.createOrg
    ? await createOrganization(admin, shape.name?.trim() || `OpenWork Eval ${runId}`)
    : null;
  const members: Record<string, DenSession> = {};
  for (const [key, memberShape] of Object.entries(shape.members ?? {})) {
    members[key] = await createMember(ref, admin, personDefaults(key, memberShape, runId), options.databaseUrl);
  }
  return { admin, members, createdOrgId };
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
    const remote = await startMockOnSandbox({
      sandbox,
      port: definition.daytonaPort,
      allowUnauthenticatedMcp: definition.allowUnauthenticatedMcp,
    });
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

async function deleteCreatedOrganization(admin: DenSession, organizationId: string): Promise<void> {
  const active = await freshSession(admin).catch(() => admin);
  const selected = await denFetch(active, "/v1/me/active-organization", {
    method: "POST",
    headers: auth(active),
    body: JSON.stringify({ organizationId }),
  });
  if (selected.response.status === 404) return;
  if (!selected.response.ok) {
    throw new Error(`Organization cleanup selection returned HTTP ${selected.response.status}: ${selected.text.slice(0, 500)}`);
  }
  const deleted = await denFetch(active, "/v1/org", { method: "DELETE", headers: auth(active) });
  if (!deleted.response.ok && deleted.response.status !== 404) {
    throw new Error(`Organization cleanup returned HTTP ${deleted.response.status}: ${deleted.text.slice(0, 500)}`);
  }
}

function reusedRef(options: ServerOptions): DenRef | null {
  if (options.reuse) {
    const apiUrl = cleanUrl(options.reuse.apiUrl);
    const webUrl = options.reuse.webUrl?.trim() || apiUrl.replace("127.0.0.1", "localhost");
    return { apiUrl, webUrl: cleanUrl(webUrl) };
  }
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
  if (options.seedProfile && reuse) {
    throw new Error('Den seedProfile "demo-org" is local-only and cannot seed an attached Den.');
  }
  if (reuse) {
    const bootedMocks = await bootLocalMocks(options.place, options.mocks ?? {});
    try {
      const organization = options.provision === false
        ? { admin: emptySession(reuse), members: {}, createdOrgId: null }
        : await provisionOrganization(
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
        async apiLog(): Promise<string> {
          throw new Error(
            "den.apiLog() is not available for attached Dens (OPENWORK_EVAL_DEN_API_URL / reuse): the den-api log lives with the process that started that server.",
          );
        },
        async [Symbol.asyncDispose](): Promise<void> {
          if (disposed) return;
          disposed = true;
          if (organization.createdOrgId) {
            await deleteCreatedOrganization(organization.admin, organization.createdOrgId).catch((error: unknown) => {
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
    if (options.seedProfile) {
      throw new Error('Den seedProfile "demo-org" is local-only and cannot seed a Daytona Den.');
    }
    if (!daytonaAvailable()) {
      throw new SkipError("Daytona CLI is unavailable; install and authenticate daytona, then set OPENWORK_EVAL_DAYTONA=1");
    }
    const base = options.place.denBase();
    if (base.kind !== "daytona") throw new Error("Daytona place returned a local Den base.");
    const preparedSandbox = process.env.OPENWORK_EVAL_DAYTONA_DEN_SANDBOX?.trim();
    const orgShape = options.org ?? {};
    const isolatePreparedTest = Boolean(preparedSandbox && options.provision !== false);
    const bootstrapAdmin = personDefaults("admin", orgShape.admin, runId);
    const provisioned = await provisionDenSandbox({
      ref: base.ref,
      reuse: preparedSandbox,
      bootstrapAdminEmail: bootstrapAdmin.email,
      log: (line) => console.error(`[openwork/testkit] ${line}`),
    });
    let bootedMocks: { handles: Record<string, MockHandle>; env: Record<string, string> } = { handles: {}, env: {} };
    try {
      bootedMocks = await bootDaytonaMocks(provisioned.sandbox, options.mocks ?? {});
      const ref = { apiUrl: cleanUrl(provisioned.apiUrl), webUrl: cleanUrl(provisioned.webUrl) };
      const organization = options.provision === false
        ? { admin: emptySession(ref), members: {}, createdOrgId: null }
        : await provisionOrganization(
            ref,
            orgShape,
            runId,
            {
              createOrg: isolatePreparedTest || Boolean(options.org),
              fallbackAdmin: (isolatePreparedTest || options.org?.admin) ? undefined : defaultReuseAdmin(),
            },
          );
      let platformAdminGrant: PlatformAdminGrant | null = null;
      if (preparedSandbox && options.provision !== false) {
        try {
          platformAdminGrant = await grantPreparedPlatformAdmin(ref, organization.admin.email);
        } catch (error) {
          if (organization.createdOrgId) {
            await deleteCreatedOrganization(organization.admin, organization.createdOrgId).catch(() => undefined);
          }
          throw error;
        }
      }
      let disposed = false;
      return {
        ref,
        placement: { kind: "daytona", sandboxId: provisioned.sandbox },
        admin: organization.admin,
        members: organization.members,
        mocks: bootedMocks.handles,
        async apiLog(): Promise<string> {
          // den-api on the server sandbox logs to /tmp/den-api.log
          // (.devcontainer/start-daytona-server.sh:158; the provisioning
          // script's own debug hint tails the same file).
          const result = await execInSandbox(defaultDaytonaExec, provisioned.sandbox, "cat /tmp/den-api.log", {
            timeoutMs: 120_000,
            context: `den-api log read for ${provisioned.sandbox}`,
          });
          return result.stdout;
        },
        async [Symbol.asyncDispose](): Promise<void> {
          if (disposed) return;
          disposed = true;
          if (organization.createdOrgId) {
            await deleteCreatedOrganization(organization.admin, organization.createdOrgId).catch((error: unknown) => {
              console.error(`[openwork/testkit] Daytona Den org cleanup failed: ${messageText(error)}`);
            });
          }
          if (platformAdminGrant) {
            await revokePreparedPlatformAdmin(platformAdminGrant).catch((error: unknown) => {
              console.error(`[openwork/testkit] Daytona platform-admin cleanup failed: ${messageText(error)}`);
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
  if (!await localRedisIsRunning()) {
    throw new Error("Local Den requires Redis on 127.0.0.1:6379. Run: redis-server --port 6379 --daemonize yes --save '' --appendonly no");
  }

  const bootedMocks = await bootLocalMocks(options.place, options.mocks ?? {});
  const services: SpawnedService[] = [];
  let database: DbHandle | undefined;
  try {
    database = await options.place.db(ephemeralDatabaseName());
    await trackResource({ kind: "mysql-db", id: database.name, label: "den-mysql" });
    await runDbPush(database.url);
    let apiPort: number;
    let webPort: number;
    if (options.ports) {
      validateFixedPort("api", options.ports.api);
      validateFixedPort("web", options.ports.web);
      await freePort(options.ports.api);
      await freePort(options.ports.web);
      apiPort = options.ports.api;
      webPort = options.ports.web;
    } else {
      const allocated = await allocateFreePorts(2);
      const allocatedApi = allocated[0];
      const allocatedWeb = allocated[1];
      if (allocatedApi === undefined || allocatedWeb === undefined) throw new Error("Could not allocate Den API/Web ports.");
      apiPort = allocatedApi;
      webPort = allocatedWeb;
    }
    const origins = [...trustedOrigins(apiPort, webPort), ...(options.trustedOrigins ?? [])].join(",");
    const ref: DenRef = {
      apiUrl: `http://127.0.0.1:${apiPort}`,
      webUrl: `http://127.0.0.1:${webPort}`,
    };
    const logsDir = join(REPO_ROOT, "evals", "results", ".testkit", database.name);
    await mkdir(logsDir, { recursive: true });
    const prepared = process.env.OPENWORK_EVAL_DEN_RUNTIME_PREPARED === "1";
    if (!prepared && options.web !== false) {
      // Every ephemeral next dev process otherwise reuses the same Turbopack
      // graph. A stale missing-module node can break /api/den even though
      // /api/ready is healthy.
      await rm(join(REPO_ROOT, "ee", "apps", "den-web", ".next", "dev"), { recursive: true, force: true });
    }
    if (options.seedProfile === "demo-org") {
      await runDemoOrgSeed(database.url, webPort, join(logsDir, "seed-demo-org.log"));
    }
    const orgShape = options.org ?? defaultLocalOrg(runId);
    const bootstrapAdmin = options.seedProfile === "demo-org"
      ? defaultReuseAdmin()
      : personDefaults("admin", orgShape.admin, runId);
      const commonEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...bootedMocks.env,
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
      DEN_ORG_MODE: "multi_org",
      DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      DEN_PASSWORD_BREACH_SCREENING_ENABLED: "false",
      // Existing Automation journeys explicitly exercise the enabled
      // deployment path. Rollout specs override this to prove disabled UI.
      DEN_AUTOMATIONS_ENABLED: "true",
      DEN_AUTOMATIONS_RUNTIME_ENABLED: "true",
      DEN_DASHBOARDS_ENABLED: "false",
      DEN_GENERATED_ARTIFACT_VIEWS_ENABLED:
        process.env.OPENWORK_EVAL_GENERATED_ARTIFACT_VIEWS_E2E_TEST === "1" ? "true" : "false",
      OPENWORK_DEV_MODE: "1",
      PROVISIONER_MODE: "stub",
        // The locally booted Den seeds this admin into the platform-admin
        // allowlist so tests can exercise /v1/admin/* capability toggles.
        DEN_BOOTSTRAP_ADMIN_EMAILS: bootstrapAdmin.email,
        ...options.env,
      };
    const api = spawnService("den-api", "dev:den:api", apiPort, { ...commonEnv, DEN_BIND_HOST: "127.0.0.1" }, join(logsDir, "api.log"));
    services.push(api);
    await trackResource({ kind: "process", id: String(api.pid), label: "den-api", match: prepared ? "@openwork-ee/den-api" : "dev:den:api" });
    const web = options.web === false
      ? null
      : spawnService("den-web", "dev:den:web", webPort, {
          DEN_WEB_HOST: "127.0.0.1",
          ...commonEnv,
          DEN_API_BASE: `http://127.0.0.1:${apiPort}`,
          DEN_BASE_URL: `http://localhost:${webPort}`,
          DEN_AUTH_ORIGIN: `http://localhost:${webPort}`,
          DEN_AUTH_FALLBACK_BASE: `http://127.0.0.1:${apiPort}`,
        }, join(logsDir, "web.log"));
    if (web) {
      services.push(web);
      await trackResource({ kind: "process", id: String(web.pid), label: "den-web", match: prepared ? "@openwork-ee/den-web" : "dev:den:web" });
    }
    await waitForHttp(`${ref.apiUrl}/health`, api, (response) => response.ok);
    if (web) {
      await waitForHttp(`${ref.webUrl}/api/ready`, web, (response) => response.ok);
      // /api/ready does not compile the dynamic /api/den proxy route. Locally,
      // accept its 307 to /health because api.<host> derivation requires
      // production DNS (see den-web app/api/_lib/den-api-redirect.ts).
      await waitForHttp(`${ref.webUrl}/api/den/health`, web, (response) => {
        if (response.ok) return true;
        if (response.status !== 307 && response.status !== 308) return false;
        const location = response.headers.get("location");
        return location !== null && new URL(location, response.url).pathname === "/health";
      }, { redirect: "manual" });
    }
    await waitForAuthProbe(ref, api);
    const organization = options.seedProfile === "demo-org"
      ? {
          admin: await signIn(ref, {
            email: defaultReuseAdmin().email,
            password: defaultReuseAdmin().password,
          }),
          members: {},
          createdOrgId: null,
        }
      : options.provision === false
        ? { admin: emptySession(ref), members: {}, createdOrgId: null }
        : await provisionOrganization(
            ref,
            orgShape,
            runId,
            { databaseUrl: database.url, createOrg: true },
          );
    let disposed = false;
    return {
      ref,
      placement: { kind: "local" },
      admin: organization.admin,
      members: organization.members,
      mocks: bootedMocks.handles,
      database,
      ports: { api: apiPort, web: webPort },
      async apiLog(): Promise<string> {
        return readFile(api.logPath, "utf8");
      },
      async [Symbol.asyncDispose](): Promise<void> {
        if (disposed) return;
        disposed = true;
        if (organization.createdOrgId) {
          await deleteCreatedOrganization(organization.admin, organization.createdOrgId).catch((error: unknown) => {
            console.error(`[openwork/testkit] local Den org cleanup failed: ${messageText(error)}`);
          });
        }
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
