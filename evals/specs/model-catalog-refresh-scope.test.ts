import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  clearEnginePoolForConfig,
  computeEngineConfigFingerprint,
  type EngineSpawnTemplate,
} from "../../apps/server/src/engine-pool.js";
import {
  createManagedOpencodeServer,
  type ManagedOpencodeServer,
} from "../../apps/server/src/managed-opencode.js";
import {
  createEnginePoolForConfig,
  registerTrustedOpencodeProcess,
  startServer,
} from "../../apps/server/src/server.js";
import type { ServerConfig } from "../../apps/server/src/types.js";

type Served = Awaited<ReturnType<typeof startServer>> & { port: number; stop: (force?: boolean) => Promise<void> };

// Minted per run so the fixture never carries a checked-in credential.
const ownerCredential = `owner-${randomUUID()}`;
const hostCredential = `host-${randomUUID()}`;

async function readCachedCatalog(cacheHome: string): Promise<string | null> {
  const dir = join(cacheHome, "opencode");
  const entries = await readdir(dir).catch(() => [] as string[]);
  const file = entries.find((entry) => /^models-[0-9a-f]{40}\.json$/.test(entry));
  return file ? await readFile(join(dir, file), "utf8") : null;
}

// Refreshing the catalog drops a cache and replaces the engine for everyone in
// the workspace, so it is gated on the collaborator scope. This pins the half
// that is easy to leave untested: who still cannot run it, and that a refused
// caller changes nothing.
test("a viewer cannot refresh the model catalog and leaves the cached one untouched", { timeout: 180_000 }, async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-catalog-scope-"));
  const workspace = join(root, "workspace");
  const xdg = join(root, "xdg");
  const cacheHome = join(xdg, "cache");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(xdg, "config", "opencode"), { recursive: true });

  const previousEnv = {
    OPENWORK_DATA_DIR: process.env.OPENWORK_DATA_DIR,
    OPENWORK_TOKEN_STORE: process.env.OPENWORK_TOKEN_STORE,
    OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB,
  };
  process.env.OPENWORK_DATA_DIR = join(root, "data");
  process.env.OPENWORK_TOKEN_STORE = join(root, "tokens.json");
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");

  const catalogHost = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      "scope-witness": {
        id: "scope-witness",
        name: "Scope witness",
        env: ["SCOPE_WITNESS_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://witness.invalid/v1",
        models: { "scope-witness-model": { id: "scope-witness-model", name: "Scope witness model" } },
      },
    }));
  });
  await new Promise<void>((resolve) => catalogHost.listen(0, "127.0.0.1", resolve));
  const address = catalogHost.address();
  if (address === null || typeof address === "string") throw new Error("catalog host did not bind a port");

  await writeFile(join(workspace, "opencode.json"), "{}", "utf8");
  await writeFile(join(xdg, "config", "opencode", "opencode.json"), "{}", "utf8");
  const runtimeConfigPath = join(root, "runtime-opencode-config.json");
  await writeFile(runtimeConfigPath, "{}\n", "utf8");

  const engineEnv = {
    OPENCODE_TEST_HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(xdg, "config"),
    XDG_DATA_HOME: join(xdg, "data"),
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: join(xdg, "state"),
    OPENCODE_CONFIG: runtimeConfigPath,
    OPENCODE_MODELS_URL: `http://127.0.0.1:${address.port}/`,
  };

  let engine: ManagedOpencodeServer | null = null;
  let served: Served | null = null;
  let config: ServerConfig | null = null;

  try {
    engine = await createManagedOpencodeServer({ cwd: workspace, env: engineEnv, timeoutMs: 120_000 });

    config = {
      host: "127.0.0.1",
      port: 0,
      configPath: join(root, "server.json"),
      token: ownerCredential,
      hostToken: hostCredential,
      approval: { mode: "auto", timeoutMs: 1000 },
      corsOrigins: ["*"],
      opencodeUsername: engine.username,
      opencodePassword: engine.password,
      workspaces: [{
        id: "ws_1",
        name: "Workspace",
        path: workspace,
        preset: "starter",
        workspaceType: "local",
        baseUrl: engine.url,
      }],
      authorizedRoots: [workspace],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    };
    registerTrustedOpencodeProcess(config, {
      baseUrl: engine.url,
      identity: "model-catalog-scope-spec",
      isAlive: engine.isAlive,
    });
    const template: EngineSpawnTemplate = { cwd: workspace, runtimeConfigPath, env: engineEnv, reservedPorts: () => [] };
    const pool = createEnginePoolForConfig({
      config,
      template,
      handle: engine,
      fingerprint: await computeEngineConfigFingerprint(template),
      registryId: null,
      trustedIdentity: null,
    });
    served = await startServer(config) as Served;
    const base = `http://127.0.0.1:${served.port}`;

    const mintToken = async (scope: "viewer" | "collaborator"): Promise<string> => {
      const response = await fetch(`${base}/tokens`, {
        method: "POST",
        headers: { "x-openwork-host-token": hostCredential, "content-type": "application/json" },
        body: JSON.stringify({ scope, label: `${scope} fixture` }),
      });
      expect(response.status).toBe(201);
      const issued: unknown = await response.json();
      const token = (issued as { token?: unknown }).token;
      if (typeof token !== "string") throw new Error(`token mint returned no token for ${scope}`);
      return token;
    };

    const refreshAs = async (token: string): Promise<{ status: number; body: string }> => {
      const response = await fetch(`${base}/workspace/ws_1/models/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(120_000),
      });
      return { status: response.status, body: await response.text() };
    };

    const cachedBefore = await readCachedCatalog(cacheHome);
    expect(cachedBefore).not.toBeNull();

    const viewerToken = await mintToken("viewer");
    const refused = await refreshAs(viewerToken);
    const cachedAfterRefusal = await readCachedCatalog(cacheHome);

    expect(refused.status).toBe(403);
    expect(refused.body).toContain("collaborator");
    // The refusal is not merely a status: the viewer left the catalog in place.
    expect(cachedAfterRefusal).toBe(cachedBefore);
    evidence.recordAssertionEvidence(
      "A viewer is refused and the cached catalog survives the attempt",
      `POST /workspace/ws_1/models/refresh as viewer -> ${refused.status}; `
        + `cached catalog unchanged=${cachedAfterRefusal === cachedBefore}`,
      refused.status === 403 && cachedAfterRefusal === cachedBefore,
    );

    const collaboratorToken = await mintToken("collaborator");
    const allowed = await refreshAs(collaboratorToken);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain("refreshedAt");
    evidence.recordAssertionEvidence(
      "A collaborator may run the same refresh",
      `POST /workspace/ws_1/models/refresh as collaborator -> ${allowed.status} ${allowed.body.slice(0, 120)}`,
      allowed.status === 200,
    );

    clearEnginePoolForConfig(config);
    await pool.disposeAll();
  } finally {
    if (served) await served.stop(true);
    if (engine) await engine.close().catch(() => undefined);
    await new Promise<void>((resolve) => catalogHost.close(() => resolve()));
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
