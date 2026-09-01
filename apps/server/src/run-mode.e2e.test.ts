import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openworkRuntimeConfigFilePath, writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { readGlobalRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const CLIENT_TOKEN = "owt_run_mode_client";
const HOST_TOKEN = "owt_run_mode_host";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const priorDataDir = process.env.OPENWORK_DATA_DIR;
const priorTokenStore = process.env.OPENWORK_TOKEN_STORE;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function clientAuth(token = CLIENT_TOKEN) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function hostAuth() {
  return { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

async function createTempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * Stand-in engine: records instance rebuild requests so the test can assert
 * that a run mode change is applied to the engine immediately instead of
 * waiting for the next rebuild.
 */
function startFakeEngine(): { url: string; disposals: string[] } {
  const disposals: string[] = [];
  const engine = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/instance/dispose") {
        disposals.push(url.searchParams.get("directory") ?? "");
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    },
  });
  stops.push(() => engine.stop(true));
  return { url: `http://127.0.0.1:${engine.port}`, disposals };
}

async function startOpenworkServer(workspaceRoot: string, options?: { readOnly?: boolean }) {
  const engine = startFakeEngine();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(workspaceRoot, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local", baseUrl: engine.url }],
    authorizedRoots: [workspaceRoot],
    readOnly: options?.readOnly === true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, config, engine };
}

async function readRenderedPermission(config: ServerConfig): Promise<Record<string, unknown>> {
  await writeOpenworkRuntimeConfigFile(config);
  const raw = await readFile(openworkRuntimeConfigFilePath(config), "utf8");
  return asRecord(asRecord(JSON.parse(raw)).permission);
}

beforeEach(async () => {
  const envRoot = await createTempRoot("openwork-run-mode-env-");
  process.env.OPENWORK_DATA_DIR = join(envRoot, "data");
  process.env.OPENWORK_TOKEN_STORE = join(envRoot, "tokens.json");
});

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
  if (priorDataDir === undefined) {
    delete process.env.OPENWORK_DATA_DIR;
  } else {
    process.env.OPENWORK_DATA_DIR = priorDataDir;
  }
  if (priorTokenStore === undefined) {
    delete process.env.OPENWORK_TOKEN_STORE;
  } else {
    process.env.OPENWORK_TOKEN_STORE = priorTokenStore;
  }
});

describe("run mode routes", () => {
  test("defaults to approve and rejects unknown modes", async () => {
    const root = resolve(await createTempRoot("openwork-run-mode-"));
    const { base } = await startOpenworkServer(root);

    const initial = await fetch(`${base}/workspace/ws_1/run-mode`, { headers: clientAuth() });
    expect(initial.status).toBe(200);
    expect(asRecord(await initial.json())).toMatchObject({ mode: "approve" });

    const invalid = await fetch(`${base}/workspace/ws_1/run-mode`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ mode: "yolo" }),
    });
    expect(invalid.status).toBe(400);
  });

  test("run everything compiles auto-approval into the engine file while protections stay interactive", async () => {
    const root = resolve(await createTempRoot("openwork-run-mode-"));
    const { base, config, engine } = await startOpenworkServer(root);

    // Authorized folders keep working as explicit external-directory grants.
    const folders = await fetch(`${base}/workspace/ws_1/authorized-folders`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ folders: ["/shared"] }),
    });
    expect(folders.status).toBe(200);
    expect(engine.disposals).toHaveLength(0);

    const enable = await fetch(`${base}/workspace/ws_1/run-mode`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ mode: "run-everything" }),
    });
    expect(enable.status).toBe(200);
    expect(asRecord(await enable.json())).toMatchObject({ mode: "run-everything", changed: true, reload: "reloaded" });
    // The change is applied to the engine before the route answers, not left
    // for the next instance rebuild.
    expect(engine.disposals).toEqual([root]);

    const readback = await fetch(`${base}/workspace/ws_1/run-mode`, { headers: clientAuth() });
    expect(asRecord(await readback.json())).toMatchObject({ mode: "run-everything" });

    const permission = await readRenderedPermission(config);
    // Claim: everything the engine would ask about is auto-allowed.
    expect(permission["*"]).toBe("allow");
    // Protections stay interactive: outside-workspace writes keep their ask
    // default ahead of the explicit folder grants (last matching rule wins),
    // and repeated identical calls still prompt.
    const externalDirectory = asRecord(permission.external_directory);
    expect(Object.keys(externalDirectory)[0]).toBe("*");
    expect(externalDirectory["*"]).toBe("ask");
    expect(externalDirectory["/shared/*"]).toBe("allow");
    expect(permission.doom_loop).toBe("ask");
    // The engine's default .env read protection survives the top-level allow.
    expect(asRecord(permission.read)).toEqual({
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow",
    });
    // The OpenWork-internal field never leaks into engine config.
    const rendered = asRecord(JSON.parse(await readFile(openworkRuntimeConfigFilePath(config), "utf8")));
    expect(rendered.run_mode).toBeUndefined();
    // The injected agent's explicit skill denies survive the preset.
    const agentPermission = asRecord(asRecord(asRecord(asRecord(rendered.agent).openwork).permission).skill);
    expect(agentPermission["customize-opencode"]).toBe("deny");

    // Switching back restores prompt-by-default without losing folder grants.
    const disable = await fetch(`${base}/workspace/ws_1/run-mode`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ mode: "approve" }),
    });
    expect(disable.status).toBe(200);
    expect(asRecord(await disable.json())).toMatchObject({ mode: "approve", changed: true, reload: "reloaded" });
    // The safety direction is applied just as promptly.
    expect(engine.disposals).toEqual([root, root]);

    const restored = await readRenderedPermission(config);
    expect(restored["*"]).toBeUndefined();
    expect(restored.doom_loop).toBeUndefined();
    expect(asRecord(restored.external_directory)["/shared/*"]).toBe("allow");
    expect(asRecord(restored.external_directory)["*"]).toBeUndefined();
    expect((await readGlobalRuntimeOpencodeConfig(config)).run_mode).toBeUndefined();

    const repeat = await fetch(`${base}/workspace/ws_1/run-mode`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ mode: "approve" }),
    });
    expect(asRecord(await repeat.json())).toMatchObject({ mode: "approve", changed: false, reload: "skipped" });
    // An unchanged write never rebuilds the engine.
    expect(engine.disposals).toEqual([root, root]);
  });

  test("requires client auth, collaborator scope, and writable server", async () => {
    const root = await createTempRoot("openwork-run-mode-");
    const { base } = await startOpenworkServer(root);

    const unauthenticated = await fetch(`${base}/workspace/ws_1/run-mode`);
    expect(unauthenticated.status).toBe(401);

    const issued = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ scope: "viewer", label: "viewer" }),
    });
    expect(issued.status).toBe(201);
    const issuedBody = asRecord(await issued.json());
    const viewerToken = typeof issuedBody.token === "string" ? issuedBody.token : "";
    expect(viewerToken).not.toBe("");

    const viewerWrite = await fetch(`${base}/workspace/ws_1/run-mode`, {
      method: "PUT",
      headers: clientAuth(viewerToken),
      body: JSON.stringify({ mode: "run-everything" }),
    });
    expect(viewerWrite.status).toBe(403);

    const readOnlyRoot = await createTempRoot("openwork-run-mode-");
    const readOnly = await startOpenworkServer(readOnlyRoot, { readOnly: true });
    const readOnlyWrite = await fetch(`${readOnly.base}/workspace/ws_1/run-mode`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ mode: "run-everything" }),
    });
    expect(readOnlyWrite.status).toBe(403);
  });
});
