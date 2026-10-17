import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedRuntimeEnvironment } from "../../evals/packages/env/src/app-web-runtime.ts";
import { denFetch, type DenSession } from "../../evals/packages/behaviors/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import type { HeadlessWebHandle } from "../../packages/world/src/headless-web.ts";
import { trackResource } from "../../packages/world/src/ledger.ts";
import { record } from "./acme-gateway.ts";

/** Seeded worlds must not inherit the developer's config, plugins, credentials or repository ancestors. */
export async function acmeRuntimeFixture(stack: AsyncDisposableStack) {
  // macOS /var aliases /private/var. The engine canonicalizes its directory;
  // matching it here prevents ordinary workspace reads being treated as external.
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwork-acme-world-")));
  stack.defer(() => rm(root, { recursive: true, force: true }));
  await trackResource({ kind: "tmpdir", id: root, label: "isolated Acme runtime" });
  await Promise.all(["workspace", "home", "cache", "config/openwork", "config/opencode", "data/openwork", "data/opencode", "state"].map((path) => mkdir(join(root, path), { recursive: true })));
  const executable = Object.fromEntries(["PATH", "PNPM_HOME", "TMPDIR", "SHELL", "npm_execpath", "npm_node_execpath"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  return { workspace: join(root, "workspace"), env: { ...executable, ...isolatedRuntimeEnvironment(root, "v1") } };
}

/** A script world owns its process. Den/build children get no ambient developer secrets or injection hooks either. */
export function acmeProcessEnvironment(source: NodeJS.ProcessEnv, runtimeEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = new Set(["OPENWORK_WORLD_STAGE", "OPENWORK_WORLD_PLACE", "OPENWORK_WORLD_OS", "OPENWORK_WORLD_SNAPSHOT_DIR", "OPENWORK_WORLD_RECIPE_HASH", "OPENWORK_WORLD_INVOCATION_HASH", "OPENWORK_WORLD_EVENTS", "OPENWORK_WORLD_LEDGER", "OPENWORK_WORLD_SEEDS", "OPENWORK_WORLD_SOURCES", "OPENWORK_WORLD_HEARTBEAT_MS", "OPENWORK_EVAL_MYSQL_URL"]);
  const harness = Object.fromEntries(Object.entries(source).filter(([key]) => keys.has(key)));
  return { ...harness, ...runtimeEnv };
}

/** Fail closed: every remote engine server must belong to this world's Den, not a hosted account. */
export function assertAcmeMcpOrigins(config: unknown, denApiUrl: string) {
  if (!record(config) || !record(config.mcp)) throw new Error("Acme runtime has no MCP configuration.");
  const expected = new URL(denApiUrl).origin;
  let owned = false;
  for (const [name, entry] of Object.entries(config.mcp)) {
    if (!record(entry)) throw new Error(`Invalid Acme MCP entry: ${name}`);
    if (entry.type !== "remote" || typeof entry.url !== "string") throw new Error(`Unexpected non-Den Acme MCP server: ${name}`);
    const url = new URL(entry.url);
    if (url.origin !== expected || url.username || url.password || url.search || url.hash || !(url.pathname === "/mcp/agent" || url.pathname.startsWith("/mcp/agent/connections/"))) throw new Error(`Acme MCP origin isolation failed: ${name}`);
    if (name === "openwork-cloud" && entry.enabled !== false) owned = true;
  }
  if (!owned) throw new Error("Acme runtime has no enabled owned Den MCP server.");
}

export async function assertAcmeConnections(den: Den, ownedMockOrigins: string[]) {
  const listed = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers: { authorization: `Bearer ${den.admin.token}` } });
  if (!listed.response.ok || !record(listed.body) || !Array.isArray(listed.body.connections)) throw new Error("Could not verify Acme mock connection ownership.");
  if (!listed.body.connections.length) throw new Error("No Acme mock connections registered.");
  for (const connection of listed.body.connections) {
    if (!record(connection) || typeof connection.url !== "string") throw new Error("Invalid Acme mock connection.");
    const url = new URL(connection.url);
    if (!ownedMockOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash) throw new Error("Acme Den contains a connection outside this world's owned mocks.");
  }
}

/** Use the supported seeded-world MCP token/reconciliation path; never copy a user's connection. */
export async function connectAcmeRuntime(den: Den, web: Pick<HeadlessWebHandle, "manifest">, orgId: string, actor: DenSession = den.admin) {
  const issued = await denFetch(actor, "/v1/mcp/token", {
    method: "POST", headers: { authorization: `Bearer ${actor.token}`, "x-openwork-org-id": orgId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = record(issued.body) ? issued.body.token : undefined;
  if (!issued.response.ok || typeof token !== "string") throw new Error("Acme could not issue its disposable Den MCP token.");
  const { manifest } = web;
  const headers = { authorization: `Bearer ${manifest.token}`, "content-type": "application/json" };
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${manifest.openworkUrl}${path}`, { headers, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Acme runtime setup ${path}: HTTP ${response.status}; response omitted.`);
    return response.json();
  }
  const workspaces = await request("/workspaces");
  const workspace = record(workspaces) && Array.isArray(workspaces.items) ? workspaces.items.find(record) : undefined;
  if (typeof workspace?.id !== "string") throw new Error("Acme runtime workspace missing.");
  const base = `/workspace/${encodeURIComponent(workspace.id)}`;
  await request(`${base}/mcp/openwork-cloud/reconcile`, {
    config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "seeded-acme-world",
  });
  // Native app-web worlds may have no managed inference catalog change to trigger
  // a generation rollover. Ask the supported engine endpoint to reload the freshly
  // reconciled global file; 503 can mean the existing rollover is coalescing.
  const reload = await fetch(`${manifest.openworkUrl}${base}/engine/reload`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(30_000) });
  if (!reload.ok && reload.status !== 503) throw new Error(`Acme owned engine reload failed: HTTP ${reload.status}`);
  // Do not send a paid prompt until the new generation actually sees the owned MCP.
  const deadline = Date.now() + 45_000;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      assertAcmeMcpOrigins(await request(`${base}/opencode/config`), den.ref.apiUrl);
      return;
    } catch (error) { lastFailure = error; }
    await delay(500);
  }
  throw lastFailure;

}
