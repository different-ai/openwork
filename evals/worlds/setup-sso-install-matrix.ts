import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { addInitScript, allocateFreePorts, browserScript, evaluate, navigate } from "@openwork/cdp";
import { clickText, waitFor } from "@openwork/behaviors";
import { resolvePlace } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { startMockIdpLab } from "@openwork/labs";

declare global {
  interface Window {
    __setupSsoPrivateCapture?: { installResponse?: string; installCopy?: string; desktopResponse?: string };
  }
}

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMPOSE_FILE = join(REPO_ROOT, "packaging", "docker", "docker-compose.eval.yml");
const MANIFEST_PATH = join(REPO_ROOT, "tmp", "setup-sso-install-matrix.json");
const PLATFORM = process.env.OPENWORK_SETUP_SSO_PLATFORM?.trim() || (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");
if (!["linux/arm64", "linux/amd64"].includes(PLATFORM)) throw new Error("The matrix supports linux/arm64 or linux/amd64.");
const SOURCE_ROOT = process.env.OPENWORK_SETUP_SSO_SOURCE_ROOT?.trim() || REPO_ROOT;
const SOURCE_SCOPES = [
  "ee", "packages", "packaging/docker", "patches", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".dockerignore", "tsconfig.json",
  "apps/desktop/package.json", "evals/packages/behaviors/package.json", "evals/packages/cdp/package.json", "evals/packages/labs/package.json", "evals/packages/matchers/package.json",
];
const HOST_API_VERSION = "0.18.48";
const HOST_API_IMAGE = "ghcr.io/different-ai/openwork-den-api:0.18.48@sha256:8f2977788063c47d06f3cd2b2c60b43da5137d42c807b577e2f30ad968e86204";
const HOST_CONTAINER_WEB_IMAGE = "ghcr.io/different-ai/openwork-den-web:0.18.48@sha256:fe856630e05b1ff96accfb2a8a108b416a1fdc1a842ea0af492b3a8472f594a5";
const HOST_WEB_ARTIFACT = "host://checked-out-den-web";
const SOURCE_FINGERPRINT_LABEL = "org.openwork.setup-sso-source";
export const SETUP_SSO_PRODUCT_SOURCE_FILES = [
  "ee/apps/den-web/app/(den)/_components/member-auth-guard.tsx",
  "ee/apps/den-web/app/(den)/_lib/den-flow.ts",
  "ee/apps/den-web/app/(den)/_lib/member-auth-routing.ts",
  "ee/apps/den-web/app/(den)/_lib/runtime-config.ts",
  "ee/apps/den-web/app/(den)/_providers/den-flow-provider.tsx",
  "ee/apps/den-web/app/(den)/install/page.tsx",
  "ee/apps/den-web/app/(den)/setup/page.tsx",
];

async function matrixPorts(): Promise<number[]> {
  const configured = process.env.OPENWORK_SETUP_SSO_PORTS?.trim();
  if (!configured) return allocateFreePorts(3);
  const ports = configured.split(",").map(Number);
  if (ports.length !== 3 || new Set(ports).size !== 3 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error("OPENWORK_SETUP_SSO_PORTS must contain three distinct web,API,IdP ports between 1024 and 65535.");
  }
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", () => reject(new Error(`Requested lab port ${port} is occupied; no process was stopped.`)));
      server.listen(port, "0.0.0.0", () => server.close((error) => error ? reject(error) : resolve()));
    });
  }
  return ports;
}

function hostAddressReachableFromDocker(): string {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("Could not find a host IPv4 address reachable from Docker.");
}

const RELEASE_COLUMNS = [
  {
    id: "0.18.54",
    apiImage: "ghcr.io/different-ai/openwork-den-api:0.18.54@sha256:d4cbd7dbe4dfa1108711b801c089504da340d319949558fe23aafee39c0f11f0",
    webImage: "ghcr.io/different-ai/openwork-den-web:0.18.54@sha256:c3ffe73874c870e519b516a14a7eb239f2bc4eb8afcba87914486562db57717e",
  },
  {
    id: "0.18.57",
    apiImage: "ghcr.io/different-ai/openwork-den-api:0.18.57@sha256:9a1d036b2f39c67544c9f78cb3e966ddcc1b0296aa61af7eebd04308afdad6d0",
    webImage: "ghcr.io/different-ai/openwork-den-web:0.18.57@sha256:aadaae6fb1b96b8e87b63c15ab4a51f5ab8782969850911b134978d357bc4569",
  },
];

interface MatrixContext {
  enterprise: boolean;
  requireSso: boolean;
  ssoStatus: string;
  domainVerified: boolean;
  singletonConfigured: boolean;
  scimReady: boolean;
  scimUsersStatus: number;
  scimUsers: number;
  passwordSignInStatus: number;
  passwordSignInError: string;
}

export interface SetupSsoMatrixColumn {
  id: string;
  apiVersion: string;
  apiImage: string;
  webImage: string;
  apiImageId: string;
  webImageId: string;
  apiUrl: string;
  webUrl: string;
  idpOrigin: string;
  project: string;
  context: MatrixContext;
  control: {
    organizationId: string;
    adminToken: string;
    adminCookie: string;
    ownerEmail: string;
    ownerPassword: string;
    installPath: string;
  };
}

export interface SetupSsoMatrixManifest {
  createdAt: string;
  commit: string;
  source: {
    fingerprint: string;
    root: string;
    scopes: readonly string[];
    platform: string;
    productFiles: readonly string[];
    dirtyProductFiles: string[];
    apiImageFingerprint: string | null;
    webImageFingerprint: string | null;
    webMode: "image" | "host-production";
    hostWebFingerprint: string | null;
    hostWebCommit: string | null;
  };
  columns: SetupSsoMatrixColumn[];
  pending: SetupSsoPendingColumn | null;
}

export interface SetupSsoPendingColumn {
  control: { ownerEmail: string; ownerPassword: string; bootstrapCode: string };
  id: "pending";
  apiVersion: string;
  apiImage: string;
  webImage: string;
  apiImageId: string;
  webImageId: string;
  apiUrl: string;
  webUrl: string;
  project: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isRecord(field) ? field : null;
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function booleanField(value: unknown, key: string): boolean {
  return isRecord(value) && value[key] === true;
}

function numberField(value: unknown, key: string): number {
  if (!isRecord(value)) return -1;
  const field = value[key];
  return typeof field === "number" ? field : -1;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function command(command: string, args: string[], timeout = 900_000): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return stdout;
}

async function compose(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["compose", ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000,
  });
  return stdout;
}

async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown; text: string }> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

function requireOk(result: { response: Response; text: string }, label: string): void {
  if (!result.response.ok) {
    throw new Error(`${label} returned HTTP ${result.response.status}: ${result.text.slice(0, 300)}`);
  }
}

function requireSession(result: { response: Response; body: unknown; text: string }, label: string): { token: string; cookie: string } {
  requireOk(result, label);
  const token = stringField(result.body, "token");
  const cookie = result.response.headers.getSetCookie()
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .find((value) => value.includes("session_token=")) ?? "";
  if (!token || !cookie) throw new Error(`${label} did not return a bearer token and session cookie.`);
  return { token, cookie };
}

function sqlString(value: string): string {
  return `CONVERT(0x${Buffer.from(value).toString("hex")} USING utf8mb4)`;
}

async function imageId(image: string): Promise<string> {
  return (await command("docker", ["image", "inspect", "--format", "{{.Id}}", image], 60_000)).trim();
}

export async function setupSsoProductSourceFingerprint(): Promise<string> {
  const untracked = (await command("git", ["-C", SOURCE_ROOT, "ls-files", "--others", "--exclude-standard", "-z", "--", ...SOURCE_SCOPES], 60_000)).split("\0").filter(Boolean);
  if (untracked.length) throw new Error("Untracked nonignored Docker source inputs must be tracked or removed before building the matrix.");
  const hash = createHash("sha256");
  const files = (await command("git", ["-C", SOURCE_ROOT, "ls-files", "-z", "--", ...SOURCE_SCOPES], 60_000)).split("\0").filter(Boolean).sort();
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(SOURCE_ROOT, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function setupSsoCurrentCommit(): Promise<string> {
  return (await command("git", ["-C", SOURCE_ROOT, "rev-parse", "HEAD"], 60_000)).trim();
}

export async function readSetupSsoManifest(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runSetupSsoSql(project: string, sql: string): Promise<string> {
  const result = await execFileAsync("docker", ["exec", `${project}-mysql-1`, "mysql", "-uroot", "-ppassword", "-D", "openwork_den", "-N", "-e", sql], { timeout: 30_000 });
  return result.stdout.trim();
}

async function imageFingerprint(image: string): Promise<string> {
  return (await command("docker", ["image", "inspect", "--format", `{{ index .Config.Labels "${SOURCE_FINGERPRINT_LABEL}" }}`, image], 60_000)).trim();
}

async function buildDevImages(fingerprint: string, commit: string): Promise<{ apiImage: string; webImage: string }> {
  const apiImage = `openwork-den-api:setup-sso-${commit.slice(0, 12)}-${fingerprint.slice(0, 12)}`;
  const webImage = `openwork-den-web:setup-sso-${commit.slice(0, 12)}-${fingerprint.slice(0, 12)}`;
  const labels = ["--label", `${SOURCE_FINGERPRINT_LABEL}=${fingerprint}`, "--label", `org.opencontainers.image.revision=${commit}`];
  for (const [dockerfile, image] of [["Dockerfile.den", apiImage], ["Dockerfile.den-web", webImage]]) {
    const versionArgs = dockerfile === "Dockerfile.den" ? ["--build-arg", `DEN_API_VERSION=${commit}`] : [];
    await command("docker", ["buildx", "build", "--load", "--platform", PLATFORM, ...labels, ...versionArgs, "-f", join(SOURCE_ROOT, "packaging/docker", dockerfile), "-t", image, SOURCE_ROOT], 1_800_000);
  }
  const fingerprints = await Promise.all([imageFingerprint(apiImage), imageFingerprint(webImage)]);
  if (fingerprints.some((value) => value !== fingerprint) || await setupSsoProductSourceFingerprint() !== fingerprint) {
    throw new Error("Built development images do not match the tested full API/Web source fingerprint.");
  }
  return { apiImage, webImage };
}

async function buildHostWeb(expectedFingerprint: string): Promise<void> {
  await command("pnpm", ["--filter", "@openwork-ee/den-web", "build"]);
  const builtFingerprint = await setupSsoProductSourceFingerprint();
  if (builtFingerprint !== expectedFingerprint) {
    throw new Error("Den Web product source changed while the host production artifact was building.");
  }
}

function startHostWeb(
  stack: AsyncDisposableStack,
  input: { webPort: number; webUrl: string; apiUrl: string; organizationName: string },
): () => string {
  let output = "";
  const child = spawn("pnpm", ["--dir", "ee/apps/den-web", "exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(input.webPort)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DEN_API_BASE: input.apiUrl,
      DEN_API_PUBLIC_URL: input.apiUrl,
      DEN_AUTH_ORIGIN: input.webUrl,
      DEN_BASE_URL: input.webUrl,
      DEN_WEB_PUBLIC_ORIGIN: input.webUrl,
      DEN_WEB_OPENWORK_AUTH_CALLBACK_URL: input.webUrl,
      DEN_ORG_MODE: "single_org",
      DEN_SINGLE_ORG_NAME: input.organizationName,
      DEN_SINGLE_ORG_SLUG: "default",
      DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "false",
      NEXT_PUBLIC_POSTHOG_API_KEY: "",
      NEXT_PUBLIC_POSTHOG_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: string) => {
    output = `${output}${chunk}`.slice(-32 * 1024);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  stack.adopt(child, async (owned: ChildProcess) => {
    if (owned.exitCode !== null || owned.signalCode !== null) return;
    owned.kill("SIGTERM");
    await Promise.race([once(owned, "exit"), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
  });
  return () => output;
}

async function waitForHttp(url: string, label: string, logs: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + 300_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${label}: ${last}. Logs:\n${(await logs()).split(/\r?\n/).slice(-40).join("\n")}`);
}

async function seedEnterpriseSsoContext(input: {
  apiUrl: string;
  webUrl: string;
  project: string;
  composeArgs: string[];
  composeEnv: NodeJS.ProcessEnv;
  ownerEmail: string;
  ownerPassword: string;
  bootstrapCode: string;
  idp: Awaited<ReturnType<typeof startMockIdpLab>>;
}): Promise<{ context: MatrixContext; control: SetupSsoMatrixColumn["control"] }> {
  const originHeaders = { origin: input.webUrl };
  const verified = await jsonRequest(`${input.apiUrl}/v1/auth/bootstrap/verify`, {
    method: "POST",
    headers: originHeaders,
    body: JSON.stringify({ email: input.ownerEmail, code: input.bootstrapCode }),
  });
  requireOk(verified, "bootstrap verification");
  const grant = stringField(verified.body, "grant");
  if (!grant) throw new Error("Bootstrap verification omitted its grant.");

  const signedUp = await jsonRequest(`${input.apiUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: originHeaders,
    body: JSON.stringify({ email: input.ownerEmail, name: "Synthetic Administrator", password: input.ownerPassword, bootstrapGrant: grant }),
  });
  requireOk(signedUp, "bootstrap account creation");
  const ownerUserId = stringField(recordField(signedUp.body, "user"), "id");
  if (!ownerUserId) throw new Error("Bootstrap account creation omitted the owner user id.");
  const signedIn = await jsonRequest(`${input.apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: originHeaders,
    body: JSON.stringify({ email: input.ownerEmail, password: input.ownerPassword }),
  });
  const session = requireSession(signedIn, "administrator sign-in");
  const authorization = { authorization: `Bearer ${session.token}` };
  const organizationResult = await jsonRequest(`${input.apiUrl}/v1/org`, { headers: authorization });
  requireOk(organizationResult, "organization lookup");
  const organization = recordField(organizationResult.body, "organization");
  const organizationId = stringField(organization, "id");
  if (!organizationId) throw new Error("Organization lookup omitted its id.");
  const adminHeaders = { ...authorization, cookie: session.cookie, "x-openwork-org-id": organizationId };

  await compose([
    ...input.composeArgs,
    "exec", "-T", "mysql", "mysql", "-uroot", "-ppassword", "-D", "openwork_den", "-N", "-e",
    `UPDATE organization SET metadata=JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.plan', JSON_OBJECT('tier', 'enterprise', 'source', 'manual')) WHERE id=${sqlString(organizationId)}`,
  ], input.composeEnv);
  const enforced = await jsonRequest(`${input.apiUrl}/v1/org`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ requireSso: true }),
  });
  requireOk(enforced, "enforced SSO organization setting");
  const enforcedOrganization = recordField(enforced.body, "organization");
  const metadata = recordField(enforcedOrganization, "metadata");
  const plan = recordField(metadata, "plan");
  const enterprise = stringField(plan, "tier") === "enterprise";
  const requireSso = booleanField(metadata, "requireSso");
  if (!enterprise || !requireSso) throw new Error("Organization did not persist enterprise plan plus requireSso=true.");

  const registration = input.idp.registration({ skipDiscovery: true });
  const registered = await jsonRequest(`${input.apiUrl}/v1/sso/oidc`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      issuer: registration.issuer,
      domain: registration.domain,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      scopes: registration.scopes,
      skipDiscovery: registration.skipDiscovery,
      authorizationEndpoint: registration.authorizationEndpoint,
      tokenEndpoint: registration.tokenEndpoint,
      jwksEndpoint: registration.jwksEndpoint,
      userInfoEndpoint: registration.userInfoEndpoint,
      tokenEndpointAuthentication: registration.tokenEndpointAuthentication,
    }),
  });
  requireOk(registered, "OIDC registration");
  const providerId = stringField(recordField(registered.body, "connection"), "providerId");
  if (!providerId) throw new Error("OIDC registration omitted the provider id.");
  const accountSuffix = randomBytes(13).toString("hex");
  const linkedAccountId = `acc_0${accountSuffix.slice(1)}`;
  await compose([
    ...input.composeArgs,
    "exec", "-T", "mysql", "mysql", "-uroot", "-ppassword", "-D", "openwork_den", "-N", "-e",
    `UPDATE sso_provider SET domain_verified=1 WHERE organization_id=${sqlString(organizationId)}; INSERT INTO account (id,user_id,account_id,provider_id) VALUES (${sqlString(linkedAccountId)},${sqlString(ownerUserId)},${sqlString(input.ownerEmail)},${sqlString(providerId)});`,
  ], input.composeEnv);
  const testResult = await jsonRequest(`${input.apiUrl}/v1/sso/test`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({}),
  });
  requireOk(testResult, "OIDC configuration test start");
  const testUrl = stringField(testResult.body, "testUrl");
  if (!testUrl) throw new Error("OIDC configuration test omitted its test URL.");

  const place = resolvePlace();
  if (place.kind !== "local") throw new Error("The setup SSO install matrix requires local placement.");
  await using configurationBrowser = await chrome({ host: place.host(), name: `setup-sso-config-${input.project}`, startUrl: "about:blank", headless: true });
  const separator = session.cookie.indexOf("=");
  if (separator < 1) throw new Error("Administrator session cookie was malformed.");
  const applied = await configurationBrowser.client.send("Network.setCookie", {
    name: session.cookie.slice(0, separator),
    value: session.cookie.slice(separator + 1),
    url: testUrl,
    httpOnly: true,
  });
  if (!isRecord(applied) || applied.success !== true) throw new Error("Could not apply the administrator cookie to the configuration browser.");
  await navigate(configurationBrowser.client, testUrl);
  await waitFor(configurationBrowser, () => document.querySelector("button")?.textContent?.includes("Approve sign-in") === true, {
    timeoutMs: 90_000,
    label: "synthetic identity-provider approval",
  });
  await clickText(configurationBrowser, "Approve sign-in");
  await waitFor(configurationBrowser, () => location.pathname === "/sso/test/complete", {
    timeoutMs: 90_000,
    label: "OIDC configuration test completion",
  });
  const browserValue = await evaluate(configurationBrowser.client, () => ({ href: location.href, body: document.body?.innerText ?? "" }));
  const browserBody = stringField(browserValue, "body");
  if (!/authentication test finished/i.test(browserBody)) {
    throw new Error(`OIDC configuration test failed at ${stringField(browserValue, "href")}: ${browserBody}`);
  }

  const statusDeadline = Date.now() + 30_000;
  let ssoState: { response: Response; body: unknown; text: string } | null = null;
  while (Date.now() < statusDeadline) {
    ssoState = await jsonRequest(`${input.apiUrl}/v1/sso`, { headers: adminHeaders });
    const connection = recordField(ssoState.body, "connection");
    if (stringField(connection, "testStatus") === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ssoState || stringField(recordField(ssoState.body, "connection"), "testStatus") !== "succeeded") {
    const connection = recordField(ssoState?.body, "connection");
    throw new Error(`OIDC configuration test did not persist succeeded status: status=${JSON.stringify(stringField(connection, "testStatus"))}, lastError=${JSON.stringify(stringField(connection, "lastError"))}.`);
  }
  const enabled = await jsonRequest(`${input.apiUrl}/v1/sso/enable`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({}),
  });
  if (enabled.response.status !== 204) throw new Error(`OIDC enable returned HTTP ${enabled.response.status}: ${enabled.text.slice(0, 300)}`);
  const enabledState = await jsonRequest(`${input.apiUrl}/v1/sso`, { headers: adminHeaders });
  requireOk(enabledState, "enabled OIDC lookup");
  const connection = recordField(enabledState.body, "connection");
  const ssoStatus = stringField(connection, "status");
  const domainVerified = booleanField(connection, "domainVerified");
  if (ssoStatus !== "enabled" || !domainVerified) throw new Error("OIDC connection is not enabled and domain-verified.");

  const scimTokenResult = await jsonRequest(`${input.apiUrl}/v1/scim/token`, { method: "POST", headers: adminHeaders });
  if (scimTokenResult.response.status !== 201) throw new Error(`SCIM token creation returned HTTP ${scimTokenResult.response.status}: ${scimTokenResult.text.slice(0, 300)}`);
  const scimToken = stringField(scimTokenResult.body, "scimToken");
  const scimReady = booleanField(scimTokenResult.body, "ssoReady");
  if (!scimToken || !scimReady) throw new Error("SCIM token response did not confirm SSO readiness.");
  const scimHeaders = {
    authorization: `Bearer ${scimToken}`,
    accept: "application/scim+json, application/json",
    "content-type": "application/scim+json",
  };
  const scimUser = await jsonRequest(`${input.apiUrl}/api/auth/scim/v2/Users`, {
    method: "POST",
    headers: scimHeaders,
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: `managed@${registration.domain}`,
      name: { givenName: "Synthetic", familyName: "Member" },
      emails: [{ primary: true, value: `managed@${registration.domain}`, type: "work" }],
      externalId: `synthetic-${input.project}`,
      active: true,
      displayName: "Synthetic Member",
    }),
  });
  if (scimUser.response.status !== 201) throw new Error(`SCIM user creation returned HTTP ${scimUser.response.status}: ${scimUser.text.slice(0, 300)}`);
  const scimUsers = await jsonRequest(`${input.apiUrl}/api/auth/scim/v2/Users`, { headers: scimHeaders });
  if (scimUsers.response.status !== 200 || numberField(scimUsers.body, "totalResults") !== 1) {
    throw new Error(`SCIM user listing returned HTTP ${scimUsers.response.status} with totalResults=${numberField(scimUsers.body, "totalResults")}.`);
  }
  const singleton = await jsonRequest(`${input.apiUrl}/v1/orgs/sso/singleton`);
  requireOk(singleton, "singleton SSO status");
  const singletonConfigured = booleanField(singleton.body, "configured");
  if (!singletonConfigured) throw new Error("Singleton SSO status did not report configured=true.");
  // Observe the real admin UI action; keep its bearer link in memory/private manifest only.
  await navigate(configurationBrowser.client, `${input.webUrl}/dashboard/members`);
  await waitFor(configurationBrowser, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Copy install link"), {
    timeoutMs: 90_000,
    label: "administrator Copy install link action",
  });
  await evaluate(configurationBrowser.client, () => {
    const captured: NonNullable<Window["__setupSsoPrivateCapture"]> = {};
    window.__setupSsoPrivateCapture = captured;
    const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text) => {
      captured.installCopy = text;
      return originalWriteText(text);
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(response.url).pathname.endsWith("/install-links") && response.ok) {
        const payload: unknown = await response.clone().json();
        if (payload && typeof payload === "object" && "installPageUrl" in payload && typeof payload.installPageUrl === "string") {
          captured.installResponse = payload.installPageUrl;
        }
      }
      return response;
    };
  });
  await clickText(configurationBrowser, "Copy install link");
  await waitFor(configurationBrowser, () => Boolean(window.__setupSsoPrivateCapture?.installResponse) && Boolean(window.__setupSsoPrivateCapture?.installCopy), {
    timeoutMs: 30_000,
    label: "real admin UI install-link response and copy argument",
  });
  const copyMatchesResponse = await evaluate(configurationBrowser.client, () => window.__setupSsoPrivateCapture?.installCopy === window.__setupSsoPrivateCapture?.installResponse);
  if (!copyMatchesResponse) throw new Error("Admin UI copied a different install link than the issued response (values withheld).");
  const installPageUrl = await evaluate(configurationBrowser.client, () => {
    const url = window.__setupSsoPrivateCapture?.installCopy;
    delete window.__setupSsoPrivateCapture;
    return url;
  });
  if (!installPageUrl) throw new Error("Admin UI install-link action omitted its copy argument.");
  const installUrl = new URL(installPageUrl);
  if (installUrl.pathname !== "/install" || !installUrl.searchParams.get("token")) throw new Error("Install link did not contain a valid /install token.");
  const enforcementOff = await jsonRequest(`${input.apiUrl}/v1/org`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ requireSso: false }),
  });
  requireOk(enforcementOff, "disable enforced SSO setting");
  const offMetadata = recordField(recordField(enforcementOff.body, "organization"), "metadata");
  if (booleanField(offMetadata, "requireSso")) throw new Error("Organization did not persist requireSso=false.");
  const passwordSignIn = await jsonRequest(`${input.apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: originHeaders,
    body: JSON.stringify({ email: input.ownerEmail, password: input.ownerPassword }),
  });
  const passwordSignInError = stringField(passwordSignIn.body, "error");
  if (passwordSignIn.response.status !== 403 || passwordSignInError !== "single_org_sso_required") {
    throw new Error(`Password sign-in was not disabled by singleton SSO with enforcement off: HTTP ${passwordSignIn.response.status} ${passwordSignInError}.`);
  }

  return { context: {
    enterprise,
    requireSso: false,
    ssoStatus,
    domainVerified,
    singletonConfigured,
    scimReady,
    scimUsersStatus: scimUsers.response.status,
    scimUsers: numberField(scimUsers.body, "totalResults"),
    passwordSignInStatus: passwordSignIn.response.status,
    passwordSignInError,
  }, control: {
    organizationId,
    adminToken: session.token,
    adminCookie: session.cookie,
    ownerEmail: input.ownerEmail,
    ownerPassword: input.ownerPassword,
    installPath: `${installUrl.pathname}${installUrl.search}`,
  } };
}

async function bootColumn(
  stack: AsyncDisposableStack,
  definition: { id: string; apiVersion: string; apiImage: string; webImage: string },
  pullPolicy: "always" | "never",
  setup: "configured",
  hostWeb?: { fingerprint: string },
): Promise<SetupSsoMatrixColumn>;
async function bootColumn(
  stack: AsyncDisposableStack,
  definition: { id: "pending"; apiVersion: string; apiImage: string; webImage: string },
  pullPolicy: "always" | "never",
  setup: "pending",
  hostWeb?: { fingerprint: string },
): Promise<SetupSsoPendingColumn>;
async function bootColumn(
  stack: AsyncDisposableStack,
  definition: { id: string; apiVersion: string; apiImage: string; webImage: string },
  pullPolicy: "always" | "never",
  setup: "configured" | "pending",
  hostWeb?: { fingerprint: string },
): Promise<SetupSsoMatrixColumn | SetupSsoPendingColumn> {
  const ports = await matrixPorts();
  const webPort = ports[0];
  const apiPort = ports[1];
  const idpPort = ports[2];
  if (webPort === undefined || apiPort === undefined || idpPort === undefined) throw new Error("Could not allocate matrix ports.");
  const suffix = randomBytes(4).toString("hex");
  const safeId = definition.id.replaceAll(".", "-");
  const project = `setup-sso-${safeId}-${suffix}`;
  const ownerEmail = "owner@synthetic-sso.test";
  const ownerPassword = `S-${randomBytes(12).toString("hex")}!`;
  const bootstrapCode = `bootstrap-${randomBytes(18).toString("hex")}`;
  const domain = "synthetic-sso.test";
  const idpHost = hostAddressReachableFromDocker();
  const idp = stack.use(await startMockIdpLab({
    publicIssuer: `http://${idpHost}:${idpPort}`,
    domain,
    defaultSubject: { email: ownerEmail, name: "Synthetic Administrator" },
    listen: { host: "0.0.0.0", port: idpPort },
    knobs: { interactive: true },
  }));
  const webUrl = `http://localhost:${webPort}`;
  const apiUrl = `http://localhost:${apiPort}`;
  const root = join(REPO_ROOT, "tmp", "setup-sso-install-matrix", project);
  await mkdir(root, { recursive: true });
  const overridePath = join(root, "docker-compose.override.yml");
  const trustedOrigins = [webUrl, apiUrl, new URL(idp.issuer).origin].join(",");
  const organizationName = "Synthetic enterprise";
  await writeFile(overridePath, [
    "services:",
    "  mysql:",
    `    platform: ${PLATFORM}`,
    "  den-migrate:",
    `    platform: ${PLATFORM}`,
    `    image: "${definition.apiImage}"`,
    `    pull_policy: ${pullPolicy}`,
    "  den:",
    `    platform: ${PLATFORM}`,
    `    image: "${definition.apiImage}"`,
    `    pull_policy: ${pullPolicy}`,
    "    environment:",
    `      CORS_ORIGINS: "${trustedOrigins}"`,
    `      DEN_BETTER_AUTH_TRUSTED_ORIGINS: "${trustedOrigins}"`,
    "  web:",
    `    platform: ${PLATFORM}`,
    `    image: "${definition.webImage}"`,
    `    pull_policy: ${pullPolicy}`,
    ...(hostWeb ? ["    profiles: [\"container-web\"]"] : []),
    "",
  ].join("\n"), { mode: 0o600 });
  const composeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENWORK_WEB_PORT: String(webPort),
    OPENWORK_API_PORT: String(apiPort),
    OPENWORK_AUTH_SECRET: randomBytes(32).toString("hex"),
    OPENWORK_DB_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    OPENWORK_ALLOW_SIGNUP: "false",
    OPENWORK_ORG_NAME: organizationName,
    OPENWORK_OWNER_EMAILS: ownerEmail,
    OPENWORK_SETUP_CODE: bootstrapCode,
  };
  const composeArgs = ["-p", project, "-f", COMPOSE_FILE, "-f", overridePath];
  let hostWebLogs = () => "";
  const logs = async () => {
    const composeLogs = await compose([...composeArgs, "logs", "--no-color", "--tail", "120", "den-migrate", "den", "web"], composeEnv)
      .catch((error: unknown) => `logs unavailable: ${messageText(error)}`);
    const state = await command("docker", ["inspect", "--format", "{{json .State}}", `${project}-den-1`], 30_000).catch(() => "Den container state unavailable.");
    let output = `${composeLogs}\nDen state: ${state}\n${hostWebLogs()}`;
    for (const secret of [composeEnv.OPENWORK_AUTH_SECRET, composeEnv.OPENWORK_DB_ENCRYPTION_KEY, bootstrapCode, ownerPassword]) {
      if (secret) output = output.replaceAll(secret, "<redacted>");
    }
    return output.replace(/Bearer\s+[^\s,;]+/gi, "Bearer <redacted>").replace(/((?:token|grant|state|code|password|secret)=)[^&\s"']+/gi, "$1<redacted>");
  };
  // Register before up: even a partial compose boot belongs to this stack.
  stack.adopt({ composeArgs, composeEnv }, async (owned) => {
    await compose([...owned.composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], owned.composeEnv)
      .catch((error: unknown) => console.error(`[setup-sso-matrix] cleanup failed for ${project}: ${messageText(error)}`));
  });
  try {
    await compose([...composeArgs, "up", "-d", "--wait", "--wait-timeout", "300"], composeEnv);
    await waitForHttp(`${apiUrl}/health`, `${definition.id} Den API`, logs);
    if (hostWeb) {
      hostWebLogs = startHostWeb(stack, { webPort, webUrl, apiUrl, organizationName });
    }
    await waitForHttp(`${webUrl}/api/ready`, `${definition.id} Den web`, logs);
  } catch (error) {
    const diagnostic = await logs();
    await writeFile(join(root, "startup-failure.log"), diagnostic, { mode: 0o600 });
    throw new Error(`${definition.id} compose startup failed before route verification:\n${diagnostic}`, { cause: error });
  }
  for (const service of ["den-migrate", "den", ...hostWeb ? [] : ["web"]]) {
    const image = service === "web" ? definition.webImage : definition.apiImage;
    const actualId = (await command("docker", ["inspect", "--format", "{{.Image}}", `${project}-${service}-1`], 60_000)).trim();
    if (actualId !== await imageId(image)) throw new Error(`${service} is not running the expected immutable image.`);
    const actualPlatform = (await command("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image], 60_000)).trim();
    if (actualPlatform !== PLATFORM) throw new Error(`${service} image does not match ${PLATFORM}.`);
  }
  if (setup === "pending") {
    return {
      id: "pending",
      control: { ownerEmail, ownerPassword, bootstrapCode },
      apiVersion: definition.apiVersion,
      apiImage: definition.apiImage,
      webImage: hostWeb ? HOST_WEB_ARTIFACT : definition.webImage,
      apiImageId: await imageId(definition.apiImage),
      webImageId: hostWeb?.fingerprint ?? await imageId(definition.webImage),
      apiUrl,
      webUrl,
      project,
    };
  }
  let seeded: Awaited<ReturnType<typeof seedEnterpriseSsoContext>>;
  try {
    seeded = await seedEnterpriseSsoContext({
      apiUrl,
      webUrl,
      project,
      composeArgs,
      composeEnv,
      ownerEmail,
      ownerPassword,
      bootstrapCode,
      idp,
    });
  } catch (error) {
    await writeFile(join(root, "failure.log"), await logs(), { mode: 0o600 });
    throw error;
  }
  return {
    id: definition.id,
    apiVersion: definition.apiVersion,
    apiImage: definition.apiImage,
    webImage: hostWeb ? HOST_WEB_ARTIFACT : definition.webImage,
    apiImageId: await imageId(definition.apiImage),
    webImageId: hostWeb?.fingerprint ?? await imageId(definition.webImage),
    apiUrl,
    webUrl,
    idpOrigin: new URL(idp.issuer).origin,
    project,
    context: seeded.context,
    control: seeded.control,
  };
}

export async function bootSetupSsoInstallMatrix(
  stack: AsyncDisposableStack,
  options: { hostWeb?: boolean; columns?: readonly string[] } = {},
): Promise<SetupSsoMatrixManifest> {
  const hostWeb = options.hostWeb ?? process.env.OPENWORK_SETUP_SSO_HOST_WEB === "1";
  const requested = new Set(
    (options.columns ?? process.env.OPENWORK_SETUP_SSO_MATRIX_COLUMNS?.split(",") ?? ["dev"])
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (requested.size !== 1) throw new Error("Run exactly one matrix column at a time to bound local capacity.");
  if (![...requested].every((id) => ["0.18.54", "0.18.57", "control", "dev", "pending"].includes(id))) throw new Error("Unknown matrix column.");
  if (requested.has("control") && SOURCE_ROOT === REPO_ROOT) throw new Error("Control requires an explicit independent OPENWORK_SETUP_SSO_SOURCE_ROOT.");
  const fingerprint = await setupSsoProductSourceFingerprint();
  const commit = await setupSsoCurrentCommit();
  const columns: SetupSsoMatrixColumn[] = [];
  for (const definition of RELEASE_COLUMNS) {
    if (requested.has(definition.id)) {
      columns.push(await bootColumn(stack, { ...definition, apiVersion: definition.id }, "always", "configured"));
    }
  }
  let pending: SetupSsoPendingColumn | null = null;
  const includesDevImages = requested.has("dev") || requested.has("control") || requested.has("pending");
  let images: { apiImage: string; webImage: string } | null = null;
  if (includesDevImages) {
    if (hostWeb) {
      if (SOURCE_ROOT !== REPO_ROOT) throw new Error("Independent source roots require full compose images.");
      await buildHostWeb(fingerprint);
      images = { apiImage: HOST_API_IMAGE, webImage: HOST_CONTAINER_WEB_IMAGE };
    } else {
      images = await buildDevImages(fingerprint, commit);
    }
  }
  if (images) {
    const definition = { ...images, apiVersion: hostWeb ? HOST_API_VERSION : commit };
    if (requested.has("pending")) {
      pending = await bootColumn(stack, { ...definition, id: "pending" }, hostWeb ? "always" : "never", "pending", hostWeb ? { fingerprint } : undefined);
    } else {
      columns.push(await bootColumn(stack, { ...definition, id: requested.has("control") ? "control" : "dev" }, hostWeb ? "always" : "never", "configured", hostWeb ? { fingerprint } : undefined));
    }
  }
  const dirtyProductFiles = (await command("git", ["-C", SOURCE_ROOT, "status", "--short", "--", ...SOURCE_SCOPES], 60_000))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
  if (requested.has("control") && dirtyProductFiles.length) throw new Error("Control API/Web source tree must be clean.");
  const manifest: SetupSsoMatrixManifest = {
    createdAt: new Date().toISOString(),
    commit,
    source: {
      fingerprint,
      root: SOURCE_ROOT,
      scopes: SOURCE_SCOPES,
      platform: PLATFORM,
      productFiles: SETUP_SSO_PRODUCT_SOURCE_FILES,
      dirtyProductFiles,
      apiImageFingerprint: images && !hostWeb ? await imageFingerprint(images.apiImage) : null,
      webImageFingerprint: images && !hostWeb ? await imageFingerprint(images.webImage) : null,
      webMode: hostWeb ? "host-production" : "image",
      hostWebFingerprint: hostWeb ? fingerprint : null,
      hostWebCommit: hostWeb ? commit : null,
    },
    columns,
    pending,
  };
  await mkdir(join(REPO_ROOT, "tmp"), { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export async function openSetupSsoBrowser(options: { host: NonNullable<Parameters<typeof chrome>[0]>["host"]; name: string }) {
  return chrome({ ...options, startUrl: "about:blank", headless: true });
}

// Stop only at the OS-launch boundary: the real UI request and real grant remain intact.
// This prevents the isolated Chromium lab from opening the operator's desktop app.
export async function captureSetupSsoDesktopHandoff(browser: Awaited<ReturnType<typeof chrome>>): Promise<void> {
  await addInitScript(browser.client, () => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(response.url).pathname.endsWith("/desktop-handoff") && response.ok) {
        window.__setupSsoPrivateCapture = { desktopResponse: await response.clone().text() };
        return new Promise<Response>(() => {});
      }
      return response;
    };
  });
}

export async function exchangeSetupSsoDesktopHandoff(browser: Awaited<ReturnType<typeof chrome>>, webUrl: string) {
  await waitFor(browser, () => Boolean(window.__setupSsoPrivateCapture?.desktopResponse), { timeoutMs: 90_000, label: "real desktop handoff grant" });
  const raw = await evaluate(browser.client, () => {
    const response = window.__setupSsoPrivateCapture?.desktopResponse;
    delete window.__setupSsoPrivateCapture;
    return response;
  });
  const payload: unknown = JSON.parse(raw ?? "null");
  const grant = stringField(payload, "grant");
  const openworkUrl = stringField(payload, "openworkUrl");
  if (!grant || !openworkUrl) throw new Error("Desktop handoff omitted its grant or registered URL.");
  const deepLink = new URL(openworkUrl);
  const parsedGrant = deepLink.searchParams.get("grant");
  const denBaseUrl = deepLink.searchParams.get("denBaseUrl");
  const destinationMatches = deepLink.protocol === "openwork:" && deepLink.hostname === "den-auth" && deepLink.pathname === "";
  const grantMatches = parsedGrant === grant;
  const denBaseUrlMatches = denBaseUrl === `${webUrl}/api/den`;
  if (!destinationMatches || !grantMatches || !denBaseUrlMatches) throw new Error("Desktop deep link has an incorrect destination, grant, or Den base URL (values withheld).");
  const response = await jsonRequest(`${denBaseUrl}/v1/auth/desktop-handoff/exchange`, { method: "POST", body: JSON.stringify({ grant: parsedGrant }) });
  const replay = await jsonRequest(`${denBaseUrl}/v1/auth/desktop-handoff/exchange`, { method: "POST", body: JSON.stringify({ grant: parsedGrant }) });
  return { destinationMatches, grantMatches, denBaseUrlMatches, status: response.response.status, hasToken: Boolean(stringField(response.body, "token")), replayStatus: replay.response.status };
}

export async function readSetupSsoBrowserUrl(browser: Awaited<ReturnType<typeof chrome>>): Promise<string> {
  return evaluate(browser.client, () => location.href);
}

export async function clearSetupSsoFetchFault(browser: Awaited<ReturnType<typeof chrome>>): Promise<void> {
  await evaluate(browser.client, () => sessionStorage.removeItem("setup-sso-fetch-fault"));
}

export async function installSetupSsoFetchFault(browser: Awaited<ReturnType<typeof chrome>>, pathname: string, kind: "network" | "http-500"): Promise<void> {
  await addInitScript(browser.client, browserScript((path, faultKind) => {
    const originalFetch = window.fetch.bind(window);
    sessionStorage.setItem("setup-sso-fetch-fault", "enabled");
    window.fetch = (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, window.location.origin);
      if (sessionStorage.getItem("setup-sso-fetch-fault") === "enabled" && (url.pathname === path || url.pathname === `/api/browser${path}`)) {
        if (faultKind === "network") return Promise.reject(new TypeError("Synthetic network failure"));
        return Promise.resolve(new Response(JSON.stringify({ error: "synthetic_failure" }), { status: 500, headers: { "content-type": "application/json" } }));
      }
      return originalFetch(input, init);
    };
  }, [pathname, kind]));
}

export async function composeSetupSsoStep(browser: Awaited<ReturnType<typeof chrome>>, artifact: { png: Buffer; hash: string; at: string }, input: {
  column: string; step: number; action: string; caption: string; callback?: string;
  observedUrl: string; sourceTestRunDir: string; expectations: string[];
}) {
  const observedUrl = input.observedUrl;
  const runnerHead = (await command("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], 60_000)).trim();
  const lines = [input.caption, `Observed URL (secret values redacted): ${observedUrl}`,
    ...(input.callback ? [`Observed SSO callback (provider state is opaque): ${input.callback}`] : [])];
  const composed = await evaluate(browser.client, browserScript(async (png, textLines) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Evidence annotation canvas is unavailable.");
    context.font = "14px monospace";
    const wrapped: string[] = [];
    for (const text of textLines) {
      let line = "";
      for (const char of text) {
        if (context.measureText(line + char).width > image.width - 40) { wrapped.push(line); line = ""; }
        line += char;
      }
      wrapped.push(line);
    }
    const stripHeight = 58 + wrapped.length * 21;
    canvas.width = image.width;
    canvas.height = image.height + stripHeight;
    context.fillStyle = "#edf2f7";
    context.fillRect(0, 0, canvas.width, stripHeight);
    context.fillStyle = "#172033";
    context.font = "bold 14px monospace";
    context.fillText("Test evidence annotation — not browser chrome", 20, 24);
    context.font = "14px monospace";
    wrapped.forEach((line, index) => context.fillText(line, 20, 49 + index * 21));
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, stripHeight);
    return { png: canvas.toDataURL("image/png").split(",")[1], originalWidth: image.width, originalHeight: image.height, stripHeight };
  }, [artifact.png.toString("base64"), lines]));
  if (!composed.png) throw new Error("Evidence annotation omitted PNG bytes.");
  const relativeRoot = join("tmp", "setup-sso-journeys", input.column, `${artifact.at.replaceAll(":", "-").replaceAll(".", "-")}-step-${input.step}`);
  await mkdir(join(REPO_ROOT, relativeRoot), { recursive: true });
  const original = join(relativeRoot, "original.png");
  const annotated = join(relativeRoot, "annotated.png");
  const metadata = join(relativeRoot, "capture.json");
  await writeFile(join(REPO_ROOT, original), artifact.png, { mode: 0o600 });
  await writeFile(join(REPO_ROOT, annotated), Buffer.from(composed.png, "base64"), { mode: 0o600 });
  await writeFile(join(REPO_ROOT, metadata), JSON.stringify({
    column: input.column, step: input.step, action: input.action, caption: input.caption,
    sourceTestRun: relative(REPO_ROOT, input.sourceTestRunDir), runnerHead, sourceCommit: await setupSsoCurrentCommit(),
    observedUrl, callback: input.callback ?? null, capturedAt: artifact.at, originalHash: artifact.hash, visualExpectations: input.expectations,
    original, annotated, originalWidth: composed.originalWidth, originalHeight: composed.originalHeight,
    annotationHeight: composed.stripHeight, method: "separate canvas companion; original pixels copied 1:1 below labelled annotation; original PNG retained; annotation is not assertion evidence",
  }, null, 2), { mode: 0o600 });
  return { original, annotated, metadata, observedUrl };
}

export function sanitizedSetupSsoUrl(raw: string, depth = 0): string {
  const url = new URL(raw);
  for (const [key, value] of url.searchParams) {
    const sensitive = /token|secret|password|credential|assertion/i.test(key) || ["state", "code", "grant", "nonce", "code_challenge"].includes(key.toLowerCase());
    if (sensitive) url.searchParams.set(key, "<redacted>");
    else if (/^(https?:\/\/|\/)/.test(value) && value.includes("?")) {
      const nested = new URL(value, url.origin);
      url.searchParams.set(key, depth < 4 ? sanitizedSetupSsoUrl(nested.toString(), depth + 1) : "<redacted>");
    }
  }
  if (url.username) url.username = "redacted";
  if (url.password) url.password = "redacted";
  if (url.hash) url.hash = "redacted";
  return url.toString().replaceAll("%3Credacted%3E", "<redacted>");
}

// Retain only sanitized document/navigation metadata. Never retain headers,
// bodies, or authentication secrets; safe route/returnTo values stay inspectable.
export async function observeSetupSsoNavigation(debuggerUrl: string | undefined) {
  if (!debuggerUrl) throw new Error("Navigation observation requires the isolated browser target.");
  const entries: Array<{ kind: string; url: string; status?: number }> = [];
  const ssoCallbacks: Array<{ url: string; origin: string; returnTo: string | null }> = [];
  const socket = new WebSocket(debuggerUrl);
  const safeUrl = sanitizedSetupSsoUrl;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Navigation observer did not attach")), 10_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "Page.enable" }));
        socket.send(JSON.stringify({ id: 2, method: "Network.enable" }));
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Navigation observer disconnected")); });
      socket.addEventListener("message", (event) => {
        const message: unknown = JSON.parse(String(event.data));
        if (!isRecord(message)) return;
        if (message.id === 2) {
          clearTimeout(timer);
          if (message.error) reject(new Error("Navigation observation failed"));
          else resolve();
        }
        const params = message.params;
        if (!isRecord(params)) return;
        const append = (kind: string, raw: unknown, status?: unknown) => {
          if (typeof raw === "string" && entries.length < 100) entries.push({ kind, url: safeUrl(raw), ...(typeof status === "number" ? { status } : {}) });
        };
        if (message.method === "Network.requestWillBeSent" && params.type === "Document") {
          if (isRecord(params.redirectResponse)) append("http-redirect", params.redirectResponse.url, params.redirectResponse.status);
          if (isRecord(params.request)) {
            append("document-request", params.request.url);
            if (typeof params.request.url === "string") {
              const requestUrl = new URL(params.request.url);
              const callback = requestUrl.searchParams.get("callbackURL");
              if (requestUrl.pathname.startsWith("/sso/") && callback) {
                const callbackUrl = new URL(callback, requestUrl.origin);
                const returnTo = callbackUrl.searchParams.get("returnTo");
                ssoCallbacks.push({ url: safeUrl(callbackUrl.toString()), origin: callbackUrl.origin, returnTo: returnTo === "/install" || returnTo === "/setup" ? returnTo : null });
              }
            }
          }
        }
        if (message.method === "Network.responseReceived" && params.type === "Document" && isRecord(params.response)) append("document-response", params.response.url, params.response.status);
        if (message.method === "Page.frameNavigated" && isRecord(params.frame) && params.frame.parentId === undefined) append("navigation", params.frame.url);
        if (message.method === "Page.navigatedWithinDocument") append("client-navigation", params.url);
      });
    });
    return { entries, ssoCallbacks, [Symbol.dispose]: () => socket.close() };
  } catch (error) {
    socket.close();
    throw error;
  }
}

export function setupSsoInstallMatrixManifestPath(): string {
  return MANIFEST_PATH;
}
