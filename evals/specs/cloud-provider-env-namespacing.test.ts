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
import {
  runtimeProviderEnvTag,
  toRuntimeProviderEnv,
} from "../../ee/apps/den-api/src/llm/provider-credentials.js";

// A catalog (models.dev) provider declaring a well-known name and a custom
// provider declaring its own. Left bare, the catalog one would switch on
// OpenCode's built-in OpenAI catalog and shadow a key the member set
// themselves; the custom one belongs to the organization that wrote it and
// must come through exactly as declared.
const CATALOG_PROVIDER_ID = "lpr_01kx4t3amgendr682dmp6120jv";
const CUSTOM_PROVIDER_ID = "lpr_01kx4t3aqfendr688a4dedf2m5";
const DECLARED_ENV = "OPENAI_API_KEY";
const CUSTOM_ENV = "GATEWAY_API_KEY";
const SCOPED_ENV = `${runtimeProviderEnvTag(CATALOG_PROVIDER_ID)}_${DECLARED_ENV}`;
const ORG_CREDENTIAL = "test-only-organization-credential";
const GATEWAY_CREDENTIAL = "test-only-gateway-credential";
const USER_CREDENTIAL = "test-only-users-own-credential";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockEnv(config: Awaited<ReturnType<typeof readGlobalRuntimeOpencodeConfig>>, providerId: string) {
  const block = runtimeProviderMap(config)[providerId];
  return isRecord(block) ? block.env : undefined;
}

test("a catalog provider is materialized under a provider-scoped env name while custom providers and the user's own key stay exactly as declared", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-provider-env-namespacing-"));
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
      id: "ws_env_namespacing",
      name: "Env namespacing",
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

  // Stored Den rows, exactly as the dashboard saved them.
  const storedCatalog = {
    id: CATALOG_PROVIDER_ID,
    providerId: "openai",
    name: "Organization OpenAI",
    source: "models_dev",
    updatedAt: "2026-09-01T00:00:00.000Z",
    providerConfig: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: [DECLARED_ENV] },
    apiKey: ORG_CREDENTIAL,
    apiKeys: null,
    models: [{ id: "assigned-model", name: "Assigned model", config: {} }],
  };
  const storedCustom = {
    id: CUSTOM_PROVIDER_ID,
    providerId: "gateway",
    name: "Organization gateway",
    source: "custom",
    updatedAt: "2026-09-01T00:00:00.000Z",
    providerConfig: {
      id: "gateway",
      name: "Gateway",
      npm: "@ai-sdk/openai-compatible",
      env: [CUSTOM_ENV],
      options: { baseURL: "https://gateway.example.test/v1" },
    },
    apiKey: null,
    apiKeys: { [CUSTOM_ENV]: GATEWAY_CREDENTIAL },
    models: [{ id: "gateway-model", name: "Gateway model", config: {} }],
  };
  // What Den's connect route hands to a member's machine.
  const connectPayloads: Record<string, Record<string, unknown>> = {
    [CATALOG_PROVIDER_ID]: toRuntimeProviderEnv(storedCatalog),
    [CUSTOM_PROVIDER_ID]: toRuntimeProviderEnv(storedCustom),
  };

  const deliveredAuth: Array<{ providerId: string; key: string | null }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "den.example.test") {
      if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: [storedCatalog, storedCustom] });
      const connect = /^\/v1\/llm-providers\/([^/]+)\/connect$/.exec(url.pathname);
      const payload = connect ? connectPayloads[decodeURIComponent(connect[1] ?? "")] : undefined;
      if (payload) return Response.json({ llmProvider: payload });
    }
    if (url.hostname === "engine.example.test") {
      const auth = /^\/auth\/(.+)$/.exec(url.pathname);
      if (auth) {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        deliveredAuth.push({
          providerId: decodeURIComponent(auth[1] ?? ""),
          key: isRecord(body) && typeof body.key === "string" ? body.key : null,
        });
        return Response.json(true);
      }
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const env = new EnvService({ path: join(root, "env.json") });
  const envValues = async () => new Map((await env.list()).map((entry) => [entry.key, entry.value]));
  const sync = new CloudProviderSync({
    config,
    env,
    fetchImpl,
    reloadEngine: async () => undefined,
    intervalMs: 3_600_000,
  });

  try {
    // The member already uses their own OpenAI key under the well-known name.
    await env.upsertMany([{ key: DECLARED_ENV, value: USER_CREDENTIAL }]);

    await sync.setSession({ baseUrl: "https://den.example.test", token: "token", orgId: "org_env" });
    expect((await sync.run("import")).status).toBe("applied");

    const runtimeConfig = await readGlobalRuntimeOpencodeConfig(config);
    const catalogEnv = blockEnv(runtimeConfig, CATALOG_PROVIDER_ID);
    const customEnv = blockEnv(runtimeConfig, CUSTOM_PROVIDER_ID);
    const afterImport = await envValues();

    expect(catalogEnv).toEqual([SCOPED_ENV]);
    expect(afterImport.get(SCOPED_ENV)).toBe(ORG_CREDENTIAL);
    evidence.recordAssertionEvidence(
      "The catalog provider's credential lives only under its provider-scoped env name",
      `The ${CATALOG_PROVIDER_ID} block declares env ${JSON.stringify(catalogEnv)} and the env store holds ${SCOPED_ENV}; the name is derived from the row id alone, so nothing was stored or migrated in Den.`,
      Array.isArray(catalogEnv) && catalogEnv.length === 1 && catalogEnv[0] === SCOPED_ENV && afterImport.get(SCOPED_ENV) === ORG_CREDENTIAL,
    );

    expect(customEnv).toEqual([CUSTOM_ENV]);
    expect(afterImport.get(CUSTOM_ENV)).toBe(GATEWAY_CREDENTIAL);
    evidence.recordAssertionEvidence(
      "A custom provider keeps the exact env name its organization declared",
      `The ${CUSTOM_PROVIDER_ID} block still declares env ${JSON.stringify(customEnv)} and the env store holds ${CUSTOM_ENV}: custom providers are outside the scoping rule.`,
      Array.isArray(customEnv) && customEnv.length === 1 && customEnv[0] === CUSTOM_ENV && afterImport.get(CUSTOM_ENV) === GATEWAY_CREDENTIAL,
    );

    expect(afterImport.get(DECLARED_ENV)).toBe(USER_CREDENTIAL);
    evidence.recordAssertionEvidence(
      "The member's own key under the well-known name is never overwritten",
      `${DECLARED_ENV} still holds the member's value after the import; the organization's OpenAI credential went to ${SCOPED_ENV} instead.`,
      afterImport.get(DECLARED_ENV) === USER_CREDENTIAL,
    );

    const catalogAuth = deliveredAuth.filter((entry) => entry.providerId === CATALOG_PROVIDER_ID);
    expect(catalogAuth).toEqual([{ providerId: CATALOG_PROVIDER_ID, key: ORG_CREDENTIAL }]);
    evidence.recordAssertionEvidence(
      "The engine still receives the organization credential through its auth API",
      `PUT /auth/${CATALOG_PROVIDER_ID} carried the organization credential resolved from ${SCOPED_ENV}.`,
      catalogAuth.length === 1 && catalogAuth[0]?.key === ORG_CREDENTIAL,
    );

    // Same rows, same ids: a second pass derives the same names and has nothing to do.
    expect((await sync.run("repeat")).status).toBe("noop");
    evidence.recordAssertionEvidence(
      "Scoped names are deterministic, so a repeat sync is a no-op",
      `A second sync of unchanged rows reported noop; ${SCOPED_ENV} is a pure function of ${CATALOG_PROVIDER_ID}.`,
      true,
    );

    // Signing out removes what OpenWork wrote and nothing else.
    await sync.clearSession();
    const afterSignOut = await envValues();
    expect(afterSignOut.has(SCOPED_ENV)).toBe(false);
    expect(afterSignOut.get(DECLARED_ENV)).toBe(USER_CREDENTIAL);
    evidence.recordAssertionEvidence(
      "Sign-out removes only the entries OpenWork wrote",
      `${SCOPED_ENV} was removed on sign-out and ${DECLARED_ENV} still holds the member's value.`,
      !afterSignOut.has(SCOPED_ENV) && afterSignOut.get(DECLARED_ENV) === USER_CREDENTIAL,
    );
  } finally {
    sync.stop();
    resetManagedProviderAuthCache();
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    await rm(root, { recursive: true, force: true });
  }
});
