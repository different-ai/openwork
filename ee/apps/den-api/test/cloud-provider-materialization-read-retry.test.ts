import { expect, test } from "bun:test";
import { createDenTypeId } from "@openwork-ee/utils/typeid";
import type {
  CloudProviderMaterializationProvider,
  CloudProviderMaterializationStore,
} from "../src/llm/cloud-provider-materialization.js";

type MaterializerModule = typeof import("../src/llm/cloud-provider-materialization.js");
type MaterializeInput = Parameters<MaterializerModule["materializeCloudWorkerProviders"]>[0];
type FetchImpl = NonNullable<MaterializeInput["fetchImpl"]>;

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test";
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32);
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790";
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: BodyInit | null | undefined): unknown {
  return typeof body === "string" && body ? JSON.parse(body) : null;
}

function bodyEntries(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.entries)) return [];
  return body.entries.filter(isRecord);
}

function makeAnthropicProvider(): CloudProviderMaterializationProvider {
  const modelId = "claude-fable-5";
  return {
    id: createDenTypeId("llmProvider"),
    source: "models_dev",
    providerId: "anthropic",
    name: "Anthropic",
    providerConfig: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
    },
    apiKey: "sk-anthropic",
    models: [{
      modelId,
      name: modelId,
      modelConfig: { id: modelId, name: modelId, tool_call: true },
    }],
  };
}

function makeInstance(input: { failConfigReads?: number; failEnvWrites?: number } = {}) {
  const calls: string[] = [];
  const envValues = new Map<string, string>();
  const managedProviders: Record<string, unknown> = {};
  let failConfigReads = input.failConfigReads ?? 0;
  let failEnvWrites = input.failEnvWrites ?? 0;

  const fetchImpl: FetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);

    if (method === "GET" && path === "/opencode/config") {
      if (failConfigReads > 0) {
        failConfigReads -= 1;
        return jsonResponse({ code: "opencode_unconfigured" }, 400);
      }
      return jsonResponse({ provider: managedProviders });
    }

    if (method === "GET" && path.startsWith("/env/")) {
      const key = decodeURIComponent(path.slice("/env/".length));
      const value = envValues.get(key);
      return value === undefined
        ? jsonResponse({ error: "env_not_found" }, 404)
        : jsonResponse({ item: { key, value } });
    }

    if (method === "PUT" && path === "/env") {
      if (failEnvWrites > 0) {
        failEnvWrites -= 1;
        return jsonResponse({ error: "env_write_failed" }, 500);
      }
      for (const entry of bodyEntries(parseBody(init?.body))) {
        if (typeof entry.key === "string" && typeof entry.value === "string") {
          envValues.set(entry.key, entry.value);
        }
      }
      return jsonResponse({ ok: true });
    }

    if (method === "PATCH" && path === "/runtime-config/providers") {
      const body = parseBody(init?.body);
      const patch = isRecord(body) && isRecord(body.provider) ? body.provider : {};
      for (const [providerId, value] of Object.entries(patch)) {
        if (value === null) delete managedProviders[providerId];
        else managedProviders[providerId] = value;
      }
      return jsonResponse({ updatedAt: Date.now() });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  return { calls, fetchImpl };
}

test("read-phase failures retry immediately while write-phase failures cool down", async () => {
  seedRequiredEnv();
  const { materializeCloudWorkerProviders } = await import(
    "../src/llm/cloud-provider-materialization.js"
  );
  const provider = makeAnthropicProvider();
  const store: CloudProviderMaterializationStore = {
    async listProviders() {
      return [provider];
    },
    async getActiveTokens() {
      return [];
    },
  };
  const organizationId = createDenTypeId("organization");
  const instanceUrl = "https://worker.example.test";
  const now = () => 1_000;
  const logger = { warn() {}, error() {} };
  const materialize = (workerId: MaterializeInput["workerId"], fetchImpl: FetchImpl) =>
    materializeCloudWorkerProviders({
      organizationId,
      workerId,
      instanceUrl,
      hostToken: "host-token",
      clientToken: "client-token",
      store,
      fetchImpl,
      logger,
      now,
    });

  const readFailureInstance = makeInstance({ failConfigReads: 1 });
  const workerId = createDenTypeId("worker");
  const failedRead = await materialize(workerId, readFailureInstance.fetchImpl);

  expect(failedRead.ok).toBe(false);
  if (failedRead.ok) throw new Error("expected the first config read to fail");
  expect(failedRead.reason).toBe("engine_config_read_failed_400");
  expect(readFailureInstance.calls).not.toContain("PUT /env");
  expect(readFailureInstance.calls).not.toContain("PATCH /runtime-config/providers");

  const retriedRead = await materialize(workerId, readFailureInstance.fetchImpl);

  expect(retriedRead.ok).toBe(true);
  expect(retriedRead.status).toBe("applied");
  expect(readFailureInstance.calls).toContain("PUT /env");
  expect(readFailureInstance.calls).toContain("PATCH /runtime-config/providers");

  const writeFailureInstance = makeInstance({ failEnvWrites: 1 });
  const writeWorkerId = createDenTypeId("worker");
  const failedWrite = await materialize(writeWorkerId, writeFailureInstance.fetchImpl);
  writeFailureInstance.calls.length = 0;
  const cooledDownWrite = await materialize(writeWorkerId, writeFailureInstance.fetchImpl);

  expect(failedWrite.ok).toBe(false);
  expect(cooledDownWrite).toEqual(failedWrite);
  expect(writeFailureInstance.calls).toEqual([]);
});
