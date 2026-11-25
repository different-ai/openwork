import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { bootManagedOpenworkServer, close, isRecord, listen, sendJson } from "./openwork-server-cli.ts";

export const KEY = "MANAGED_RECONCILIATION_API_KEY";
export const RESOURCE = "MANAGED_RECONCILIATION_RESOURCE_NAME";
export const MANAGED_SECRET = "synthetic-managed-key";
export const LOCAL_SECRET = "synthetic-local-override";
export const PROVIDER_ID = "lpr_reconciliation_fixture";

/** The real server reconciles a deterministic Den inventory into its real managed engine. */
export async function managedProviderReconciliation(seed: Seed) {
  const scratch = seed.tmpPath("managed-provider-reconciliation");
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let credential = false;
  let removed = false;
  let revision = 1;
  const requests: string[] = [];
  const cloud = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(path);
    const provider = {
      id: PROVIDER_ID, providerId: "fixture", source: "custom", name: "Reconciled models",
      updatedAt: `2026-01-0${revision}T00:00:00.000Z`, pinnedModelIds: ["kept"],
      providerConfig: {
        npm: "@ai-sdk/openai-compatible", env: [RESOURCE, KEY],
        options: { baseURL: "http://127.0.0.1:9/v1" }, whitelist: ["kept"],
      },
      models: [
        { id: "kept", name: `Kept ${revision}`, config: {
          reasoning: true, tool_call: true, limit: { context: 32000, output: 1024 },
          cost: { input: 1, output: 2 }, options: { temperature: 0.3 },
          headers: { "x-fixture-model": "kept" }, variants: { careful: { reasoningEffort: "high" } },
        } },
        ...(revision === 1 ? [{ id: "obsolete", name: "Obsolete", config: {} }] : []),
      ],
    };
    if (path === "/v1/llm-providers") return sendJson(response, 200, { llmProviders: removed ? [] : [provider] });
    if (path === `/v1/llm-providers/${PROVIDER_ID}/connect`) return sendJson(response, 200, {
      llmProvider: { ...provider, apiKey: null, apiKeys: { [RESOURCE]: "synthetic-resource", ...(credential ? { [KEY]: MANAGED_SECRET } : {}) } },
    });
    if (path === "/v1/inference-providers") return sendJson(response, 200, { inferenceProviders: [] });
    sendJson(response, 404, { error: "not_found" });
  });
  const cloudUrl = await listen(cloud);
  const token = "provider-reconciliation-client";
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | undefined;
  try {
    managed = await bootManagedOpenworkServer({ scratch, workspace, token, sink: () => undefined });
    const base = managed.base;
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method, headers: { "x-openwork-host-token": `${token}-host`, authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (!response.ok && response.status !== 404) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 250)}`);
      const payload: unknown = text ? JSON.parse(text) : null;
      return { status: response.status, body: isRecord(payload) ? payload : {} };
    };
    await call("/den-session", "PUT", { baseUrl: cloudUrl, token: "synthetic-den-session", orgId: "org-fixture" });
    return {
      requests,
      sync: () => call("/cloud-provider-sync/run", "POST", { reason: "manual" }),
      status: async () => (await call("/cloud-provider-sync/status")).body,
      config: async () => (await call("/runtime-config/providers")).body,
      env: (name: string) => call(`/env/${name}`),
      setLocalKey: () => call("/env", "PUT", { entries: [{ key: KEY, value: LOCAL_SECRET }] }),
      deliverCredential: () => { credential = true; },
      changeModels: () => { revision = 2; },
      removeProvider: () => { removed = true; },
      async [Symbol.asyncDispose]() { await managed?.stop(); await close(cloud); await rm(scratch, { recursive: true, force: true }); },
    };
  } catch (error) {
    await managed?.stop(); await close(cloud); await rm(scratch, { recursive: true, force: true }); throw error;
  }
}
