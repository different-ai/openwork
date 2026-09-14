import { createServer } from "node:http";
import { afterEach, expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import { CloudProviderSync, removedCloudModels, type CloudModelRemovalImpact } from "../../apps/server/src/cloud-provider-sync";
import { EnvService } from "../../apps/server/src/env-file";
import type { ServerConfig } from "../../apps/server/src/types";
import type { RuntimeOpencodeConfig } from "../../apps/server/src/runtime-opencode-config-store";

const memory = vi.hoisted(() => {
  const runtime: RuntimeOpencodeConfig = {};
  return { runtime, workspace: new Map<string, Record<string, unknown>>() };
});
vi.mock("../../apps/server/src/runtime-opencode-config-store", async (original) => ({
  ...await original<typeof import("../../apps/server/src/runtime-opencode-config-store")>(),
  readGlobalRuntimeOpencodeConfig: async () => memory.runtime,
  readRuntimeOpencodeConfig: async () => ({}),
  writeGlobalRuntimeOpencodeConfig: async (_config: unknown, update: (value: RuntimeOpencodeConfig) => RuntimeOpencodeConfig) => {
    memory.runtime = update(memory.runtime);
    return { config: memory.runtime, changed: true };
  },
  writeRuntimeOpencodeConfig: async () => { throw new Error("Unexpected workspace runtime write"); },
}));
vi.mock("../../apps/server/src/openwork-workspace-config-store", () => ({
  hasOpenworkWorkspaceConfig: async () => true,
  readOpenworkWorkspaceConfig: async (_config: unknown, id: string) => memory.workspace.get(id) ?? {},
  writeOpenworkWorkspaceConfig: async (_config: unknown, id: string, update: (value: Record<string, unknown>) => Record<string, unknown>) => {
    const value = update(memory.workspace.get(id) ?? {});
    memory.workspace.set(id, value);
    return value;
  },
}));
vi.mock("../../apps/server/src/openwork-runtime-config", () => ({ writeOpenworkRuntimeConfigFile: async () => ({ path: "/synthetic/runtime", changed: false }) }));
vi.mock("../../apps/server/src/managed-provider-auth", async (original) => ({
  ...await original<typeof import("../../apps/server/src/managed-provider-auth")>(),
  syncManagedProviderAuth: async () => ({ delivered: [], rotated: [], unchanged: [], removed: [], skipped: [], failed: [] }),
}));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  memory.runtime = {};
  memory.workspace.clear();
});

function provider(id: string, modelIds: string[]) {
  return { id, providerId: "fixture-family", name: "Fixture Family", source: "custom", updatedAt: "2026-01-01T00:00:00Z",
    providerConfig: { npm: "@ai-sdk/openai-compatible", env: [] }, apiKey: null, apiKeys: null,
    models: modelIds.map((modelId) => ({ id: modelId, name: `Display ${modelId}`, config: {} })),
  };
}

test("provider and model removals emit unarchived engine-bound sessions per workspace without rebinding", async ({ evidence }) => {
  const first = "lpr_fixture_one";
  const retired = "lpr_fixture_retired";
  let providers = [provider(first, ["removed_model", "kept_model"]), provider(retired, ["retired_model"])];
  const sessions = [
    { id: "fixture_affected", directory: "/synthetic/one", time: { archived: 0 }, model: { providerID: first, id: "removed_model" } },
    { id: "fixture_archived", directory: "/synthetic/one", time: { archived: 1 }, model: { providerID: first, id: "removed_model" } },
    { id: "fixture_provider_removed", directory: "/synthetic/one", model: { providerID: retired, id: "retired_model" } },
    { id: "fixture_kept", directory: "/synthetic/one", model: { providerID: first, id: "kept_model" } },
    { id: "fixture_workspace_two", directory: "/synthetic/two", model: { providerID: first, id: "removed_model" } },
  ];
  const initial = JSON.stringify(sessions);
  const requests: Array<{ method: string; path: string; directory: string | null }> = [];
  const engine = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method ?? "GET", path: url.pathname, directory: url.searchParams.get("directory") });
    response.writeHead(url.pathname === "/session" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(sessions));
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { engine.close((error) => error ? reject(error) : resolve()); engine.closeAllConnections(); }));
  const address = engine.address();
  if (!address || typeof address === "string") throw new Error("Engine fixture missing");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture-token", hostToken: "fixture-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], authorizedRoots: [], readOnly: false,
    startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    workspaces: ["one", "two"].map((id) => ({ id, name: id, path: `/synthetic/${id}`, preset: "starter", workspaceType: "local", baseUrl })),
  };
  const env = new EnvService({ path: "/synthetic/unused-env" });
  vi.spyOn(env, "list").mockResolvedValue([]);
  vi.spyOn(env, "upsertMany").mockImplementation(async () => { throw new Error("Unexpected credential write"); });
  vi.spyOn(env, "delete").mockImplementation(async () => { throw new Error("Unexpected credential delete"); });
  const impacts: CloudModelRemovalImpact[] = [];
  const sync = new CloudProviderSync({ config, env, intervalMs: 3_600_000, reloadEngine: async () => ({ action: "reloaded_in_place" }),
    onModelsRemoved: (impact) => impacts.push(impact),
    fetchImpl: async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: providers });
      if (url.pathname === "/v1/inference-providers") return Response.json({}, { status: 404 });
      const id = /^\/v1\/llm-providers\/([^/]+)\/connect$/.exec(url.pathname)?.[1];
      const entry = providers.find((entry) => entry.id === id);
      if (entry) return Response.json({ llmProvider: entry });
      throw new Error("Unexpected Den fixture route");
    },
  });
  cleanups.push(() => sync.stop());
  await sync.setSession({ baseUrl: "https://fixture.invalid", token: "fixture-den", orgId: "fixture-org" });
  expect((await sync.run("initial")).status).not.toBe("failed");
  expect(impacts).toEqual([]);
  providers = [provider(first, ["kept_model"])];
  const result = await sync.run("removed");
  expect(result.status).toBe("applied");
  expect(impacts).toHaveLength(2);
  expect(impacts[0]).toMatchObject({ workspaceId: "one", sessionIds: ["fixture_affected", "fixture_provider_removed"], inventoryComplete: true });
  expect(impacts[1]).toMatchObject({ workspaceId: "two", sessionIds: ["fixture_workspace_two"], inventoryComplete: true });
  expect(impacts[0]?.removedModels).toEqual([
    { providerId: first, modelId: "removed_model", variant: null, displayName: "Display removed_model", providerName: "Fixture Family" },
    { providerId: retired, modelId: "retired_model", variant: null, displayName: "Display retired_model", providerName: "Fixture Family" },
  ]);
  expect(result.affectedSessions).toEqual(impacts);
  expect(sync.status().affectedSessions).toEqual(impacts);
  expect(JSON.stringify(sessions)).toBe(initial);
  expect(requests).toEqual([{ method: "GET", path: "/session", directory: "/synthetic/one" }, { method: "GET", path: "/session", directory: "/synthetic/two" }]);
  await sync.run("noop");
  expect(impacts).toHaveLength(2);
  await sync.suspend();
  expect(sync.status().affectedSessions).toEqual([]);
  evidence.recordAssertionEvidence("Cloud removal emits scoped unarchived affected sessions, not a migration", "A real sync pass removed one model and one provider against in-memory config witnesses; only engine GETs occurred, restored archive=0 was included, archived/other-model records were excluded, workspace sets were separate and no bindings changed.", true);
});

test("removal delta ignores additions, names and unrelated identities", async () => {
  const current = { provider: { name: "Family", models: { old: { name: "Previous" }, keep: { name: "Kept" } } } };
  expect(removedCloudModels(current, { provider: { models: { old: { name: "Renamed" }, keep: {}, new: {} } } })).toEqual([]);
  expect(removedCloudModels(current, { provider: { models: { keep: {} } } })).toEqual([{ providerId: "provider", modelId: "old", variant: null, displayName: "Previous", providerName: "Family" }]);
});
