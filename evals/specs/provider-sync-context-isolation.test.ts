import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { CloudProviderSync } from "../../apps/server/src/cloud-provider-sync.js";
import { EnvService } from "../../apps/server/src/env-file.js";
import { resetManagedProviderAuthCache } from "../../apps/server/src/managed-provider-auth.js";
import {
  readGlobalRuntimeOpencodeConfig,
  runtimeProviderMap,
} from "../../apps/server/src/runtime-opencode-config-store.js";
import type { ServerConfig } from "../../apps/server/src/types.js";

const PROVIDER_ID = "lpr_context_isolation";
const ENV_KEY = "CONTEXT_ISOLATION_API_KEY";

test("a failed organization transition cannot retain the prior provider context", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-provider-context-isolation-"));
  const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  resetManagedProviderAuthCache();

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_context_isolation",
      name: "Context isolation",
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: "https://engine.example.test",
    }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const provider: Record<string, unknown> = {
    id: PROVIDER_ID,
    providerId: "openai-compatible",
    name: "Context isolation provider",
    source: "custom",
    updatedAt: "2026-08-28T00:00:00.000Z",
    providerConfig: {
      env: [ENV_KEY],
      npm: "@ai-sdk/openai-compatible",
    },
    apiKey: "test-only-org-a-credential",
    apiKeys: null,
    models: [{ id: "context-isolation-model", name: "Context isolation model", config: {} }],
  };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "den.example.test") {
      const orgId = new Headers(init?.headers).get("x-openwork-legacy-org-id");
      if (orgId === "org_b") return Response.json({ error: "not_found" }, { status: 404 });
      if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: [provider] });
      if (url.pathname === `/v1/llm-providers/${PROVIDER_ID}/connect`) {
        return Response.json({ llmProvider: provider });
      }
    }
    if (url.hostname === "engine.example.test" && url.pathname === `/auth/${PROVIDER_ID}`) {
      return Response.json(true);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const env = new EnvService({ path: join(root, "env.json") });
  let engineBusy = false;
  let reloads = 0;
  const sync = new CloudProviderSync({
    config,
    env,
    fetchImpl,
    engineBusy: async () => engineBusy,
    reloadEngine: async () => {
      reloads += 1;
    },
    intervalMs: 3_600_000,
  });

  try {
    await sync.setSession({ baseUrl: "https://den.example.test", token: "token-a", orgId: "org_a" });
    expect((await sync.run("org-a")).status).toBe("applied");
    expect(runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[PROVIDER_ID]).toBeDefined();
    expect((await env.list()).some((entry) => entry.key === ENV_KEY)).toBe(true);
    evidence.recordAssertionEvidence(
      "Organization A materializes its own managed provider context",
      `The runtime provider and its named environment entry were both present after one successful pass.`,
      true,
    );

    engineBusy = true;
    await sync.setSession({ baseUrl: "https://den.example.test", token: "token-b", orgId: "org_b" });
    expect((await sync.run("org-b")).status).toBe("failed");

    const providerAfterFailure = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config))[PROVIDER_ID];
    const envAfterFailure = (await env.list()).some((entry) => entry.key === ENV_KEY);
    expect(providerAfterFailure).toBeUndefined();
    expect(envAfterFailure).toBe(false);
    expect(sync.status().providers).toEqual([]);
    evidence.recordAssertionEvidence(
      "A new organization is not acknowledged until the old context is quarantined",
      `The old runtime provider, named environment entry, and visible provider status were absent after the transition.`,
      providerAfterFailure === undefined && !envAfterFailure && sync.status().providers.length === 0,
    );

    expect(sync.status().lastRun?.message).toBe("den_request_failed_404");
    expect(reloads).toBe(2);
    evidence.recordAssertionEvidence(
      "A failing replacement sync cannot keep the old engine generation alive",
      `The replacement list failed with a terminal 404 after the security cleanup forced the second engine reload.`,
      sync.status().lastRun?.message === "den_request_failed_404" && reloads === 2,
    );
  } finally {
    sync.stop();
    resetManagedProviderAuthCache();
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    await rm(root, { recursive: true, force: true });
  }
});
