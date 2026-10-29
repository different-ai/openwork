import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serializeSignedCookie } from "better-call";
import { installClock } from "./clock.mjs";
import { runCliCase, runAbuseIsolationCase } from "./cases.mjs";

const caseName = process.env.DEVICE_LOGIN_TEST_CASE ?? "delayed";
const virtual = process.env.DEVICE_LOGIN_TEST_CLOCK === "virtual";
const epoch = Math.floor(Date.now() / 1000) * 1000;
const clock = virtual ? installClock(epoch) : null;
const app = new Hono();
const report = {
  type: "device-login-result", case: caseName, clock: virtual ? "virtual" : "real",
  serverVersion: null, approvalAfterSeconds: caseName === "delayed" ? 130 : null,
  polls: 0, cliPolls: 0, elapsedSeconds: 0, cliElapsedSeconds: null,
  lastPollStatus: null, plain429: false, rate429Count: 0, rate429Trace: [],
  pollTrace: [], requestCounts: {}, traceLimit: 256, traceTruncated: false,
  codeTtlSeconds: null, codeIntervalSeconds: null, rateLimitEnabled: false,
  rateLimitStorage: null, databaseCounter: null, databaseCounters: [],
  approved: false, denied: false, cliExit: null, cliError: null,
  sessionValidated: false, credentialsWritten: false, sessionDelta: null,
};
const protocolErrors = new Set(["authorization_pending", "slow_down", "expired_token", "access_denied", "invalid_request", "invalid_grant"]);
const endpointNames = new Set(["/api/auth/device/code", "/api/auth/device/token", "/v1/auth/device/decision", "/v1/me"]);
const codes = new Map();
let stage = "local server setup";
let server;
let client;
let cli;
let directory;
let baseUrl;
let firstIssuedAt;
let cliCode;
let browserA;
let snapshotCounters;
let requestFailure = false;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("The test blocked a non-local HTTP request.");
  return nativeFetch(input, { ...init, redirect: "error" });
};
function elapsed() { return (Date.now() - (firstIssuedAt ?? epoch)) / 1000; }
function boundedPush(list, item) {
  if (list.length < report.traceLimit) list.push(item);
  else report.traceTruncated = true;
}
function secondsHeader(headers, name) {
  const value = headers.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}
async function request(path, { body, session, cookie, ip = "192.0.2.10" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin: baseUrl, "x-forwarded-for": ip,
      ...(session ? { authorization: `Bearer ${session.token}` } : {}), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
}
async function decide(code, browser, decision) {
  return request("/v1/auth/device/decision", {
    body: { userCode: code.user_code, decision }, session: browser.session, ip: browser.ip,
  });
}

try {
  server = serve({ hostname: "127.0.0.1", port: 0, fetch: async (incoming) => {
    try {
      const suppliedTime = incoming.headers.get("x-device-login-test-time");
      if (clock && suppliedTime) clock.set(Number(suppliedTime));
      const pathname = new URL(incoming.url).pathname;
      const endpoint = endpointNames.has(pathname) ? pathname : "other";
      report.requestCounts[endpoint] = (report.requestCounts[endpoint] ?? 0) + 1;
      const source = incoming.headers.get("x-device-login-test-source") === "cli" ? "cli" : "probe";
      let trace;
      if (pathname === "/api/auth/device/token") {
        report.polls += 1;
        if (source === "cli") report.cliPolls += 1;
        report.elapsedSeconds = elapsed();
        const body = await incoming.clone().json();
        trace = { poll: report.polls, source, code: codes.get(body.device_code)?.label ?? "unknown", elapsedSeconds: elapsed() };
        if (source === "cli" && caseName === "delayed" && !report.approved && elapsed() >= 130) {
          const result = await decide(cliCode, browserA, "approve");
          assert.equal(result.status, 200, "The browser approval must be accepted.");
          report.approved = true;
        }
        if (source === "cli" && caseName === "denial" && !report.denied) {
          const result = await decide(cliCode, browserA, "deny");
          assert.equal(result.status, 200, "The browser denial must be accepted.");
          report.denied = true;
        }
      }
      const response = await app.fetch(incoming);
      if (pathname === "/api/auth/device/code" && response.status === 200) {
        const body = await response.clone().json();
        firstIssuedAt ??= Date.now();
        report.codeTtlSeconds ??= body.expires_in;
        report.codeIntervalSeconds ??= body.interval;
        assert.ok(codes.size < 4, "The test must use at most four device codes.");
        const code = { ...body, issuedAt: Date.now(), label: source === "cli" ? "cli" : `device-${codes.size + 1}` };
        codes.set(body.device_code, code);
        if (source === "cli") cliCode = code;
      }
      if (trace) {
        report.lastPollStatus = response.status;
        const body = await response.clone().json().catch(() => null);
        trace.status = response.status;
        trace.error = protocolErrors.has(body?.error) ? body.error : null;
        boundedPush(report.pollTrace, trace);
        if (response.status === 429) {
          report.rate429Count += 1;
          if (body?.error !== "slow_down") report.plain429 = true;
          boundedPush(report.rate429Trace, { ...trace,
            retryAfterSeconds: secondsHeader(response.headers, "retry-after"),
            xRetryAfterSeconds: secondsHeader(response.headers, "x-retry-after") });
        }
      }
      return response;
    } catch {
      requestFailure = true;
      return new Response("Test request failed", { status: 500 });
    }
  } });
  if (!server.listening) await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    BETTER_AUTH_URL: baseUrl, DEN_BASE_URL: baseUrl, DEN_API_PUBLIC_URL: baseUrl,
    DEN_BETTER_AUTH_TRUSTED_ORIGINS: baseUrl, DEN_WEB_APP_HOSTS: "127.0.0.1",
    DEN_TRUSTED_PROXIES: "127.0.0.1/32,::1/128",
  });
  stage = "Den auth imports";
  const { auth } = await import("../../src/auth.ts");
  const { env } = await import("../../src/env.ts");
  report.serverVersion = env.serviceVersion;
  const database = await import("../../src/db.ts");
  client = database.client;
  const { registerAuthRoutes } = await import("../../src/routes/auth/index.ts");
  const { registerMeRoutes } = await import("../../src/routes/me/index.ts");
  const { AuthSessionTable, DeviceCodeTable, RateLimitTable } = await import("@openwork-ee/den-db/schema");
  const { eq } = await import("@openwork-ee/den-db/drizzle");
  const { sessionMiddleware } = await import("../../src/session.ts");
  app.use("*", sessionMiddleware);
  registerAuthRoutes(app);
  registerMeRoutes(app);
  report.rateLimitEnabled = auth.options.rateLimit.enabled;
  report.rateLimitStorage = auth.options.rateLimit.storage;
  assert.equal(report.rateLimitEnabled, true, "Den database rate limiting must be enabled.");
  assert.equal(report.rateLimitStorage, "database", "Den must use database rate counters.");
  snapshotCounters = async () => {
    const counters = await database.db.select({ key: RateLimitTable.key, count: RateLimitTable.count }).from(RateLimitTable);
    const tokenCounters = counters.filter((row) => row.key.includes("/device/token"));
    report.databaseCounters = tokenCounters.map((row) => ({
      client: row.key.includes("192.0.2.10") ? "primary" : row.key.includes("192.0.2.11") ? "secondary" : "probe",
      count: row.count,
    }));
    report.databaseCounter = tokenCounters.find((row) => row.key.includes("192.0.2.10"))?.count ?? null;
    return tokenCounters;
  };
  const sessionRows = () => database.db.select({ userId: AuthSessionTable.userId }).from(AuthSessionTable);
  const readCode = async (code) => {
    const rows = await database.db.select().from(DeviceCodeTable).where(eq(DeviceCodeTable.deviceCode, code.device_code));
    return rows[0] ?? null;
  };
  const validateToken = async (token, expectedUser) => {
    assert.ok(typeof token === "string" && token.length > 0, "The token response must contain a session token.");
    const rows = await database.db.select({ userId: AuthSessionTable.userId, expiresAt: AuthSessionTable.expiresAt })
      .from(AuthSessionTable).where(eq(AuthSessionTable.token, token));
    assert.equal(rows.length, 1, "The token must have one real session row.");
    assert.ok(rows[0].userId === expectedUser.id, "The session must belong to the approving user.");
    assert.ok(rows[0].expiresAt.getTime() > Date.now(), "The session must not have expired.");
    const me = await request("/v1/me", { session: { token }, ip: "192.0.2.30" });
    assert.equal(me.status, 200, "The session must pass the real me route.");
    assert.ok(me.body?.user?.id === expectedUser.id, "The me route must identify the approving user.");
  };

  stage = "synthetic browser session setup";
  const context = await auth.$context;
  const createBrowser = async (label, ip) => {
    const user = await context.internalAdapter.createUser({
      name: `Device Login Regression ${label}`, email: `device-login-${label.toLowerCase()}@example.test`, emailVerified: true,
    });
    const session = await context.internalAdapter.createSession(user.id);
    await validateToken(session.token, user);
    return { user, session, ip };
  };
  browserA = await createBrowser("A", "192.0.2.20");
  const fixture = {
    report, browserA, createBrowser, readCode, validateToken, sessionRows, snapshotCounters, decide,
    getCliCode: () => cliCode,
    // Better Auth's own verify-then-approve/deny flow, called with the browser's signed session cookie.
    async rawDecide(code, browser, decision) {
      const cookie = (await serializeSignedCookie(context.authCookies.sessionToken.name, browser.session.token, context.secret)).split(";")[0];
      const claim = await request(`/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`, { cookie, ip: browser.ip });
      assert.equal(claim.status, 200, "Better Auth's verification endpoint must accept the signed-in browser.");
      return request(`/api/auth/device/${decision}`, { body: { userCode: code.user_code }, cookie, ip: browser.ip });
    },
    advanceTo(seconds) {
      assert.ok(clock, "Direct clock steps require virtual mode.");
      clock.set(epoch + seconds * 1000);
    },
    async issueCode() {
      const result = await request("/api/auth/device/code", { body: { client_id: "openwork-cli" } });
      assert.equal(result.status, 200, "The code endpoint must issue a device code.");
      return codes.get(result.body.device_code);
    },
    poll(code, ip = "192.0.2.10", session) {
      return request("/api/auth/device/token", {
        body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "openwork-cli" }, ip, session,
      });
    },
    async runCli() {
      directory = await mkdtemp(join(tmpdir(), "openwork-device-login-"));
      const credentialsPath = join(directory, "credentials.json");
      cli = spawn(process.execPath, ["--import", fileURLToPath(new URL("cli-preload.mjs", import.meta.url)),
        fileURLToPath(new URL("../../../../../packages/openwork-bootstrap/bin/openwork.mjs", import.meta.url)),
        "login", "--base-url", baseUrl, "--force", "--json"], {
        env: { ...process.env, HOME: directory, OPENWORK_CREDENTIALS_PATH: credentialsPath,
          OPENWORK_API_TOKEN: "", DEVICE_LOGIN_TEST_ORIGIN: baseUrl, DEVICE_LOGIN_TEST_EPOCH: String(epoch) },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let cliNow = epoch;
      cli.on("message", (message) => {
        if (message?.type === "device-login-clock" && Number.isFinite(message.now)) cliNow = message.now;
      });
      // Bound output in memory. Never print it. It contains the device code.
      let cliError = "";
      cli.stdout.resume();
      cli.stderr.on("data", (chunk) => { cliError = (cliError + chunk.toString()).slice(-16_384); });
      const watchdog = setTimeout(() => cli.kill("SIGKILL"), virtual ? 45_000 : 210_000);
      try {
        const [exitCode, signal] = await once(cli, "close");
        report.cliExit = exitCode;
        assert.equal(signal, null, "The CLI must exit without a timeout or signal.");
      } finally { clearTimeout(watchdog); }
      report.cliElapsedSeconds = ((virtual ? cliNow : Date.now()) - (cliCode?.issuedAt ?? epoch)) / 1000;
      report.cliError = ["login_denied", "login_expired", "login_failed", "device_code_failed"].find((value) => cliError.includes(`${value}:`)) ?? null;
      report.credentialsWritten = await stat(credentialsPath).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      return { credentials: report.credentialsWritten ? JSON.parse(await readFile(credentialsPath, "utf8")) : null };
    },
  };
  stage = `${caseName} assertions`;
  if (caseName === "abuse-isolation") await runAbuseIsolationCase(fixture);
  else await runCliCase(fixture, caseName);
  assert.equal(requestFailure, false, "The local HTTP handler must not fail.");
  assert.equal(report.traceTruncated, false, "The test must stay within the trace limit.");
} catch (error) {
  report.failure = error instanceof assert.AssertionError ? error.message : `Setup failed at ${stage}. Error type=${error?.code ?? error?.name ?? "unknown"}.`;
  if (error?.code === "ERR_MODULE_NOT_FOUND") report.missingPackage = error.message.match(/Cannot find package '([^']+)'/)?.[1] ?? null;
  process.exitCode = 1;
} finally {
  // Attempt every cleanup step, even if an earlier step fails.
  const cleanups = [
    async () => { if (cli && cli.exitCode === null && cli.signalCode === null) { cli.kill("SIGKILL"); await once(cli, "close"); } },
    async () => { if (snapshotCounters) await snapshotCounters(); },
    async () => { if (server) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); },
    async () => { if (client?.end) await client.end(); },
    async () => { if (directory) await rm(directory, { recursive: true, force: true }); },
  ];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch {
      report.cleanupFailed = true;
      report.failure ??= "A local cleanup step failed.";
      process.exitCode = 1;
    }
  }
  clock?.restore();
  if (process.connected) {
    await new Promise((resolve) => process.send(report, resolve));
    process.disconnect();
  }
}
