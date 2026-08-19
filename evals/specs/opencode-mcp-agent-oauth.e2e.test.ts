import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { denFetch, signIn } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { needs, server, SkipError, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

// Proves the docs' "Verified" claim for OpenCode: the real `opencode` CLI
// completes the full public OAuth path against the Den MCP gateway — RFC9728
// discovery, dynamic client registration, PKCE authorize + consent, loopback
// callback, token exchange, credential storage, transparent refresh with
// rotation, and logout — and the minted token works on the /mcp/agent surface.
const MCP_NAME = "openwork";
const ORGANIZATION_NAME = "OAuth Lab";
const EXPECTED_TOOLS = ["execute_capability", "search_capabilities"] as const;
const OPENCODE_BIN = process.env.OPENWORK_EVAL_OPENCODE_BIN?.trim() || "opencode";
const COMMAND_TIMEOUT_MS = 60_000;
const AUTHORIZE_URL_TIMEOUT_MS = 90_000;
const AUTH_EXIT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Launcher names opencode may shell out to for opening the authorize URL.
const BROWSER_LAUNCHERS = ["open", "xdg-open", "sensible-browser", "x-www-browser", "www-browser"];
const POISONED_ACCESS_TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJleHAiOjF9.invalid";

const placementCommand = process.env.OPENWORK_EVAL_DAYTONA?.trim() === "1" ? "daytona" : "docker";
const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
  commands: [placementCommand, OPENCODE_BIN],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `opencode OAuth connection to the Den MCP agent skipped — needs: ${missingRequirements.join(", ")}`
  : "opencode connects to the Den MCP agent through the full OAuth flow and survives token rotation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

function containsTokenMaterial(value: string): boolean {
  return value.includes("ow_mcp_at_") || value.includes("ow_mcp_rt_");
}

interface CommandResult {
  label: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

interface OpencodeHome {
  root: string;
  env: NodeJS.ProcessEnv;
  authFilePath: string;
  capturedUrlsPath: string;
}

function childEnvironment(home: { root: string; binDir: string; browserShim: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The spec may itself run under an opencode session; parent OPENCODE_*
    // variables must not redirect the child CLI away from the isolated home.
    if (key.startsWith("OPENCODE")) continue;
    // The CLI under test needs no credentials beyond its own OAuth flow;
    // runner and CI secrets stay out of its process environment.
    if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)) continue;
    env[key] = value;
  }
  env.HOME = path.join(home.root, "home");
  env.XDG_CONFIG_HOME = path.join(home.root, "xdg-config");
  env.XDG_DATA_HOME = path.join(home.root, "xdg-data");
  env.XDG_CACHE_HOME = path.join(home.root, "xdg-cache");
  env.PATH = [home.binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  env.BROWSER = home.browserShim;
  env.NO_COLOR = "1";
  return env;
}

async function prepareOpencodeHome(mcpUrl: string): Promise<OpencodeHome> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwork-opencode-oauth-"));
  const binDir = path.join(root, "bin");
  const configDir = path.join(root, "xdg-config", "opencode");
  const dataDir = path.join(root, "xdg-data", "opencode");
  const capturedUrlsPath = path.join(root, "captured-urls.txt");
  await mkdir(binDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(root, "xdg-cache", "opencode"), { recursive: true });
  await mkdir(path.join(root, "home"), { recursive: true });
  await writeFile(capturedUrlsPath, "", "utf8");

  // Browser launchers are intercepted so no real browser opens and the
  // authorize URL becomes observable even if stdout formatting changes.
  const shim = `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(capturedUrlsPath)}\nexit 0\n`;
  for (const launcher of BROWSER_LAUNCHERS) {
    const shimPath = path.join(binDir, launcher);
    await writeFile(shimPath, shim, "utf8");
    await chmod(shimPath, 0o755);
  }
  const browserShim = path.join(binDir, BROWSER_LAUNCHERS[0]);

  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      [MCP_NAME]: {
        type: "remote",
        url: mcpUrl,
        enabled: true,
        oauth: {},
      },
    },
  };
  await writeFile(path.join(configDir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    root,
    env: childEnvironment({ root, binDir, browserShim }),
    authFilePath: path.join(dataDir, "mcp-auth.json"),
    capturedUrlsPath,
  };
}

function runOpencode(home: OpencodeHome, args: string[], label: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(OPENCODE_BIN, args, {
      cwd: home.root,
      env: home.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      const out = stripAnsi(Buffer.concat(stdout).toString("utf8"));
      const err = stripAnsi(Buffer.concat(stderr).toString("utf8"));
      resolve({ label, exitCode, stdout: out, stderr: err, combined: `${out}\n${err}` });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

interface AuthProcess {
  exited: Promise<CommandResult>;
  liveOutput(): string;
  kill(): void;
}

function startAuthProcess(home: OpencodeHome): AuthProcess {
  const child: ChildProcess = spawn(OPENCODE_BIN, ["mcp", "auth", MCP_NAME], {
    cwd: home.root,
    env: home.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<CommandResult>((resolve) => {
    const finish = (exitCode: number | null) => {
      const out = stripAnsi(Buffer.concat(stdout).toString("utf8"));
      const err = stripAnsi(Buffer.concat(stderr).toString("utf8"));
      resolve({ label: "opencode mcp auth", exitCode, stdout: out, stderr: err, combined: `${out}\n${err}` });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
  return {
    exited,
    liveOutput: () => stripAnsi(`${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`),
    kill: () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    },
  };
}

function authorizeUrlFrom(text: string): string {
  for (const raw of text.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    let candidate = raw;
    while (/[),.;\]]$/.test(candidate)) candidate = candidate.slice(0, -1);
    try {
      const url = new URL(candidate);
      if (url.pathname.includes("/oauth2/authorize")) return url.toString();
    } catch {
      // Ignore fragments that only look like URLs.
    }
  }
  return "";
}

async function waitForAuthorizeUrl(home: OpencodeHome, auth: AuthProcess): Promise<string> {
  const deadline = Date.now() + AUTHORIZE_URL_TIMEOUT_MS;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const captured = await readFile(home.capturedUrlsPath, "utf8").catch(() => "");
    const fromShim = authorizeUrlFrom(captured);
    if (fromShim) return fromShim;
    lastOutput = auth.liveOutput();
    const fromStdout = authorizeUrlFrom(lastOutput);
    if (fromStdout) return fromStdout;
    await delay(250);
  }
  throw new Error(`opencode mcp auth never surfaced an authorize URL. Output so far:\n${lastOutput.slice(0, 2_000)}`);
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

interface ApprovalOutcome {
  consentPageUrl: string;
  callbackUrl: URL;
  callbackStatus: number;
}

// Replays exactly what the Den consent page (app/mcp/select-organization)
// does in a real browser: session sign-in, authorize redirect, set-active
// organization, consent accept, then the front-channel hop to opencode's
// loopback callback server.
async function approveAuthorization(
  authorizeUrl: URL,
  member: DenSession,
  organization: { id: string; slug: string | null },
): Promise<ApprovalOutcome> {
  const origin = authorizeUrl.origin;
  const jar = new CookieJar();
  const signInResponse = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: member.email, password: member.password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!signInResponse.ok) {
    throw new Error(`OAuth browser sign-in failed: HTTP ${signInResponse.status} ${(await signInResponse.text()).slice(0, 500)}`);
  }
  jar.absorb(signInResponse);

  const authorizeResponse = await fetch(authorizeUrl, {
    redirect: "manual",
    headers: { cookie: jar.header() },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  jar.absorb(authorizeResponse);
  const consentLocation = authorizeResponse.headers.get("location") ?? "";
  if (authorizeResponse.status < 300 || authorizeResponse.status >= 400 || !consentLocation) {
    throw new Error(`Authorize did not redirect to consent: HTTP ${authorizeResponse.status} ${(await authorizeResponse.text()).slice(0, 500)}`);
  }
  const consentPage = new URL(consentLocation, origin);
  if (!consentPage.pathname.includes("/mcp/select-organization")) {
    throw new Error(`Authorize redirected somewhere other than organization consent: ${consentPage.toString()}`);
  }
  const oauthQuery = consentPage.search.replace(/^\?/, "");
  const requestedScope = consentPage.searchParams.get("scope") ?? "openid profile email mcp:read";

  const setActiveResponse = await fetch(`${origin}/api/auth/organization/set-active`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: jar.header() },
    body: JSON.stringify({ organizationId: organization.id, organizationSlug: organization.slug }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!setActiveResponse.ok) {
    throw new Error(`Selecting the organization during consent failed: HTTP ${setActiveResponse.status} ${(await setActiveResponse.text()).slice(0, 500)}`);
  }
  jar.absorb(setActiveResponse);

  const consentResponse = await fetch(`${origin}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: jar.header() },
    body: JSON.stringify({ accept: true, scope: requestedScope, oauth_query: oauthQuery }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const consentText = await consentResponse.text();
  let consentPayload: unknown = null;
  try {
    consentPayload = consentText.trim() ? JSON.parse(consentText) : null;
  } catch {
    consentPayload = consentText;
  }
  const callbackTarget = isRecord(consentPayload) && typeof consentPayload.url === "string" ? consentPayload.url : "";
  if (!consentResponse.ok || !callbackTarget) {
    throw new Error(`OAuth consent accept failed: HTTP ${consentResponse.status} ${consentText.slice(0, 500)}`);
  }
  const callbackUrl = new URL(callbackTarget);
  const callbackResponse = await fetch(callbackUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await callbackResponse.text();
  return { consentPageUrl: consentPage.toString(), callbackUrl, callbackStatus: callbackResponse.status };
}

interface StoredCredential {
  raw: string;
  parsed: unknown;
  accessToken: string;
  refreshToken: string;
}

function firstStringDeep(value: unknown, matches: (key: string) => boolean, depth = 0): string {
  if (!isRecord(value) || depth > 8) return "";
  for (const [key, entry] of Object.entries(value)) {
    if (matches(key.toLowerCase()) && typeof entry === "string" && entry.length > 0) return entry;
  }
  for (const entry of Object.values(value)) {
    const found = firstStringDeep(entry, matches, depth + 1);
    if (found) return found;
  }
  return "";
}

function overwriteFirstDeep(value: unknown, matches: (key: string) => boolean, next: string | number, depth = 0): boolean {
  if (!isRecord(value) || depth > 8) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (matches(key.toLowerCase()) && (typeof entry === "string" || typeof entry === "number")) {
      value[key] = typeof entry === "number" && typeof next === "string" ? Date.now() - 60_000 : next;
      return true;
    }
  }
  for (const entry of Object.values(value)) {
    if (overwriteFirstDeep(entry, matches, next, depth + 1)) return true;
  }
  return false;
}

async function readStoredCredential(home: OpencodeHome): Promise<StoredCredential> {
  const raw = await readFile(home.authFilePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return {
    raw,
    parsed,
    accessToken: firstStringDeep(parsed, (key) => key === "accesstoken" || key === "access_token" || key === "access"),
    refreshToken: firstStringDeep(parsed, (key) => key === "refreshtoken" || key === "refresh_token" || key === "refresh"),
  };
}

async function poisonStoredCredential(home: OpencodeHome, credential: StoredCredential): Promise<{ expiryPoisoned: boolean; accessPoisoned: boolean }> {
  const expiryPoisoned = overwriteFirstDeep(
    credential.parsed,
    (key) => key === "expiresat" || key === "expires_at" || key === "expiry" || key === "expires",
    Date.now() - 60_000,
  );
  const accessPoisoned = overwriteFirstDeep(
    credential.parsed,
    (key) => key === "accesstoken" || key === "access_token" || key === "access",
    POISONED_ACCESS_TOKEN,
  );
  await writeFile(home.authFilePath, `${JSON.stringify(credential.parsed, null, 2)}\n`, "utf8");
  return { expiryPoisoned, accessPoisoned };
}

let requestId = 0;

async function mcpRequest(mcpUrl: string, token: string, method: string, params: unknown): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  if (!response.ok) return { status: response.status, payload: raw };
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`MCP ${method} returned no SSE data frame: ${raw.slice(0, 500)}`);
  const payload: unknown = JSON.parse(dataLine.slice(5));
  if (isRecord(payload) && payload.error) throw new Error(`MCP ${method} returned JSON-RPC error: ${JSON.stringify(payload.error)}`);
  return { status: response.status, payload: isRecord(payload) ? payload.result : payload };
}

async function listToolNames(mcpUrl: string, token: string): Promise<string[]> {
  const { payload } = await mcpRequest(mcpUrl, token, "tools/list", {});
  const tools = isRecord(payload) && Array.isArray(payload.tools) ? payload.tools.filter(isRecord) : [];
  return tools.flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : [])).sort();
}

function toolJson(result: unknown): unknown {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content[0] : null;
  if (!isRecord(content) || typeof content.text !== "string") {
    throw new Error(`MCP tool result had no text content: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return JSON.parse(content.text);
}

async function callAgentTool(mcpUrl: string, token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { payload } = await mcpRequest(mcpUrl, token, "tools/call", { name, arguments: args });
  return payload;
}

async function activeOrganization(admin: DenSession): Promise<{ id: string; slug: string | null }> {
  const result = await denFetch(admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${admin.token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((entry) => entry.name === ORGANIZATION_NAME);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  const slug = organization && typeof organization.slug === "string" ? organization.slug : null;
  return { id, slug };
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 30 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("The opencode OAuth proof requires a cold managed Den");
  }

  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "OAuth Admin" },
      members: {},
    },
  });
  const mcpUrl = `${den.ref.apiUrl.replace(/\/+$/, "")}/mcp/agent`;
  const organization = await activeOrganization(den.admin);

  // Claim 1 — anonymous requests are rejected, the challenge advertises
  // discoverable OAuth metadata naming a real authorization server, and the
  // advertised resource identity matches the URL clients actually connect to.
  // opencode validates that match per RFC 9728 and refuses drifted hosts, so
  // an identity mismatch here breaks every strict OAuth client.
  const anonymous = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eval", version: "0" } } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await anonymous.text();
  const challenge = anonymous.headers.get("www-authenticate") ?? "";
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
  let issuer = "";
  let advertisedResource = "";
  if (metadataUrl) {
    const metadataResponse = await fetch(metadataUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const metadata: unknown = metadataResponse.ok ? await metadataResponse.json() : null;
    const servers = isRecord(metadata) && Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers : [];
    issuer = typeof servers[0] === "string" ? servers[0] : "";
    advertisedResource = isRecord(metadata) && typeof metadata.resource === "string" ? metadata.resource : "";
  }
  const challengeSound = anonymous.status === 401
    && metadataUrl.length > 0
    && issuer.length > 0
    && advertisedResource === mcpUrl;
  evidence.recordAssertionEvidence(
    "The MCP agent endpoint rejects anonymous clients with a discoverable OAuth challenge whose resource identity matches the connect URL",
    `POST initialize without a bearer returned HTTP ${anonymous.status}; resource metadata ${metadataUrl || "(missing)"} advertised issuer ${issuer || "(missing)"} and resource ${advertisedResource || "(missing)"} for connect URL ${mcpUrl}.`,
    challengeSound,
  );
  expect(anonymous.status).toBe(401);
  expect(metadataUrl.length).toBeGreaterThan(0);
  expect(issuer.length).toBeGreaterThan(0);
  expect(advertisedResource, "The advertised MCP resource identity must match the URL clients connect to (RFC 9728); strict OAuth clients like opencode refuse drifted hosts.").toBe(mcpUrl);

  const home = await prepareOpencodeHome(mcpUrl);
  await using homeCleanup = {
    async [Symbol.asyncDispose]() {
      await rm(home.root, { recursive: true, force: true }).catch(() => undefined);
    },
  };

  // Claim 2 — the real opencode binary drives a spec-compliant PKCE
  // authorization and completes once the member approves consent.
  const authProcess = startAuthProcess(home);
  await using authProcessCleanup = {
    async [Symbol.asyncDispose]() {
      authProcess.kill();
    },
  };
  const authorizeUrl = new URL(await waitForAuthorizeUrl(home, authProcess));
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri") ?? "";
  const oauthState = authorizeUrl.searchParams.get("state") ?? "";
  const authorizeShape = authorizeUrl.searchParams.get("response_type") === "code"
    && (authorizeUrl.searchParams.get("client_id") ?? "").length > 0
    && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(redirectUri)
    && oauthState.length > 10
    && (authorizeUrl.searchParams.get("code_challenge") ?? "").length > 20
    && authorizeUrl.searchParams.get("code_challenge_method") === "S256"
    && authorizeUrl.searchParams.get("resource") === mcpUrl;
  expect(authorizeShape, `Authorize URL was not a compliant PKCE request: ${authorizeUrl.toString()}`).toBe(true);

  const approval = await approveAuthorization(authorizeUrl, den.admin, organization);
  const callbackParams = approval.callbackUrl.searchParams;
  const frontChannelClean = (callbackParams.get("code") ?? "").length > 0
    && callbackParams.get("state") === oauthState
    && !callbackParams.has("access_token")
    && !callbackParams.has("refresh_token")
    && !callbackParams.has("id_token");
  const authResult = await Promise.race([
    authProcess.exited,
    delay(AUTH_EXIT_TIMEOUT_MS).then(() => null),
  ]);
  if (!authResult) {
    authProcess.kill();
    throw new Error(`opencode mcp auth did not exit after the loopback callback. Output:\n${authProcess.liveOutput().slice(0, 2_000)}`);
  }
  const authClean = authResult.exitCode === 0 && !containsTokenMaterial(authResult.combined);
  evidence.recordAssertionEvidence(
    "opencode completed the full OAuth PKCE flow after real consent approval",
    `Authorize URL used S256 + loopback ${redirectUri} pinned to ${mcpUrl}; consent hop ${approval.consentPageUrl} redirected to ${approval.callbackUrl.origin}${approval.callbackUrl.pathname} (HTTP ${approval.callbackStatus}) carrying only code+state; opencode exited ${String(authResult.exitCode)} without leaking token material.`,
    authorizeShape && frontChannelClean && authClean,
  );
  expect(frontChannelClean, `Front channel leaked token material or broke state: ${approval.callbackUrl.toString()}`).toBe(true);
  expect(authResult.exitCode, `opencode mcp auth failed:\n${authResult.combined.slice(0, 2_000)}`).toBe(0);
  expect(containsTokenMaterial(authResult.combined)).toBe(false);

  // Claim 3 — opencode persisted rotating OAuth credentials and reports the
  // connection as authenticated.
  const credential = await readStoredCredential(home);
  const storedShape = credential.accessToken.split(".").length === 3
    && credential.refreshToken.startsWith("ow_mcp_rt_");
  const authList = await runOpencode(home, ["mcp", "auth", "list"], "opencode mcp auth list");
  const mcpList = await runOpencode(home, ["mcp", "list"], "opencode mcp list");
  const authListSound = authList.exitCode === 0
    && /\bopenwork\b/i.test(authList.combined)
    && /authenticated/i.test(authList.combined)
    && !/not authenticated|expired/i.test(authList.combined)
    && !containsTokenMaterial(authList.combined);
  const mcpListSound = mcpList.exitCode === 0
    && /\bopenwork\b/i.test(mcpList.combined)
    && /connected/i.test(mcpList.combined)
    && !/failed|needs authentication/i.test(mcpList.combined)
    && !containsTokenMaterial(mcpList.combined);
  evidence.recordAssertionEvidence(
    "opencode stored a JWT access token with a rotating refresh token and reports the server authenticated and connected",
    `mcp-auth.json held a ${credential.accessToken.split(".").length}-part access token and an ${credential.refreshToken.slice(0, 10)}… refresh token; auth list said: ${authList.combined.trim().slice(0, 300)}; mcp list said: ${mcpList.combined.trim().slice(0, 300)}.`,
    storedShape && authListSound && mcpListSound,
  );
  expect(storedShape, `Stored credential shape was wrong: ${credential.raw.slice(0, 300)}`).toBe(true);
  expect(authListSound, `opencode mcp auth list did not report authenticated:\n${authList.combined.slice(0, 1_000)}`).toBe(true);
  expect(mcpListSound, `opencode mcp list did not report connected:\n${mcpList.combined.slice(0, 1_000)}`).toBe(true);

  // Claim 4 — the opencode-minted OAuth token works on the MCP surface:
  // exactly the two agent tools, and a real capability executes.
  const toolNames = await listToolNames(mcpUrl, credential.accessToken);
  const skillSearch = await callAgentTool(mcpUrl, credential.accessToken, "search_capabilities", {
    query: "create skill",
    limit: 20,
    type: "skills",
  });
  const searchPayload = toolJson(skillSearch);
  const matches = isRecord(searchPayload) && Array.isArray(searchPayload.matches) ? searchPayload.matches.filter(isRecord) : [];
  const createSkillMatch = matches.find((entry) => typeof entry.name === "string" && entry.name.includes("create-skill"));
  const createSkillName = createSkillMatch && typeof createSkillMatch.name === "string" ? createSkillMatch.name : "";
  expect(createSkillName, `search_capabilities never surfaced the builtin create-skill: ${JSON.stringify(searchPayload).slice(0, 500)}`).not.toBe("");
  const execution = toolJson(await callAgentTool(mcpUrl, credential.accessToken, "execute_capability", { name: createSkillName }));
  const executionSound = isRecord(execution)
    && execution.kind === "skill"
    && typeof execution.content === "string"
    && execution.content.includes("name: create-skill");
  evidence.recordAssertionEvidence(
    "The OAuth token opencode obtained drives the real capability surface",
    `tools/list returned ${JSON.stringify(toolNames)}; search_capabilities matched ${createSkillName}; execute_capability returned its SKILL.md (kind=${isRecord(execution) ? String(execution.kind) : "?"}).`,
    JSON.stringify(toolNames) === JSON.stringify([...EXPECTED_TOOLS]) && executionSound,
  );
  expect(toolNames).toEqual([...EXPECTED_TOOLS]);
  expect(executionSound, `execute_capability did not return the builtin skill: ${JSON.stringify(execution).slice(0, 500)}`).toBe(true);

  // Claim 5 — a stale local credential is refreshed transparently with
  // rotation, while the stale token itself stays rejected.
  const poisoned = await poisonStoredCredential(home, credential);
  expect(poisoned.expiryPoisoned && poisoned.accessPoisoned, `mcp-auth.json no longer exposes expiry/access fields: ${credential.raw.slice(0, 300)}`).toBe(true);
  const staleRejected = await mcpRequest(mcpUrl, POISONED_ACCESS_TOKEN, "tools/list", {});
  const mcpListAfterExpiry = await runOpencode(home, ["mcp", "list"], "opencode mcp list after forced expiry");
  const refreshed = await readStoredCredential(home);
  const rotationSound = refreshed.accessToken.split(".").length === 3
    && refreshed.accessToken !== credential.accessToken
    && refreshed.accessToken !== POISONED_ACCESS_TOKEN
    && refreshed.refreshToken.startsWith("ow_mcp_rt_")
    && refreshed.refreshToken !== credential.refreshToken;
  const refreshedToolNames = await listToolNames(mcpUrl, refreshed.accessToken);
  const refreshSound = mcpListAfterExpiry.exitCode === 0
    && /connected/i.test(mcpListAfterExpiry.combined)
    && rotationSound
    && staleRejected.status === 401
    && JSON.stringify(refreshedToolNames) === JSON.stringify([...EXPECTED_TOOLS]);
  evidence.recordAssertionEvidence(
    "opencode transparently refreshes an expired credential with refresh-token rotation while the stale token stays rejected",
    `After poisoning the stored credential, opencode mcp list exited ${String(mcpListAfterExpiry.exitCode)} and reported connected; the stale bearer got HTTP ${staleRejected.status}; the store rotated to a new access token (changed: ${String(refreshed.accessToken !== credential.accessToken)}) and new refresh token (changed: ${String(refreshed.refreshToken !== credential.refreshToken)}); tools/list with the refreshed token returned ${JSON.stringify(refreshedToolNames)}.`,
    refreshSound,
  );
  expect(staleRejected.status).toBe(401);
  expect(mcpListAfterExpiry.exitCode, `opencode mcp list failed after forced expiry:\n${mcpListAfterExpiry.combined.slice(0, 1_000)}`).toBe(0);
  expect(rotationSound, `Refresh did not rotate credentials: before=${credential.refreshToken.slice(0, 14)}… after=${refreshed.refreshToken.slice(0, 14)}…`).toBe(true);
  expect(refreshedToolNames).toEqual([...EXPECTED_TOOLS]);

  // Claim 6 — logout removes the stored credential and opencode stops
  // reporting the server as authenticated.
  const logout = await runOpencode(home, ["mcp", "logout", MCP_NAME], "opencode mcp logout");
  const authListAfterLogout = await runOpencode(home, ["mcp", "auth", "list"], "opencode mcp auth list after logout");
  const storedAfterLogout = await readFile(home.authFilePath, "utf8").catch(() => "");
  const logoutSound = logout.exitCode === 0
    && authListAfterLogout.exitCode === 0
    && !/\bopenwork\b.*\bauthenticated\b|✓ openwork/i.test(authListAfterLogout.combined.replace(/not authenticated/gi, ""))
    && !storedAfterLogout.includes("ow_mcp_rt_");
  evidence.recordAssertionEvidence(
    "Logout removes the stored OAuth credential and the server is no longer authenticated",
    `opencode mcp logout exited ${String(logout.exitCode)}; auth list then said: ${authListAfterLogout.combined.trim().slice(0, 300)}; the credential store no longer contains a refresh token.`,
    logoutSound,
  );
  expect(logout.exitCode, `opencode mcp logout failed:\n${logout.combined.slice(0, 1_000)}`).toBe(0);
  expect(storedAfterLogout.includes("ow_mcp_rt_")).toBe(false);
  expect(logoutSound, `Auth list still reports authenticated after logout:\n${authListAfterLogout.combined.slice(0, 1_000)}`).toBe(true);
});
