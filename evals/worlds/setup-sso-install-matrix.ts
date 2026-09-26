import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePorts, navigate } from "@openwork/cdp";
import { clickText, waitFor } from "@openwork/behaviors";
import { resolvePlace } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { startMockIdpLab } from "@openwork/labs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMPOSE_FILE = join(REPO_ROOT, "packaging", "docker", "docker-compose.eval.yml");
const MANIFEST_PATH = join(REPO_ROOT, "tmp", "setup-sso-install-matrix.json");
const DEV_API_IMAGE = "openwork-den-api:setup-sso-dev-a51297520";
const DEV_WEB_IMAGE = "openwork-den-web:setup-sso-dev-a51297520";
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
    id: "0.18.43",
    apiImage: "ghcr.io/different-ai/openwork-den-api:0.18.43@sha256:5efc691668ac750238a244afd529f5baa9abf8ede13242238d947802c4387146",
    webImage: "ghcr.io/different-ai/openwork-den-web:0.18.43@sha256:fc4676f5be201500beb3ef262e702a864a847338428d3efbe045b922dc4d41c2",
  },
  {
    id: "0.18.48",
    apiImage: "ghcr.io/different-ai/openwork-den-api:0.18.48@sha256:8f2977788063c47d06f3cd2b2c60b43da5137d42c807b577e2f30ad968e86204",
    webImage: "ghcr.io/different-ai/openwork-den-web:0.18.48@sha256:fe856630e05b1ff96accfb2a8a108b416a1fdc1a842ea0af492b3a8472f594a5",
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
  const hash = createHash("sha256");
  for (const file of SETUP_SSO_PRODUCT_SOURCE_FILES) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(REPO_ROOT, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function setupSsoCurrentCommit(): Promise<string> {
  return (await command("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], 60_000)).trim();
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

async function buildDevImages(fingerprint: string): Promise<void> {
  const label = `${SOURCE_FINGERPRINT_LABEL}=${fingerprint}`;
  await command("docker", ["buildx", "build", "--load", "--label", label, "-f", "packaging/docker/Dockerfile.den", "-t", DEV_API_IMAGE, "."]);
  await command("docker", ["buildx", "build", "--load", "--label", label, "-f", "packaging/docker/Dockerfile.den-web", "-t", DEV_WEB_IMAGE, "."]);
  const fingerprints = await Promise.all([imageFingerprint(DEV_API_IMAGE), imageFingerprint(DEV_WEB_IMAGE)]);
  if (fingerprints.some((value) => value !== fingerprint)) {
    throw new Error("Built development images do not match the tested product-source fingerprint.");
  }
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
  const browserResult = await configurationBrowser.client.send("Runtime.evaluate", {
    expression: `({ href: location.href, body: document.body?.innerText ?? "" })`,
    returnByValue: true,
  });
  const browserValue = recordField(recordField(browserResult, "result"), "value");
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
  const installLink = await jsonRequest(`${input.apiUrl}/v1/orgs/${encodeURIComponent(organizationId)}/install-links`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ rotate: true }),
  });
  requireOk(installLink, "install link creation");
  const installPageUrl = stringField(installLink.body, "installPageUrl");
  if (!installPageUrl) throw new Error("Install link creation omitted installPageUrl.");
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
  const ports = await allocateFreePorts(3);
  const webPort = ports[0];
  const apiPort = ports[1];
  const idpPort = ports[2];
  if (webPort === undefined || apiPort === undefined || idpPort === undefined) throw new Error("Could not allocate matrix ports.");
  const suffix = randomBytes(4).toString("hex");
  const safeId = definition.id.replaceAll(".", "-");
  const project = `setup-sso-${safeId}-${suffix}`;
  const ownerEmail = `owner-${safeId}-${suffix}@synthetic-sso.test`;
  const ownerPassword = `S-${randomBytes(12).toString("hex")}!`;
  const bootstrapCode = `bootstrap-${randomBytes(18).toString("hex")}`;
  const domain = `idp-${safeId}-${suffix}.test`;
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
  const organizationName = `Synthetic enterprise ${definition.id}`;
  await writeFile(overridePath, [
    "services:",
    "  den-migrate:",
    `    image: "${definition.apiImage}"`,
    `    pull_policy: ${pullPolicy}`,
    "  den:",
    `    image: "${definition.apiImage}"`,
    `    pull_policy: ${pullPolicy}`,
    "    environment:",
    `      CORS_ORIGINS: "${trustedOrigins}"`,
    `      DEN_BETTER_AUTH_TRUSTED_ORIGINS: "${trustedOrigins}"`,
    "  web:",
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
    const composeLogs = await compose([...composeArgs, "logs", "--no-color", "--tail", "120", "den", "web"], composeEnv)
      .catch((error: unknown) => `logs unavailable: ${messageText(error)}`);
    return `${composeLogs}\n${hostWebLogs()}`;
  };
  try {
    await compose([...composeArgs, "up", "-d", "--wait", "--wait-timeout", "300"], composeEnv);
    await waitForHttp(`${apiUrl}/health`, `${definition.id} Den API`, logs);
    if (hostWeb) {
      hostWebLogs = startHostWeb(stack, { webPort, webUrl, apiUrl, organizationName });
    }
    await waitForHttp(`${webUrl}/api/ready`, `${definition.id} Den web`, logs);
  } catch (error) {
    await writeFile(join(root, "startup-failure.log"), await logs(), { mode: 0o600 });
    await compose([...composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], composeEnv).catch(() => undefined);
    throw error;
  }
  stack.adopt({ composeArgs, composeEnv }, async (owned) => {
    await compose([...owned.composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], owned.composeEnv)
      .catch((error: unknown) => console.error(`[setup-sso-matrix] cleanup failed for ${project}: ${messageText(error)}`));
  });
  if (setup === "pending") {
    return {
      id: "pending",
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
    (options.columns ?? process.env.OPENWORK_SETUP_SSO_MATRIX_COLUMNS?.split(",") ?? ["0.18.43", "0.18.48", "dev", "pending"])
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const fingerprint = await setupSsoProductSourceFingerprint();
  const columns: SetupSsoMatrixColumn[] = [];
  for (const definition of RELEASE_COLUMNS) {
    if (requested.has(definition.id)) {
      columns.push(await bootColumn(stack, { ...definition, apiVersion: definition.id }, "always", "configured"));
    }
  }
  let pending: SetupSsoPendingColumn | null = null;
  if ((requested.has("dev") || requested.has("pending")) && hostWeb) {
    await buildHostWeb(fingerprint);
  } else if (requested.has("dev") || requested.has("pending")) {
    await buildDevImages(fingerprint);
  }
  if (requested.has("dev")) {
    columns.push(await bootColumn(
      stack,
      hostWeb
        ? { id: "dev", apiVersion: HOST_API_VERSION, apiImage: HOST_API_IMAGE, webImage: HOST_CONTAINER_WEB_IMAGE }
        : { id: "dev", apiVersion: "a51297520", apiImage: DEV_API_IMAGE, webImage: DEV_WEB_IMAGE },
      hostWeb ? "always" : "never",
      "configured",
      hostWeb ? { fingerprint } : undefined,
    ));
  }
  if (requested.has("pending")) {
    pending = await bootColumn(
      stack,
      hostWeb
        ? { id: "pending", apiVersion: HOST_API_VERSION, apiImage: HOST_API_IMAGE, webImage: HOST_CONTAINER_WEB_IMAGE }
        : { id: "pending", apiVersion: "a51297520", apiImage: DEV_API_IMAGE, webImage: DEV_WEB_IMAGE },
      hostWeb ? "always" : "never",
      "pending",
      hostWeb ? { fingerprint } : undefined,
    );
  }
  const commit = (await command("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], 60_000)).trim();
  const dirtyProductFiles = (await command("git", ["-C", REPO_ROOT, "status", "--short", "--", ...SETUP_SSO_PRODUCT_SOURCE_FILES], 60_000))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
  const includesDevImages = requested.has("dev") || requested.has("pending");
  const manifest: SetupSsoMatrixManifest = {
    createdAt: new Date().toISOString(),
    commit,
    source: {
      fingerprint,
      productFiles: SETUP_SSO_PRODUCT_SOURCE_FILES,
      dirtyProductFiles,
      apiImageFingerprint: includesDevImages && !hostWeb ? await imageFingerprint(DEV_API_IMAGE) : null,
      webImageFingerprint: includesDevImages && !hostWeb ? await imageFingerprint(DEV_WEB_IMAGE) : null,
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

export function setupSsoInstallMatrixManifestPath(): string {
  return MANIFEST_PATH;
}
