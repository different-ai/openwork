import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PRIVATE_VALUES_CAPABILITY_HEADER } from "@openwork/types/den/agent-permissions";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

const ROUTE = "/managed-policy/private-values";
const VALUE_RULES = [
  { action: "private_value_fill", resource: "*", effect: "deny", source: "Everyone" },
  { action: "private_value_fill", resource: "*.example.com", effect: "allow", source: "Everyone" },
  { action: "private_value_command", resource: "security *", effect: "deny", source: "Everyone" },
  { action: "private_value_paste", resource: "*", effect: "deny", source: "Finance" },
];
const OTHER_RULES = [
  { action: "shell", resource: "rm *", effect: "deny", source: "Everyone" },
  { action: "webfetch", resource: "*.example.com", effect: "allow", source: "Everyone" },
];
const said: (string | null)[] = [];
const den: { features: { privateValues: boolean }; rules: unknown; status: number } = { features: { privateValues: true }, rules: [...OTHER_RULES, ...VALUE_RULES], status: 200 };
const cleanup: (() => unknown)[] = [];
let temp = "";
let base = "";
let denUrl = "";
let config: ServerConfig;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "private-value-policy-"));
  const organization = await serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/org") return Response.json({ features: den.features });
    if (path !== "/v1/me/desktop-config") return new Response(null, { status: 404 });
    said.push(request.headers.get(AGENT_PRIVATE_VALUES_CAPABILITY_HEADER));
    return den.status === 200 ? Response.json({ agentPermissions: { rules: den.rules } }) : new Response(null, { status: den.status });
  } });
  cleanup.push(() => organization.stop());
  denUrl = `http://127.0.0.1:${organization.port}`;
  config = {
    host: "127.0.0.1", port: 0, token: "fixture-client", hostToken: "fixture-host", configPath: join(temp, "state", "server.json"),
    trustedDenOrigin: "http://127.0.0.1:1", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [], authorizedRoots: [temp], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const { startServer } = await import("../src/server.js");
  const server = await startServer(config, { deferManagedEngineStartup: true });
  cleanup.push(() => server.stop());
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  for (const close of cleanup.reverse()) await Promise.resolve().then(close).catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
});

async function read(headers: Record<string, string> = { authorization: `Bearer ${config.token}` }) {
  const response = await fetch(`${base}${ROUTE}`, { headers, signal: AbortSignal.timeout(15_000) });
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json };
}

test("signed out, private values are off and the organization is never asked", async () => {
  expect((await read({})).status).toBe(401);
  expect(await read()).toEqual({ status: 200, json: { enabled: false, rules: [] } });
  expect(said).toEqual([]);
});

test("with the rollout on, the answer is the organization's private-value rules alone, read as a desktop that understands them", async () => {
  await managedDesktopPolicy(config).setSession({ baseUrl: denUrl, orgId: "org_fixture", token: "fixture-den-token" });
  said.length = 0;
  expect(await read()).toEqual({ status: 200, json: { enabled: true, rules: VALUE_RULES } });
  expect(said.at(-1)).toBe("1");
  den.rules = OTHER_RULES;
  expect(await read()).toEqual({ status: 200, json: { enabled: true, rules: [] } });
});

test("with the rollout off, nothing is on and no rule is returned", async () => {
  den.rules = [...OTHER_RULES, ...VALUE_RULES];
  den.features.privateValues = false;
  try {
    expect(await read()).toEqual({ status: 200, json: { enabled: false, rules: [] } });
  } finally { den.features.privateValues = true; }
});

test("rules that could not be read or understood are never an answer of on with no rules", async () => {
  for (const broken of [{ status: 500 }, { status: 403 }, { rules: "none" }, { rules: [{ action: "private_value_fill", resource: "*", effect: "sometimes", source: "Everyone" }] }]) {
    Object.assign(den, { status: 200, rules: VALUE_RULES }, broken);
    const answer = await read();
    expect(answer.status, JSON.stringify(broken)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(answer.json)).not.toContain('"enabled":true');
  }
  Object.assign(den, { status: 200, rules: VALUE_RULES });
  expect(await read()).toEqual({ status: 200, json: { enabled: true, rules: VALUE_RULES } });
});
