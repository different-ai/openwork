import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIVATE_VALUE_FILLS_ROUTE, type PrivateValueFillReport } from "@openwork/types/den/private-value-fills";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

const ROUTE = "/managed-policy/private-values/record";
const REPORT: PrivateValueFillReport = {
  id: "fixture-fill-id",
  at: "2026-01-01T00:00:00.000Z",
  site: "https://app.example",
  field: "password",
  source: "command",
  program: "bw",
  result: "filled",
};
const requests: unknown[] = [];
const statuses: number[] = [];
const cleanup: (() => unknown)[] = [];
let temp = "";
let base = "";
let denUrl = "";
let config: ServerConfig;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "private-value-fill-report-"));
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/me/desktop-config") return Response.json({});
    if (path !== PRIVATE_VALUE_FILLS_ROUTE) return new Response(null, { status: 404 });
    const status = statuses.shift() ?? 200;
    const body: unknown = await request.json();
    requests.push({
      method: request.method,
      auth: request.headers.get("authorization"),
      org: request.headers.get("x-openwork-org-id"),
      legacyOrg: request.headers.get("x-openwork-legacy-org-id"),
      accept: request.headers.get("accept"),
      contentType: request.headers.get("content-type"),
      body,
    });
    return status === 200 ? Response.json({ recorded: true }) : new Response(null, { status });
  } });
  cleanup.push(() => den.stop());
  denUrl = `http://127.0.0.1:${den.port}`;
  config = {
    host: "127.0.0.1", port: 0, token: "fixture-client", hostToken: "fixture-host", configPath: join(temp, "state", "server.json"),
    trustedDenOrigin: "http://127.0.0.1:1", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [], authorizedRoots: [temp], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const { startServer } = await import("../src/server.js");
  const server = await startServer(config, { deferManagedEngineStartup: true });
  cleanup.push(() => server.stop());
  base = `http://127.0.0.1:${server.port}`;
  await managedDesktopPolicy(config).setSession({ baseUrl: denUrl, orgId: "org_fixture", token: "fixture-den-token" });
});
beforeEach(() => {
  requests.length = 0;
  statuses.length = 0;
});
afterAll(async () => {
  for (const close of cleanup.reverse()) await Promise.resolve().then(close).catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
});

async function post(body: unknown = REPORT, token = config.token) {
  const response = await fetch(`${base}${ROUTE}`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json: unknown = await response.json();
  return { status: response.status, json };
}

test("forwards the validated report using the signed-in member's Den credentials", async () => {
  expect(await post({ ...REPORT, sessionId: "local-session-id", value: "fixture-private-value" })).toEqual({ status: 200, json: { ok: true, recorded: true } });
  expect(requests).toEqual([{
    method: "POST", auth: "Bearer fixture-den-token", org: "org_fixture", legacyOrg: "org_fixture",
    accept: "application/json", contentType: "application/json", body: REPORT,
  }]);
});

test("rejects unauthenticated local requests without forwarding", async () => {
  expect((await post(REPORT, "")).status).toBe(401);
  expect(requests).toEqual([]);
});

test("rejects invalid reports without forwarding", async () => {
  expect(await post({ ...REPORT, result: "off" })).toEqual({ status: 400, json: { ok: false, code: "invalid_report" } });
  expect(requests).toEqual([]);
});

test("retries Den 5xx, keeping the same report, then reports failure after three attempts", async () => {
  statuses.push(500, 502, 503);
  expect(await post()).toEqual({ status: 200, json: { ok: false, code: "den_unavailable" } });
  expect(requests).toHaveLength(3);
  for (const request of requests) expect(request).toMatchObject({ body: REPORT });
});

test("does not retry a Den 4xx response", async () => {
  statuses.push(403);
  expect(await post()).toEqual({ status: 200, json: { ok: false, code: "den_rejected" } });
  expect(requests).toHaveLength(1);
});

test("does not forward without an org session", async () => {
  await managedDesktopPolicy(config).clearSession();
  expect(await post()).toEqual({ status: 200, json: { ok: false, code: "not_signed_in" } });
  expect(requests).toEqual([]);
});
