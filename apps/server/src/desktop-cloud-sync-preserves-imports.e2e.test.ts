import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${label}`);
  return value;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-desktop-cloud-sync-"));
  roots.push(root);
  return root;
}

async function startOpenworkServer(workspaceRoot: string) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(workspaceRoot, "server.json"),
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

describe("desktop cloud sync provider imports", () => {
  test("preserves workspace provider import baseline while recording sync state", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);
    const providerImport = {
      cloudProviderId: "lpr_test",
      providerId: "ow_lpr_test",
      sourceProviderId: "openai",
      name: "Test Provider",
      source: "org",
      updatedAt: "2026-06-01T00:00:00.000Z",
      modelIds: ["model-a"],
      importedAt: 1780442400000,
    };

    const patchResponse = await fetch(`${base}/workspace/ws_1/config`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({
        openwork: {
          cloudImports: {
            providers: { lpr_test: providerImport },
          },
        },
      }),
    });
    expect(patchResponse.status).toBe(200);

    const syncResponse = await fetch(`${base}/workspace/ws_1/desktop-cloud-sync`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        snapshot: {
          organizationId: "org_1",
          orgMemberId: "member_1",
          teamIds: ["team_1"],
          resources: {
            llmProviders: { lpr_test: "2026-06-02T00:00:00.000Z" },
            marketplaces: {},
          },
        },
      }),
    });
    expect(syncResponse.status).toBe(200);
    const syncBody = expectRecord(await syncResponse.json(), "desktop cloud sync response");
    const responseState = expectRecord(syncBody.state, "desktop cloud sync response state");
    expect(Object.keys(expectRecord(responseState.entries, "desktop cloud sync response entries"))).toContain(
      "org_1::member_1",
    );

    const configResponse = await fetch(`${base}/workspace/ws_1/config`, { headers: auth(token) });
    expect(configResponse.status).toBe(200);
    const configBody = expectRecord(await configResponse.json(), "workspace config response");
    const openwork = expectRecord(configBody.openwork, "workspace openwork config");
    const cloudImports = expectRecord(openwork.cloudImports, "workspace cloud imports");
    const providers = expectRecord(cloudImports.providers, "workspace imported providers");
    const preservedProvider = expectRecord(providers.lpr_test, "preserved provider import baseline");
    expect(preservedProvider).toEqual(providerImport);

    const stateResponse = await fetch(`${base}/workspace/ws_1/desktop-cloud-sync`, { headers: auth(token) });
    expect(stateResponse.status).toBe(200);
    const stateBody = expectRecord(await stateResponse.json(), "desktop cloud sync state");
    const entries = expectRecord(stateBody.entries, "desktop cloud sync entries");
    const entry = expectRecord(entries["org_1::member_1"], "recorded desktop cloud sync entry");
    expect(entry.organizationId).toBe("org_1");
    expect(entry.orgMemberId).toBe("member_1");
    expect(Array.isArray(entry.pendingChanges) ? entry.pendingChanges : []).toHaveLength(1);
  });
});
