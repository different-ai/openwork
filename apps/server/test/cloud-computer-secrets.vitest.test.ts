// The cloud computer's secret routes over real HTTP: the contract, the rollout gate, and that a value sent to them is
// in no log line, error or response. Every value here is made up for the test.
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

const VALUE = 'fake "quoted" \\ pass wörd ✓ & <b> 100% a+b=c';
const SESSION = "conversation-one";
const features = { remoteComputers: true, browserSecretHandles: true };
const logged: string[] = [];
const cleanup: (() => unknown)[] = [];
let temp = "";
let base = "";
let config: ServerConfig;

/** Everything the process wrote while the server ran: request logs, warnings and unhandled errors. */
function recordOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    const spy = vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => { logged.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; });
    cleanup.push(() => spy.mockRestore());
  }
  for (const method of ["log", "info", "warn", "error"] as const) {
    const spy = vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logged.push(parts.map((part) => part instanceof Error ? `${part.stack}` : typeof part === "string" ? part : JSON.stringify(part)).join(" ")); });
    cleanup.push(() => spy.mockRestore());
  }
}

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "cloud-computer-secrets-"));
  // The organization as the server reads it: its rollouts, and permissions that leave the host usable.
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname;
    return path === "/v1/org" ? Response.json({ features }) : path === "/v1/me/desktop-config" ? Response.json({ agentPermissions: { rules: [] } }) : new Response(null, { status: 404 });
  } });
  cleanup.push(() => den.stop());
  config = {
    host: "127.0.0.1", port: 0, token: "fixture-client", hostToken: "fixture-host", configPath: join(temp, "state", "server.json"),
    trustedDenOrigin: "http://127.0.0.1:1", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [], authorizedRoots: [temp], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: true,
  };
  await managedDesktopPolicy(config).setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_fixture", token: "fixture-den-token" });
  recordOutput();
  // The cloud computer exists only inside the operator-installed Linux runtime. Its secret store and approvals need no
  // display, so the server is started as that runtime would start it.
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("This runtime does not describe its platform.");
  vi.stubEnv("DEN_RUNTIME_MANAGED", "1");
  vi.stubEnv("OPENWORK_CLOUD_COMPUTER_DISPLAY", ":99");
  vi.stubEnv("OPENWORK_UI_CONTROL_DISCOVERY", join(temp, "ui", "discovery.json"));
  cleanup.push(() => vi.unstubAllEnvs());
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try {
    const { startServer } = await import("../src/server.js");
    const server = await startServer(config);
    cleanup.push(() => server.stop());
    base = `http://127.0.0.1:${server.port}`;
  } finally { Object.defineProperty(process, "platform", platform); }
});
afterAll(async () => {
  for (const close of cleanup.reverse()) await Promise.resolve().then(close).catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  return { status: response.status, text, json: parsed, cache: response.headers.get("cache-control") };
}
// Client and host bearer authority is available to guest shell tools, not a proof of a human answer.
const routes: [string, string, unknown?][] = [
  ["GET", `/cloud-computer/secrets?sessionId=${SESSION}`],
  ["POST", "/cloud-computer/secrets", { sessionId: SESSION, label: "Site sign-in", kind: "password", origins: ["https://app.example"], value: VALUE }],
  ["DELETE", "/cloud-computer/secrets", { sessionId: SESSION, secretRef: "sec_example" }],
  ["GET", `/cloud-computer/request?sessionId=${SESSION}`],
  ["POST", "/cloud-computer/request", { sessionId: SESSION, id: "guessed-or-discovered-id", answer: "allow" }],
];

test("cloud enrollment and approval stay disabled even with both rollouts and guest-readable authority", async () => {
  expect((await fetch(`${base}/cloud-computer/secrets?sessionId=${SESSION}`)).status).toBe(401);
  for (const headers of [{}, { "x-openwork-host-token": config.hostToken }]) {
    for (const [method, path, body] of routes) {
      expect(await call(method, path, body, headers)).toMatchObject({ status: 404, json: { code: "feature_disabled" } });
    }
  }
});

test("a disabled route never parses or echoes a malformed enrollment or approval", async () => {
  for (const path of ["/cloud-computer/secrets", "/cloud-computer/request"]) {
    expect(await call("POST", path, `{"value":"${VALUE}`)).toMatchObject({ status: 404, json: { code: "feature_disabled" } });
  }
});

test("rollout changes cannot re-enable cloud secret enrollment or approval", async () => {
  for (const off of ["browserSecretHandles", "remoteComputers"] as const) {
    features[off] = false;
    try {
      for (const [method, path, body] of routes) expect(await call(method, path, body)).toMatchObject({ status: 404, json: { code: "feature_disabled" } });
    } finally { features[off] = true; }
  }
});

test("disabled routes never log or persist the submitted fake value", async () => {
  const output = logged.join("\n");
  expect(output).toMatch(/POST \/cloud-computer\/secrets 404/);
  expect(output).not.toMatch(/sessionId=/);
  const entries = await readdir(temp, { recursive: true, withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name))));
  const written = Buffer.concat(files).toString("utf8");
  for (const spelling of [VALUE, JSON.stringify(VALUE).slice(1, -1), encodeURIComponent(VALUE), Buffer.from(VALUE).toString("base64")]) {
    expect(output.includes(spelling)).toBe(false);
    expect(written.includes(spelling)).toBe(false);
  }
});
